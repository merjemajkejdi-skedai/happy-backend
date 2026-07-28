import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { recomputeOrder } from './ordersService';
import { deriveCourseStatus } from './statusMachine';
import { transferOrder } from './lifecycleService';
import type { Order, OrderCourse, RestaurantSettings, UserRole, Venue } from '../../generated/prisma/client';

export type MergeResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

const ORDER_NOT_MODIFIABLE = (status: string) => err(409, 'ORDER_NOT_MODIFIABLE', `Cannot modify an order with status '${status}'`);

// 'merged' is included alongside the two Phase 1 terminal statuses — an
// already-merged order (itself once a target) is just as unavailable as a
// closed/cancelled one.
const TERMINAL_STATUSES = ['closed', 'cancelled', 'merged'] as const;

interface MergeGateResult {
  target: Order;
  source: Order;
  venue: Venue;
  settings: RestaurantSettings;
}

// Section 2's gate list, in order. order.merge_approve (declared in the
// static permission matrix since 2a-ii) is never checked directly here —
// resolvePermissions() already narrows waiter's own order.merge away
// entirely when merge_requires_manager is true (see permissions.ts's
// 'order.merge' case), so requirePermission('order.merge') at the route
// layer already produces the exact same 403 for that case. This defensive
// re-check exists only so a test calling mergeOrders directly (bypassing
// HTTP + RBAC, this codebase's own established test pattern) still gets it.
async function checkMergeGate(
  venueId: string,
  actorRole: UserRole,
  targetOrderId: string,
  sourceOrderId: string,
): Promise<MergeResult<MergeGateResult>> {
  if (targetOrderId === sourceOrderId) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'source_order_id must differ from the target order') };
  }

  const [target, source] = await Promise.all([
    scopedPrisma.order.findFirst({ where: { id: targetOrderId, venueId } }),
    scopedPrisma.order.findFirst({ where: { id: sourceOrderId, venueId } }),
  ]);
  if (!target) return { ok: false, error: err(404, 'NOT_FOUND', 'Target order not found') };
  if (!source) return { ok: false, error: err(404, 'NOT_FOUND', 'Source order not found') };

  const { venue, settings } = await getVenueAndSettings(venueId);
  if (!settings.mergeTablesEnabled) {
    return { ok: false, error: err(403, 'MERGE_DISABLED', 'Table merge is not enabled for this venue') };
  }
  if (actorRole === 'waiter' && settings.mergeRequiresManager) {
    return { ok: false, error: err(403, 'MERGE_REQUIRES_MANAGER', 'Merging orders requires manager approval at this venue') };
  }

  for (const order of [target, source]) {
    if ((TERMINAL_STATUSES as readonly string[]).includes(order.status)) {
      return { ok: false, error: ORDER_NOT_MODIFIABLE(order.status) };
    }
    if (order.amountPaid.greaterThan(0)) {
      return { ok: false, error: err(409, 'ORDER_ALREADY_PAID', 'This order has already been paid, at least partially, and cannot be merged') };
    }
    if (order.parentOrderId) {
      return { ok: false, error: err(409, 'MERGE_ORDER_HAS_SPLIT', 'A split-bill child order cannot be merged') };
    }
    const liveChildren = await scopedPrisma.order.count({
      where: { venueId, parentOrderId: order.id, status: { notIn: [...TERMINAL_STATUSES] } },
    });
    if (liveChildren > 0) {
      return { ok: false, error: err(409, 'MERGE_ORDER_HAS_SPLIT', 'An order with live split-bill children cannot be merged until they are resolved') };
    }
  }

  return { ok: true, value: { target, source, venue, settings } };
}

async function validateTargetTableTransfer(venueId: string, target: Order, settings: RestaurantSettings, targetTableId: string): Promise<MergeResult<null>> {
  if (!settings.allowTableTransfer) return { ok: false, error: err(403, 'TRANSFER_DISABLED', 'Table transfer is not allowed for this venue') };
  const targetTable = await scopedPrisma.restaurantTable.findFirst({ where: { id: targetTableId, venueId, deletedAt: null } });
  if (!targetTable) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };
  if (!targetTable.isActive) return { ok: false, error: err(422, 'TABLE_INACTIVE', 'This table is inactive') };
  const conflict = await scopedPrisma.order.findFirst({
    where: {
      venueId,
      tableId: targetTableId,
      id: { not: target.id },
      parentOrderId: null,
      status: { in: ['draft', 'open', 'sent', 'partially_served', 'served'] },
    },
  });
  if (conflict) return { ok: false, error: err(409, 'TABLE_ALREADY_HAS_ACTIVE_ORDER', 'This table already has an active order') };
  return { ok: true, value: null };
}

function earlierDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

interface MergeOutcome {
  target: Order;
  source: Order;
  courses: OrderCourse[];
  itemCount: number;
}

// The one place both mergeOrders and previewMerge run the actual move +
// recompute + course-reconciliation logic — previewMerge runs this same
// function inside a transaction it always rolls back (see PreviewRollback
// below), which is what guarantees preview and commit report identical
// numbers rather than two hand-maintained formulas drifting apart.
async function runMergeTransaction(tx: Tx, venueId: string, actorUserId: string, target: Order, source: Order): Promise<MergeOutcome> {
  const [sourceCourses, targetCoursesBefore] = await Promise.all([
    tx.orderCourse.findMany({ where: { orderId: source.id, venueId } }),
    tx.orderCourse.findMany({ where: { orderId: target.id, venueId } }),
  ]);

  // "All non-cancelled source items reassign to the target, preserving
  // status, timestamps, and every snapshot." A single updateMany touching
  // only order_id — nothing else about these rows changes.
  await tx.orderItem.updateMany({
    where: { orderId: source.id, venueId, status: { not: 'cancelled' } },
    data: { orderId: target.id },
  });

  const now = new Date();
  const updatedSource = await recomputeOrder(tx, venueId, source.id, {
    explicitFlag: 'merged',
    extraData: { mergedIntoOrderId: target.id, mergedAt: now, mergedByUserId: actorUserId },
  });
  // Rolls up target's totals from its now-combined item set and lazily
  // creates/updates whatever order_courses rows those items' course_number
  // values need — "create rows... recompute item_count" from section 3 is
  // handled entirely by this one call, for both sides.
  const updatedTarget = await recomputeOrder(tx, venueId, target.id);

  // "take the earlier fired_at when both sides fired the same course" — the
  // one piece recomputeOrder's generic roll-up can't do on its own, since it
  // has no notion of "this row's predecessor came from a different order."
  // Only source courses that were actually fired are worth reconciling: an
  // unfired source course leaves nothing on the target to regress.
  for (const sc of sourceCourses) {
    if (!sc.firedAt) continue;

    const targetRowAfter = await tx.orderCourse.findUnique({
      where: { orderId_courseNumber: { orderId: target.id, courseNumber: sc.courseNumber } },
    });
    // No target row exists for this course number even after the move —
    // every item that was ever in it on the source was cancelled before the
    // merge, so there's nothing left to carry a fired history for.
    if (!targetRowAfter) continue;

    const tcBefore = targetCoursesBefore.find(c => c.courseNumber === sc.courseNumber);
    const targetFiredEarlier = tcBefore?.firedAt != null && tcBefore.firedAt < sc.firedAt;
    const finalFiredAt = targetFiredEarlier ? tcBefore!.firedAt : sc.firedAt;
    const finalFiredBy = targetFiredEarlier ? tcBefore!.firedByUserId : sc.firedByUserId;

    const currentItems = await tx.orderItem.findMany({
      where: { orderId: target.id, venueId, courseNumber: sc.courseNumber, status: { not: 'cancelled' } },
    });
    const status = deriveCourseStatus('fired', currentItems);
    const firstReadyAt =
      earlierDate(sc.firstReadyAt, tcBefore?.firstReadyAt ?? null) ??
      (currentItems.some(i => i.status === 'ready' || i.status === 'served') ? now : null);
    const allServedAt =
      earlierDate(sc.allServedAt, tcBefore?.allServedAt ?? null) ??
      (currentItems.length > 0 && currentItems.every(i => i.status === 'served') ? now : null);

    await tx.orderCourse.update({
      where: { id: targetRowAfter.id },
      data: { firedAt: finalFiredAt, firedByUserId: finalFiredBy, status, firstReadyAt, allServedAt },
    });
  }

  if (source.tableId) {
    await tx.restaurantTable.update({ where: { id: source.tableId }, data: { status: 'dirty' } });
  }

  await tx.orderEvent.create({
    data: {
      venueId,
      orderId: target.id,
      eventType: 'order.merged',
      actorUserId,
      payload: { sourceOrderId: source.id, sourceOrderNumber: source.orderNumber },
    },
  });
  await tx.orderEvent.create({
    data: {
      venueId,
      orderId: source.id,
      eventType: 'order.absorbed',
      actorUserId,
      payload: { targetOrderId: target.id, targetOrderNumber: target.orderNumber },
    },
  });

  const [finalCourses, itemCount] = await Promise.all([
    tx.orderCourse.findMany({ where: { orderId: target.id, venueId }, orderBy: { courseNumber: 'asc' } }),
    tx.orderItem.count({ where: { orderId: target.id, venueId, status: { not: 'cancelled' } } }),
  ]);

  return { target: updatedTarget, source: updatedSource, courses: finalCourses, itemCount };
}

