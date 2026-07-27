import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, getVenueAndSettings, type OrderDomainError } from './validation';
import { validateCourseNumber } from '../menu/validation';
import { resolveModifierPrice } from '../menu/modifierPricing';
import { decrementStockForOrder, businessDateFor } from '../menu/stockService';
import { recomputeOrder } from './ordersService';
import { sendItemsCore } from './lifecycleService';
import {
  Prisma,
  type OrderItem,
  type OrderItemModifier,
  type Destination,
  type RestaurantSettings,
  type OrderStatus,
} from '../../generated/prisma/client';

export type OrderItemResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

// Thrown from inside addItem's transaction when the atomic stock decrement
// (session 2e) fails, so Prisma rolls back the whole insert — caught just
// outside the transaction and converted back into the normal
// OrderItemResult error shape, same pattern already used elsewhere in this
// module for Prisma constraint-violation catches.
class StockDecrementFailure extends Error {
  constructor(public readonly domainError: OrderDomainError) {
    super(domainError.message);
  }
}

// An item can only be added/edited while its order is still being built up
// or actively being served — not once it's fully served, closed, or cancelled.
const ITEM_MUTABLE_ORDER_STATUSES: OrderStatus[] = ['draft', 'open', 'sent', 'partially_served'];

export type OrderItemWithModifiers = OrderItem & { modifiers: OrderItemModifier[] };

// ── Modifier selection resolution — shared by add/update/PATCH .../modifiers ─

export interface ResolvedModifierLine {
  modifierOptionId: string;
  groupNameSnapshot: string;
  optionNameSnapshot: string;
  priceDeltaSnapshot: Prisma.Decimal;
}

type ModifierResolution =
  | { ok: true; lines: ResolvedModifierLine[]; modifiersTotal: Prisma.Decimal }
  | { ok: false; error: OrderDomainError };

