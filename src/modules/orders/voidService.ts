import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { computeDisplayLabel } from '../tables/service';
import { err, getVenueAndSettings, computeBusinessDate, type OrderDomainError } from './validation';
import { recomputeOrder } from './ordersService';
import { resolveVoidPolicy } from './voidPolicy';
import { Prisma, type RestaurantVoidLog, type UserRole } from '../../generated/prisma/client';

export type VoidResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

export interface RequestVoidInput {
  reasonCode?: string | null;
  reasonText?: string | null;
}

// ── Request (or immediately execute) a void ─────────────────────────────────
//
// Single entry point for both the new POST .../items/:itemId/void route and
// the legacy DELETE .../items/:itemId route — see 2d-i.md: "This replaces
// the Phase 1 void behavior... Keep that route working; route it through the
// new flow." Phase 1's allow_item_void_after_send flag is no longer
// consulted here — every outcome in the new decision tree (section 4) is
// either an immediate cancel or a queued approval request, never a flat
// rejection, so there is nothing left for that flag to gate.
export async function requestVoid(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  orderId: string,
  itemId: string,
  input: RequestVoidInput,
): Promise<VoidResult<{ pending: boolean; voidLog: RestaurantVoidLog }>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  if (item.status === 'cancelled') {
    return { ok: false, error: err(409, 'ITEM_ALREADY_CANCELLED', 'This item has already been voided') };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);

  const reasonCode = input.reasonCode?.trim() || null;
  const reasonText = input.reasonText?.trim() || null;
  // "needs reason_code (from void_reason_preset_list) or reason_text" — the
  // preset list is treated as what the client uses to populate a picker, not
  // a server-enforced whitelist; the server only checks that *some* reason
  // was actually supplied when one is required. See docs/phase2/SESSION-2d-i.md.
  if (settings.voidReasonRequired && !reasonCode && !reasonText) {
    return { ok: false, error: err(422, 'VOID_REASON_REQUIRED', 'A reason is required to void this item') };
  }

  const alreadyPending = await scopedPrisma.restaurantVoidLog.findFirst({
    where: { venueId, orderItemId: itemId, status: 'pending_approval' },
  });
  if (alreadyPending) {
    return { ok: false, error: err(409, 'VOID_ALREADY_PENDING', 'A void request for this item is already pending approval') };
  }

  const policy = resolveVoidPolicy(item, actorRole, settings);

  const [requestedByUser, table] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorUserId } }),
    order.tableId ? scopedPrisma.restaurantTable.findFirst({ where: { id: order.tableId, venueId } }) : Promise.resolve(null),
  ]);
  if (!requestedByUser) throw new Error(`user ${actorUserId} missing`);

  const requestedByName = requestedByUser.fullName;
  const businessDate = computeBusinessDate(venue.timezone, settings.ticketNumberReset);
  const voidValue = item.unitPriceSnapshot.plus(item.modifiersTotal).times(item.quantity);
  const tableLabelSnapshot = table ? computeDisplayLabel(settings.tableNamingMode, table.tableNumber, table.tableName) : null;

  const willAutoApprove = !policy.requiresApproval || policy.autoApprove;

  const result = await scopedPrisma.$transaction(async tx => {
    const voidLog = await tx.restaurantVoidLog.create({
      data: {
        venueId,
        businessDate,
        shiftId: order.shiftId,
        orderId,
        orderNumber: order.orderNumber,
        orderItemId: itemId,
        itemNameSnapshot: item.itemNameSnapshot,
        categoryNameSnapshot: item.categoryNameSnapshot,
        quantity: item.quantity,
        unitPriceSnapshot: item.unitPriceSnapshot,
        voidValue,
        destinationSnapshot: item.destinationSnapshot,
        stage: policy.stage,
        status: willAutoApprove ? 'auto_approved' : 'pending_approval',
        reasonCode,
        reasonText,
        requestedByUserId: actorUserId,
        requestedByName,
        tableLabelSnapshot,
        ...(willAutoApprove
          ? { approvedByUserId: actorUserId, approvedByName: requestedByName, resolvedAt: new Date() }
          : {}),
      },
    });

    if (!willAutoApprove) {
      await tx.approvalRequest.create({
        data: {
          venueId,
          requestType: 'void',
          subjectId: voidLog.id,
          orderId,
          status: 'pending_approval',
          requestedByUserId: actorUserId,
          requiredRole: settings.voidApprovalRole,
        },
      });
      await tx.orderEvent.create({
        data: { venueId, orderId, orderItemId: itemId, eventType: 'item.void_requested', actorUserId, payload: { voidLogId: voidLog.id, stage: policy.stage } },
      });
      return { pending: true, voidLog };
    }

    await tx.orderItem.update({
      where: { id: itemId },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reasonText ?? reasonCode, voidByUserId: actorUserId, voidId: voidLog.id },
    });
    // TODO(2e): restore reserved/available stock for menuItemId via a
    // stock_movements row once stock tracking lands.
    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: itemId, eventType: 'item.voided', actorUserId, payload: { voidLogId: voidLog.id, reason: reasonText ?? reasonCode } },
    });
    await recomputeOrder(tx, venueId, orderId);

    return { pending: false, voidLog };
  });

  return { ok: true, value: result };
}

// ── Approve ──────────────────────────────────────────────────────────────────

