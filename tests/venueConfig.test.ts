import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as settingsService from '../src/modules/settings/service';
import * as usersService from '../src/modules/users/service';
import * as tablesService from '../src/modules/tables/service';
import { createTestVenue, destroyTestVenue, TEST_VENUE_SLUG } from './fixtures';

async function venueByslug(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) throw new Error(`seed venue missing: ${slug}`);
  return venue;
}

describe('Bar-venue course rejection', () => {
  it('rejects courses_enabled=true on the seeded happy-bar venue with 422 COURSES_NOT_ALLOWED_FOR_BAR', async () => {
    const venue = await venueByslug('happy-bar');
    const admin = await usersService.listUsers(venue.id, { role: 'admin' });
    const actorId = admin.users[0].id;

    const result = await settingsService.updateSettings(venue.id, actorId, { coursesEnabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: 'COURSES_NOT_ALLOWED_FOR_BAR', message: 'courses_enabled cannot be true for a happy_bar venue' },
    });

    // Doesn't actually mutate the row — confirm.
    const settings = await settingsService.getSettingsRow(venue.id);
    expect(settings!.coursesEnabled).toBe(false);
  });

  it('allows courses_enabled=true on a non-bar venue (happy-hybrid already seeds it true)', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await usersService.listUsers(venue.id, { role: 'admin' });
    const actorId = admin.users[0].id;

    const result = await settingsService.updateSettings(venue.id, actorId, { coursesEnabled: true });
    expect(result.ok).toBe(true);
  });

  it('other settings rules: counter_service_enabled required when tables_enabled is false', async () => {
    const venue = await venueByslug('happy-resto');
    const admin = await usersService.listUsers(venue.id, { role: 'admin' });
    const actorId = admin.users[0].id;

    const result = await settingsService.updateSettings(venue.id, actorId, { tablesEnabled: false });
    expect(result).toEqual({
      ok: false,
      error: { code: 'COUNTER_SERVICE_REQUIRED', message: 'counter_service_enabled must be true when tables_enabled is false' },
    });
  });

  it('rejects pin_length outside 4-8', async () => {
    const venue = await venueByslug('happy-resto');
    const admin = await usersService.listUsers(venue.id, { role: 'admin' });
    const actorId = admin.users[0].id;

    const tooShort = await settingsService.updateSettings(venue.id, actorId, { pinLength: 3 });
    expect(tooShort.ok).toBe(false);
    const tooLong = await settingsService.updateSettings(venue.id, actorId, { pinLength: 9 });
    expect(tooLong.ok).toBe(false);
  });
});

describe('PIN collision', () => {
  // Dedicated throwaway venue — creating/colliding PINs must never touch the
  // shared dev seed data.
  beforeAll(async () => {
    await createTestVenue('pin', [{ role: 'waiter', pin: '1234' }]);
  });
  afterAll(async () => { await destroyTestVenue(); });

  it('rejects creating a second user with a PIN already used at the same venue', async () => {
    const venue = await prisma.venue.findUnique({ where: { slug: TEST_VENUE_SLUG } });
    const result = await usersService.createUser(venue!.id, { fullName: 'Second Waiter', role: 'waiter', pin: '1234' });
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'PIN_ALREADY_IN_USE', message: 'That PIN is already in use at this venue' },
    });
  });

  it('allows the same PIN at a DIFFERENT venue (uniqueness is per-venue, not global)', async () => {
    const otherVenue = await venueByslug('happy-hybrid');
    // happy-hybrid's waiter already has PIN 1111, not 1234, so this is a
    // fresh PIN there even though it collides with the fixture venue's PIN.
    const result = await usersService.createUser(otherVenue.id, { fullName: 'Cross-venue Probe', role: 'waiter', pin: '1234' });
    expect(result.ok).toBe(true);
    if (result.ok) await usersService.softDeleteUser(otherVenue.id, '00000000-0000-0000-0000-000000000000', result.value.id);
  });

  it('rejects resetting a PIN to one already used by another user at the venue', async () => {
    const venue = await prisma.venue.findUnique({ where: { slug: TEST_VENUE_SLUG } });
    const second = await usersService.createUser(venue!.id, { fullName: 'Kitchen Probe', role: 'kitchen', pin: '5678' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const result = await usersService.resetPin(venue!.id, second.value.id, '1234');
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'PIN_ALREADY_IN_USE', message: 'That PIN is already in use at this venue' },
    });
  });
});

