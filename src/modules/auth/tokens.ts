import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { scopedPrisma } from '../../middleware/venueScope';
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_DAYS, jwtSecret } from '../../shared/config';
import type { AccessTokenPayload } from '../../middleware/auth';
import type { UserRole } from '../../generated/prisma/client';

export function signAccessToken(userId: string, venueId: string, role: UserRole): string {
  const payload: AccessTokenPayload = { sub: userId, venue_id: venueId, role, jti: crypto.randomUUID() };
  return jwt.sign(payload, jwtSecret(), { expiresIn: ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url'); // 256-bit opaque token
}

export async function issueRefreshToken(userId: string, deviceLabel: string | null = null) {
  const rawToken = generateRawRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await scopedPrisma.refreshToken.create({ data: { userId, tokenHash, deviceLabel, expiresAt } });
  return { rawToken, expiresAt };
}

export type RefreshResult =
  | { ok: true; userId: string; rawToken: string; expiresAt: Date }
  | { ok: false; reason: 'not_found' | 'expired' | 'reused' };

// Verifies + rotates a refresh token: the presented one is revoked and a new
// row is issued in its place. If the presented token was ALREADY revoked,
// that's reuse of a token that shouldn't exist anymore — most likely a
// stolen/replayed token — so every currently-active refresh token for that
// user ("the entire user's token family") is revoked in response, and the
// caller is expected to 401.
export async function rotateRefreshToken(rawToken: string, deviceLabel?: string | null): Promise<RefreshResult> {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await scopedPrisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) return { ok: false, reason: 'not_found' };

  if (existing.revokedAt) {
    await scopedPrisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: false, reason: 'reused' };
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const issued = await issueRefreshToken(existing.userId, deviceLabel ?? existing.deviceLabel);
  await scopedPrisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });

  return { ok: true, userId: existing.userId, rawToken: issued.rawToken, expiresAt: issued.expiresAt };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  await scopedPrisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
}
