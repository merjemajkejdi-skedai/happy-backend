import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, getVenueAndSettings, type ReportDomainError } from './validation';
import { computeBusinessDate } from '../shifts/businessDate';
import { Prisma, type Order, type Shift } from '../../generated/prisma/client';

export type ReportResult<T> = { ok: true; value: T } | { ok: false; error: ReportDomainError };

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function roundInt(n: number): number {
  return Math.round(n);
}

const SETTLED_VOID_STATUSES = ['approved', 'auto_approved'];

export interface ReportPayload {
  period: { start: string; end: string; business_dates: string[] };
  shift: { id: string; name: string | null; opened_at: string; closed_at: string | null } | null;
  revenue: {
    gross_sales: number;
    voids_value: number;
    net_sales: number;
    tax_total: number;
    service_charge_total: number;
    discount_total: number;
    grand_total: number;
    tips_total: number;
  };
  orders: {
    count: number;
    closed: number;
    cancelled: number;
    merged: number;
    average_value: number;
    table_orders: number;
    counter_orders: number;
  };
  covers: { total: number; average_per_order: number; revenue_per_cover: number };
  waiters: {
    user_id: string;
    name: string;
    orders: number;
    covers: number;
    gross_sales: number;
    voids_count: number;
    voids_value: number;
    average_order_value: number;
    tips_total: number;
  }[];
  voids: {
    count: number;
    value: number;
    before_send: number;
    after_send: number;
    rejected_count: number;
    by_reason: { reason: string; count: number; value: number }[];
    by_user: { user_id: string; name: string; count: number; value: number }[];
  };
  payments: {
    by_method: { method: string; count: number; amount: number }[];
    total_captured: number;
    unsettled_value: number;
    cash_expected: number;
    cash_counted: number | null;
    cash_variance: number | null;
  };
  top_items: { menu_item_id: string; name: string; category: string; quantity: number; revenue: number; void_count: number }[];
  destinations: {
    kitchen: { items: number; avg_prep_seconds: number } | null;
    bar: { items: number; avg_prep_seconds: number } | null;
  };
  courses: { average_fire_to_ready_seconds: Record<string, number> } | null;
}

function coversFor(o: Order): number {
  return o.guestCount ?? 1;
}

// Every underlying table (orders, payments, restaurant_void_log) carries its
// own venue_id + business_date + shift_id columns directly — no join
// required either way. Shift-scoped narrows to shift_id exactly (more
// precise than business_date alone, since two shifts can share one business
// day); otherwise falls back to the business_date range, per section 3's
// "filter by business_date, not created_at."
function scopedWhere(venueId: string, shiftId: string | undefined, businessDateStart: Date, businessDateEnd: Date) {
  return shiftId ? { venueId, shiftId } : { venueId, businessDate: { gte: businessDateStart, lte: businessDateEnd } };
}

