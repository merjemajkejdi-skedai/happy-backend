import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type ShiftDomainError } from './validation';
import { computeBusinessDate } from './businessDate';
import { Prisma, type Shift } from '../../generated/prisma/client';

export type ShiftResult<T> = { ok: true; value: T } | { ok: false; error: ShiftDomainError };

// Scoped to shift creation's own try/catch, so a bare fields[0]==='venue_id'
// check is safe here — no other unique constraint on the shifts table
// involves venue_id alone. Mirrors ordersService.ts's isTableConflict.
function isShiftConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const cause = (e.meta as { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } | undefined)
    ?.driverAdapterError?.cause;
  const fields = cause?.constraint?.fields;
  return Array.isArray(fields) && fields.length === 1 && fields[0] === 'venue_id';
}

// ── Open ─────────────────────────────────────────────────────────────────────

export interface OpenShiftInput {
  name?: string | null;
  openingFloat?: number | string | null;
}

export async function openShift(venueId: string, actorUserId: string, input: OpenShiftInput): Promise<ShiftResult<Shift>> {
  const { venue, settings } = await getVenueAndSettings(venueId);

  const openingFloat = input.openingFloat != null ? new Prisma.Decimal(input.openingFloat) : new Prisma.Decimal(0);
  if (openingFloat.lessThan(0)) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'opening_float must not be negative') };

  const businessDate = computeBusinessDate(new Date(), venue.timezone, settings.businessDayStartHour);

  try {
    const shift = await scopedPrisma.$transaction(async tx => {
      const created = await tx.shift.create({
        data: { venueId, businessDate, name: input.name ?? null, openedByUserId: actorUserId, openingFloat },
      });

      // Sweep in every still-active order not currently attached to an open
      // shift — never attached at all (created while nothing was open), or
      // left pointing at a shift that was force-closed while it was still
      // open. This is a superset of 2g-ii.md section 3's literal "reassigns
      // them to the next shift on open" (which only names the force-close
      // case) — see docs/phase2/SESSION-2g-ii.md for why that's the more
      // complete, still-correct reading.
      const orphaned = await tx.order.findMany({
        where: {
          venueId,
          status: { notIn: ['closed', 'cancelled', 'merged'] },
          OR: [{ shiftId: null }, { shift: { status: 'closed' } }],
        },
      });
      for (const order of orphaned) {
        await tx.order.update({ where: { id: order.id }, data: { shiftId: created.id } });
        await tx.orderEvent.create({
          data: {
            venueId,
            orderId: order.id,
            eventType: 'order.shift_reassigned',
            actorUserId,
            payload: { fromShiftId: order.shiftId, toShiftId: created.id },
          },
        });
      }

      return created;
    });
    return { ok: true, value: shift };
  } catch (e) {
    if (isShiftConflict(e)) return { ok: false, error: err(409, 'SHIFT_ALREADY_OPEN', 'A shift is already open for this venue') };
    throw e;
  }
}

// ── Close ────────────────────────────────────────────────────────────────────

export interface CloseShiftInput {
  closingCashCounted?: number | string | null;
  notes?: string | null;
}

export type CloseShiftResult =
  | { ok: true; value: Shift }
  | { ok: false; error: ShiftDomainError; openOrders?: { id: string; orderNumber: number }[] };

export async function closeShift(venueId: string, actorUserId: string, input: CloseShiftInput, force: boolean): Promise<CloseShiftResult> {
  const shift = await scopedPrisma.shift.findFirst({ where: { venueId, status: 'open' } });
  if (!shift) return { ok: false, error: err(404, 'NOT_FOUND', 'No open shift to close') };

  const openOrders = await scopedPrisma.order.findMany({
    where: { venueId, shiftId: shift.id, status: { notIn: ['closed', 'cancelled', 'merged'] } },
  });
  if (openOrders.length > 0 && !force) {
    return {
      ok: false,
      error: err(409, 'SHIFT_HAS_OPEN_ORDERS', 'This shift has open orders — pass force=true to close it anyway'),
      openOrders: openOrders.map(o => ({ id: o.id, orderNumber: o.orderNumber })),
    };
  }

  const closingCashCounted = input.closingCashCounted != null ? new Prisma.Decimal(input.closingCashCounted) : null;

  const updated = await scopedPrisma.$transaction(async tx => {
    const closedAt = new Date();

    // cash_variance = closing_cash_counted - (opening_float + cash payments
    // in shift). Negative means short — stored as-is, never clamped or
    // suppressed (2g-ii.md section 3's explicit instruction).
    const cashSum = await tx.payment.aggregate({
      where: { venueId, shiftId: shift.id, method: 'cash', isVoided: false },
      _sum: { amount: true },
    });
    const cashInShift = cashSum._sum.amount ?? new Prisma.Decimal(0);
    const expectedCash = shift.openingFloat.plus(cashInShift);
    const cashVariance = closingCashCounted != null ? closingCashCounted.minus(expectedCash) : null;

    const closed = await tx.shift.update({
      where: { id: shift.id },
      data: {
        status: 'closed',
        closedAt,
        closedByUserId: actorUserId,
        closingCashCounted,
        cashVariance,
        notes: input.notes ?? null,
      },
    });

    // 2g-ii.md section 4 — a stub. Session 2h-i fills in the real payload;
    // this just records that a report was generated, for what period, and
    // marks it final.
    await tx.shiftReport.create({
      data: {
        venueId,
        shiftId: closed.id,
        periodStart: shift.openedAt,
        periodEnd: closedAt,
        generatedByUserId: actorUserId,
        payload: { generator: '2g-ii-stub', note: 'Payload populated by session 2h-i' },
        isFinal: true,
      },
    });

    return closed;
  });

  return { ok: true, value: updated };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface CurrentShiftResult {
  shift: Shift | null;
  // shift_auto_close_hours flags a long-running shift — it is never
  // auto-closed (2g-ii.md section 3: "Auto-closing behind a manager's back
  // loses cash reconciliation").
  flagged: boolean;
}

export async function getCurrentShift(venueId: string): Promise<CurrentShiftResult> {
  const { settings } = await getVenueAndSettings(venueId);
  const shift = await scopedPrisma.shift.findFirst({ where: { venueId, status: 'open' } });
  if (!shift) return { shift: null, flagged: false };

  const hoursOpen = (Date.now() - shift.openedAt.getTime()) / (60 * 60 * 1000);
  return { shift, flagged: hoursOpen > settings.shiftAutoCloseHours };
}

export interface ListShiftsParams {
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
}

export async function listShifts(venueId: string, params: ListShiftsParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));

  const where: Prisma.ShiftWhereInput = { venueId };
  if (params.from || params.to) {
    where.businessDate = {};
    if (params.from) where.businessDate.gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) where.businessDate.lte = new Date(`${params.to}T00:00:00.000Z`);
  }

  const [shifts, total] = await Promise.all([
    scopedPrisma.shift.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.shift.count({ where }),
  ]);

  return { shifts, page, perPage, total };
}

export async function getShift(venueId: string, shiftId: string): Promise<Shift | null> {
  return scopedPrisma.shift.findFirst({ where: { id: shiftId, venueId } });
}
