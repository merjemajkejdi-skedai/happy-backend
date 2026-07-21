import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { sendDomainError } from '../lib/response';

// Login-only. Keyed by (venue_slug, ip) so one venue's brute-force attempt
// doesn't exhaust the budget for every other venue sharing the same IP
// (e.g. behind a shared NAT), and vice versa. Combined with — not a
// replacement for — the per-user failedLoginCount/lockedUntil lockout in
// modules/auth/service.ts; the two are independent gates on the same routes.
//
// ipKeyGenerator normalizes IPv6 addresses (e.g. collapsing the variable
// host part of an address block) before they go into the key — using
// req.ip raw would let an IPv6 client trivially rotate through addresses
// to dodge the limit, which express-rate-limit v8 refuses to allow silently.
export const loginRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `${req.body?.venue_slug ?? 'unknown'}:${ipKeyGenerator(req.ip ?? '')}`,
  handler: (_req, res) => {
    sendDomainError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many login attempts — try again shortly');
  },
});
