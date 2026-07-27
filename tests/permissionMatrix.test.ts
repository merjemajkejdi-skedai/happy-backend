// Session 2a-ii — unit tests for the permission registry's static matrix and
// resolvePermissions()'s settings-dependent resolution. Written before the
// implementation (TESTS FIRST). Pure function tests — no DB, no HTTP — so
// every one of the 30 permissions x 5 roles can be exercised directly and
// quickly. Route-level enforcement (does the real HTTP route actually match
// this resolution) is covered separately in tests/permissionRoutes.test.ts,
// for the subset of permissions that have a real, already-built route to
// call — several permissions in this matrix (order.fire, order.split,
// order.merge, order.merge_approve, void.approve, order.payment,
// order.payment_void, menu.stock, shift.manage, reports.view/export) belong
// to features later Phase 2 sessions build; this session only has to make
// GET /permissions resolve them correctly, not enforce them at a route that
// doesn't exist yet.
import { describe, it, expect } from 'vitest';
import {
  ROLE_PERMISSIONS,
  roleHasPermission,
  resolvePermissions,
  resolveDisplayScope,
  type Permission,
} from '../src/shared/permissions';
import type { RestaurantSettings, Venue, UserRole } from '../src/generated/prisma/client';

// Minimal-but-complete fixtures — only the fields resolvePermissions reads
// are meaningful; the rest exist to satisfy the Prisma type shape.
function makeSettings(overrides: Partial<RestaurantSettings> = {}): RestaurantSettings {
  return {
    id: 's1',
    venueId: 'v1',
    loginMethod: 'pin',
    pinLength: 4,
    sessionTimeoutMinutes: 720,
    requirePinOnReopen: false,
    tableNamingMode: 'number',
    tablesEnabled: true,
    counterServiceEnabled: false,
    ticketNumberPrefix: '',
    ticketNumberReset: 'daily',
    requireTableForOrder: true,
    allowTableTransfer: true,
    coursesEnabled: true,
    defaultCourseCount: 3,
    modifiersEnabled: true,
    allowFreeTextNotes: true,
    kitchenDisplayEnabled: true,
    barDisplayEnabled: false,
    kitchenPrinterEnabled: false,
    barPrinterEnabled: false,
    displayAutoRefreshSeconds: 10,
    displayShowElapsedTime: true,
    displayWarnAfterMinutes: 15,
    allowItemVoidAfterSend: false,
    autoSendOnAdd: false,
    whatsappEnabled: false,
    whatsappConfig: null,
    aiEnabled: false,
    aiConfig: null,
    pmsEnabled: false,
    pmsRoomChargeEnabled: false,
    taxRatePercent: '20.00' as unknown as RestaurantSettings['taxRatePercent'],
    serviceChargePercent: '0.00' as unknown as RestaurantSettings['serviceChargePercent'],
    extra: {},
    modifierPricingMode: 'fixed',
    modifierMaxGroupsPerItem: 10,
    requireModifierValidation: true,
    sendByCourse: false,
    courseNames: ['Starters', 'Mains', 'Desserts'],
    autoFireFirstCourse: true,
    courseFireRequiresPreviousServed: false,
    showFireAlertSeconds: 30,
    splitBillEnabled: false,
    splitEqualEnabled: true,
    splitByItemEnabled: true,
    splitMaxWays: 8,
    mergeTablesEnabled: false,
    mergeRequiresManager: true,
    voidRequiresApproval: false,
    voidApprovalRole: 'manager',
    voidBeforeSendRequiresApproval: false,
    voidReasonRequired: true,
    voidReasonPresetList: [],
    voidAlertsKitchen: true,
    stockTrackingMode: 'none',
    stockAuto86AtZero: true,
    stockWarnThreshold: 5,
    allowNegativeStock: false,
    eightysixRequiresManager: false,
    eightysixResetsDaily: true,
    paymentCaptureEnabled: true,
    paymentMethodsEnabled: ['cash', 'card'],
    requirePaymentToClose: false,
    allowPartialPayment: true,
    shiftsEnabled: true,
    shiftAutoCloseHours: 24,
    businessDayStartHour: 5,
    reportsVisibleToManager: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as RestaurantSettings;
}

function makeVenue(overrides: Partial<Venue> = {}): Venue {
  return {
    id: 'v1',
    name: 'Test Venue',
    slug: 'test-venue',
    venueType: 'happy_hybrid',
    timezone: 'Europe/Tirane',
    currency: 'ALL',
    locale: 'sq-AL',
    address: null,
    phone: null,
    isActive: true,
    pmsProvider: null,
    pmsPropertyId: null,
    pmsConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Venue;
}

const ROLES: UserRole[] = ['waiter', 'kitchen', 'bar', 'manager', 'admin'];

// Transcribed exactly from docs/phase2/2a-ii.md section 3. 'S' cells are
// checked against their MAXIMAL (ceiling) static value here — resolution
// narrowing is tested separately below.
const STATIC_MATRIX: Record<Permission, Record<UserRole, boolean>> = {
  'order.create': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.view_own': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.view_all': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'order.send': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.fire': { waiter: true, kitchen: false, bar: false, manager: true, admin: true },
  'order.serve': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.transfer': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.close': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.cancel_sent': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'order.split': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.merge': { waiter: true, kitchen: false, bar: false, manager: true, admin: true },
  'order.merge_approve': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'order.events.read': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'order.void': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  // order.void_after_send is deliberately excluded here — see the dedicated
  // describe block below; its static N for waiter/bar in the doc conflicts
  // with section 4's resolution rule, resolved in favor of section 4 (see
  // docs/phase2/SESSION-2a-ii.md for the full rationale).
  'void.approve': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'order.payment': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'order.payment_void': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'display.view': { waiter: false, kitchen: true, bar: true, manager: true, admin: true },
  'display.bump': { waiter: false, kitchen: true, bar: true, manager: true, admin: true },
  'menu.view': { waiter: true, kitchen: true, bar: true, manager: true, admin: true },
  'menu.write': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'menu.eightysix': { waiter: true, kitchen: true, bar: true, manager: true, admin: true },
  'menu.stock': { waiter: false, kitchen: true, bar: true, manager: true, admin: true },
  'table.view': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'table.status': { waiter: true, kitchen: false, bar: true, manager: true, admin: true },
  'table.write': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'shift.manage': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'reports.view': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'reports.export': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'user.manage': { waiter: false, kitchen: false, bar: false, manager: true, admin: true },
  'settings.write': { waiter: false, kitchen: false, bar: false, manager: false, admin: true },
  'venue.write': { waiter: false, kitchen: false, bar: false, manager: false, admin: true },
} as unknown as Record<Permission, Record<UserRole, boolean>>;

describe('Static permission matrix (ceiling values)', () => {
  for (const [permission, expectedByRole] of Object.entries(STATIC_MATRIX) as [Permission, Record<UserRole, boolean>][]) {
    for (const role of ROLES) {
      const expected = expectedByRole[role];
      it(`${permission}: ${role} => ${expected ? 'Y' : 'N'}`, () => {
        expect(roleHasPermission(role, permission)).toBe(expected);
      });
    }
  }
});

describe('resolvePermissions — order.split (requires split_bill_enabled)', () => {
  const venue = makeVenue();
  for (const role of ['waiter', 'bar', 'manager', 'admin'] as UserRole[]) {
    it(`${role} loses order.split when split_bill_enabled is false`, () => {
      const resolved = resolvePermissions(role, makeSettings({ splitBillEnabled: false }), venue);
      expect(resolved.permissions).not.toContain('order.split');
    });
    it(`${role} has order.split when split_bill_enabled is true`, () => {
      const resolved = resolvePermissions(role, makeSettings({ splitBillEnabled: true }), venue);
      expect(resolved.permissions).toContain('order.split');
    });
  }
  it('kitchen never has order.split, setting on or off', () => {
    expect(resolvePermissions('kitchen', makeSettings({ splitBillEnabled: true }), venue).permissions).not.toContain('order.split');
  });
});

describe('resolvePermissions — order.merge (waiter needs merge_tables_enabled AND NOT merge_requires_manager)', () => {
  const venue = makeVenue();
  it('waiter has order.merge when enabled and manager not required', () => {
    const resolved = resolvePermissions('waiter', makeSettings({ mergeTablesEnabled: true, mergeRequiresManager: false }), venue);
    expect(resolved.permissions).toContain('order.merge');
  });
  it('waiter loses order.merge when merge_requires_manager is true', () => {
    const resolved = resolvePermissions('waiter', makeSettings({ mergeTablesEnabled: true, mergeRequiresManager: true }), venue);
    expect(resolved.permissions).not.toContain('order.merge');
  });
  it('waiter loses order.merge when merge_tables_enabled is false', () => {
    const resolved = resolvePermissions('waiter', makeSettings({ mergeTablesEnabled: false, mergeRequiresManager: false }), venue);
    expect(resolved.permissions).not.toContain('order.merge');
  });
  it('manager/admin only need merge_tables_enabled — merge_requires_manager does not narrow them', () => {
    for (const role of ['manager', 'admin'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ mergeTablesEnabled: true, mergeRequiresManager: true }), venue);
      expect(resolved.permissions).toContain('order.merge');
    }
  });
  it('manager/admin lose order.merge when merge_tables_enabled is false', () => {
    for (const role of ['manager', 'admin'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ mergeTablesEnabled: false }), venue);
      expect(resolved.permissions).not.toContain('order.merge');
    }
  });
  it('bar/kitchen never have order.merge regardless of settings', () => {
    for (const role of ['bar', 'kitchen'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ mergeTablesEnabled: true, mergeRequiresManager: false }), venue);
      expect(resolved.permissions).not.toContain('order.merge');
    }
  });
});

