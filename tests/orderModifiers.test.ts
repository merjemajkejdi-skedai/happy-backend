import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';

// Dedicated fixture, separate from tests/orders.test.ts's fixture — this
// file exercises the full session 2b-ii validation matrix and needs several
// purpose-built groups per rule, which would clutter the Phase 1 fixture.
const SLUG = 'test-order-modifiers-2b-ii-fixture';

interface Fixture {
  venueId: string;
  adminUserId: string;
  pizzaId: string; // destination 'kitchen'
  sundaeId: string; // destination 'kitchen'
  crustGroupId: string; // single, required, min 1 max 1
  thinCrustId: string;
  thickCrustId: string;
  extrasGroupId: string; // multiple, not required, min 2 max 3, 4 options
  extraOptionIds: string[]; // A, B, C, D
  destinationProbeOptionId: string; // group applies_to_destination='bar', attached to Pizza (kitchen)
  unattachedOptionId: string; // real option whose group is never attached to Pizza
  freeGroupOptionIds: string[]; // pricing_mode='free', attached to Sundae
  tieredOptionIds: string[]; // pricing_mode='tiered', attached to Sundae, each tier_prices {"1":0,"2":50,"3":100}
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;

  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } }); // cascades order_items, order_item_modifiers
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });

  const groups = await prisma.modifierGroup.findMany({ where: { venueId: venue.id } });
  const items = await prisma.menuItem.findMany({ where: { venueId: venue.id } });
  await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: items.map(i => i.id) } } });
  await prisma.modifierOption.deleteMany({ where: { groupId: { in: groups.map(g => g.id) } } });
  await prisma.modifierGroup.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
}

async function setupFixture(): Promise<Fixture> {
  await destroyFixture();

  const venue = await prisma.venue.create({
    data: {
      slug: SLUG,
      name: 'Order Modifiers Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowFreeTextNotes: true,
          autoSendOnAdd: false,
          requireModifierValidation: true,
          taxRatePercent: 10,
          ticketNumberPrefix: 'M-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });

  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `fixture-${venue.id}` },
  });

  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const pizza = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Pizza', price: 1000, destination: 'kitchen' },
  });
  const sundae = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Sundae', price: 500, destination: 'kitchen' },
  });

  const crustGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Crust', type: 'single', isRequired: true, minSelect: 1, maxSelect: 1, pricingMode: 'fixed' },
  });
  const thinCrust = await prisma.modifierOption.create({ data: { groupId: crustGroup.id, name: 'Thin', priceDelta: 0 } });
  const thickCrust = await prisma.modifierOption.create({ data: { groupId: crustGroup.id, name: 'Thick', priceDelta: 50 } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: pizza.id, groupId: crustGroup.id } });

  const extrasGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Extras', type: 'multiple', isRequired: false, minSelect: 2, maxSelect: 3, pricingMode: 'fixed' },
  });
  const extraOptions = await Promise.all(
    ['A', 'B', 'C', 'D'].map(name => prisma.modifierOption.create({ data: { groupId: extrasGroup.id, name, priceDelta: 10 } })),
  );
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: pizza.id, groupId: extrasGroup.id } });

  const destinationProbeGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Bar Garnish', type: 'single', appliesToDestination: 'bar', pricingMode: 'fixed' },
  });
  const destinationProbeOption = await prisma.modifierOption.create({
    data: { groupId: destinationProbeGroup.id, name: 'Umbrella', priceDelta: 20 },
  });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: pizza.id, groupId: destinationProbeGroup.id } });

  const unattachedGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Unattached Group', type: 'single', pricingMode: 'fixed' },
  });
  const unattachedOption = await prisma.modifierOption.create({ data: { groupId: unattachedGroup.id, name: 'Ghost Option', priceDelta: 5 } });
  // Deliberately never linked via menu_item_modifier_groups.

  const freeGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Free Toppings', type: 'multiple', minSelect: 0, maxSelect: 5, pricingMode: 'free' },
  });
  const freeOptions = await Promise.all(
    ['Ketchup', 'Mustard'].map(name => prisma.modifierOption.create({ data: { groupId: freeGroup.id, name, priceDelta: 30 } })),
  );
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: sundae.id, groupId: freeGroup.id } });

  const tieredGroup = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Tiered Scoops', type: 'multiple', minSelect: 0, maxSelect: 3, pricingMode: 'tiered' },
  });
  const tierPrices = { '1': 0, '2': 50, '3': 100 };
  const tieredOptions = await Promise.all(
    ['Vanilla', 'Chocolate', 'Strawberry'].map(name =>
      prisma.modifierOption.create({ data: { groupId: tieredGroup.id, name, priceDelta: 999, tierPrices } }),
    ),
  );
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: sundae.id, groupId: tieredGroup.id } });

  return {
    venueId: venue.id,
    adminUserId: admin.id,
    pizzaId: pizza.id,
    sundaeId: sundae.id,
    crustGroupId: crustGroup.id,
    thinCrustId: thinCrust.id,
    thickCrustId: thickCrust.id,
    extrasGroupId: extrasGroup.id,
    extraOptionIds: extraOptions.map(o => o.id),
    destinationProbeOptionId: destinationProbeOption.id,
    unattachedOptionId: unattachedOption.id,
    freeGroupOptionIds: freeOptions.map(o => o.id),
    tieredOptionIds: tieredOptions.map(o => o.id),
  };
}