// ── Commit ───────────────────────────────────────────────────────────────────

export async function mergeOrders(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  targetOrderId: string,
  sourceOrderId: string,
  targetTableId?: string | null,
): Promise<MergeResult<{ target: Order; source: Order }>> {
  const gate = await checkMergeGate(venueId, actorRole, targetOrderId, sourceOrderId);
  if (!gate.ok) return gate;
  let { target } = gate.value;
  const { source } = gate.value;

  // "Target table unchanged unless target_table_id is given, in which case
  // transfer the target first" — a real, separately-committed operation
  // (transferOrder runs its own transaction/event), not folded into the
  // merge transaction below.
  if (targetTableId && targetTableId !== target.tableId) {
    const transferred = await transferOrder(venueId, actorUserId, target.id, targetTableId);
    if (!transferred.ok) return transferred;
    target = transferred.value;
  }

  const outcome = await scopedPrisma.$transaction(tx => runMergeTransaction(tx, venueId, actorUserId, target, source));
  return { ok: true, value: { target: outcome.target, source: outcome.source } };
}

// ── Preview ──────────────────────────────────────────────────────────────────

export interface MergePreview {
  targetOrderId: string;
  sourceOrderId: string;
  itemCount: number;
  grandTotal: string;
  courses: { courseNumber: number; itemCount: number; status: string; firedAt: Date | null }[];
}

// Sentinel thrown to unwind an always-rolled-back transaction — see
// PreviewRollback's use below. Never escapes previewMerge.
class PreviewRollback extends Error {
  constructor(public outcome: MergeOutcome) {
    super('preview rollback — internal control flow only, never surfaced');
  }
}

export async function previewMerge(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  targetOrderId: string,
  sourceOrderId: string,
  targetTableId?: string | null,
): Promise<MergeResult<MergePreview>> {
  const gate = await checkMergeGate(venueId, actorRole, targetOrderId, sourceOrderId);
  if (!gate.ok) return gate;
  const { target, source, settings } = gate.value;

  if (targetTableId && targetTableId !== target.tableId) {
    const transferCheck = await validateTargetTableTransfer(venueId, target, settings, targetTableId);
    if (!transferCheck.ok) return transferCheck;
  }

  let outcome: MergeOutcome;
  try {
    await scopedPrisma.$transaction(async tx => {
      const result = await runMergeTransaction(tx, venueId, actorUserId, target, source);
      throw new PreviewRollback(result);
    });
    /* istanbul ignore next -- runMergeTransaction always throws PreviewRollback above */
    throw new Error('unreachable');
  } catch (e) {
    if (!(e instanceof PreviewRollback)) throw e;
    outcome = e.outcome;
  }

  return {
    ok: true,
    value: {
      targetOrderId: target.id,
      sourceOrderId: source.id,
      itemCount: outcome.itemCount,
      grandTotal: outcome.target.grandTotal.toString(),
      courses: outcome.courses.map(c => ({ courseNumber: c.courseNumber, itemCount: c.itemCount, status: c.status, firedAt: c.firedAt })),
    },
  };
}
