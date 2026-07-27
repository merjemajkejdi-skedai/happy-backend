import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, getVenueContext, validateDestination, type MenuDomainError } from './validation';
import { Prisma, type ModifierGroup, type ModifierOption, type ModifierType, type ModifierPricing, type Destination } from '../../generated/prisma/client';

export type ModifierResult<T> = { ok: true; value: T } | { ok: false; error: MenuDomainError };

function validateGroupRules(
  type: ModifierType,
  isRequired: boolean,
  minSelect: number,
  maxSelect: number | null,
): MenuDomainError | null {
  if (type === 'single' && !(maxSelect === 1 || maxSelect === null)) {
    return err(422, 'INVALID_MAX_SELECT', "max_select must be 1 or null for a 'single' modifier group");
  }
  if (type === 'multiple' && maxSelect !== null && maxSelect < minSelect) {
    return err(422, 'INVALID_MAX_SELECT', "max_select must be null or >= min_select for a 'multiple' modifier group");
  }
  if (isRequired && minSelect < 1) {
    return err(422, 'INVALID_MIN_SELECT', 'min_select must be >= 1 when the group is required');
  }
  return null;
}

// tier_prices shape check (2b-i section 2): keys must be positive-integer
// strings, values numbers >= 0. Whether tier_prices is allowed AT ALL for a
// given option (only when its group's pricing_mode='tiered') is a separate
// check — checkTierPricesAllowed below — since that needs the parent group.
function validateTierPrices(tierPrices: unknown): MenuDomainError | null {
  if (tierPrices === null || tierPrices === undefined) return null;
  if (typeof tierPrices !== 'object' || Array.isArray(tierPrices)) {
    return err(422, 'INVALID_TIER_PRICES', 'tier_prices must be an object mapping selection ordinal to price');
  }
  for (const [key, value] of Object.entries(tierPrices as Record<string, unknown>)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) {
      return err(422, 'INVALID_TIER_PRICES', 'tier_prices keys must be positive integer strings');
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return err(422, 'INVALID_TIER_PRICES', 'tier_prices values must be numbers >= 0');
    }
  }
  return null;
}

function checkTierPricesAllowed(pricingMode: ModifierPricing, tierPrices: unknown): MenuDomainError | null {
  if (tierPrices === null || tierPrices === undefined) return null;
  if (pricingMode !== 'tiered') {
    return err(422, 'INVALID_TIER_PRICES', "tier_prices is only allowed when the group's pricing_mode is 'tiered'");
  }
  return validateTierPrices(tierPrices);
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

// ── Groups ───────────────────────────────────────────────────────────────────

export interface ModifierGroupWithOptions extends ModifierGroup {
  options: ModifierOption[];
}

export interface ListModifierGroupsParams {
  page?: number;
  perPage?: number;
  // is_active (Phase 2) is distinct from soft-delete (deleted_at), matching
  // the menu_items.is_active/is_available convention — deleted_at is always
  // excluded regardless of this flag.
  includeInactive?: boolean;
}

export async function listModifierGroups(venueId: string, params: ListModifierGroupsParams = {}) {
  const where: Prisma.ModifierGroupWhereInput = { venueId, deletedAt: null };
  if (!params.includeInactive) where.isActive = true;
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));

  const [groups, total] = await Promise.all([
    scopedPrisma.modifierGroup.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.modifierGroup.count({ where }),
  ]);
  if (groups.length === 0) return { groups: [] as ModifierGroupWithOptions[], page, perPage, total };

  const options = await scopedPrisma.modifierOption.findMany({
    where: { groupId: { in: groups.map(g => g.id) }, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  const optionsByGroup = new Map<string, ModifierOption[]>();
  for (const o of options) {
    const list = optionsByGroup.get(o.groupId) ?? [];
    list.push(o);
    optionsByGroup.set(o.groupId, list);
  }

  const withOptions = groups.map(g => ({ ...g, options: optionsByGroup.get(g.id) ?? [] }));
  return { groups: withOptions, page, perPage, total };
}

export interface ModifierGroupInput {
  name: string;
  type: ModifierType;
  isRequired?: boolean;
  minSelect?: number;
  maxSelect?: number | null;
  sortOrder?: number;
  pricingMode?: ModifierPricing;
  appliesToDestination?: Destination | null;
  displayStyle?: string;
  isActive?: boolean;
}

export async function createModifierGroup(venueId: string, input: ModifierGroupInput): Promise<ModifierResult<ModifierGroup>> {
  const isRequired = input.isRequired ?? false;
  const minSelect = input.minSelect ?? 0;
  const maxSelect = input.maxSelect ?? null;

  const ruleError = validateGroupRules(input.type, isRequired, minSelect, maxSelect);
  if (ruleError) return { ok: false, error: ruleError };

  if (input.appliesToDestination != null) {
    const context = await getVenueContext(venueId);
    const destError = validateDestination(context.venueType, input.appliesToDestination);
    if (destError) return { ok: false, error: destError };
  }

  const group = await scopedPrisma.modifierGroup.create({
    data: {
      venueId,
      name: input.name,
      type: input.type,
      isRequired,
      minSelect,
      maxSelect,
      sortOrder: input.sortOrder ?? 0,
      pricingMode: input.pricingMode ?? 'fixed',
      appliesToDestination: input.appliesToDestination ?? null,
      displayStyle: input.displayStyle ?? 'list',
      isActive: input.isActive ?? true,
    },
  });
  return { ok: true, value: group };
}

export async function updateModifierGroup(
  venueId: string,
  groupId: string,
  input: Partial<ModifierGroupInput>,
): Promise<ModifierResult<ModifierGroup>> {
  const existing = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  const mergedType = input.type ?? existing.type;
  const mergedRequired = input.isRequired !== undefined ? input.isRequired : existing.isRequired;
  const mergedMin = input.minSelect !== undefined ? input.minSelect : existing.minSelect;
  const mergedMax = input.maxSelect !== undefined ? input.maxSelect : existing.maxSelect;

  const ruleError = validateGroupRules(mergedType, mergedRequired, mergedMin, mergedMax);
  if (ruleError) return { ok: false, error: ruleError };

  const mergedDestination = input.appliesToDestination !== undefined ? input.appliesToDestination : existing.appliesToDestination;
  if (mergedDestination != null) {
    const context = await getVenueContext(venueId);
    const destError = validateDestination(context.venueType, mergedDestination);
    if (destError) return { ok: false, error: destError };
  }

  const data: Prisma.ModifierGroupUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.type !== undefined) data.type = input.type;
  if (input.isRequired !== undefined) data.isRequired = input.isRequired;
  if (input.minSelect !== undefined) data.minSelect = input.minSelect;
  if (input.maxSelect !== undefined) data.maxSelect = input.maxSelect;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.pricingMode !== undefined) data.pricingMode = input.pricingMode;
  if (input.appliesToDestination !== undefined) data.appliesToDestination = input.appliesToDestination;
  if (input.displayStyle !== undefined) data.displayStyle = input.displayStyle;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const group = await scopedPrisma.modifierGroup.update({ where: { id: groupId }, data });
  return { ok: true, value: group };
}