// The full validation matrix (session 2b-ii, section 1) runs only while
// settings.require_modifier_validation is true. When it's false, every rule
// below is skipped, but resolution — fetching the real option/group rows and
// computing snapshots/price via resolveModifierPrice — always runs, because
// a snapshot can't be written for a row that was never looked up. The one
// exception is existence itself (an option id that doesn't resolve to a real,
// active, in-venue row): that's not a business rule, it's referential
// integrity, so MODIFIER_SELECTION_INVALID always applies regardless of the
// flag.
async function resolveModifierSelections(
  venueId: string,
  menuItemId: string,
  itemDestination: Destination,
  rawOptionIds: string[],
  settings: RestaurantSettings,
): Promise<ModifierResolution> {
  const requireValidation = settings.requireModifierValidation;

  if (requireValidation && new Set(rawOptionIds).size !== rawOptionIds.length) {
    return { ok: false, error: err(422, 'MODIFIER_DUPLICATE_SELECTION', 'The same modifier option was selected more than once') };
  }

  const uniqueIds = [...new Set(rawOptionIds)];
  // ModifierOption carries no direct venue_id column (only reachable via
  // group.venueId) — same pattern as the menu module.
  const options = uniqueIds.length
    ? await prisma.modifierOption.findMany({
        where: { id: { in: uniqueIds }, isActive: true, deletedAt: null, group: { venueId, deletedAt: null } },
        include: { group: true },
      })
    : [];
  if (options.length !== uniqueIds.length) {
    return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', 'One or more selected modifier options are invalid') };
  }

  const byId = new Map(options.map(o => [o.id, o]));
  // Preserve the payload's own order (and, when validation is off, any raw
  // duplicates) — the order options were submitted in is the only signal
  // available for tiered-pricing ordinals ("1st pick free, 2nd costs 50..."),
  // and there's no other notion of "selection order" for a modifier set.
  const selections = rawOptionIds.map(id => byId.get(id)!);

  if (requireValidation) {
    const links = await prisma.menuItemModifierGroup.findMany({ where: { menuItemId } });
    const attachedGroupIds = new Set(links.map(l => l.groupId));

    for (const s of selections) {
      if (!attachedGroupIds.has(s.groupId)) {
        return {
          ok: false,
          error: err(422, 'MODIFIER_OPTION_NOT_IN_GROUP', `"${s.name}" does not belong to a group attached to this item`),
        };
      }
      if (s.group.appliesToDestination != null && s.group.appliesToDestination !== itemDestination) {
        return {
          ok: false,
          error: err(422, 'MODIFIER_DESTINATION_MISMATCH', `"${s.group.name}" is not available for this item's destination`),
        };
      }
    }

    const attachedGroups = attachedGroupIds.size
      ? await scopedPrisma.modifierGroup.findMany({ where: { id: { in: [...attachedGroupIds] }, venueId, deletedAt: null } })
      : [];
    const countByGroup = new Map<string, number>();
    for (const s of selections) countByGroup.set(s.groupId, (countByGroup.get(s.groupId) ?? 0) + 1);

    for (const group of attachedGroups) {
      const count = countByGroup.get(group.id) ?? 0;
      if (group.isRequired && count === 0) {
        return { ok: false, error: err(422, 'MODIFIER_GROUP_REQUIRED', `"${group.name}" requires a selection`) };
      }
      if (count === 0) continue;
      // type='single' groups always have max_select 1 or null (enforced at
      // group-config time) — the null case still needs this explicit check
      // since the max_select comparison below wouldn't otherwise catch it.
      if (group.type === 'single' && count > 1) {
        return { ok: false, error: err(422, 'MODIFIER_MAX_EXCEEDED', `"${group.name}" allows only one selection`) };
      }
      if (group.maxSelect != null && count > group.maxSelect) {
        return { ok: false, error: err(422, 'MODIFIER_MAX_EXCEEDED', `"${group.name}" allows at most ${group.maxSelect} selection(s)`) };
      }
      if (count < group.minSelect) {
        return { ok: false, error: err(422, 'MODIFIER_MIN_NOT_MET', `"${group.name}" requires at least ${group.minSelect} selection(s)`) };
      }
    }
  }

  const ordinals = new Map<string, number>();
  let modifiersTotal = new Prisma.Decimal(0);
  const lines: ResolvedModifierLine[] = selections.map(s => {
    const ordinal = (ordinals.get(s.groupId) ?? 0) + 1;
    ordinals.set(s.groupId, ordinal);
    const priceDeltaSnapshot = new Prisma.Decimal(
      resolveModifierPrice({ priceDelta: Number(s.priceDelta), tierPrices: s.tierPrices }, ordinal, s.group, settings),
    );
    modifiersTotal = modifiersTotal.plus(priceDeltaSnapshot);
    return { modifierOptionId: s.id, groupNameSnapshot: s.group.name, optionNameSnapshot: s.name, priceDeltaSnapshot };
  });

  return { ok: true, lines, modifiersTotal };
}

// ── Add ──────────────────────────────────────────────────────────────────────

export interface AddItemInput {
  menuItemId: string;
  quantity?: number;
  modifierOptionIds?: string[];
  notes?: string | null;
  courseNumber?: number | null;
}

