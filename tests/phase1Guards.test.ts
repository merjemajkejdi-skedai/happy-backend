import { describe, it, expect } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ROLE_PERMISSIONS } from '../src/shared/permissions';
import * as venueService from '../src/modules/venue/service';
import { serializeVenue } from '../src/modules/venue/serializers';
import * as settingsService from '../src/modules/settings/service';
import { serializeSettings } from '../src/shared/settingsSerializer';
import * as authService from '../src/modules/auth/service';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import { serializeOrder } from '../src/modules/orders/serializers';

async function venueByslug(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) throw new Error(`seed venue missing: ${slug}`);
  return venue;
}

describe('No route or permission exists for manager or bar roles', () => {
  it('manager and bar have zero permissions in Phase 1', () => {
    expect(ROLE_PERMISSIONS.manager.size).toBe(0);
    expect(ROLE_PERMISSIONS.bar.size).toBe(0);
  });
});

describe('whatsapp_config, ai_config, and pms_* fields are absent while their flags are false', () => {
  it('GET /venue omits pms_provider/pms_property_id/pms_config', async () => {
    const venue = await venueByslug('happy-resto');
    const settings = await settingsService.getSettingsRow(venue.id);
    expect(settings!.pmsEnabled).toBe(false); // seed default — this test is only meaningful if the flag is actually off

    const raw = await venueService.getVenue(venue.id);
    const serialized: any = serializeVenue(raw!, settings!.pmsEnabled);
    expect(serialized).not.toHaveProperty('pmsProvider');
    expect(serialized).not.toHaveProperty('pmsPropertyId');
    expect(serialized).not.toHaveProperty('pmsConfig');
  });

  it('GET /settings omits whatsapp_config, ai_config, and pms_room_charge_enabled', async () => {
    const venue = await venueByslug('happy-resto');
    const settings = await settingsService.getSettingsRow(venue.id);
    expect(settings!.whatsappEnabled).toBe(false);
    expect(settings!.aiEnabled).toBe(false);
    expect(settings!.pmsEnabled).toBe(false);

    const serialized: any = serializeSettings(settings!);
    expect(serialized).not.toHaveProperty('whatsappConfig');
    expect(serialized).not.toHaveProperty('aiConfig');
    expect(serialized).not.toHaveProperty('pmsRoomChargeEnabled');
    // pms_enabled itself is always present — it's the gate, not gated.
    expect(serialized).toHaveProperty('pmsEnabled', false);
  });

  it('GET /auth/venue-config (the public route) never includes pms_*/whatsapp_*/ai_* at all', async () => {
    const config = await authService.getVenueConfig('happy-resto');
    expect(config).toEqual({
      name: 'Happy Resto',
      venue_type: 'happy_restaurant',
      login_method: 'pin',
      locale: 'sq-AL',
      currency: 'ALL',
    });
  });

  it('GET /auth/me omits the same fields on both venue and settings', async () => {
    const venue = await venueByslug('happy-resto');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });

    const me: any = await authService.getMe(admin.id, venue.id);
    expect(me.venue).not.toHaveProperty('pmsProvider');
    expect(me.venue).not.toHaveProperty('pmsPropertyId');
    expect(me.venue).not.toHaveProperty('pmsConfig');
    expect(me.settings).not.toHaveProperty('whatsappConfig');
    expect(me.settings).not.toHaveProperty('aiConfig');
    expect(me.settings).not.toHaveProperty('pmsRoomChargeEnabled');
  });

  it('GET /orders/:id omits pms_folio_id/pms_room_number/pms_posted_at', async () => {
    const venue = await venueByslug('happy-bar'); // only seeded venue with require_table_for_order=false, so counter mode works here
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const settings = await settingsService.getSettingsRow(venue.id);
    expect(settings!.pmsEnabled).toBe(false);

    const orderResult = await ordersService.createOrder(venue.id, admin.id, { serviceMode: 'counter' });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;

    const serialized: any = serializeOrder(orderResult.value, settings!.pmsEnabled);
    expect(serialized).not.toHaveProperty('pmsFolioId');
    expect(serialized).not.toHaveProperty('pmsRoomNumber');
    expect(serialized).not.toHaveProperty('pmsPostedAt');

    await lifecycleService.cancelOrder(venue.id, admin.id, 'waiter', orderResult.value.id, 'test cleanup');
  });
});

