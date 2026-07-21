import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, getVenueAndSettings, type OrderDomainError } from './validation';
import { validateCourseNumber } from '../menu/validation';
import { recomputeOrderTotals } from './ordersService';
import {
  Prisma,
  type OrderItem,
  type OrderItemModifier,
  type ModifierGroup,
  type ModifierOption,
  type OrderStatus,
  type UserRole,
} from '../../generated/prisma/client';
import { roleHasPermission } from '../../shared/permissions';

export type OrderItemResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

function isConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

// An item can only be added/edited while its order is still being built up
// or actively being served — not once it's fully served, closed, or cancelled.
const ITEM_MUTABLE_ORDER_STATUSES: OrderStatus[] = ['draft', 'open', 'sent', 'partially_served'];

export type OrderItemWithModifiers = OrderItem & { modifiers: OrderItemModifier[] };

// ── Modifier selection validation — shared by add and update ────────────────

type ModifierValidation =
  | { ok: true; options: ModifierOption[]; groupsById: Map<string, ModifierGroup> }
  | { ok: false; error: OrderDomainError };

async function validateModifierSelection(venueId: string, menuItemId: string, rawOptionIds: string[]): Promise<ModifierValidation> {
  const selectedOptionIds = [...new Set(rawOptionIds)];

  // MenuItemModifierGroup/ModifierOption carry no direct venue_id column
  // (only reachable via group.venueId) — same pattern as the menu module.
  const links = await prisma.menuItemModifierGroup.findMany({ where: { menuItemId } });
  const attachedGroupIds = links.map(l => l.groupId);
  const groups = attachedGroupIds.length
    ? await scopedPrisma.modifierGroup.findMany({ where: { id: { in: attachedGroupIds }, venueId, deletedAt: null } })
    : [];
  const groupsById = new Map(groups.map(g => [g.id, g]));

  const selectedOptions = selectedOptionIds.length
    ? await prisma.modifierOption.findMany({
        where: { id: { in: selectedOptionIds }, isActive: true, deletedAt: null, group: { venueId, deletedAt: null } },
      })
    : [];
  if (selectedOptions.length !== selectedOptionIds.length) {
    return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', 'One or more selected modifier options are invalid') };
  }

  const selectedByGroup = new Map<string, ModifierOption[]>();
  for (const opt of selectedOptions) {
    if (!groupsById.has(opt.groupId)) {
      return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', 'Selected modifier option does not belong to a group attached to this item') };
    }
    const list = selectedByGroup.get(opt.groupId) ?? [];
    list.push(opt);
    selectedByGroup.set(opt.groupId, list);
  }

  for (const group of groups) {
    const count = (selectedByGroup.get(group.id) ?? []).length;
    if (group.isRequired && count < group.minSelect) {
      return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', `"${group.name}" requires at least ${group.minSelect} selection(s)`) };
    }
    if (count > 0) {
      if (group.type === 'single' && count > 1) {
        return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', `"${group.name}" allows only one selection`) };
      }
      if (group.maxSelect != null && count > group.maxSelect) {
        return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', `"${group.name}" allows at most ${group.maxSelect} selection(s)`) };
      }
      if (count < group.minSelect) {
        return { ok: false, error: err(422, 'MODIFIER_SELECTION_INVALID', `"${group.name}" requires at least ${group.minSelect} selection(s)`) };
      }
    }
  }

  return { ok: true, options: selectedOptions, groupsById };
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
  idempotencyKey?: string,
): Promise<OrderItemResult<OrderItemWithModifiers>> {
  if (idempotencyKey) {
    const existing = await scopedPrisma.orderItem.findFirst({ where: { orderId, venueId, idempotencyKey } });
    if (existing) {
      const modifiers = await prisma.orderItemModifier.findMany({ where: { orderItemId: existing.id } });
      return { ok: true, value: { ...existing, modifiers } };
    }
  }

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

  const { settings } = await getVenueAndSettings(venueId);

  if (input.notes && !settings.allowFreeTextNotes) {
    return { ok: false, error: err(422, 'NOTES_NOT_ALLOWED', 'Free-text notes are not allowed for this venue') };
  }

  const courseNumberSnapshot = input.courseNumber !== undefined ? input.courseNumber : menuItem.courseNumber;
  const courseError = validateCourseNumber(settings.coursesEnabled, courseNumberSnapshot);
  if (courseError) return { ok: false, error: courseError };

  const validated = await validateModifierSelection(venueId, menuItem.id, input.modifierOptionIds ?? []);
  if (!validated.ok) return { ok: false, error: validated.error };
  const { options: selectedOptions, groupsById } = validated;

  const unitPriceSnapshot = menuItem.price;
  const taxRateSnapshot = menuItem.taxRatePercent ?? settings.taxRatePercent;
  const modifiersTotal = selectedOptions.reduce((sum, o) => sum.plus(o.priceDelta), new Prisma.Decimal(0));
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
          taxRateSnapshot,
          quantity,
          modifiersTotal,
          lineTotal,
          status: 'pending',
          notes: input.notes ?? null,
          addedByUserId: actorUserId,
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      if (selectedOptions.length > 0) {
        await tx.orderItemModifier.createMany({
          data: selectedOptions.map(o => ({
            orderItemId: created.id,
            modifierOptionId: o.id,
            groupNameSnapshot: groupsById.get(o.groupId)!.name,
            optionNameSnapshot: o.name,
            priceDeltaSnapshot: o.priceDelta,
          })),
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

      // TODO(prompt-8): once the shared "send to kitchen/bar" service
      // exists, auto_send_on_add should call it here — it should also flip
      // order.status to 'sent', set first_sent_at, and emit the proper send
      // audit event. For now this only flips the item's own status so the
      // flag is functional rather than silently ignored; replace this block
      // with a call into that service once it lands.
      let finalItem = created;
      if (settings.autoSendOnAdd) {
        finalItem = await tx.orderItem.update({ where: { id: created.id }, data: { status: 'sent', sentAt: new Date() } });
      }

      await recomputeOrderTotals(tx, venueId, orderId);

      const modifiers = await tx.orderItemModifier.findMany({ where: { orderItemId: created.id } });
      return { ...finalItem, modifiers };
    });
    return { ok: true, value: result };
  } catch (e) {
    if (isConflict(e) && idempotencyKey) {
      const existing = await scopedPrisma.orderItem.findFirst({ where: { orderId, venueId, idempotencyKey } });
      if (existing) {
        const modifiers = await prisma.orderItemModifier.findMany({ where: { orderItemId: existing.id } });
        return { ok: true, value: { ...existing, modifiers } };
      }
    }
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

  let selectedOptions: ModifierOption[] | undefined;
  let groupsById: Map<string, ModifierGroup> | undefined;
  if (input.modifierOptionIds !== undefined) {
    if (!item.menuItemId) {
      return { ok: false, error: err(422, 'MENU_ITEM_UNAVAILABLE', 'The original menu item for this order item no longer exists') };
    }
    const validated = await validateModifierSelection(venueId, item.menuItemId, input.modifierOptionIds);
    if (!validated.ok) return { ok: false, error: validated.error };
    selectedOptions = validated.options;
    groupsById = validated.groupsById;
  }

  // Snapshot immutability: unit_price_snapshot/tax_rate_snapshot never
  // change here — only quantity and modifier selection can move line_total.
  const modifiersTotal = selectedOptions
    ? selectedOptions.reduce((sum, o) => sum.plus(o.priceDelta), new Prisma.Decimal(0))
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

    if (selectedOptions) {
      await tx.orderItemModifier.deleteMany({ where: { orderItemId: itemId } });
      if (selectedOptions.length > 0) {
        await tx.orderItemModifier.createMany({
          data: selectedOptions.map(o => ({
            orderItemId: itemId,
            modifierOptionId: o.id,
            groupNameSnapshot: groupsById!.get(o.groupId)!.name,
            optionNameSnapshot: o.name,
            priceDeltaSnapshot: o.priceDelta,
          })),
        });
      }
    }

    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: itemId, eventType: 'item.updated', actorUserId, payload: { before, after } },
    });

    await recomputeOrderTotals(tx, venueId, orderId);

    const modifiers = await tx.orderItemModifier.findMany({ where: { orderItemId: itemId } });
    return { ...updatedItem, modifiers };
  });

  return { ok: true, value: updated };
}

