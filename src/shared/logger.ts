// Minimal structured logger — Phase 1 doesn't need a logging library, just
// consistent, greppable/parseable output. One JSON line per event.
//
// Settings changes are the first consumer (they explicitly are NOT
// order_events — that table is for order state, not venue configuration) but
// this is meant to be reused anywhere else that needs a structured audit
// trail without a dedicated table.
export interface LogEvent {
  event: string;
  venueId?: string;
  actorUserId?: string;
  [key: string]: unknown;
}

function write(level: 'info' | 'warn' | 'error', entry: LogEvent) {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), ...entry });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (entry: LogEvent) => write('info', entry),
  warn: (entry: LogEvent) => write('warn', entry),
  error: (entry: LogEvent) => write('error', entry),
};
