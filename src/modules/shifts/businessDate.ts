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
