import crypto from 'crypto';
import { scopedPrisma } from '../../middleware/venueScope';
import type { MenuCategory, MenuItem, ModifierGroup, ModifierOption } from '../../generated/prisma/client';
import { serializeMenuItem, serializeModifierOption } from './serializers';

type SerializedOption = ReturnType<typeof serializeModifierOption>;
type SerializedItem = ReturnType<typeof serializeMenuItem>;

export interface TreeModifierGroup extends ModifierGroup {
  options: SerializedOption[];
}

export interface TreeItem extends SerializedItem {
  modifierGroups: TreeModifierGroup[];
}

export interface TreeCategory extends MenuCategory {
  items: TreeItem[];
}

export interface MenuTree {
  categories: TreeCategory[];
  version: string;
}

// One small, fixed number of flat queries regardless of menu size — no
// nested Prisma `include` (relation shapes don't reliably survive the
// venueScope extension's $allOperations wrapper, verified in the tables
// module), no per-category/per-item round trips.
export async function getMenuTree(venueId: string): Promise<MenuTree> {
  const [categories, items, groups] = await Promise.all([
    scopedPrisma.menuCategory.findMany({
      where: { venueId, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    scopedPrisma.menuItem.findMany({
      where: { venueId, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    scopedPrisma.modifierGroup.findMany({
      where: { venueId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const groupIds = groups.map(g => g.id);
  const itemIds = items.map(i => i.id);

  const [options, links] = await Promise.all([
    groupIds.length
      ? scopedPrisma.modifierOption.findMany({
          where: { groupId: { in: groupIds }, isActive: true, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        })
      : Promise.resolve([]),
    itemIds.length
      ? scopedPrisma.menuItemModifierGroup.findMany({
          where: { menuItemId: { in: itemIds } },
          orderBy: { sortOrder: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  const optionsByGroup = new Map<string, SerializedOption[]>();
  for (const o of options) {
    const list = optionsByGroup.get(o.groupId) ?? [];
    list.push(serializeModifierOption(o));
    optionsByGroup.set(o.groupId, list);
  }

  const groupsById = new Map(groups.map(g => [g.id, g]));
  const linksByItem = new Map<string, typeof links>();
  for (const link of links) {
    const list = linksByItem.get(link.menuItemId) ?? [];
    list.push(link);
    linksByItem.set(link.menuItemId, list);
  }

  const itemsByCategory = new Map<string, MenuItem[]>();
  for (const item of items) {
    const list = itemsByCategory.get(item.categoryId) ?? [];
    list.push(item);
    itemsByCategory.set(item.categoryId, list);
  }

  const tree: TreeCategory[] = categories.map(category => ({
    ...category,
    items: (itemsByCategory.get(category.id) ?? []).map(item => ({
      ...serializeMenuItem(item),
      modifierGroups: (linksByItem.get(item.id) ?? [])
        .map(link => groupsById.get(link.groupId))
        .filter((g): g is ModifierGroup => !!g)
        .map(group => ({ ...group, options: optionsByGroup.get(group.id) ?? [] })),
    })),
  }));

  return { categories: tree, version: computeVersion(categories, items, groups, options, links.length) };
}

// Cheap change-detection signal for POS clients to skip re-parsing an
// unchanged menu, not a strict audit trail: derived from the max updatedAt
// and row counts of everything already fetched above, so it costs nothing
// extra to compute. A soft-delete that isn't the most-recently-touched row
// in its table could in principle leave this unchanged even though the
// active set shrank — acceptable here since the cost of a false negative is
// just an unnecessary client refetch, never stale data (the client always
// gets the true current tree; this is purely a "should I bother re-parsing"
// hint, not part of the response's correctness).
function computeVersion(
  categories: MenuCategory[],
  items: MenuItem[],
  groups: ModifierGroup[],
  options: ModifierOption[],
  linkCount: number,
): string {
  const allUpdatedAt = [
    ...categories.map(c => c.updatedAt.getTime()),
    ...items.map(i => i.updatedAt.getTime()),
    ...groups.map(g => g.updatedAt.getTime()),
    ...options.map(o => o.updatedAt.getTime()),
  ];
  const maxUpdatedAt = allUpdatedAt.length ? Math.max(...allUpdatedAt) : 0;
  const signature = [maxUpdatedAt, categories.length, items.length, groups.length, options.length, linkCount].join(':');
  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16);
}
