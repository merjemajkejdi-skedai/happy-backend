import { prisma } from '../../db/prisma';
import { scopedPrisma } from '../../middleware/venueScope';
import { err, type DomainError } from '../../lib/domainError';
import type { RestaurantSettings, Venue } from '../../generated/prisma/client';

export { err };
export type ShiftDomainError = DomainError;

// Same shape as orders/validation.ts's getVenueAndSettings and every other
// module's own copy (menu/validation.ts's getVenueContext, etc.) — kept
// module-local by established convention rather than shared, since it's a
// two-line wrapper and cross-module coupling isn't worth it for that.
export async function getVenueAndSettings(venueId: string): Promise<{ venue: Venue; settings: RestaurantSettings }> {
  const [venue, settings] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId } }),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);
  if (!venue || !settings) throw new Error(`venue or settings missing for ${venueId}`);
  return { venue, settings };
}

export type Tx = Parameters<Parameters<typeof scopedPrisma.$transaction>[0]>[0];
