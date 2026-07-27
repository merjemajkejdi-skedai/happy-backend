import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as modifiersService from '../src/modules/menu/modifiersService';

async function venueByslug(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) throw new Error(`seed venue missing: ${slug}`);
  return venue;
}

// Isolated fixture venue so group-limit/attachment tests can freely
// create/delete groups and items without disturbing seeded fixture data
// shared by other test files.
describe('Modifier groups — Phase 2 session 2b-i', () => {
  const SLUG = 'test-modifiers-2b-i-fixture';
  let venueId: string;

  async function destroyFixture() {
    const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
    if (!venue) return;
    const items = await prisma.menuItem.findMany({ where: { venueId: venue.id } });
    const groups = await prisma.modifierGroup.findMany({ where: { venueId: venue.id } });
    await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: items.map(i => i.id) } } });
    await prisma.modifierOption.deleteMany({ where: { groupId: { in: groups.map(g => g.id) } } });
    await prisma.modifierGroup.deleteMany({ where: { venueId: venue.id } });
    await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
    await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
    await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
  }

  beforeAll(async () => {
    await destroyFixture();
    const venue = await prisma.venue.create({
      data: { slug: SLUG, name: '2b-i Fixture', venueType: 'happy_hybrid', settings: { create: {} } },
    });
    venueId = venue.id;
  });

  afterAll(async () => {
    await destroyFixture();
  });

  describe('group rule validation (single/multiple/required — Phase 1, reconfirmed)', () => {
    it("rejects max_select > 1 for type='single'", async () => {
      const result = await modifiersService.createModifierGroup(venueId, { name: 'Size', type: 'single', maxSelect: 2 });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_MAX_SELECT' }) });
    });

    it("rejects max_select < min_select for type='multiple'", async () => {
      const result = await modifiersService.createModifierGroup(venueId, {
        name: 'Toppings', type: 'multiple', minSelect: 3, maxSelect: 2,
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_MAX_SELECT' }) });
    });

    it('rejects is_required with min_select 0', async () => {
      const result = await modifiersService.createModifierGroup(venueId, {
        name: 'Required Choice', type: 'single', isRequired: true, minSelect: 0,
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_MIN_SELECT' }) });
    });
  });

  describe('applies_to_destination validation', () => {
    it('rejects a destination invalid for the venue type', async () => {
      const restoVenue = await venueByslug('happy-resto');
      const result = await modifiersService.createModifierGroup(restoVenue.id, {
        name: 'Bar Probe Group', type: 'single', appliesToDestination: 'bar',
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'DESTINATION_NOT_AVAILABLE' }) });
    });

    it('allows a valid destination and null (no restriction)', async () => {
      const kitchen = await modifiersService.createModifierGroup(venueId, {
        name: 'Kitchen Probe Group', type: 'single', appliesToDestination: 'kitchen',
      });
      expect(kitchen.ok).toBe(true);
      const none = await modifiersService.createModifierGroup(venueId, { name: 'Unrestricted Group', type: 'single' });
      expect(none.ok).toBe(true);

      for (const r of [kitchen, none]) {
        if (r.ok) await prisma.modifierGroup.delete({ where: { id: r.value.id } });
      }
    });
  });

  describe('tier_prices validation', () => {
    it('rejects tier_prices on an option whose group is not pricing_mode=tiered', async () => {
      const group = await modifiersService.createModifierGroup(venueId, { name: 'Fixed Group', type: 'single', pricingMode: 'fixed' });
      expect(group.ok).toBe(true);
      if (!group.ok) return;

      const result = await modifiersService.createModifierOption(venueId, group.value.id, {
        name: 'Large', tierPrices: { '1': 0 },
      });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_TIER_PRICES' }) });

      await prisma.modifierGroup.delete({ where: { id: group.value.id } });
    });

    it.each([
      [{ '0': 5 }, 'non-positive key'],
      [{ 'a': 5 }, 'non-numeric key'],
      [{ '1': -5 }, 'negative value'],
      [{ '1': 'free' }, 'non-numeric value'],
      [[1, 2], 'an array instead of an object'],
    ] as const)('rejects malformed tier_prices: %s (%s)', async tierPrices => {
      const group = await modifiersService.createModifierGroup(venueId, { name: 'Tiered Group', type: 'single', pricingMode: 'tiered' });
      expect(group.ok).toBe(true);
      if (!group.ok) return;

      const result = await modifiersService.createModifierOption(venueId, group.value.id, { name: 'Large', tierPrices });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_TIER_PRICES');

      await prisma.modifierGroup.delete({ where: { id: group.value.id } });
    });

    it('accepts valid tier_prices on a tiered group, and rejects them being added later if the group is not tiered', async () => {
      const group = await modifiersService.createModifierGroup(venueId, { name: 'Tiered Group 2', type: 'single', pricingMode: 'tiered' });
      expect(group.ok).toBe(true);
      if (!group.ok) return;

      const created = await modifiersService.createModifierOption(venueId, group.value.id, {
        name: 'Large', tierPrices: { '1': 0, '2': 50, '3': 100 },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const fixedGroup = await modifiersService.updateModifierGroup(venueId, group.value.id, { pricingMode: 'fixed' });
      expect(fixedGroup.ok).toBe(true);

      const updated = await modifiersService.updateModifierOption(venueId, created.value.id, { tierPrices: { '1': 0 } });
      expect(updated).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_TIER_PRICES' }) });

      await prisma.modifierGroup.delete({ where: { id: group.value.id } });
    });
  });

  describe('modifier_max_groups_per_item (default 10)', () => {
    it('rejects attaching more than the venue limit to one item', async () => {
      const category = await prisma.menuCategory.create({ data: { venueId, name: 'Cap Probe Category' } });
      const item = await prisma.menuItem.create({
        data: { venueId, categoryId: category.id, name: 'Cap Probe Item', price: 1, destination: 'none' },
      });
      const groups = await Promise.all(
        Array.from({ length: 11 }, (_, i) => prisma.modifierGroup.create({ data: { venueId, name: `Cap Group ${i}`, type: 'single' } })),
      );

      const result = await modifiersService.setItemModifierGroups(venueId, item.id, groups.map(g => g.id));
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'MODIFIER_GROUP_LIMIT_EXCEEDED' }) });

      const within = await modifiersService.setItemModifierGroups(venueId, item.id, groups.slice(0, 10).map(g => g.id));
      expect(within.ok).toBe(true);

      await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: item.id } });
      await prisma.modifierGroup.deleteMany({ where: { id: { in: groups.map(g => g.id) } } });
      await prisma.menuItem.delete({ where: { id: item.id } });
      await prisma.menuCategory.delete({ where: { id: category.id } });
    });
  });

  describe('delete blocked while attached', () => {
    it('returns 409 MODIFIER_GROUP_HAS_ATTACHED_ITEMS while attached to an active item, then succeeds once detached', async () => {
      const category = await prisma.menuCategory.create({ data: { venueId, name: 'Delete Probe Category' } });
      const item = await prisma.menuItem.create({
        data: { venueId, categoryId: category.id, name: 'Delete Probe Item', price: 1, destination: 'none' },
      });
      const group = await modifiersService.createModifierGroup(venueId, { name: 'Attached Group', type: 'single' });
      expect(group.ok).toBe(true);
      if (!group.ok) return;

      await modifiersService.setItemModifierGroups(venueId, item.id, [group.value.id]);

      const blocked = await modifiersService.deleteModifierGroup(venueId, group.value.id);
      expect(blocked).toEqual({ ok: false, error: expect.objectContaining({ code: 'MODIFIER_GROUP_HAS_ATTACHED_ITEMS' }) });

      await modifiersService.setItemModifierGroups(venueId, item.id, []);
      const allowed = await modifiersService.deleteModifierGroup(venueId, group.value.id);
      expect(allowed.ok).toBe(true);

      await prisma.menuItem.delete({ where: { id: item.id } });
      await prisma.menuCategory.delete({ where: { id: category.id } });
    });
  });

  describe('duplicate', () => {
    it('copies the group config and options but not item attachments', async () => {
      const category = await prisma.menuCategory.create({ data: { venueId, name: 'Duplicate Probe Category' } });
      const item = await prisma.menuItem.create({
        data: { venueId, categoryId: category.id, name: 'Duplicate Probe Item', price: 1, destination: 'none' },
      });
      const original = await modifiersService.createModifierGroup(venueId, { name: 'Original Group', type: 'multiple', pricingMode: 'tiered' });
      expect(original.ok).toBe(true);
      if (!original.ok) return;
      await modifiersService.createModifierOption(venueId, original.value.id, { name: 'Opt A', tierPrices: { '1': 0 } });
      await modifiersService.setItemModifierGroups(venueId, item.id, [original.value.id]);

      const duplicated = await modifiersService.duplicateModifierGroup(venueId, original.value.id);
      expect(duplicated.ok).toBe(true);
      if (!duplicated.ok) return;

      expect(duplicated.value.name).toBe('Original Group (copy)');
      expect(duplicated.value.pricingMode).toBe('tiered');
      expect(duplicated.value.options.map(o => o.name)).toEqual(['Opt A']);
      expect(duplicated.value.id).not.toBe(original.value.id);

      const links = await prisma.menuItemModifierGroup.findMany({ where: { groupId: duplicated.value.id } });
      expect(links).toHaveLength(0);

      await modifiersService.setItemModifierGroups(venueId, item.id, []);
      await prisma.modifierGroup.deleteMany({ where: { id: { in: [original.value.id, duplicated.value.id] } } });
      await prisma.menuItem.delete({ where: { id: item.id } });
      await prisma.menuCategory.delete({ where: { id: category.id } });
    });
  });

  describe('reorder', () => {
    it('sets sort_order positionally from the given group_ids order', async () => {
      const a = await modifiersService.createModifierGroup(venueId, { name: 'Reorder A', type: 'single' });
      const b = await modifiersService.createModifierGroup(venueId, { name: 'Reorder B', type: 'single' });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      const result = await modifiersService.reorderModifierGroups(venueId, [b.value.id, a.value.id]);
      expect(result).toEqual({
        ok: true,
        value: [{ groupId: b.value.id, sortOrder: 0 }, { groupId: a.value.id, sortOrder: 1 }],
      });

      const refetchedA = await prisma.modifierGroup.findUniqueOrThrow({ where: { id: a.value.id } });
      const refetchedB = await prisma.modifierGroup.findUniqueOrThrow({ where: { id: b.value.id } });
      expect(refetchedB.sortOrder).toBe(0);
      expect(refetchedA.sortOrder).toBe(1);

      await prisma.modifierGroup.deleteMany({ where: { id: { in: [a.value.id, b.value.id] } } });
    });
  });

  describe('include_inactive listing', () => {
    it('excludes is_active=false groups by default, includes them with includeInactive', async () => {
      const active = await modifiersService.createModifierGroup(venueId, { name: 'Active Listing Group', type: 'single' });
      const inactive = await modifiersService.createModifierGroup(venueId, { name: 'Inactive Listing Group', type: 'single', isActive: false });
      expect(active.ok && inactive.ok).toBe(true);
      if (!active.ok || !inactive.ok) return;

      const defaultList = await modifiersService.listModifierGroups(venueId);
      const defaultNames = defaultList.groups.map(g => g.name);
      expect(defaultNames).toContain('Active Listing Group');
      expect(defaultNames).not.toContain('Inactive Listing Group');

      const fullList = await modifiersService.listModifierGroups(venueId, { includeInactive: true });
      expect(fullList.groups.map(g => g.name)).toContain('Inactive Listing Group');

      await prisma.modifierGroup.deleteMany({ where: { id: { in: [active.value.id, inactive.value.id] } } });
    });
  });

  describe('getItemModifierGroups', () => {
    it('returns resolved groups with options and defaults, in attachment sort order', async () => {
      const category = await prisma.menuCategory.create({ data: { venueId, name: 'Resolved Probe Category' } });
      const item = await prisma.menuItem.create({
        data: { venueId, categoryId: category.id, name: 'Resolved Probe Item', price: 1, destination: 'none' },
      });
      const group = await modifiersService.createModifierGroup(venueId, { name: 'Resolved Group', type: 'single' });
      expect(group.ok).toBe(true);
      if (!group.ok) return;
      await modifiersService.createModifierOption(venueId, group.value.id, { name: 'Default Opt', isDefault: true });

      await modifiersService.setItemModifierGroups(venueId, item.id, [group.value.id]);

      const resolved = await modifiersService.getItemModifierGroups(venueId, item.id);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value).toHaveLength(1);
      expect(resolved.value[0].name).toBe('Resolved Group');
      expect(resolved.value[0].options.map(o => ({ name: o.name, isDefault: o.isDefault }))).toEqual([
        { name: 'Default Opt', isDefault: true },
      ]);

      await modifiersService.setItemModifierGroups(venueId, item.id, []);
      await prisma.modifierGroup.delete({ where: { id: group.value.id } });
      await prisma.menuItem.delete({ where: { id: item.id } });
      await prisma.menuCategory.delete({ where: { id: category.id } });
    });
  });
});
