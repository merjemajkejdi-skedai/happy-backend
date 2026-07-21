import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Response } from 'express';
import { prisma } from '../src/db/prisma';
import { requirePermission } from '../src/middleware/rbac';
import * as categoriesService from '../src/modules/menu/categoriesService';
import * as itemsService from '../src/modules/menu/itemsService';
import { getMenuTree } from '../src/modules/menu/treeService';

async function venueByslug(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) throw new Error(`seed venue missing: ${slug}`);
  return venue;
}

describe('Destination validation — all three seeded venues', () => {
  it("happy-resto (happy_restaurant): rejects 'bar', allows 'kitchen' and 'none'", async () => {
    const venue = await venueByslug('happy-resto');

    const rejected = await categoriesService.createCategory(venue.id, { name: 'Bar Probe Category', defaultDestination: 'bar' });
    expect(rejected).toEqual({
      ok: false,
      error: { status: 422, code: 'DESTINATION_NOT_AVAILABLE', message: "destination 'bar' is not available for a happy_restaurant venue" },
    });

    const kitchen = await categoriesService.createCategory(venue.id, { name: 'Kitchen Probe Category', defaultDestination: 'kitchen' });
    expect(kitchen.ok).toBe(true);
    const none = await categoriesService.createCategory(venue.id, { name: 'None Probe Category', defaultDestination: 'none' });
    expect(none.ok).toBe(true);

    for (const r of [kitchen, none]) {
      if (r.ok) await categoriesService.deleteCategory(venue.id, r.value.id);
    }
  });

  it("happy-bar (happy_bar): rejects 'kitchen', allows 'bar' and 'none'", async () => {
    const venue = await venueByslug('happy-bar');

    const rejected = await categoriesService.createCategory(venue.id, { name: 'Kitchen Probe Category', defaultDestination: 'kitchen' });
    expect(rejected).toEqual({
      ok: false,
      error: { status: 422, code: 'DESTINATION_NOT_AVAILABLE', message: "destination 'kitchen' is not available for a happy_bar venue" },
    });

    const bar = await categoriesService.createCategory(venue.id, { name: 'Bar Probe Category', defaultDestination: 'bar' });
    expect(bar.ok).toBe(true);
    const none = await categoriesService.createCategory(venue.id, { name: 'None Probe Category', defaultDestination: 'none' });
    expect(none.ok).toBe(true);

    for (const r of [bar, none]) {
      if (r.ok) await categoriesService.deleteCategory(venue.id, r.value.id);
    }
  });

  it('happy-hybrid (happy_hybrid): allows kitchen, bar, and none', async () => {
    const venue = await venueByslug('happy-hybrid');

    const kitchen = await categoriesService.createCategory(venue.id, { name: 'Kitchen Probe Category', defaultDestination: 'kitchen' });
    const bar = await categoriesService.createCategory(venue.id, { name: 'Bar Probe Category', defaultDestination: 'bar' });
    const none = await categoriesService.createCategory(venue.id, { name: 'None Probe Category', defaultDestination: 'none' });
    expect(kitchen.ok).toBe(true);
    expect(bar.ok).toBe(true);
    expect(none.ok).toBe(true);

    for (const r of [kitchen, bar, none]) {
      if (r.ok) await categoriesService.deleteCategory(venue.id, r.value.id);
    }
  });

  it('destination validation also applies to items overriding their category default', async () => {
    const venue = await venueByslug('happy-resto');
    const category = await categoriesService.createCategory(venue.id, { name: 'Item Destination Probe Category', defaultDestination: 'kitchen' });
    expect(category.ok).toBe(true);
    if (!category.ok) return;

    const rejected = await itemsService.createItem(venue.id, {
      categoryId: category.value.id, name: 'Bar Item Probe', price: 5, destination: 'bar',
    });
    expect(rejected).toEqual({
      ok: false,
      error: { status: 422, code: 'DESTINATION_NOT_AVAILABLE', message: "destination 'bar' is not available for a happy_restaurant venue" },
    });

    await categoriesService.deleteCategory(venue.id, category.value.id);
  });
});

