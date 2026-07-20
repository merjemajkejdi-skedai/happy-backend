import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { query, queryOne } from '../db/connection';
import { signToken } from '../middleware/auth';
import type { Venue, Staff } from '../types';

export const authRouter = Router();

const ok  = <T>(res: Response, data: T) => res.json({ success: true, data });
const err = (res: Response, message: string, status = 400) => res.status(status).json({ success: false, error: message });

// POST /auth/login
// Body: { code, pin?, email? }
// `code` identifies the venue. If `email` is given, look up that exact staff
// row and verify the pin against it. Otherwise scan the venue's active staff
// for a pin match — a normal PIN-pad login on a shared POS terminal.
authRouter.post('/login', async (req: Request, res: Response) => {
  const { code, pin, email } = req.body ?? {};
  if (!code?.trim()) return err(res, 'code is required');
  if (!pin?.trim() && !email?.trim()) return err(res, 'pin (and/or email) is required');

  try {
    const venue = await queryOne<Venue>('SELECT * FROM venues WHERE code = $1', [String(code).trim().toLowerCase()]);
    if (!venue) return err(res, 'Venue not found', 401);

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

    if (!staff) return err(res, 'Invalid credentials', 401);

    const token = signToken({ staffId: staff.id, venueId: venue.id, venueType: venue.venue_type, role: staff.role });

    ok(res, {
      token,
      staff: { id: staff.id, name: staff.name, role: staff.role },
      venue: { id: venue.id, code: venue.code, name: venue.name, venue_type: venue.venue_type },
    });
  } catch (e) {
    err(res, (e as Error).message, 500);
  }
});

// Stateless JWT — nothing to invalidate server-side.
authRouter.post('/logout', (_req: Request, res: Response) => ok(res, { loggedOut: true }));