async function createOrder() {
  const result = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
  if (!result.ok) throw new Error('order setup failed');
  return result.value.id;
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Required group', () => {
  it('rejects zero selections with MODIFIER_GROUP_REQUIRED', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_GROUP_REQUIRED', message: '"Crust" requires a selection' },
    });
  });
});

describe('Single-type group', () => {
  it('rejects two selections with MODIFIER_MAX_EXCEEDED', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.thickCrustId, ...fx.extraOptionIds.slice(0, 2)],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_MAX_EXCEEDED', message: '"Crust" allows only one selection' },
    });
  });
});

describe('min_select / max_select at n-1, n, n+1 (Extras: min 2, max 3)', () => {
  it('rejects 1 selection (min-1) with MODIFIER_MIN_NOT_MET', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0]],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_MIN_NOT_MET', message: '"Extras" requires at least 2 selection(s)' },
    });
  });

  it('accepts 2 selections (= min)', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[1]],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts 3 selections (= max)', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, ...fx.extraOptionIds.slice(0, 3)],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects 4 selections (max+1) with MODIFIER_MAX_EXCEEDED', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, ...fx.extraOptionIds],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_MAX_EXCEEDED', message: '"Extras" allows at most 3 selection(s)' },
    });
  });
});

describe('Option not in an attached group', () => {
  it('rejects a real option whose group is never attached to this item', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[1], fx.unattachedOptionId],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_OPTION_NOT_IN_GROUP', message: '"Ghost Option" does not belong to a group attached to this item' },
    });
  });
});

describe('Duplicate selection', () => {
  it('rejects the same option id submitted twice', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[0]],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_DUPLICATE_SELECTION', message: 'The same modifier option was selected more than once' },
    });
  });
});

describe('Destination mismatch', () => {
  it("rejects a group whose applies_to_destination doesn't match the item's destination", async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[1], fx.destinationProbeOptionId],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_DESTINATION_MISMATCH', message: '"Bar Garnish" is not available for this item\'s destination' },
    });
  });
});

describe('Pricing modes', () => {
  it('free mode zeroes deltas regardless of the stored price_delta', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.sundaeId,
      modifierOptionIds: fx.freeGroupOptionIds,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modifiers.map(m => Number(m.priceDeltaSnapshot))).toEqual([0, 0]);
    expect(Number(result.value.modifiersTotal)).toBe(0);
  });

  it('tiered mode resolves by submission-order ordinal within the group, not option identity', async () => {
    const orderId = await createOrder();
    const [vanilla, chocolate, strawberry] = fx.tieredOptionIds;

    const forward = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.sundaeId,
      modifierOptionIds: [vanilla, chocolate, strawberry],
    });
    expect(forward.ok).toBe(true);
    if (forward.ok) {
      expect(forward.value.modifiers.map(m => Number(m.priceDeltaSnapshot))).toEqual([0, 50, 100]);
      expect(Number(forward.value.modifiersTotal)).toBe(150);
    }

    // Same three options, different submission order — the *last* one
    // submitted is now ordinal 1 within the group (free), proving ordinal
    // tracks submission order, not which specific option was picked.
    const orderId2 = await createOrder();
    const reordered = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId2, {
      menuItemId: fx.sundaeId,
      modifierOptionIds: [strawberry, vanilla],
    });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) {
      expect(reordered.value.modifiers.map(m => Number(m.priceDeltaSnapshot))).toEqual([0, 50]);
    }
  });
});

