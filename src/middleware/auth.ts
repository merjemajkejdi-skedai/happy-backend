import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../shared/config';
import { sendError } from '../lib/response';
import type { UserRole } from '../generated/prisma/client';

// Access token payload — see modules/auth/tokens.ts for signing.
export interface AccessTokenPayload {
  sub: string; // userId
  venue_id: string;
  role: UserRole;
  jti: string;
}

export interface AuthContext {
  userId: string;
  venueId: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Pure JWT verification — no DB round-trip. Access tokens are short-lived by
// design (see shared/config.ts ACCESS_TOKEN_TTL); revocation happens at the
// refresh-token layer, not here. If an account is deactivated mid-session it
// stays valid until its access token naturally expires.
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return sendError(res, 'UNAUTHORIZED', 'No token provided');
  }

  try {
    const decoded = jwt.verify(header.slice(7), jwtSecret()) as AccessTokenPayload;
    req.auth = { userId: decoded.sub, venueId: decoded.venue_id, role: decoded.role };
    next();
  } catch {
    return sendError(res, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}