export async function deleteModifierGroup(venueId: string, groupId: string): Promise<ModifierResult<null>> {
  const existing = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  const attachedCount = await prisma.menuItemModifierGroup.count({
    where: { groupId, menuItem: { isActive: true, deletedAt: null } },
  });
  if (attachedCount > 0) {
    return { ok: false, error: err(409, 'MODIFIER_GROUP_HAS_ATTACHED_ITEMS', 'This modifier group is still attached to one or more active menu items') };
  }

  await scopedPrisma.modifierGroup.update({ where: { id: groupId }, data: { deletedAt: new Date() } });
  return { ok: true, value: null };
}

// Reorders groups: sort_order is positional, index in the given array
// becomes the new sort_order — same convention as setItemModifierGroups.
export async function reorderModifierGroups(
  venueId: string,
  groupIds: string[],
): Promise<ModifierResult<{ groupId: string; sortOrder: number }[]>> {
  const uniqueIds = [...new Set(groupIds)];
  const groups = await scopedPrisma.modifierGroup.findMany({ where: { id: { in: uniqueIds }, venueId, deletedAt: null } });
  if (groups.length !== uniqueIds.length) {
    return { ok: false, error: err(404, 'NOT_FOUND', 'One or more modifier groups not found') };
  }

  await prisma.$transaction(
    uniqueIds.map((groupId, index) => prisma.modifierGroup.update({ where: { id: groupId }, data: { sortOrder: index } })),
  );
  return { ok: true, value: uniqueIds.map((groupId, index) => ({ groupId, sortOrder: index })) };
}