describe('resolvePermissions — order.void_after_send (waiter/bar: only when void_requires_approval is false)', () => {
  const venue = makeVenue();
  it('waiter/bar gain it when void_requires_approval is false', () => {
    for (const role of ['waiter', 'bar'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ voidRequiresApproval: false }), venue);
      expect(resolved.permissions).toContain('order.void_after_send');
    }
  });
  it('waiter/bar lose it when void_requires_approval is true', () => {
    for (const role of ['waiter', 'bar'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ voidRequiresApproval: true }), venue);
      expect(resolved.permissions).not.toContain('order.void_after_send');
    }
  });
  it('manager/admin always have it, regardless of the setting', () => {
    for (const role of ['manager', 'admin'] as UserRole[]) {
      expect(resolvePermissions(role, makeSettings({ voidRequiresApproval: true }), venue).permissions).toContain('order.void_after_send');
      expect(resolvePermissions(role, makeSettings({ voidRequiresApproval: false }), venue).permissions).toContain('order.void_after_send');
    }
  });
  it('kitchen never has it', () => {
    expect(resolvePermissions('kitchen', makeSettings({ voidRequiresApproval: false }), venue).permissions).not.toContain('order.void_after_send');
  });
});

describe('resolvePermissions — menu.eightysix (waiter/kitchen/bar: requires NOT eightysix_requires_manager)', () => {
  const venue = makeVenue();
  it('waiter/kitchen/bar have it when eightysix_requires_manager is false', () => {
    for (const role of ['waiter', 'kitchen', 'bar'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ eightysixRequiresManager: false }), venue);
      expect(resolved.permissions).toContain('menu.eightysix');
    }
  });
  it('waiter/kitchen/bar lose it when eightysix_requires_manager is true', () => {
    for (const role of ['waiter', 'kitchen', 'bar'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ eightysixRequiresManager: true }), venue);
      expect(resolved.permissions).not.toContain('menu.eightysix');
    }
  });
  it('manager/admin always have it, regardless of the setting', () => {
    for (const role of ['manager', 'admin'] as UserRole[]) {
      expect(resolvePermissions(role, makeSettings({ eightysixRequiresManager: true }), venue).permissions).toContain('menu.eightysix');
    }
  });
});

