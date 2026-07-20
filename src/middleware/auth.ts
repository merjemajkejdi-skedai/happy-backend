import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db/connection';
import { sendError } from '../lib/response';
import type { AuthTokenPayload } from '../types';

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: '16h' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return sendError(res, 'UNAUTHORIZED', 'No token provided');
  }

  try {
    const decoded = jwt.verify(header.slice(7), jwtSecret()) as AuthTokenPayload;
    const staff = await queryOne<{ id: string; name: string; role: string; is_active: boolean }>(
      'SELECT id, name, role, is_active FROM staff WHERE id = $1 AND venue_id = $2',
      [decoded.staffId, decoded.venueId],
    );
    if (!staff) return sendError(res, 'UNAUTHORIZED', 'Staff not found');
    if (!staff.is_active) return sendError(res, 'UNAUTHORIZED', 'Account deactivated');

    req.user = { ...decoded, name: staff.name };
    next();
  } catch {
    return sendError(res, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}