export async function addItem(
  venueId: string,
  actorUserId: string,
  orderId: string,
  input: AddItemInput,
): Promise<OrderItemResult<OrderItemWithModifiers>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (!ITEM_MUTABLE_ORDER_STATUSES.includes(order.status)) {
    return { ok: false, error: err(409, 'ORDER_NOT_MODIFIABLE', `Cannot add items to an order with status '${order.status}'`) };
  }

  const menuItem = await scopedPrisma.menuItem.findFirst({ where: { id: input.menuItemId, venueId, isActive: true, deletedAt: null } });
  if (!menuItem) return { ok: false, error: err(404, 'NOT_FOUND', 'Menu item not found') };
  if (!menuItem.isAvailable) return { ok: false, error: err(422, 'MENU_ITEM_UNAVAILABLE', 'This menu item is currently unavailable') };

  const category = await scopedPrisma.menuCategory.findFirst({ where: { id: menuItem.categoryId, venueId } });
  if (!category) throw new Error(`category ${menuItem.categoryId} missing for menu item ${menuItem.id}`);

  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'quantity must be a positive integer') };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);

  if (input.notes && !settings.allowFreeTextNotes) {
    return { ok: false, error: err(422, 'NOTES_NOT_ALLOWED', 'Free-text notes are not allowed for this venue') };
  }

  const businessDate = businessDateFor(venue.timezone);

  const courseNumberSnapshot = input.courseNumber !== undefined ? input.courseNumber : menuItem.courseNumber;
  const courseError = validateCourseNumber(settings.coursesEnabled, courseNumberSnapshot);
  if (courseError) return { ok: false, error: courseError };

  const resolved = await resolveModifierSelections(venueId, menuItem.id, menuItem.destination, input.modifierOptionIds ?? [], settings);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { lines, modifiersTotal } = resolved;

  const unitPriceSnapshot = menuItem.price;
  const taxRateSnapshot = menuItem.taxRatePercent ?? settings.taxRatePercent;
  const lineTotal = unitPriceSnapshot.plus(modifiersTotal).times(quantity);

  try {
    const result = await scopedPrisma.$transaction(async tx => {
      const created = await tx.orderItem.create({
        data: {
          orderId,
          venueId,
          menuItemId: menuItem.id,
          itemNameSnapshot: menuItem.name,
          categoryNameSnapshot: category.name,
          unitPriceSnapshot,
          destinationSnapshot: menuItem.destination,
          courseNumberSnapshot,
          // Phase 2, session 2c: courseNumber is the live fire target, seeded
          // from the snapshot at creation but independently movable later via
          // PATCH .../items/:itemId/course — never merge the two back together.
          courseNumber: courseNumberSnapshot,
          taxRateSnapshot,
          quantity,
          modifiersTotal,
          lineTotal,
          status: 'pending',
          notes: input.notes ?? null,
          addedByUserId: actorUserId,
        },
      });

      // Phase 2, session 2e: atomic decrement inside this same transaction —
      // see stockService.decrementStockForOrder for why this can't be
      // checked before the transaction starts. Throwing here rolls back the
      // order-item insert too; caught just below.
      const decremented = await decrementStockForOrder(tx, venueId, menuItem.id, quantity, created.id, actorUserId, businessDate, settings);
      if (!decremented.ok) throw new StockDecrementFailure(decremented.error);

      if (lines.length > 0) {
        await tx.orderItemModifier.createMany({
          data: lines.map(line => ({ orderItemId: created.id, ...line })),
        });
      }

      await tx.orderEvent.create({
        data: {
          venueId,
          orderId,
          orderItemId: created.id,
          eventType: 'item.added',
          actorUserId,
          payload: { menuItemId: menuItem.id, name: created.itemNameSnapshot, quantity },
        },
      });

      if (settings.autoSendOnAdd) {
        await sendItemsCore(tx, venueId, orderId, actorUserId, [created.id]);
      } else {
        await recomputeOrder(tx, venueId, orderId);
      }

      const finalItem = await tx.orderItem.findUniqueOrThrow({ where: { id: created.id } });
      const modifiers = await tx.orderItemModifier.findMany({ where: { orderItemId: created.id } });
      return { ...finalItem, modifiers };
    });
    return { ok: true, value: result };
  } catch (e) {
    if (e instanceof StockDecrementFailure) return { ok: false, error: e.domainError };
    throw e;
  }
}

// ── Update (pending only) ────────────────────────────────────────────────────

export interface UpdateItemInput {
  quantity?: number;
  notes?: string | null;
  modifierOptionIds?: string[];
}

