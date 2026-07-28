import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope, scopedPrisma } from '../../middleware/venueScope';
import { requireResolvedPermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as reportService from './reportService';
import { getVenueAndSettings } from './validation';
import { computeBusinessDate, businessDateWindowStart } from '../shifts/businessDate';
import type { ReportPayload } from './reportService';

export const reportsRouter = Router();
reportsRouter.use(authenticate, venueScope);

// reports.view/reports.export are settings-dependent (a manager only holds
// them when restaurant_settings.reports_visible_to_manager is true — see
// resolvePermissions in shared/permissions.ts) — a router-level
// requirePermission() blanket would check only the static role ceiling and
// never actually enforce that setting for a manager. Fixed this session
// (2h-ii) to match the same requireResolvedPermission pattern already used
// for menu.eightysix (also settings-dependent) in menu/itemsRoutes.ts; the
// static gate on this router (and on shifts/routes.ts's three GET routes,
// same underlying bug) was inherited from 2h-i/2g-ii. See
// docs/phase2/SESSION-2h-ii.md.
const viewGate = requireResolvedPermission('reports.view');

interface ResolvedPeriod {
  periodStart: Date;
  periodEnd: Date;
  shiftId?: string;
}

// Shared by every route below except /shift/:id (which is scoped by the
// path param instead). `?shift_id=` narrows exactly to that shift;
// otherwise `?from&to` (business dates, YYYY-MM-DD) — both default to the
// venue's current business date when omitted, so a bare request without
// query params reports on "today."
async function resolvePeriod(req: Request): Promise<ResolvedPeriod | { error: true }> {
  const venueId = req.auth!.venueId;
  const { shift_id, from, to } = req.query as Record<string, string | undefined>;

  if (shift_id) {
    const shift = await scopedPrisma.shift.findFirst({ where: { id: shift_id, venueId } });
    if (!shift) return { error: true };
    return { periodStart: shift.openedAt, periodEnd: shift.closedAt ?? new Date(), shiftId: shift.id };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);
  const today = computeBusinessDate(new Date(), venue.timezone, settings.businessDayStartHour).toISOString().slice(0, 10);
  const fromDate = from ?? today;
  const toDate = to ?? fromDate;

  const periodStart = businessDateWindowStart(fromDate, venue.timezone, settings.businessDayStartHour);
  const nextAfterTo = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const periodEnd = new Date(businessDateWindowStart(nextAfterTo, venue.timezone, settings.businessDayStartHour).getTime() - 1000);

  return { periodStart, periodEnd };
}

async function computeFromRequest(req: Request, res: Response): Promise<reportService.ReportPayload | null> {
  const period = await resolvePeriod(req);
  if ('error' in period) {
    sendError(res, 'NOT_FOUND', 'Shift not found');
    return null;
  }
  return reportService.computeReport(req.auth!.venueId, period.periodStart, period.periodEnd, period.shiftId);
}

reportsRouter.get('/shift/:id', viewGate, async (req: Request, res: Response) => {
  const result = await reportService.getShiftReport(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

reportsRouter.get('/range', viewGate, async (req: Request, res: Response) => {
  const groupBy = req.query.group_by as string | undefined;
  const period = await resolvePeriod(req);
  if ('error' in period) return sendError(res, 'NOT_FOUND', 'Shift not found');

  if (!groupBy) {
    const report = await reportService.computeReport(req.auth!.venueId, period.periodStart, period.periodEnd, period.shiftId);
    return sendData(res, report);
  }

  if (groupBy === 'waiter') {
    const report = await reportService.computeReport(req.auth!.venueId, period.periodStart, period.periodEnd, period.shiftId);
    return sendData(res, report.waiters);
  }

  const { venue, settings } = await getVenueAndSettings(req.auth!.venueId);
  const businessDateStart = computeBusinessDate(period.periodStart, venue.timezone, settings.businessDayStartHour);
  const businessDateEnd = computeBusinessDate(period.periodEnd, venue.timezone, settings.businessDayStartHour);

  if (groupBy === 'day') {
    const days: string[] = [];
    for (let d = businessDateStart.getTime(); d <= businessDateEnd.getTime(); d += 24 * 60 * 60 * 1000) {
      days.push(new Date(d).toISOString().slice(0, 10));
    }
    const reports = await Promise.all(
      days.map(async day => {
        const start = businessDateWindowStart(day, venue.timezone, settings.businessDayStartHour);
        const nextDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const end = new Date(businessDateWindowStart(nextDay, venue.timezone, settings.businessDayStartHour).getTime() - 1000);
        const report = await reportService.computeReport(req.auth!.venueId, start, end);
        return { business_date: day, report };
      }),
    );
    return sendData(res, reports);
  }

  if (groupBy === 'shift') {
    const shifts = await scopedPrisma.shift.findMany({
      where: { venueId: req.auth!.venueId, businessDate: { gte: businessDateStart, lte: businessDateEnd } },
      orderBy: { openedAt: 'asc' },
    });
    const reports = await Promise.all(
      shifts.map(async s => ({
        shift_id: s.id,
        report: await reportService.computeReport(req.auth!.venueId, s.openedAt, s.closedAt ?? new Date(), s.id),
      })),
    );
    return sendData(res, reports);
  }

  return sendError(res, 'VALIDATION_ERROR', "group_by must be one of: day, shift, waiter");
});

reportsRouter.get('/sales', viewGate, async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, { revenue: report.revenue, orders: report.orders, covers: report.covers });
});

reportsRouter.get('/waiters', viewGate, async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.waiters);
});

