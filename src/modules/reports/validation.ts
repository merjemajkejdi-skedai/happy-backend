import { prisma } from '../../db/prisma';
import { err, type DomainError } from '../../lib/domainError';
import type { RestaurantSettings, Venue } from '../../generated/prisma/client';

export { err };
export type ReportDomainError = DomainError;

// Same shape as every other module's own copy — kept module-local by
// established convention rather than shared.
export async function getVenueAndSettings(venueId: string): Promise<{ venue: Venue; settings: RestaurantSettings }> {
  const [venue, settings] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId } }),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);
  if (!venue || !settings) throw new Error(`venue or settings missing for ${venueId}`);
  return { venue, settings };
}