// Copies the group's own config and its options — NOT item attachments
// ("Duplicate copies options but not attachments").
export async function duplicateModifierGroup(venueId: string, groupId: string): Promise<ModifierResult<ModifierGroupWithOptions>> {
  const existing = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  const options = await scopedPrisma.modifierOption.findMany({
    where: { groupId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  const duplicate = await prisma.modifierGroup.create({
    data: {
      venueId,
      name: `${existing.name} (copy)`,
      type: existing.type,
      isRequired: existing.isRequired,
      minSelect: existing.minSelect,
      maxSelect: existing.maxSelect,
      sortOrder: existing.sortOrder,
      pricingMode: existing.pricingMode,
      appliesToDestination: existing.appliesToDestination,
      displayStyle: existing.displayStyle,
      isActive: existing.isActive,
    },
  });

  const newOptions = options.length
    ? await prisma.$transaction(
        options.map(o =>
          prisma.modifierOption.create({
            data: {
              groupId: duplicate.id,
              name: o.name,
              priceDelta: o.priceDelta,
              sortOrder: o.sortOrder,
              isDefault: o.isDefault,
              stockTracked: o.stockTracked,
              tierPrices: o.tierPrices ?? undefined,
            },
          }),
        ),
      )
    : [];

  return { ok: true, value: { ...duplicate, options: newOptions } };
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface ModifierOptionInput {
  name: string;
  priceDelta?: number;
  sortOrder?: number;
  isDefault?: boolean;
  stockTracked?: boolean;
  tierPrices?: unknown;
}

export async function createModifierOption(
  venueId: string,
  groupId: string,
  input: ModifierOptionInput,
): Promise<ModifierResult<ModifierOption>> {
  const group = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!group) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  const tierError = checkTierPricesAllowed(group.pricingMode, input.tierPrices);
  if (tierError) return { ok: false, error: tierError };

  const option = await prisma.modifierOption.create({
    data: {
      groupId,
      name: input.name,
      priceDelta: input.priceDelta ?? 0,
      sortOrder: input.sortOrder ?? 0,
      isDefault: input.isDefault ?? false,
      stockTracked: input.stockTracked ?? false,
      tierPrices: input.tierPrices !== undefined ? toJsonInput(input.tierPrices) : undefined,
    },
  });
  return { ok: true, value: option };
}

export async function updateModifierOption(
  venueId: string,
  optionId: string,
  input: Partial<ModifierOptionInput>,
): Promise<ModifierResult<ModifierOption>> {
  const existing = await prisma.modifierOption.findFirst({
    where: { id: optionId, deletedAt: null, group: { venueId, deletedAt: null } },
    include: { group: true },
  });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier option not found') };

  if (input.tierPrices !== undefined) {
    const tierError = checkTierPricesAllowed(existing.group.pricingMode, input.tierPrices);
    if (tierError) return { ok: false, error: tierError };
  }

  const data: Prisma.ModifierOptionUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.priceDelta !== undefined) data.priceDelta = input.priceDelta;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  if (input.stockTracked !== undefined) data.stockTracked = input.stockTracked;
  if (input.tierPrices !== undefined) data.tierPrices = toJsonInput(input.tierPrices);

  const option = await prisma.modifierOption.update({ where: { id: optionId }, data });
  return { ok: true, value: option };
}

export async function deleteModifierOption(venueId: string, optionId: string): Promise<ModifierResult<null>> {
  const existing = await prisma.modifierOption.findFirst({
    where: { id: optionId, deletedAt: null, group: { venueId, deletedAt: null } },
  });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier option not found') };

  await prisma.modifierOption.update({ where: { id: optionId }, data: { deletedAt: new Date(), isActive: false } });
  return { ok: true, value: null };
}

// ── Item <-> group attachment ────────────────────────────────────────────────

// Replaces the FULL set of groups attached to an item. sort_order is
// positional: the order group_ids appears in the request is the order the
// client wants them shown in, so index becomes sort_order directly.
export async function setItemModifierGroups(
  venueId: string,
  itemId: string,
  groupIds: string[],
): Promise<ModifierResult<{ groupId: string; sortOrder: number }[]>> {
  const item = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const uniqueIds = [...new Set(groupIds)];

  const context = await getVenueContext(venueId);
  if (uniqueIds.length > context.modifierMaxGroupsPerItem) {
    return {
      ok: false,
      error: err(422, 'MODIFIER_GROUP_LIMIT_EXCEEDED', `An item cannot have more than ${context.modifierMaxGroupsPerItem} modifier groups`),
    };
  }

  if (uniqueIds.length > 0) {
    const groups = await scopedPrisma.modifierGroup.findMany({ where: { id: { in: uniqueIds }, venueId, deletedAt: null } });
    if (groups.length !== uniqueIds.length) {
      return { ok: false, error: err(404, 'NOT_FOUND', 'One or more modifier groups not found') };
    }
  }

  await prisma.$transaction([
    prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: itemId } }),
    ...uniqueIds.map((groupId, index) =>
      prisma.menuItemModifierGroup.create({ data: { menuItemId: itemId, groupId, sortOrder: index } }),
    ),
  ]);

  return { ok: true, value: uniqueIds.map((groupId, index) => ({ groupId, sortOrder: index })) };
}

// Resolved groups + options + defaults for one item — same shape as the
// per-item slice of GET /menu's tree, exposed standalone for callers (e.g.
// an item editor) that don't need the whole menu.
export async function getItemModifierGroups(venueId: string, itemId: string): Promise<ModifierResult<ModifierGroupWithOptions[]>> {
  const item = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const links = await prisma.menuItemModifierGroup.findMany({ where: { menuItemId: itemId }, orderBy: { sortOrder: 'asc' } });
  if (links.length === 0) return { ok: true, value: [] };

  const groupIds = links.map(l => l.groupId);
  const [groups, options] = await Promise.all([
    scopedPrisma.modifierGroup.findMany({ where: { id: { in: groupIds }, venueId, deletedAt: null } }),
    scopedPrisma.modifierOption.findMany({
      where: { groupId: { in: groupIds }, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const optionsByGroup = new Map<string, ModifierOption[]>();
  for (const o of options) {
    const list = optionsByGroup.get(o.groupId) ?? [];
    list.push(o);
    optionsByGroup.set(o.groupId, list);
  }
  const groupsById = new Map(groups.map(g => [g.id, g]));

  const resolved = links
    .map(link => groupsById.get(link.groupId))
    .filter((g): g is ModifierGroup => !!g)
    .map(g => ({ ...g, options: optionsByGroup.get(g.id) ?? [] }));

  return { ok: true, value: resolved };
}
