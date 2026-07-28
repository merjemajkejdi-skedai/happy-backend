// Distinct from orders/validation.ts's computeBusinessDate (which governs
// ticket_number resets and knows nothing about business_day_start_hour) and
// from menu/stockService.ts's businessDateFor (a plain calendar-day reset,
// no start-hour offset — kept as-is for stock, out of this session's scope).
// This is the one venue-timezone-and-start-hour-aware business date, used
// for orders.business_date and shifts.business_date going forward.
//
// "A timestamp before the start hour belongs to the previous calendar
// date." A 02:00 order on the 24th with business_day_start_hour=5 has
// business_date 2026-07-23.
export function computeBusinessDate(timestamp: Date, timezone: string, businessDayStartHour: number): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(timestamp);

  const get = (type: string) => parts.find(p => p.type === type)!.value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  let hour = Number(get('hour'));
  // hour12:false formats local midnight as "24" under some ICU builds
  // rather than "00" — normalize before comparing against the start hour.
  if (hour === 24) hour = 0;

  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (hour < businessDayStartHour) {
    return new Date(localDate.getTime() - 24 * 60 * 60 * 1000);
  }
  return localDate;
}

// The inverse of computeBusinessDate: the real UTC instant at which a given
// business date (a plain "YYYY-MM-DD" calendar date, the same shape
// business_date columns store) actually begins in the venue's own timezone
// — i.e. business_day_start_hour local time on that date. Used by
// session 2h-i's report routes to turn a `?from&to` business-date range
// into genuine period.start/period.end instants, per REPORT-PAYLOAD.md's
// example (a business date's window runs from its own start hour through
// one second before the next date's start hour).
//
// Two-pass correction rather than a timezone library: treat the desired
// wall-clock time as if it were UTC (a guess), check what wall-clock time
// that guess actually renders as in the target timezone, and shift by the
// difference. One pass is enough outside a DST transition; a second pass
// makes it exact even when the first guess landed right on one (the
// tz-rendered hour on the corrected guess is re-checked, not assumed).
export function businessDateWindowStart(businessDate: string, timezone: string, businessDayStartHour: number): Date {
  const [year, month, day] = businessDate.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, businessDayStartHour, 0, 0);
  let guess = new Date(desired);

  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(guess);
    const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
    const renderedHour = get('hour') === 24 ? 0 : get('hour');
    const renderedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), renderedHour, get('minute'), get('second'));
    guess = new Date(guess.getTime() + (desired - renderedAsUtc));
  }

  return guess;
}