describe('No code path writes pms_folio_id, pms_room_number, or pms_posted_at', () => {
  it('stays null through the entire order lifecycle: create -> add -> send -> close', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const table = await prisma.restaurantTable.findFirstOrThrow({ where: { venueId: venue.id, deletedAt: null } });
    const item = await prisma.menuItem.findFirstOrThrow({ where: { venueId: venue.id, deletedAt: null, isActive: true } });

    const orderResult = await ordersService.createOrder(venue.id, admin.id, { serviceMode: 'table', tableId: table.id });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    const orderId = orderResult.value.id;
    expect(orderResult.value.pmsFolioId).toBeNull();
    expect(orderResult.value.pmsRoomNumber).toBeNull();
    expect(orderResult.value.pmsPostedAt).toBeNull();

    const addResult = await orderItemsService.addItem(venue.id, admin.id, orderId, { menuItemId: item.id, quantity: 1 });
    expect(addResult.ok).toBe(true);

    const sendResult = await lifecycleService.sendItems(venue.id, admin.id, orderId, {});
    expect(sendResult.ok).toBe(true);

    let order = await ordersService.getOrder(venue.id, orderId);
    expect(order!.pmsFolioId).toBeNull();
    expect(order!.pmsRoomNumber).toBeNull();
    expect(order!.pmsPostedAt).toBeNull();

    // Force every item served so close is reachable, without going through
    // the not-yet-built kitchen recall route — this test only cares about
    // the pms_* columns, not the display flow.
    await prisma.orderItem.updateMany({ where: { orderId }, data: { status: 'served' } });

    const closeResult = await lifecycleService.closeOrder(venue.id, admin.id, orderId);
    expect(closeResult.ok).toBe(true);
    if (closeResult.ok) {
      expect(closeResult.value.pmsFolioId).toBeNull();
      expect(closeResult.value.pmsRoomNumber).toBeNull();
      expect(closeResult.value.pmsPostedAt).toBeNull();
    }

    order = await ordersService.getOrder(venue.id, orderId);
    expect(order!.pmsFolioId).toBeNull();
    expect(order!.pmsRoomNumber).toBeNull();
    expect(order!.pmsPostedAt).toBeNull();

    await prisma.restaurantTable.update({ where: { id: table.id }, data: { status: 'free' } });
  });
});

describe('discount_total is always 0', () => {
  it('stays 0 across create, add-item, and close', async () => {
    const venue = await venueByslug('happy-bar');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const item = await prisma.menuItem.findFirstOrThrow({ where: { venueId: venue.id, deletedAt: null, isActive: true } });

    const orderResult = await ordersService.createOrder(venue.id, admin.id, { serviceMode: 'counter' });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    expect(Number(orderResult.value.discountTotal)).toBe(0);
    const orderId = orderResult.value.id;

    const addResult = await orderItemsService.addItem(venue.id, admin.id, orderId, { menuItemId: item.id, quantity: 2 });
    expect(addResult.ok).toBe(true);

    let order = await ordersService.getOrder(venue.id, orderId);
    expect(Number(order!.discountTotal)).toBe(0);

    await prisma.orderItem.updateMany({ where: { orderId }, data: { status: 'served', sentAt: new Date(), servedAt: new Date() } });
    const closeResult = await lifecycleService.closeOrder(venue.id, admin.id, orderId);
    expect(closeResult.ok).toBe(true);
    if (closeResult.ok) expect(Number(closeResult.value.discountTotal)).toBe(0);
  });
});

describe('happy_bar venues cannot enable courses', () => {
  it('rejects courses_enabled=true with COURSES_NOT_ALLOWED_FOR_BAR', async () => {
    const venue = await venueByslug('happy-bar');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });

    const result = await settingsService.updateSettings(venue.id, admin.id, { coursesEnabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: 'COURSES_NOT_ALLOWED_FOR_BAR', message: 'courses_enabled cannot be true for a happy_bar venue' },
    });

    const settings = await settingsService.getSettingsRow(venue.id);
    expect(settings!.coursesEnabled).toBe(false);
  });
});
