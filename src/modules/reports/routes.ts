import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope, scopedPrisma } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as reportService from './reportService';
import { getVenueAndSettings } from './validation';
import { computeBusinessDate, businessDateWindowStart } from '../shifts/businessDate';

export const reportsRouter = Router();
reportsRouter.use(authenticate, venueScope);
reportsRouter.use(requirePermission('reports.view'));

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

reportsRouter.get('/shift/:id', async (req: Request, res: Response) => {
  const result = await reportService.getShiftReport(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

reportsRouter.get('/range', async (req: Request, res: Response) => {
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

reportsRouter.get('/sales', async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, { revenue: report.revenue, orders: report.orders, covers: report.covers });
});

reportsRouter.get('/waiters', async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.waiters);
});

reportsRouter.get('/voids', async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.voids);
});

reportsRouter.get('/items', async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;

  const sortBy = req.query.sort === 'quantity' ? 'quantity' : 'revenue';
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20));
  const sorted = [...report.top_items].sort((a, b) => b[sortBy] - a[sortBy]).slice(0, limit);
  sendData(res, sorted);
});

reportsRouter.get('/payments', async (req: Request, res: Response) => {
  const report = await computeFromRequest(req, res);
  if (!report) return;
  sendData(res, report.payments);
});

reportsRouter.post('/generate', async (req: Request, res: Response) => {
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