export async function approveVoid(venueId: string, actorUserId: string, voidLogId: string): Promise<VoidResult<RestaurantVoidLog>> {
  const voidLog = await scopedPrisma.restaurantVoidLog.findFirst({ where: { id: voidLogId, venueId } });
  if (!voidLog) return { ok: false, error: err(404, 'NOT_FOUND', 'Void request not found') };
  if (voidLog.status !== 'pending_approval') {
    return { ok: false, error: err(409, 'VOID_ALREADY_RESOLVED', `This void request has already been resolved (status '${voidLog.status}')`) };
  }

  const approver = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!approver) throw new Error(`user ${actorUserId} missing`);

  const updated = await scopedPrisma.$transaction(async tx => {
    const now = new Date();
    if (voidLog.orderItemId) {
      const item = await tx.orderItem.findFirst({ where: { id: voidLog.orderItemId, venueId } });
      if (item && item.status !== 'cancelled') {
        await tx.orderItem.update({
          where: { id: voidLog.orderItemId },
          data: { status: 'cancelled', cancelledAt: now, cancelReason: voidLog.reasonText ?? voidLog.reasonCode, voidByUserId: actorUserId, voidId: voidLog.id },
        });
        // TODO(2e): restore stock, same as the auto-approved path above.
        await tx.orderEvent.create({
          data: { venueId, orderId: voidLog.orderId, orderItemId: voidLog.orderItemId, eventType: 'item.voided', actorUserId, payload: { voidLogId: voidLog.id } },
        });
        await recomputeOrder(tx, venueId, voidLog.orderId);
      }
    }

    const resolvedLog = await tx.restaurantVoidLog.update({
      where: { id: voidLogId },
      data: { status: 'approved', approvedByUserId: actorUserId, approvedByName: approver.fullName, resolvedAt: now },
    });

    await tx.approvalRequest.updateMany({
      where: { venueId, requestType: 'void', subjectId: voidLogId, status: 'pending_approval' },
      data: { status: 'approved', resolvedByUserId: actorUserId, resolvedAt: now },
    });

    return resolvedLog;
  });

  return { ok: true, value: updated };
}

// ── Reject ───────────────────────────────────────────────────────────────────

export async function rejectVoid(
  venueId: string,
  actorUserId: string,
  voidLogId: string,
  rejectionReason: string | undefined,
): Promise<VoidResult<RestaurantVoidLog>> {
  const voidLog = await scopedPrisma.restaurantVoidLog.findFirst({ where: { id: voidLogId, venueId } });
  if (!voidLog) return { ok: false, error: err(404, 'NOT_FOUND', 'Void request not found') };
  if (voidLog.status !== 'pending_approval') {
    return { ok: false, error: err(409, 'VOID_ALREADY_RESOLVED', `This void request has already been resolved (status '${voidLog.status}')`) };
  }

  const rejecter = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!rejecter) throw new Error(`user ${actorUserId} missing`);

  const updated = await scopedPrisma.$transaction(async tx => {
    const now = new Date();
    // The item is never touched on rejection — it stays exactly as it was;
    // "approved_by" is reused here as "resolved by" (the schema has no
    // separate rejected-by pair) since who acted on a rejected request is
    // just as reportable as who approved one.
    const resolvedLog = await tx.restaurantVoidLog.update({
      where: { id: voidLogId },
      data: { status: 'rejected', approvedByUserId: actorUserId, approvedByName: rejecter.fullName, resolvedAt: now, rejectionReason: rejectionReason ?? null },
    });

    await tx.approvalRequest.updateMany({
      where: { venueId, requestType: 'void', subjectId: voidLogId, status: 'pending_approval' },
      data: { status: 'rejected', resolvedByUserId: actorUserId, resolvedAt: now },
    });

    if (voidLog.orderItemId) {
      await tx.orderEvent.create({
        data: { venueId, orderId: voidLog.orderId, orderItemId: voidLog.orderItemId, eventType: 'item.void_rejected', actorUserId, payload: { voidLogId, rejectionReason: rejectionReason ?? null } },
      });
    }

    return resolvedLog;
  });

  return { ok: true, value: updated };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listPendingVoids(venueId: string, page: number, perPage: number) {
  const where = { venueId, status: 'pending_approval' as const };
  const [logs, total] = await Promise.all([
    scopedPrisma.restaurantVoidLog.findMany({ where, orderBy: { requestedAt: 'asc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.restaurantVoidLog.count({ where }),
  ]);
  return { logs, page, perPage, total };
}

export interface ListVoidsParams {
  from?: string; // YYYY-MM-DD, business_date
  to?: string;
  status?: string;
  userId?: string;
  page: number;
  perPage: number;
}

export async function listVoids(venueId: string, params: ListVoidsParams) {
  const where: Prisma.RestaurantVoidLogWhereInput = { venueId };
  if (params.from || params.to) {
    where.businessDate = {};
    if (params.from) where.businessDate.gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) where.businessDate.lte = new Date(`${params.to}T00:00:00.000Z`);
  }
  if (params.status) where.status = params.status as RestaurantVoidLog['status'];
  if (params.userId) where.requestedByUserId = params.userId;

  const [logs, total] = await Promise.all([
    scopedPrisma.restaurantVoidLog.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: (params.page - 1) * params.perPage, take: params.perPage }),
    scopedPrisma.restaurantVoidLog.count({ where }),
  ]);
  return { logs, page: params.page, perPage: params.perPage, total };
}

export async function getVoid(venueId: string, voidLogId: string): Promise<RestaurantVoidLog | null> {
  return scopedPrisma.restaurantVoidLog.findFirst({ where: { id: voidLogId, venueId } });
}

// ── Order close guard ────────────────────────────────────────────────────────

export async function hasPendingVoid(venueId: string, orderId: string): Promise<boolean> {
  const pending = await scopedPrisma.restaurantVoidLog.findFirst({ where: { venueId, orderId, status: 'pending_approval' } });
  return !!pending;
}
