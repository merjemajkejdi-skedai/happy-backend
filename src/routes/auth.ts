import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { query, queryOne } from '../db/connection';
import { signToken } from '../middleware/auth';
import { sendData, sendError } from '../lib/response';
import type { Venue, Staff, RestaurantSettings } from '../types';

export const authRouter = Router();

// POST /auth/login
// Body: { code, pin?, email? }
// `code` identifies the venue. If `email` is given, look up that exact staff
// row and verify the pin against it. Otherwise scan the venue's active staff
// for a pin match — a normal PIN-pad login on a shared POS terminal.
authRouter.post('/login', async (req: Request, res: Response) => {
  const { code, pin, email } = req.body ?? {};
  if (!code?.trim()) return sendError(res, 'VALIDATION_ERROR', 'code is required');
  if (!pin?.trim() && !email?.trim()) return sendError(res, 'VALIDATION_ERROR', 'pin (and/or email) is required');

  try {
    const venue = await queryOne<Venue>('SELECT * FROM venues WHERE code = $1', [String(code).trim().toLowerCase()]);
    if (!venue) return sendError(res, 'UNAUTHORIZED', 'Venue not found');

    let staff: Staff | undefined;

    if (email?.trim()) {
      const row = await queryOne<Staff>(
        'SELECT * FROM staff WHERE venue_id = $1 AND email = $2 AND is_active = TRUE',
        [venue.id, String(email).trim().toLowerCase()],
      );
      if (row?.pin_hash && pin?.trim() && await bcrypt.compare(String(pin), row.pin_hash)) {
        staff = row;
      } else if (row && !row.pin_hash && !pin?.trim()) {
        staff = row; // email-only login, only if the account has no PIN set
      }
    } else {
      const candidates = await query<Staff>(
        'SELECT * FROM staff WHERE venue_id = $1 AND is_active = TRUE AND pin_hash IS NOT NULL',
        [venue.id],
      );
      for (const candidate of candidates) {
        if (await bcrypt.compare(String(pin), candidate.pin_hash as string)) { staff = candidate; break; }
      }
    }

    if (!staff) return sendError(res, 'UNAUTHORIZED', 'Invalid credentials');

    const token = signToken({ staffId: staff.id, venueId: venue.id, venueType: venue.venue_type, role: staff.role });
    const settings = await queryOne<RestaurantSettings>('SELECT * FROM restaurant_settings WHERE venue_id = $1', [venue.id]);

    sendData(res, {
      token,
      staff: { id: staff.id, name: staff.name, role: staff.role },
      venue: {
        id: venue.id,
        code: venue.code,
        name: venue.name,
        venue_type: venue.venue_type,
        currency: settings?.currency ?? 'EUR',
        counter_service_enabled: settings?.counter_service_enabled ?? false,
        kitchen_display_enabled: settings?.kitchen_display_enabled ?? false,
        bar_display_enabled: settings?.bar_display_enabled ?? false,
        // Optional bolt-ons: omitted entirely while disabled, not sent as false.
        ...(settings?.whatsapp_enabled ? { whatsapp_enabled: true } : {}),
        ...(settings?.ai_enabled ? { ai_enabled: true } : {}),
        ...(settings?.pms_enabled ? { pms_enabled: true } : {}),
      },
    });
  } catch (e) {
    sendError(res, 'INTERNAL_ERROR', (e as Error).message);
  }
});

// Stateless JWT — nothing to invalidate server-side.
authRouter.post('/logout', (_req: Request, res: Response) => sendData(res, { loggedOut: true }));