export async function updateItem(
  venueId: string,
  actorUserId: string,
  orderId: string,
  itemId: string,
  input: UpdateItemInput,
): Promise<OrderItemResult<OrderItemWithModifiers>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  if (item.status !== 'pending') {
    return { ok: false, error: err(409, 'ITEM_ALREADY_SENT', 'This item has already been sent and can no longer be edited') };
  }

  const quantity = input.quantity !== undefined ? input.quantity : item.quantity;
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'quantity must be a positive integer') };
  }

  const { settings } = await getVenueAndSettings(venueId);
  if (input.notes && !settings.allowFreeTextNotes) {
    return { ok: false, error: err(422, 'NOTES_NOT_ALLOWED', 'Free-text notes are not allowed for this venue') };
  }

  let lines: ResolvedModifierLine[] | undefined;
  if (input.modifierOptionIds !== undefined) {
    if (!item.menuItemId) {
      return { ok: false, error: err(422, 'MENU_ITEM_UNAVAILABLE', 'The original menu item for this order item no longer exists') };
    }
    const resolved = await resolveModifierSelections(venueId, item.menuItemId, item.destinationSnapshot, input.modifierOptionIds, settings);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    lines = resolved.lines;
  }

  // Snapshot immutability: unit_price_snapshot/tax_rate_snapshot never
  // change here — only quantity and modifier selection can move line_total.
  const modifiersTotal = lines
    ? lines.reduce((sum, l) => sum.plus(l.priceDeltaSnapshot), new Prisma.Decimal(0))
    : item.modifiersTotal;
  const lineTotal = item.unitPriceSnapshot.plus(modifiersTotal).times(quantity);

  const before = { quantity: item.quantity, notes: item.notes };
  const after = { quantity, notes: input.notes !== undefined ? input.notes : item.notes };

  const updated = await scopedPrisma.$transaction(async tx => {
    const updatedItem = await tx.orderItem.update({
      where: { id: itemId },
      data: {
        quantity,
        notes: input.notes !== undefined ? input.notes : undefined,
        modifiersTotal,
        lineTotal,
      },
    });

    if (lines) {
      await tx.orderItemModifier.deleteMany({ where: { orderItemId: itemId } });
      if (lines.length > 0) {
        await tx.orderItemModifier.createMany({ data: lines.map(line => ({ orderItemId: itemId, ...line })) });
      }
    }

    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: itemId, eventType: 'item.updated', actorUserId, payload: { before, after } },
    });

    await recomputeOrder(tx, venueId, orderId);

    const modifiers = await tx.orderItemModifier.findMany({ where: { orderItemId: itemId } });
    return { ...updatedItem, modifiers };
  });

  return { ok: true, value: updated };
}

// ── Replace modifiers only (PATCH .../items/:itemId/modifiers) ──────────────

export async function setItemModifiers(
  venueId: string,
  actorUserId: string,
  orderId: string,
  itemId: string,
  modifierOptionIds: string[],
): Promise<OrderItemResult<OrderItemWithModifiers>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  if (item.status !== 'pending') {
    return { ok: false, error: err(409, 'ITEM_ALREADY_SENT', 'This item has already been sent and can no longer be edited') };
  }
  if (!item.menuItemId) {
    return { ok: false, error: err(422, 'MENU_ITEM_UNAVAILABLE', 'The original menu item for this order item no longer exists') };
  }

  const { settings } = await getVenueAndSettings(venueId);
  const resolved = await resolveModifierSelections(venueId, item.menuItemId, item.destinationSnapshot, modifierOptionIds, settings);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { lines, modifiersTotal } = resolved;

  const lineTotal = item.unitPriceSnapshot.plus(modifiersTotal).times(item.quantity);

  const updated = await scopedPrisma.$transaction(async tx => {
    const updatedItem = await tx.orderItem.update({ where: { id: itemId }, data: { modifiersTotal, lineTotal } });

    await tx.orderItemModifier.deleteMany({ where: { orderItemId: itemId } });
    if (lines.length > 0) {
      await tx.orderItemModifier.createMany({ data: lines.map(line => ({ orderItemId: itemId, ...line })) });
    }

    await tx.orderEvent.create({
      data: {
        venueId,
        orderId,
        orderItemId: itemId,
        eventType: 'item.modifiers_updated',
        actorUserId,
        payload: { modifierOptionIds },
      },
    });

    await recomputeOrder(tx, venueId, orderId);

    const modifiers = await tx.orderItemModifier.findMany({ where: { orderItemId: itemId } });
    return { ...updatedItem, modifiers };
  });

  return { ok: true, value: updated };
}

// Void handling moved to voidService.ts (Phase 2, session 2d-i) — see
// requestVoid/approveVoid/rejectVoid there. The old flat allow-after-send
// gate this function used to enforce no longer exists in the new flow.