describe('Table naming-mode validation — all three seeded venues', () => {
  it("happy-resto (mode 'both'): number-only, name-only, and both are all valid; neither is rejected", async () => {
    const venue = await venueByslug('happy-resto');
    const area = (await prisma.area.findFirst({ where: { venueId: venue.id } }))!;

    const neither = await tablesService.createTable(venue.id, { areaId: area.id });
    expect(neither).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_IDENTIFIER_REQUIRED', message: 'at least one of table_number or table_name is required' },
    });

    const numberOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9001 });
    expect(numberOnly.ok).toBe(true);
    const nameOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableName: 'Naming Probe' });
    expect(nameOnly.ok).toBe(true);
    const both = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9002, tableName: 'Naming Probe Both' });
    expect(both.ok).toBe(true);

    for (const r of [numberOnly, nameOnly, both]) {
      if (r.ok) await tablesService.deleteTable(venue.id, r.value.id);
    }
  });

  it("happy-bar (mode 'name'): table_name required, table_number forbidden", async () => {
    const venue = await venueByslug('happy-bar');
    const area = (await prisma.area.findFirst({ where: { venueId: venue.id } }))!;

    const numberOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9001 });
    expect(numberOnly).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_NAME_REQUIRED', message: "table_name is required for this venue's naming mode" },
    });

    const both = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9001, tableName: 'Naming Probe' });
    expect(both).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_NUMBER_NOT_ALLOWED', message: "table_number must be null for this venue's naming mode" },
    });

    const nameOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableName: 'Naming Probe' });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok) await tablesService.deleteTable(venue.id, nameOnly.value.id);
  });

  it("happy-hybrid (mode 'number'): table_number required, table_name forbidden", async () => {
    const venue = await venueByslug('happy-hybrid');
    const area = (await prisma.area.findFirst({ where: { venueId: venue.id } }))!;

    const nameOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableName: 'Naming Probe' });
    expect(nameOnly).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_NUMBER_REQUIRED', message: "table_number is required for this venue's naming mode" },
    });

    const both = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9001, tableName: 'Naming Probe' });
    expect(both).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_NAME_NOT_ALLOWED', message: "table_name must be null for this venue's naming mode" },
    });

    const numberOnly = await tablesService.createTable(venue.id, { areaId: area.id, tableNumber: 9001 });
    expect(numberOnly.ok).toBe(true);
    if (numberOnly.ok) await tablesService.deleteTable(venue.id, numberOnly.value.id);
  });

  it('computes display_label correctly for each mode', () => {
    expect(tablesService.computeDisplayLabel('both', 12, 'Terrace Corner')).toBe('12 — Terrace Corner');
    expect(tablesService.computeDisplayLabel('both', 12, null)).toBe('12');
    expect(tablesService.computeDisplayLabel('both', null, 'Terrace Corner')).toBe('Terrace Corner');
    expect(tablesService.computeDisplayLabel('name', null, 'Terrace Corner')).toBe('Terrace Corner');
    expect(tablesService.computeDisplayLabel('number', 12, null)).toBe('12');
  });
});

describe('Manager/bar role rejection on user create', () => {
  it('rejects role=manager with 422 ROLE_NOT_AVAILABLE_IN_PHASE_1', async () => {
    const venue = await venueByslug('happy-resto');
    const result = await usersService.createUser(venue.id, { fullName: 'Future Manager', role: 'manager', pin: '4444' });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'ROLE_NOT_AVAILABLE_IN_PHASE_1', message: 'role must be one of: waiter, kitchen, admin' },
    });
  });

  it('rejects role=bar with 422 ROLE_NOT_AVAILABLE_IN_PHASE_1', async () => {
    const venue = await venueByslug('happy-bar');
    const result = await usersService.createUser(venue.id, { fullName: 'Future Bar Staff', role: 'bar', pin: '4444' });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'ROLE_NOT_AVAILABLE_IN_PHASE_1', message: 'role must be one of: waiter, kitchen, admin' },
    });
  });

  it('rejects role=manager on PATCH too', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await usersService.listUsers(venue.id, { role: 'admin' });
    const target = (await usersService.listUsers(venue.id, { role: 'waiter' })).users[0];

    const result = await usersService.updateUser(venue.id, admin.users[0].id, target.id, { role: 'manager' });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'ROLE_NOT_AVAILABLE_IN_PHASE_1', message: 'role must be one of: waiter, kitchen, admin' },
    });
  });
});