reportsRouter.get('/voids', viewGate, async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.voids);
});

reportsRouter.get('/items', viewGate, async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;

  const sortBy = req.query.sort === 'quantity' ? 'quantity' : 'revenue';
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const sorted = [...report.top_items].sort((a, b) => b[sortBy] - a[sortBy]).slice(0, limit);
  sendData(res, sorted);
});

reportsRouter.get('/payments', viewGate, async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.payments);
});

reportsRouter.post('/generate', viewGate, async (req: Request, res: Response) => {
  const period = await resolvePeriod(req);
  if ('error' in period) return sendError(res, 'NOT_FOUND', 'Shift not found');

  const { report, shiftReportId } = await reportService.generateReport(
    req.auth!.venueId,
    req.auth!.userId,
    period.periodStart,
    period.periodEnd,
    period.shiftId,
  );
  sendData(res, { shift_report_id: shiftReportId, report });
});

// ── Export (2h-ii) ───────────────────────────────────────────────────────────

const EXPORT_SECTIONS = ['sales', 'waiters', 'voids', 'items', 'payments'] as const;
type ExportSection = (typeof EXPORT_SECTIONS)[number];
const EXPORT_FORMATS = ['csv', 'json'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Every export section is a straight slice of the SAME computeReport payload
// every other /reports/* route already serves — "exports must match the
// on-screen report exactly" (2h-ii.md section 1) is satisfied by construction
// rather than by a second, parallel formatting path. `sales` mirrors GET
// /reports/sales's own composite; `items` deliberately does NOT apply the
// /reports/items route's own ?sort/?limit re-sorting — export has no
// equivalent query params in the spec, so it exports the full, revenue-sorted
// top_items list computeReport already returns.
function sectionData(report: ReportPayload, section: ExportSection): unknown {
  switch (section) {
    case 'sales':
      return { revenue: report.revenue, orders: report.orders, covers: report.covers };
    case 'waiters':
      return report.waiters;
    case 'voids':
      return report.voids;
    case 'items':
      return report.top_items;
    case 'payments':
      return report.payments;
  }
}

// Fixed column order for the two pure-array sections, so an empty result set
// still produces a header row (2h-ii.md section 1's "includes a header row"
// — the array's own keys aren't available to infer from when it's empty).
const ARRAY_SECTION_COLUMNS: Partial<Record<ExportSection, string[]>> = {
  waiters: ['user_id', 'name', 'orders', 'covers', 'gross_sales', 'voids_count', 'voids_value', 'average_order_value', 'tips_total'],
  items: ['menu_item_id', 'name', 'category', 'quantity', 'revenue', 'void_count'],
};

function csvCell(value: unknown, formatNumber: (n: number) => string): string {
  let s: string;
  if (typeof value === 'number') s = formatNumber(value);
  else if (value == null) s = '';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per array element for array-shaped sections (waiters, items); one
// row of the section's own top-level keys for object-shaped sections (sales,
// voids, payments) — nested arrays/objects (e.g. voids.by_reason) are
// JSON-stringified into their own cell rather than inventing a second,
// differently-shaped table, so the whole export stays one well-formed CSV.
function toCsv(section: ExportSection, data: unknown, locale: string): string {
  const formatNumber = (n: number) => new Intl.NumberFormat(locale).format(n);
  const rows: Record<string, unknown>[] = Array.isArray(data) ? data : [data as Record<string, unknown>];
  const columns = rows.length ? Object.keys(rows[0]) : (ARRAY_SECTION_COLUMNS[section] ?? []);
  const lines = rows.map(row => columns.map(c => csvCell(row[c], formatNumber)).join(','));
  return [columns.join(','), ...lines].join('\r\n');
}

reportsRouter.get('/export', requireResolvedPermission('reports.export'), async (req: Request, res: Response) => {
  const section = req.query.section as string | undefined;
  const format = req.query.format as string | undefined;
  if (!section || !EXPORT_SECTIONS.includes(section as ExportSection)) {
    return sendError(res, 'VALIDATION_ERROR', `section must be one of: ${EXPORT_SECTIONS.join(', ')}`);
  }
  if (!format || !EXPORT_FORMATS.includes(format as ExportFormat)) {
    return sendError(res, 'VALIDATION_ERROR', `format must be one of: ${EXPORT_FORMATS.join(', ')}`);
  }

  const period = await resolvePeriod(req);
  if ('error' in period) return sendError(res, 'NOT_FOUND', 'Shift not found');
  const [report, { venue }] = await Promise.all([
    reportService.computeReport(req.auth!.venueId, period.periodStart, period.periodEnd, period.shiftId),
    getVenueAndSettings(req.auth!.venueId),
  ]);
  const data = sectionData(report, section as ExportSection);

  if (format === 'json') return sendData(res, data);

  const from = period.periodStart.toISOString().slice(0, 10);
  const to = period.periodEnd.toISOString().slice(0, 10);
  const csv = toCsv(section as ExportSection, data, venue.locale);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${section}-${from}-${to}.csv"`);
  res.send(csv);
});
