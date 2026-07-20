// Dedicated, disposable test fixtures — tests that need to trigger failures,
// lockouts, or other mutating behavior must NOT run against the shared dev
// seed data (happy-resto/happy-bar/happy-hybrid), since that would corrupt
// data the user relies on for manual testing. This venue is created fresh
// and torn down around the tests that need it.
import bcrypt from 'bcrypt';
import { prisma } from '../src/db/prisma';
import { pinLookup } from '../src/shared/pin';
import type { UserRole, LoginMethod } from '../src/generated/prisma/client';

export const TEST_VENUE_SLUG = 'test-auth-fixture';

export interface TestUserSpec {
  role: UserRole;
  pin?: string;
  email?: string;
  password?: string;
}

// Low bcrypt cost factor — these are throwaway test credentials, not real
// PINs/passwords, and tests run many of them.
const TEST_BCRYPT_COST = 4;

export async function createTestVenue(loginMethod: LoginMethod, users: TestUserSpec[]) {
  await destroyTestVenue();

  const venue = await prisma.venue.create({
    data: {
      slug: TEST_VENUE_SLUG,
      name: 'Test Auth Fixture',
      venueType: 'happy_hybrid',
      settings: { create: { loginMethod } },
    },
  });

  for (const u of users) {
    await prisma.user.create({
      data: {
        venueId: venue.id,
        role: u.role,
        fullName: `Test ${u.role}`,
        email: u.email ?? null,
        passwordHash: u.password ? await bcrypt.hash(u.password, TEST_BCRYPT_COST) : null,
        pinHash: u.pin ? await bcrypt.hash(u.pin, TEST_BCRYPT_COST) : null,
        pinLookup: u.pin ? pinLookup(u.pin) : null,
      },
    });
  }

  return venue;
}

export async function destroyTestVenue() {
  const venue = await prisma.venue.findUnique({ where: { slug: TEST_VENUE_SLUG } });
  if (!venue) return;
  await prisma.user.deleteMany({ where: { venueId: venue.id } }); // cascades refresh_tokens
  await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
}
