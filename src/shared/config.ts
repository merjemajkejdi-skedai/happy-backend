// Central config for auth token lifetimes and lockout policy — env-overridable,
// sane defaults for dev. Nothing here should be hardcoded again at a call site.

export const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
export const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);

export const LOGIN_LOCKOUT_THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD || 5);
export const LOGIN_LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export function pinPepper(): string {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper) throw new Error('PIN_PEPPER is not set');
  return pepper;
}