describe('resolvePermissions — reports.view / reports.export (manager: requires reports_visible_to_manager)', () => {
  const venue = makeVenue();
  it('manager has both when reports_visible_to_manager is true', () => {
    const resolved = resolvePermissions('manager', makeSettings({ reportsVisibleToManager: true }), venue);
    expect(resolved.permissions).toContain('reports.view');
    expect(resolved.permissions).toContain('reports.export');
  });
  it('manager loses both when reports_visible_to_manager is false', () => {
    const resolved = resolvePermissions('manager', makeSettings({ reportsVisibleToManager: false }), venue);
    expect(resolved.permissions).not.toContain('reports.view');
    expect(resolved.permissions).not.toContain('reports.export');
  });
  it('admin always has both, regardless of the setting', () => {
    const resolved = resolvePermissions('admin', makeSettings({ reportsVisibleToManager: false }), venue);
    expect(resolved.permissions).toContain('reports.view');
    expect(resolved.permissions).toContain('reports.export');
  });
  it('waiter/kitchen/bar never have either', () => {
    for (const role of ['waiter', 'kitchen', 'bar'] as UserRole[]) {
      const resolved = resolvePermissions(role, makeSettings({ reportsVisibleToManager: true }), venue);
      expect(resolved.permissions).not.toContain('reports.view');
      expect(resolved.permissions).not.toContain('reports.export');
    }
  });
});

