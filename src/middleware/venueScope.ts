import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db/prisma';
import { sendError } from '../lib/response';

// Models with a direct venue_id column — see docs/SCHEMA.md. Models that only
// relate to a venue transitively through a parent (RefreshToken via User,
// ModifierOption via ModifierGroup, MenuItemModifierGroup, OrderItemModifier
// via OrderItem) are intentionally excluded: there's no venue_id column on
// them to filter by in the first place, so there's nothing to guard.
const VENUE_SCOPED_MODELS = new Set([
  'RestaurantSettings', 'User', 'Area', 'RestaurantTable', 'MenuCategory',
  'MenuItem', 'ModifierGroup', 'Order', 'OrderItem', 'OrderEvent', 'TicketCounter',
  'IdempotencyRequest',
]);

// Operations that scan or bulk-touch rows — this is where "forgot to filter
// by venue" turns into a cross-tenant data leak. findUnique/create/update/
// delete (by id) are deliberately NOT guarded: they operate on one
// already-identified row via its primary key, which structurally can't carry
// an extra venueId filter unless the model has a compound unique key that
// includes it (none of these do). Ownership of a by-id result still has to
// be checked by the caller after the fact.
const GUARDED_OPERATIONS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany',
]);

function hasVenueFilter(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;
  if (w.venueId != null) return true;
  // Common combinator shape: a top-level AND array where one branch carries venueId.
  if (Array.isArray(w.AND)) return w.AND.some(hasVenueFilter);
  return false;
}

// venue_id must never be readable from body/query/params — every query
// against a venue-scoped table must be filtered by the venueId that came off
// the authenticated JWT (req.auth.venueId), never anything client-supplied.
// This extension is the mechanical safety net for that rule: it throws
// rather than silently returning cross-venue data if the filter is missing.
export const scopedPrisma = prisma.$extends({
  name: 'venueScopeGuard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (VENUE_SCOPED_MODELS.has(model) && GUARDED_OPERATIONS.has(operation)) {
          const where = (args as { where?: unknown } | undefined)?.where;
          if (!hasVenueFilter(where)) {
            throw new Error(`venueScope violation: ${model}.${operation} ran without a venue_id filter`);
          }
        }
        return query(args);
      },
    },
  },
});

// Route-level guard: guarantees req.auth.venueId is present before a handler
// runs. Pair with `authenticate` (which sets req.auth) on every protected route.
export function venueScope(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.venueId) return sendError(res, 'UNAUTHORIZED', 'Unauthorised');
  next();
}