describe('Course validation — happy-bar (courses always disabled there)', () => {
  it('rejects a non-null default_course_number with 422 COURSES_DISABLED', async () => {
    const venue = await venueByslug('happy-bar');

    const rejected = await categoriesService.createCategory(venue.id, { name: 'Course Probe Category', defaultDestination: 'bar', defaultCourseNumber: 1 });
    expect(rejected).toEqual({
      ok: false,
      error: { status: 422, code: 'COURSES_DISABLED', message: 'course_number must be null when courses are disabled for this venue' },
    });
  });

  it('allows a null course_number', async () => {
    const venue = await venueByslug('happy-bar');
    const ok = await categoriesService.createCategory(venue.id, { name: 'Null Course Probe Category', defaultDestination: 'bar', defaultCourseNumber: null });
    expect(ok.ok).toBe(true);
    if (ok.ok) await categoriesService.deleteCategory(venue.id, ok.value.id);
  });

  it('rejects a non-null course_number on an item too', async () => {
    const venue = await venueByslug('happy-bar');
    const category = await categoriesService.createCategory(venue.id, { name: 'Item Course Probe Category', defaultDestination: 'bar' });
    expect(category.ok).toBe(true);
    if (!category.ok) return;

    const rejected = await itemsService.createItem(venue.id, {
      categoryId: category.value.id, name: 'Course Item Probe', price: 5, courseNumber: 2,
    });
    expect(rejected).toEqual({
      ok: false,
      error: { status: 422, code: 'COURSES_DISABLED', message: 'course_number must be null when courses are disabled for this venue' },
    });

    await categoriesService.deleteCategory(venue.id, category.value.id);
  });
});

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = vi.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

