import { prisma } from '../../db/prisma';
import type { VenueType, Destination } from '../../generated/prisma/client';
import { err, type DomainError } from '../../lib/domainError';

export { err };
export type MenuDomainError = DomainError;

export interface VenueMenuContext {
  venueType: VenueType;
  coursesEnabled: boolean;
}

export async function getVenueContext(venueId: string): Promise<VenueMenuContext> {
  const [venue, settings] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId } }),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);
  if (!venue || !settings) throw new Error(`venue or settings missing for ${venueId}`);
  return { venueType: venue.venueType, coursesEnabled: settings.coursesEnabled };
}

// Applied to both a category's default_destination and an item's own
// destination — a category default that would be invalid for every item
// inheriting it is just as much a footgun as an invalid item, so the same
// rule guards both.
export function validateDestination(venueType: VenueType, destination: Destination): MenuDomainError | null {
  if (venueType === 'happy_restaurant' && destination === 'bar') {
    return err(422, 'DESTINATION_NOT_AVAILABLE', "destination 'bar' is not available for a happy_restaurant venue");
  }
  if (venueType === 'happy_bar' && destination === 'kitchen') {
    return err(422, 'DESTINATION_NOT_AVAILABLE', "destination 'kitchen' is not available for a happy_bar venue");
  }
  return null;
}

// Same reasoning — applied to a category's default_course_number too, not
// just an item's course_number.
export function validateCourseNumber(coursesEnabled: boolean, courseNumber: number | null | undefined): MenuDomainError | null {
  if (!coursesEnabled && courseNumber != null) {
    return err(422, 'COURSES_DISABLED', 'course_number must be null when courses are disabled for this venue');
  }
  return null;
}