// The one report-computation function every route projects from (2h-i.md
// section 2). `periodStart`/`periodEnd` are real instants — for a shift,
// its own opened_at/closed_at; for a range, the venue-timezone-aware window
// boundaries from shifts/businessDate.ts's businessDateWindowStart. An
// optional `shiftId` narrows scope beyond what business_date alone can (two
// shifts sharing one business day) — an explicit, documented extension of
// the spec's literal 3-arg signature; see docs/phase2/SESSION-2h-i.md.
export async function computeReport(
  venueId: string,
  periodStart: Date,
  periodEnd: Date,
  shiftId?: string | null,
): Promise<ReportPayload> {
  const { venue, settings } = await getVenueAndSettings(venueId);

  let shift: Shift | null = null;
  if (shiftId) {
    shift = await scopedPrisma.shift.findFirst({ where: { id: shiftId, venueId } });
  }

  const businessDateStart = computeBusinessDate(periodStart, venue.timezone, settings.businessDayStartHour);
  const businessDateEnd = computeBusinessDate(periodEnd, venue.timezone, settings.businessDayStartHour);
  const where = scopedWhere(venueId, shiftId ?? undefined, businessDateStart, businessDateEnd);

  const [orders, payments, voidLogs, shiftsInScope] = await Promise.all([
    scopedPrisma.order.findMany({ where }),
    scopedPrisma.payment.findMany({ where: { ...where, isVoided: false } }),
    scopedPrisma.restaurantVoidLog.findMany({ where }),
    shiftId
      ? Promise.resolve(shift ? [shift] : [])
      : scopedPrisma.shift.findMany({ where: { venueId, businessDate: { gte: businessDateStart, lte: businessDateEnd } } }),
  ]);

  const orderIds = orders.map(o => o.id);
  const [items, courses] = await Promise.all([
    orderIds.length ? scopedPrisma.orderItem.findMany({ where: { venueId, orderId: { in: orderIds } } }) : Promise.resolve([]),
    orderIds.length && venue.venueType !== 'happy_bar'
      ? scopedPrisma.orderCourse.findMany({ where: { venueId, orderId: { in: orderIds } } })
      : Promise.resolve([]),
  ]);

  // ── orders{} + the revenue exclusion rule ─────────────────────────────────
  // Equal-split children are excluded wholesale from revenue/orders-average
  // figures — the parent's own subtotal/tax/grand_total were never touched
  // by an equal split (see docs/phase2/SESSION-2f-i.md), so counting a
  // child's share ALONGSIDE the parent's full total would double it. by_item
  // /by_seat children stay in — their items genuinely moved, so parent +
  // children sum to the original with no overlap. This is the order-level
  // half of "the synthetic line items must NOT be counted as sales"; the
  // item-level half (menu_item_id IS NULL) is applied separately below for
  // top_items/destinations, which aggregate items directly regardless of
  // which order currently holds them.
  const nonCancelledMerged = orders.filter(o => o.status !== 'cancelled' && o.status !== 'merged');
  const revenueOrders = nonCancelledMerged.filter(o => o.splitType !== 'equal');

  const orderers = {
    count: orders.length,
    closed: orders.filter(o => o.status === 'closed').length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
    merged: orders.filter(o => o.status === 'merged').length,
    average_value: revenueOrders.length ? round2(sum(revenueOrders, o => Number(o.grandTotal)) / revenueOrders.length) : 0,
    table_orders: orders.filter(o => o.serviceMode === 'table').length,
    counter_orders: orders.filter(o => o.serviceMode === 'counter').length,
  };

  // ── voids ──────────────────────────────────────────────────────────────
  const settledVoidLogs = voidLogs.filter(v => SETTLED_VOID_STATUSES.includes(v.status));
  const voidsValueTotal = sum(settledVoidLogs, v => Number(v.voidValue));

  // ── revenue{} ──────────────────────────────────────────────────────────
  const netSales = sum(revenueOrders, o => Number(o.subtotal));
  const taxTotal = sum(revenueOrders, o => Number(o.taxTotal));
  const serviceChargeTotal = sum(revenueOrders, o => Number(o.serviceChargeTotal));
  const discountTotal = sum(revenueOrders, o => Number(o.discountTotal));
  const grandTotalSum = sum(revenueOrders, o => Number(o.grandTotal));
  const tipsTotal = sum(payments, p => Number(p.tipAmount));

  const revenue = {
    gross_sales: round2(netSales + voidsValueTotal),
    voids_value: round2(voidsValueTotal),
    net_sales: round2(netSales),
    tax_total: round2(taxTotal),
    service_charge_total: round2(serviceChargeTotal),
    discount_total: round2(discountTotal),
    grand_total: round2(grandTotalSum),
    tips_total: round2(tipsTotal),
  };

  // ── covers{} ───────────────────────────────────────────────────────────
  const coversTotal = sum(revenueOrders, coversFor);
  const covers = {
    total: coversTotal,
    average_per_order: revenueOrders.length ? round2(coversTotal / revenueOrders.length) : 0,
    revenue_per_cover: coversTotal ? round2(netSales / coversTotal) : 0,
  };

  // ── waiters[] ──────────────────────────────────────────────────────────
  const openerByOrderId = new Map(orders.map(o => [o.id, o.openedByUserId]));
  const waiterIds = [...new Set(revenueOrders.map(o => o.openedByUserId))];
  const waiterUsers = waiterIds.length ? await prisma.user.findMany({ where: { id: { in: waiterIds } } }) : [];
  const waiterNameById = new Map(waiterUsers.map(u => [u.id, u.fullName]));

  const waiters = waiterIds
    .map(uid => {
      const wOrders = revenueOrders.filter(o => o.openedByUserId === uid);
      // Void/tip attribution follows the ORDER's opener, not who requested
      // the void or who took the payment — consistent with "Waiter
      // attribution follows opened_by_user_id" applied uniformly.
      const wVoids = settledVoidLogs.filter(v => openerByOrderId.get(v.orderId) === uid);
      const wPayments = payments.filter(p => openerByOrderId.get(p.orderId) === uid);
      return {
        user_id: uid,
        name: waiterNameById.get(uid) ?? '',
        orders: wOrders.length,
        covers: sum(wOrders, coversFor),
        gross_sales: round2(sum(wOrders, o => Number(o.subtotal))),
        voids_count: wVoids.length,
        voids_value: round2(sum(wVoids, v => Number(v.voidValue))),
        average_order_value: wOrders.length ? round2(sum(wOrders, o => Number(o.grandTotal)) / wOrders.length) : 0,
        tips_total: round2(sum(wPayments, p => Number(p.tipAmount))),
      };
    })
    .sort((a, b) => b.gross_sales - a.gross_sales);

  // ── voids{} ────────────────────────────────────────────────────────────
  const byReasonMap = new Map<string, { count: number; value: number }>();
  const byUserMap = new Map<string, { name: string; count: number; value: number }>();
  for (const v of voidLogs) {
    const reasonKey = v.reasonCode ?? v.reasonText ?? 'unspecified';
    const reasonEntry = byReasonMap.get(reasonKey) ?? { count: 0, value: 0 };
    reasonEntry.count += 1;
    const userEntry = byUserMap.get(v.requestedByUserId) ?? { name: v.requestedByName, count: 0, value: 0 };
    userEntry.count += 1;
    if (SETTLED_VOID_STATUSES.includes(v.status)) {
      reasonEntry.value += Number(v.voidValue);
      userEntry.value += Number(v.voidValue);
    }
    byReasonMap.set(reasonKey, reasonEntry);
    byUserMap.set(v.requestedByUserId, userEntry);
  }

  const voidsSection = {
    count: voidLogs.length,
    value: round2(voidsValueTotal),
    before_send: voidLogs.filter(v => v.stage === 'before_send').length,
    after_send: voidLogs.filter(v => v.stage === 'after_send').length,
    rejected_count: voidLogs.filter(v => v.status === 'rejected').length,
    by_reason: [...byReasonMap.entries()].map(([reason, v]) => ({ reason, count: v.count, value: round2(v.value) })),
    by_user: [...byUserMap.entries()].map(([user_id, v]) => ({ user_id, name: v.name, count: v.count, value: round2(v.value) })),
  };

  // ── payments{} ─────────────────────────────────────────────────────────
  const byMethodMap = new Map<string, { count: number; amount: number }>();
  for (const p of payments) {
    const entry = byMethodMap.get(p.method) ?? { count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += Number(p.amount);
    byMethodMap.set(p.method, entry);
  }
  const totalCaptured = sum(payments, p => Number(p.amount));
  // Unsettled value deliberately covers ALL non-terminal orders, including
  // equal-split children — a child's amount_due is real money still owed on
  // that specific check, not a duplicate of the parent's (the parent's own
  // amount_due already reflects only what IT still needs collected).
  const unsettledValue = sum(nonCancelledMerged, o => Number(o.amountDue));

  const cashPaymentsTotal = sum(payments.filter(p => p.method === 'cash'), p => Number(p.amount));
  const openingFloatSum = sum(shiftsInScope, s => Number(s.openingFloat));
  const closedShiftsInScope = shiftsInScope.filter(s => s.status === 'closed');
  const cashCounted = closedShiftsInScope.length ? sum(closedShiftsInScope, s => Number(s.closingCashCounted ?? 0)) : null;
  const cashVariance = closedShiftsInScope.length ? sum(closedShiftsInScope, s => Number(s.cashVariance ?? 0)) : null;

  const paymentsSection = {
    by_method: [...byMethodMap.entries()].map(([method, v]) => ({ method, count: v.count, amount: round2(v.amount) })),
    total_captured: round2(totalCaptured),
    unsettled_value: round2(unsettledValue),
    cash_expected: round2(openingFloatSum + cashPaymentsTotal),
    cash_counted: cashCounted != null ? round2(cashCounted) : null,
    cash_variance: cashVariance != null ? round2(cashVariance) : null,
  };

  // ── top_items[] ────────────────────────────────────────────────────────
  // menu_item_id IS NULL is exactly the equal-split synthetic item marker
  // (2f-i.md section 3) — the item-level half of the exclusion rule.
  const realItems = items.filter(i => i.menuItemId != null && i.status !== 'cancelled');
  const itemsById = new Map(items.map(i => [i.id, i]));
  const voidCountByMenuItem = new Map<string, number>();
  for (const v of voidLogs) {
    if (!v.orderItemId || !SETTLED_VOID_STATUSES.includes(v.status)) continue;
    const menuItemId = itemsById.get(v.orderItemId)?.menuItemId;
    if (menuItemId) voidCountByMenuItem.set(menuItemId, (voidCountByMenuItem.get(menuItemId) ?? 0) + 1);
  }

  const topItemsMap = new Map<string, { name: string; category: string; quantity: number; revenue: number }>();
  for (const i of realItems) {
    const entry = topItemsMap.get(i.menuItemId!) ?? { name: i.itemNameSnapshot, category: i.categoryNameSnapshot, quantity: 0, revenue: 0 };
    entry.quantity += i.quantity;
    entry.revenue += Number(i.lineTotal);
    topItemsMap.set(i.menuItemId!, entry);
  }
  const topItems = [...topItemsMap.entries()]
    .map(([menu_item_id, v]) => ({
      menu_item_id,
      name: v.name,
      category: v.category,
      quantity: v.quantity,
      revenue: round2(v.revenue),
      void_count: voidCountByMenuItem.get(menu_item_id) ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 100);

  // ── destinations{} ─────────────────────────────────────────────────────
  // Counts every item that reached that destination regardless of a later
  // void — this is a kitchen/bar throughput metric, not a revenue one; the
  // prep work happened even if front-of-house later voided the item.
  function destStats(dest: 'kitchen' | 'bar') {
    const relevant = items.filter(i => i.destinationSnapshot === dest);
    const withTimes = relevant.filter(i => i.sentAt && i.readyAt);
    const avg = withTimes.length ? sum(withTimes, i => (i.readyAt!.getTime() - i.sentAt!.getTime()) / 1000) / withTimes.length : 0;
    return { items: relevant.length, avg_prep_seconds: roundInt(avg) };
  }
  const destinations = {
    kitchen: destStats('kitchen'),
    bar: venue.venueType === 'happy_restaurant' ? null : destStats('bar'),
  };

  // ── courses{} ──────────────────────────────────────────────────────────
  let coursesSection: ReportPayload['courses'] = null;
  if (venue.venueType !== 'happy_bar') {
    const byCourseNumber = new Map<number, number[]>();
    for (const c of courses) {
      if (c.firedAt && c.firstReadyAt) {
        const list = byCourseNumber.get(c.courseNumber) ?? [];
        list.push((c.firstReadyAt.getTime() - c.firedAt.getTime()) / 1000);
        byCourseNumber.set(c.courseNumber, list);
      }
    }
    const avgByCourse: Record<string, number> = {};
    for (const [num, secs] of byCourseNumber) avgByCourse[String(num)] = roundInt(secs.reduce((a, b) => a + b, 0) / secs.length);
    coursesSection = { average_fire_to_ready_seconds: avgByCourse };
  }

  // ── period{} / shift{} ─────────────────────────────────────────────────
  const businessDates: string[] = [];
  for (let d = businessDateStart.getTime(); d <= businessDateEnd.getTime(); d += 24 * 60 * 60 * 1000) {
    businessDates.push(new Date(d).toISOString().slice(0, 10));
  }

  return {
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), business_dates: businessDates },
    shift: shift ? { id: shift.id, name: shift.name, opened_at: shift.openedAt.toISOString(), closed_at: shift.closedAt?.toISOString() ?? null } : null,
    revenue,
    orders: orderers,
    covers,
    waiters,
    voids: voidsSection,
    payments: paymentsSection,
    top_items: topItems,
    destinations,
    courses: coursesSection,
  };
}

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((total, item) => total + fn(item), 0);
}

