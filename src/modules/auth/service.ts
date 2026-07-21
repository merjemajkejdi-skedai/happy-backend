import bcrypt from 'bcrypt';
import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { pinLookup } from '../../shared/pin';
import { LOGIN_LOCKOUT_THRESHOLD, LOGIN_LOCKOUT_MINUTES } from '../../shared/config';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from './tokens';
import { serializeSettings } from '../../shared/settingsSerializer';
import { serializeUser } from '../../shared/userSerializer';
import { serializeVenue } from '../venue/serializers';
import type { User, Venue, RestaurantSettings } from '../../generated/prisma/client';

export type LoginError =
  | 'venue_not_found'
  | 'wrong_login_method'
  | 'invalid_credentials'
  | 'locked';

export type LoginResult =
  | { ok: true; accessToken: string; refreshToken: string; refreshExpiresAt: Date; user: User; venue: Venue }
  | { ok: false; error: LoginError };

async function resolveVenue(slug: string): Promise<(Venue & { settings: RestaurantSettings | null }) | null> {
  return prisma.venue.findUnique({ where: { slug }, include: { settings: true } });
}

function isLocked(user: User): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

// Shared by both login flows: on failure, bump failed_login_count and lock
// the account once it hits the threshold. On success, clear both and stamp
// last_login_at. This is the only place that mutates that bookkeeping, so
// the two login routes can't drift out of sync with each other.
async function recordLoginOutcome(user: User, succeeded: boolean): Promise<void> {
  if (succeeded) {
    await scopedPrisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    return;
  }

  const failedLoginCount = user.failedLoginCount + 1;
  const lockedUntil =
    failedLoginCount >= LOGIN_LOCKOUT_THRESHOLD
      ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000)
      : user.lockedUntil;

  await scopedPrisma.user.update({ where: { id: user.id }, data: { failedLoginCount, lockedUntil } });
}

async function completeLogin(user: User, venue: Venue): Promise<LoginResult> {
  await recordLoginOutcome(user, true);
  const accessToken = signAccessToken(user.id, venue.id, user.role);
  const { rawToken: refreshToken, expiresAt: refreshExpiresAt } = await issueRefreshToken(user.id);
  return { ok: true, accessToken, refreshToken, refreshExpiresAt, user, venue };
}

export async function loginWithPin(venueSlug: string, pin: string): Promise<LoginResult> {
  const venue = await resolveVenue(venueSlug);
  if (!venue || !venue.settings) return { ok: false, error: 'venue_not_found' };
  if (venue.settings.loginMethod === 'email') return { ok: false, error: 'wrong_login_method' };

  const user = await scopedPrisma.user.findFirst({
    where: { venueId: venue.id, pinLookup: pinLookup(pin), isActive: true, deletedAt: null },
  });
  if (!user) return { ok: false, error: 'invalid_credentials' };
  if (isLocked(user)) return { ok: false, error: 'locked' };

  const valid = user.pinHash ? await bcrypt.compare(pin, user.pinHash) : false;
  if (!valid) {
    await recordLoginOutcome(user, false);
    return { ok: false, error: 'invalid_credentials' };
  }

  return completeLogin(user, venue);
}

export async function loginWithEmail(venueSlug: string, email: string, password: string): Promise<LoginResult> {
  const venue = await resolveVenue(venueSlug);
  if (!venue || !venue.settings) return { ok: false, error: 'venue_not_found' };
  if (venue.settings.loginMethod === 'pin') return { ok: false, error: 'wrong_login_method' };

  const user = await scopedPrisma.user.findFirst({
    where: { venueId: venue.id, email, isActive: true, deletedAt: null },
  });
  if (!user) return { ok: false, error: 'invalid_credentials' };
  if (isLocked(user)) return { ok: false, error: 'locked' };

  const valid = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!valid) {
    await recordLoginOutcome(user, false);
    return { ok: false, error: 'invalid_credentials' };
  }

  return completeLogin(user, venue);
}

export type RefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string; refreshExpiresAt: Date }
  | { ok: false; reason: 'not_found' | 'expired' | 'reused' | 'user_inactive' };

export async function refreshSession(rawRefreshToken: string): Promise<RefreshOutcome> {
  const rotated = await rotateRefreshToken(rawRefreshToken);
  if (!rotated.ok) return { ok: false, reason: rotated.reason };

  // Single-row lookup by primary key — deliberately not filtered by venueId
  // (we don't know it yet at this point), which is exactly the case
  // findUnique is excluded from the venueScope guard for.
  const user = await scopedPrisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user || !user.isActive || user.deletedAt) return { ok: false, reason: 'user_inactive' };

  const accessToken = signAccessToken(user.id, user.venueId, user.role);
  return { ok: true, accessToken, refreshToken: rotated.rawToken, refreshExpiresAt: rotated.expiresAt };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  await revokeRefreshToken(rawRefreshToken);
}

export interface MeResult {
  user: Omit<User, 'passwordHash' | 'pinHash' | 'pinLookup'>;
  venue: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export async function getMe(userId: string, venueId: string): Promise<MeResult | null> {
  const user = await scopedPrisma.user.findFirst({ where: { id: userId, venueId, deletedAt: null } });
  if (!user) return null;

  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  const settings = await prisma.restaurantSettings.findUnique({ where: { venueId } });
  if (!venue || !settings) return null;

  return { user: serializeUser(user), venue: serializeVenue(venue, settings.pmsEnabled), settings: serializeSettings(settings) };
}

export interface VenueConfig {
  name: string;
  venue_type: string;
  login_method: string;
  locale: string;
  currency: string;
}

export async function getVenueConfig(slug: string): Promise<VenueConfig | null> {
  const venue = await prisma.venue.findUnique({ where: { slug }, include: { settings: true } });
  if (!venue || !venue.settings) return null;
  return {
    name: venue.name,
    venue_type: venue.venueType,
    login_method: venue.settings.loginMethod,
    locale: venue.locale,
    currency: venue.currency,
  };
}
