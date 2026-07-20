import { Router, Request, Response } from 'express';
import { sendData, sendError } from '../../lib/response';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import * as authService from './service';

export const authRouter = Router();

function userView(user: { id: string; fullName: string; email: string | null; role: string; venueId: string }) {
  return { id: user.id, fullName: user.fullName, email: user.email, role: user.role, venueId: user.venueId };
}

// POST /login/pin — { venue_slug, pin }
authRouter.post('/login/pin', async (req: Request, res: Response) => {
  const { venue_slug, pin } = req.body ?? {};
  if (!venue_slug?.trim() || !pin?.trim()) return sendError(res, 'VALIDATION_ERROR', 'venue_slug and pin are required');

  const result = await authService.loginWithPin(String(venue_slug).trim(), String(pin));
  if (!result.ok) return sendLoginError(res, result.error);

  sendData(res, {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    refresh_expires_at: result.refreshExpiresAt,
    user: userView(result.user),
    venue: { id: result.venue.id, slug: result.venue.slug, name: result.venue.name, venueType: result.venue.venueType },
  });
});

// POST /login/email — { venue_slug, email, password }
authRouter.post('/login/email', async (req: Request, res: Response) => {
  const { venue_slug, email, password } = req.body ?? {};
  if (!venue_slug?.trim() || !email?.trim() || !password) {
    return sendError(res, 'VALIDATION_ERROR', 'venue_slug, email and password are required');
  }

  const result = await authService.loginWithEmail(String(venue_slug).trim(), String(email).trim(), String(password));
  if (!result.ok) return sendLoginError(res, result.error);

  sendData(res, {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    refresh_expires_at: result.refreshExpiresAt,
    user: userView(result.user),
    venue: { id: result.venue.id, slug: result.venue.slug, name: result.venue.name, venueType: result.venue.venueType },
  });
});

function sendLoginError(res: Response, error: authService.LoginError) {
  switch (error) {
    case 'venue_not_found': return sendError(res, 'NOT_FOUND', 'Venue not found');
    case 'wrong_login_method': return sendError(res, 'VALIDATION_ERROR', 'This venue does not support that login method');
    case 'locked': return sendError(res, 'UNAUTHORIZED', 'Account is temporarily locked — try again later');
    case 'invalid_credentials': return sendError(res, 'UNAUTHORIZED', 'Invalid credentials');
  }
}

// POST /refresh — { refresh_token }
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body ?? {};
  if (!refresh_token?.trim()) return sendError(res, 'VALIDATION_ERROR', 'refresh_token is required');

  const result = await authService.refreshSession(String(refresh_token));
  if (!result.ok) {
    const message =
      result.reason === 'reused'
        ? 'Refresh token reuse detected — all sessions for this account have been revoked'
        : 'Invalid or expired refresh token';
    return sendError(res, 'UNAUTHORIZED', message);
  }

  sendData(res, {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    refresh_expires_at: result.refreshExpiresAt,
  });
});

// POST /logout — { refresh_token }
authRouter.post('/logout', async (req: Request, res: Response) => {
  const { refresh_token } = req.body ?? {};
  if (!refresh_token?.trim()) return sendError(res, 'VALIDATION_ERROR', 'refresh_token is required');
  await authService.logout(String(refresh_token));
  sendData(res, { loggedOut: true });
});

// GET /me — requires auth
authRouter.get('/me', authenticate, venueScope, async (req: Request, res: Response) => {
  const result = await authService.getMe(req.auth!.userId, req.auth!.venueId);
  if (!result) return sendError(res, 'NOT_FOUND', 'User not found');
  sendData(res, result);
});

// GET /venue-config?slug=... — the ONLY unauthenticated data route.
authRouter.get('/venue-config', async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? '').trim();
  if (!slug) return sendError(res, 'VALIDATION_ERROR', 'slug is required');
  const config = await authService.getVenueConfig(slug);
  if (!config) return sendError(res, 'NOT_FOUND', 'Venue not found');
  sendData(res, config);
});