// ── Materialization ────────────────────────────────────────────────────────

export async function generateReport(
  venueId: string,
  actorUserId: string,
  periodStart: Date,
  periodEnd: Date,
  shiftId?: string | null,
): Promise<{ report: ReportPayload; shiftReportId: string }> {
  const report = await computeReport(venueId, periodStart, periodEnd, shiftId);
  const created = await scopedPrisma.shiftReport.create({
    data: {
      venueId,
      shiftId: shiftId ?? null,
      periodStart,
      periodEnd,
      generatedByUserId: actorUserId,
      payload: report as unknown as Prisma.InputJsonValue,
      isFinal: true,
    },
  });
  return { report, shiftReportId: created.id };
}

// A finalized report is served from the stored payload, never recomputed —
// the numbers must never drift once is_final=true (2h-i.md section 5). An
// open shift with no final report yet gets a live, unstored preview.
export async function getShiftReport(venueId: string, shiftId: string): Promise<ReportResult<ReportPayload>> {
  const shift = await scopedPrisma.shift.findFirst({ where: { id: shiftId, venueId } });
  if (!shift) return { ok: false, error: err(404, 'NOT_FOUND', 'Shift not found') };

  const existing = await scopedPrisma.shiftReport.findFirst({
    where: { venueId, shiftId, isFinal: true },
    orderBy: { generatedAt: 'desc' },
  });
  if (existing) return { ok: true, value: existing.payload as unknown as ReportPayload };

  const report = await computeReport(venueId, shift.openedAt, shift.closedAt ?? new Date(), shiftId);
  return { ok: true, value: report };
}