// ── Void ─────────────────────────────────────────────────────────────────────

export interface VoidItemInput {
  reason?: string | null;
}

export async function voidItem(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  orderId: string,
  itemId: string,
  input: VoidItemInput,
): Promise<OrderItemResult<null>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  if (item.status === 'cancelled') {
    return { ok: false, error: err(409, 'ITEM_ALREADY_CANCELLED', 'This item has already been voided') };
  }

  const { settings } = await getVenueAndSettings(venueId);

  if (item.status !== 'pending') {
    if (!settings.allowItemVoidAfterSend || !roleHasPermission(actorRole, 'order.void_after_send')) {
      return { ok: false, error: err(403, 'VOID_AFTER_SEND_NOT_ALLOWED', 'Voiding an item after it has been sent is not allowed') };
    }
  }

  if (settings.requireReasonOnVoid && !input.reason?.trim()) {
    return { ok: false, error: err(422, 'VOID_REASON_REQUIRED', 'A reason is required to void this item') };
  }

  await scopedPrisma.$transaction(async tx => {
    await tx.orderItem.update({
      where: { id: itemId },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: input.reason ?? null, voidByUserId: actorUserId },
    });

    await tx.orderEvent.create({
      data: {
        venueId,
        orderId,
        orderItemId: itemId,
        eventType: 'item.voided',
        actorUserId,
        payload: { reason: input.reason ?? null, previousStatus: item.status },
      },
    });

    await recomputeOrderTotals(tx, venueId, orderId);
  });

  return { ok: true, value: null };
}