describe('resolveDisplayScope / resolvePermissions — display.view & display.bump scope', () => {
  it('kitchen sees kitchen only at a non-happy_restaurant venue', () => {
    const scope = resolveDisplayScope('kitchen', 'happy_hybrid');
    expect(scope).toEqual({ kitchen: true, bar: false });
  });
  it('kitchen sees kitchen AND bar at a happy_restaurant venue', () => {
    const scope = resolveDisplayScope('kitchen', 'happy_restaurant');
    expect(scope).toEqual({ kitchen: true, bar: true });
  });
  it('bar sees bar only, regardless of venue type', () => {
    expect(resolveDisplayScope('bar', 'happy_restaurant')).toEqual({ kitchen: false, bar: true });
    expect(resolveDisplayScope('bar', 'happy_bar')).toEqual({ kitchen: false, bar: true });
    expect(resolveDisplayScope('bar', 'happy_hybrid')).toEqual({ kitchen: false, bar: true });
  });
  it('manager/admin see both, regardless of venue type', () => {
    for (const role of ['manager', 'admin'] as UserRole[]) {
      expect(resolveDisplayScope(role, 'happy_bar')).toEqual({ kitchen: true, bar: true });
    }
  });
  it('waiter sees neither', () => {
    expect(resolveDisplayScope('waiter', 'happy_hybrid')).toEqual({ kitchen: false, bar: false });
  });
  it('resolvePermissions omits display.view/display.bump entirely when scope is empty (waiter)', () => {
    const resolved = resolvePermissions('waiter', makeSettings(), makeVenue());
    expect(resolved.permissions).not.toContain('display.view');
    expect(resolved.permissions).not.toContain('display.bump');
  });
  it('resolvePermissions includes display.view/display.bump when scope is non-empty (kitchen)', () => {
    const resolved = resolvePermissions('kitchen', makeSettings(), makeVenue({ venueType: 'happy_bar' }));
    expect(resolved.permissions).toContain('display.view');
    expect(resolved.permissions).toContain('display.bump');
    expect(resolved.displayScope).toEqual({ kitchen: true, bar: false });
  });
});

describe('resolvePermissions — no unexpected permissions leak in', () => {
  it("admin's resolved set never includes settings.write/venue.write for manager", () => {
    const resolved = resolvePermissions('manager', makeSettings(), makeVenue());
    expect(resolved.permissions).not.toContain('settings.write');
    expect(resolved.permissions).not.toContain('venue.write');
  });
});