describe('Totals across multiple groups', () => {
  it('modifiers_total sums every selected delta; line_total = (unit_price + modifiers_total) * quantity', async () => {
    const orderId = await createOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      quantity: 2,
      // Crust: Thick (+50). Extras: A, B, C (+10 each = 30).
      modifierOptionIds: [fx.thickCrustId, ...fx.extraOptionIds.slice(0, 3)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.value.modifiersTotal)).toBe(80); // 50 + 10*3
    expect(Number(result.value.unitPriceSnapshot)).toBe(1000);
    expect(Number(result.value.lineTotal)).toBe(2160); // (1000 + 80) * 2
  });
});

describe('Modifier edit blocked after send', () => {
  it('PATCH .../modifiers on a sent item returns 409 ITEM_ALREADY_SENT', async () => {
    const orderId = await createOrder();
    const added = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[1]],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await prisma.orderItem.update({ where: { id: added.value.id }, data: { status: 'sent' } });

    const result = await orderItemsService.setItemModifiers(fx.venueId, fx.adminUserId, orderId, added.value.id, [fx.thickCrustId]);
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'ITEM_ALREADY_SENT', message: 'This item has already been sent and can no longer be edited' },
    });
  });

  it('PATCH .../modifiers on a pending item revalidates and recomputes', async () => {
    const orderId = await createOrder();
    const added = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.pizzaId,
      modifierOptionIds: [fx.thinCrustId, fx.extraOptionIds[0], fx.extraOptionIds[1]],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const result = await orderItemsService.setItemModifiers(fx.venueId, fx.adminUserId, orderId, added.value.id, [fx.thickCrustId]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.modifiers).toHaveLength(1);
      expect(result.value.modifiers[0].optionNameSnapshot).toBe('Thick');
      expect(Number(result.value.modifiersTotal)).toBe(50);
      expect(Number(result.value.lineTotal)).toBe(1050);
    }

    // Revalidation still applies — zero selections now violates Crust's required rule.
    const invalid = await orderItemsService.setItemModifiers(fx.venueId, fx.adminUserId, orderId, added.value.id, []);
    expect(invalid).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_GROUP_REQUIRED', message: '"Crust" requires a selection' },
    });
  });
});

describe('require_modifier_validation = false', () => {
  it('skips every business rule but still snapshots correctly', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireModifierValidation: false } });
    try {
      const orderId = await createOrder();
      // Zero selections for the required Crust group, plus a real option
      // from a group that isn't even attached to this item — every rule
      // this would normally break is skipped.
      const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
        menuItemId: fx.pizzaId,
        modifierOptionIds: [fx.unattachedOptionId],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.modifiers).toHaveLength(1);
      expect(result.value.modifiers[0].optionNameSnapshot).toBe('Ghost Option');
      expect(Number(result.value.modifiers[0].priceDeltaSnapshot)).toBe(5);
      expect(Number(result.value.modifiersTotal)).toBe(5);
    } finally {
      await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireModifierValidation: true } });
    }
  });

  it('still rejects a genuinely nonexistent option id (referential integrity, not a business rule)', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireModifierValidation: false } });
    try {
      const orderId = await createOrder();
      const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
        menuItemId: fx.pizzaId,
        modifierOptionIds: ['00000000-0000-0000-0000-000000000000'],
      });
      expect(result).toEqual({
        ok: false,
        error: { status: 422, code: 'MODIFIER_SELECTION_INVALID', message: 'One or more selected modifier options are invalid' },
      });
    } finally {
      await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireModifierValidation: true } });
    }
  });
});

describe('CRITICAL: snapshot immutability after a modifier option changes', () => {
  it("leaves an existing order item's modifier snapshots and totals unchanged when the option's price/tier changes later", async () => {
    const orderId = await createOrder();
    const added = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.sundaeId,
      modifierOptionIds: [fx.tieredOptionIds[0], fx.tieredOptionIds[1]],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(Number(added.value.modifiersTotal)).toBe(50); // ordinal 1 -> 0, ordinal 2 -> 50

    // Change the underlying option's tier_prices after the order item
    // already exists.
    await prisma.modifierOption.update({
      where: { id: fx.tieredOptionIds[0] },
      data: { tierPrices: { '1': 999, '2': 999 } },
    });

    const order = await ordersService.getOrder(fx.venueId, orderId);
    const item = order!.items.find(i => i.id === added.value.id)!;
    expect(Number(item.modifiersTotal)).toBe(50);
    expect(Number(item.lineTotal)).toBe(550); // (500 + 50) * 1
    expect(item.modifiers.map(m => Number(m.priceDeltaSnapshot))).toEqual([0, 50]);

    // Revert so this test is not order-dependent on later ones.
    await prisma.modifierOption.update({
      where: { id: fx.tieredOptionIds[0] },
      data: { tierPrices: { '1': 0, '2': 50, '3': 100 } },
    });
  });
});