describe('86-toggle vs menu-write permission separation', () => {
  it.each(['waiter', 'kitchen'] as const)('%s is permitted to toggle availability (menu.availability)', role => {
    const req = { auth: { userId: 'u1', venueId: 'v1', role } } as any;
    const res = mockRes();
    const next = vi.fn();
    requirePermission('menu.availability')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['waiter', 'kitchen'] as const)('%s is denied editing the menu (menu.write)', role => {
    const req = { auth: { userId: 'u1', venueId: 'v1', role } } as any;
    const res = mockRes();
    const next = vi.fn();
    requirePermission('menu.write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) }),
    );
  });

  it('admin is permitted both menu.availability and menu.write', () => {
    for (const permission of ['menu.availability', 'menu.write'] as const) {
      const req = { auth: { userId: 'u1', venueId: 'v1', role: 'admin' } } as any;
      const res = mockRes();
      const next = vi.fn();
      requirePermission(permission)(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});

describe('Full menu tree — shape and sorting', () => {
  const SLUG = 'test-menu-tree-fixture';
  let venueId: string;

  // Menu tables are RESTRICT (not CASCADE) on venue_id, so the venue can't be
  // deleted until its categories/items/groups/options/links are gone first.
  async function destroyMenuTreeFixture() {
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
    await destroyMenuTreeFixture();
    const venue = await prisma.venue.create({
      data: { slug: SLUG, name: 'Menu Tree Fixture', venueType: 'happy_hybrid', settings: { create: {} } },
    });
    venueId = venue.id;

    const categoryB = await prisma.menuCategory.create({
      data: { venueId, name: 'Zebra Category', sortOrder: 1 },
    });
    const categoryA = await prisma.menuCategory.create({
      data: { venueId, name: 'Apple Category', sortOrder: 0 },
    });
    const inactiveCategory = await prisma.menuCategory.create({
      data: { venueId, name: 'Inactive Category', sortOrder: 0, isActive: false },
    });
    await prisma.menuItem.create({
      data: { venueId, categoryId: inactiveCategory.id, name: 'Orphaned Item', price: 1, destination: 'none' },
    });

    const itemZ = await prisma.menuItem.create({
      data: { venueId, categoryId: categoryA.id, name: 'Zucchini', price: 4, destination: 'kitchen', sortOrder: 1 },
    });
    const itemA = await prisma.menuItem.create({
      data: { venueId, categoryId: categoryA.id, name: 'Apple Pie', price: 6, destination: 'kitchen', sortOrder: 0 },
    });
    await prisma.menuItem.create({
      data: { venueId, categoryId: categoryA.id, name: 'Deleted Item', price: 1, destination: 'kitchen', deletedAt: new Date() },
    });
    await prisma.menuItem.create({
      data: { venueId, categoryId: categoryB.id, name: 'Inactive Item', price: 1, destination: 'kitchen', isActive: false },
    });

    const group = await prisma.modifierGroup.create({
      data: { venueId, name: 'Toppings', type: 'multiple', sortOrder: 0 },
    });
    await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Extra Cheese', priceDelta: 1.5, sortOrder: 1 } });
    await prisma.modifierOption.create({ data: { groupId: group.id, name: 'No Cheese', priceDelta: 0, sortOrder: 0 } });
    await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Deleted Option', priceDelta: 0, deletedAt: new Date() } });

    await prisma.menuItemModifierGroup.create({ data: { menuItemId: itemA.id, groupId: group.id, sortOrder: 0 } });

    void itemZ;
  });

  afterAll(async () => {
    await destroyMenuTreeFixture();
  });

  it('excludes inactive/soft-deleted categories, items, and options', async () => {
    const tree = await getMenuTree(venueId);
    const categoryNames = tree.categories.map(c => c.name);
    expect(categoryNames).not.toContain('Inactive Category');

    const allItemNames = tree.categories.flatMap(c => c.items.map(i => i.name));
    expect(allItemNames).not.toContain('Orphaned Item');
    expect(allItemNames).not.toContain('Deleted Item');
    expect(allItemNames).not.toContain('Inactive Item');
  });

  it('sorts categories by sort_order then name', async () => {
    const tree = await getMenuTree(venueId);
    expect(tree.categories.map(c => c.name)).toEqual(['Apple Category', 'Zebra Category']);
  });

  it('sorts items within a category by sort_order then name', async () => {
    const tree = await getMenuTree(venueId);
    const apple = tree.categories.find(c => c.name === 'Apple Category')!;
    expect(apple.items.map(i => i.name)).toEqual(['Apple Pie', 'Zucchini']);
  });

  it('attaches modifier groups and options, sorted, with numeric price fields', async () => {
    const tree = await getMenuTree(venueId);
    const apple = tree.categories.find(c => c.name === 'Apple Category')!;
    const itemWithGroup = apple.items.find(i => i.name === 'Apple Pie')!;

    expect(itemWithGroup.modifierGroups).toHaveLength(1);
    const toppings = itemWithGroup.modifierGroups[0];
    expect(toppings.name).toBe('Toppings');
    expect(toppings.options.map(o => o.name)).toEqual(['No Cheese', 'Extra Cheese']);
    expect(toppings.options.every(o => typeof o.priceDelta === 'number')).toBe(true);

    expect(typeof itemWithGroup.price).toBe('number');
    expect(itemWithGroup.price).toBe(6);

    // No group was ever attached to Zucchini.
    const zucchini = apple.items.find(i => i.name === 'Zucchini')!;
    expect(zucchini.modifierGroups).toEqual([]);
  });

  it('returns a stable, non-empty version/ETag value', async () => {
    const tree1 = await getMenuTree(venueId);
    const tree2 = await getMenuTree(venueId);
    expect(tree1.version).toBeTruthy();
    expect(tree1.version).toBe(tree2.version);
  });
});
