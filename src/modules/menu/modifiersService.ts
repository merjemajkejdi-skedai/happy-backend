import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, type MenuDomainError } from './validation';
import type { ModifierGroup, ModifierOption, ModifierType, Prisma } from '../../generated/prisma/client';

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

// ── Groups ───────────────────────────────────────────────────────────────────

export interface ModifierGroupWithOptions extends ModifierGroup {
  options: ModifierOption[];
}

export async function listModifierGroups(venueId: string): Promise<ModifierGroupWithOptions[]> {
  const groups = await scopedPrisma.modifierGroup.findMany({
    where: { venueId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  if (groups.length === 0) return [];

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

  return groups.map(g => ({ ...g, options: optionsByGroup.get(g.id) ?? [] }));
}

export interface ModifierGroupInput {
  name: string;
  type: ModifierType;
  isRequired?: boolean;
  minSelect?: number;
  maxSelect?: number | null;
  sortOrder?: number;
}

export async function createModifierGroup(venueId: string, input: ModifierGroupInput): Promise<ModifierResult<ModifierGroup>> {
  const isRequired = input.isRequired ?? false;
  const minSelect = input.minSelect ?? 0;
  const maxSelect = input.maxSelect ?? null;

  const ruleError = validateGroupRules(input.type, isRequired, minSelect, maxSelect);
  if (ruleError) return { ok: false, error: ruleError };

  const group = await scopedPrisma.modifierGroup.create({
    data: { venueId, name: input.name, type: input.type, isRequired, minSelect, maxSelect, sortOrder: input.sortOrder ?? 0 },
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

  const data: Prisma.ModifierGroupUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.type !== undefined) data.type = input.type;
  if (input.isRequired !== undefined) data.isRequired = input.isRequired;
  if (input.minSelect !== undefined) data.minSelect = input.minSelect;
  if (input.maxSelect !== undefined) data.maxSelect = input.maxSelect;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  const group = await scopedPrisma.modifierGroup.update({ where: { id: groupId }, data });
  return { ok: true, value: group };
}

export async function deleteModifierGroup(venueId: string, groupId: string): Promise<ModifierResult<null>> {
  const existing = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  await scopedPrisma.modifierGroup.update({ where: { id: groupId }, data: { deletedAt: new Date() } });
  return { ok: true, value: null };
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface ModifierOptionInput {
  name: string;
  priceDelta?: number;
  sortOrder?: number;
}

export async function createModifierOption(
  venueId: string,
  groupId: string,
  input: ModifierOptionInput,
): Promise<ModifierResult<ModifierOption>> {
  const group = await scopedPrisma.modifierGroup.findFirst({ where: { id: groupId, venueId, deletedAt: null } });
  if (!group) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier group not found') };

  const option = await prisma.modifierOption.create({
    data: { groupId, name: input.name, priceDelta: input.priceDelta ?? 0, sortOrder: input.sortOrder ?? 0 },
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
  });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Modifier option not found') };

  const data: Prisma.ModifierOptionUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.priceDelta !== undefined) data.priceDelta = input.priceDelta;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

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
