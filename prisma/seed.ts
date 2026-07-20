// Idempotent dev seed — safe to run repeatedly (`npm run db:seed`).
// Creates three fully-populated venues, one per venue type, so every
// venue-type behavior difference (courses, counter service, kitchen/bar
// display, table naming, login method) is testable from day one.
//
// No orders are seeded — those are created through the API in later steps.
import { PrismaClient, Prisma } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const PIN_PEPPER = process.env.PIN_PEPPER;
if (!PIN_PEPPER) throw new Error('PIN_PEPPER is not set — copy .env.example to .env and configure it.');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function pinLookup(pin: string): string {
  return crypto.createHmac('sha256', PIN_PEPPER!).update(pin).digest('hex');
}

const PASSWORD = 'Passw0rd!';
const ROLE_PINS = { waiter: '1111', kitchen: '2222', admin: '3333' } as const;

// ── Idempotent upsert helpers ────────────────────────────────────────────────
// Several uniqueness rules in this schema are partial unique indexes
// (hand-added raw SQL — see docs/SCHEMA.md), which Prisma's typed API can't
// see, so `upsert()` isn't usable for those models. These helpers do the
// equivalent findFirst-then-create/update by hand.

async function upsertArea(venueId: string, name: string, sortOrder: number) {
  const existing = await prisma.area.findFirst({ where: { venueId, name } });
  if (existing) {
    return prisma.area.update({ where: { id: existing.id }, data: { sortOrder, isActive: true, deletedAt: null } });
  }
  return prisma.area.create({ data: { venueId, name, sortOrder } });
}

async function upsertTable(
  venueId: string,
  areaId: string,
  input: { tableNumber?: number; tableName?: string; seats: number; sortOrder: number },
) {
  const where: Prisma.RestaurantTableWhereInput = { venueId };
  if (input.tableNumber != null) where.tableNumber = input.tableNumber;
  if (input.tableName != null) where.tableName = input.tableName;
  const existing = await prisma.restaurantTable.findFirst({ where });
  if (existing) {
    return prisma.restaurantTable.update({
      where: { id: existing.id },
      data: { areaId, seats: input.seats, sortOrder: input.sortOrder, isActive: true, deletedAt: null },
    });
  }
  return prisma.restaurantTable.create({
    data: { venueId, areaId, tableNumber: input.tableNumber, tableName: input.tableName, seats: input.seats, sortOrder: input.sortOrder },
  });
}

async function upsertCategory(
  venueId: string,
  input: { name: string; destination: 'kitchen' | 'bar'; defaultCourseNumber?: number; sortOrder: number },
) {
  const existing = await prisma.menuCategory.findFirst({ where: { venueId, name: input.name } });
  const data = {
    defaultDestination: input.destination,
    defaultCourseNumber: input.defaultCourseNumber ?? null,
    sortOrder: input.sortOrder,
    isActive: true,
    deletedAt: null,
  };
  if (existing) return prisma.menuCategory.update({ where: { id: existing.id }, data });
  return prisma.menuCategory.create({ data: { venueId, name: input.name, ...data } });
}

async function upsertItem(
  venueId: string,
  categoryId: string,
  input: { name: string; price: number; destination: 'kitchen' | 'bar'; courseNumber?: number; sortOrder: number },
) {
  const existing = await prisma.menuItem.findFirst({ where: { venueId, name: input.name } });
  const data = {
    categoryId,
    price: input.price,
    destination: input.destination,
    courseNumber: input.courseNumber ?? null,
    sortOrder: input.sortOrder,
    isActive: true,
    isAvailable: true,
    deletedAt: null,
  };
  if (existing) return prisma.menuItem.update({ where: { id: existing.id }, data });
  return prisma.menuItem.create({ data: { venueId, name: input.name, ...data } });
}

async function upsertModifierGroup(
  venueId: string,
  input: { name: string; type: 'single' | 'multiple'; isRequired: boolean; minSelect: number; maxSelect: number | null; sortOrder: number },
) {
  const existing = await prisma.modifierGroup.findFirst({ where: { venueId, name: input.name } });
  const data = {
    type: input.type,
    isRequired: input.isRequired,
    minSelect: input.minSelect,
    maxSelect: input.maxSelect,
    sortOrder: input.sortOrder,
    deletedAt: null,
  };
  if (existing) return prisma.modifierGroup.update({ where: { id: existing.id }, data });
  return prisma.modifierGroup.create({ data: { venueId, name: input.name, ...data } });
}

async function upsertModifierOption(groupId: string, input: { name: string; priceDelta: number; sortOrder: number }) {
  const existing = await prisma.modifierOption.findFirst({ where: { groupId, name: input.name } });
  const data = { priceDelta: input.priceDelta, sortOrder: input.sortOrder, isActive: true, deletedAt: null };
  if (existing) return prisma.modifierOption.update({ where: { id: existing.id }, data });
  return prisma.modifierOption.create({ data: { groupId, name: input.name, ...data } });
}

async function upsertUser(
  venueId: string,
  input: { role: 'waiter' | 'kitchen' | 'admin'; fullName: string; email: string },
) {
  const pin = ROLE_PINS[input.role];
  const [passwordHash, pinHash] = await Promise.all([bcrypt.hash(PASSWORD, 10), bcrypt.hash(pin, 10)]);
  const data = {
    fullName: input.fullName,
    email: input.email,
    passwordHash,
    pinHash,
    pinLookup: pinLookup(pin),
    isActive: true,
    deletedAt: null,
  };
  const existing = await prisma.user.findFirst({ where: { venueId, role: input.role } });
  if (existing) return prisma.user.update({ where: { id: existing.id }, data });
  return prisma.user.create({ data: { venueId, role: input.role, ...data } });
}

// ── Venue data ───────────────────────────────────────────────────────────────

type Destination = 'kitchen' | 'bar';

interface ItemSpec { name: string; price: number; courseNumber?: number }
interface CategorySpec { name: string; destination: Destination; defaultCourseNumber?: number; items: ItemSpec[] }
interface ModifierSpec {
  name: string;
  type: 'single' | 'multiple';
  isRequired: boolean;
  minSelect: number;
  maxSelect: number | null;
  options: { name: string; priceDelta: number }[];
  attachTo: string[]; // menu item names
}
interface TableSpec { tableNumber?: number; tableName?: string; seats?: number }
interface AreaSpec { name: string; tables: TableSpec[] }

interface VenueSpec {
  slug: string;
  name: string;
  venueType: 'happy_restaurant' | 'happy_bar' | 'happy_hybrid';
  settings: {
    coursesEnabled: boolean;
    tablesEnabled: boolean;
    counterServiceEnabled: boolean;
    requireTableForOrder?: boolean;
    ticketNumberPrefix?: string;
    kitchenDisplayEnabled: boolean;
    barDisplayEnabled: boolean;
    tableNamingMode: 'number' | 'name' | 'both';
    loginMethod: 'pin' | 'email' | 'both';
  };
  areas: AreaSpec[];
  categories: CategorySpec[];
  modifiers: ModifierSpec[];
}

const COOKING_TEMP: Omit<ModifierSpec, 'attachTo'> = {
  name: 'Cooking Temperature',
  type: 'single',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  options: [{ name: 'Rare', priceDelta: 0 }, { name: 'Medium', priceDelta: 0 }, { name: 'Well Done', priceDelta: 0 }],
};
const EXTRAS: Omit<ModifierSpec, 'attachTo'> = {
  name: 'Extras',
  type: 'multiple',
  isRequired: false,
  minSelect: 0,
  maxSelect: 3,
  options: [{ name: 'Extra Cheese', priceDelta: 150 }, { name: 'Bacon', priceDelta: 200 }, { name: 'Mushrooms', priceDelta: 150 }],
};
const ICE: Omit<ModifierSpec, 'attachTo'> = {
  name: 'Ice',
  type: 'single',
  isRequired: false,
  minSelect: 0,
  maxSelect: 1,
  options: [{ name: 'No Ice', priceDelta: 0 }, { name: 'Regular Ice', priceDelta: 0 }, { name: 'Extra Ice', priceDelta: 0 }],
};

const RESTAURANT_FOOD_CATEGORIES: CategorySpec[] = [
  {
    name: 'Starters', destination: 'kitchen', defaultCourseNumber: 1,
    items: [
      { name: 'Bruschetta', price: 450, courseNumber: 1 },
      { name: 'Caesar Salad', price: 600, courseNumber: 1 },
      { name: 'Soup of the Day', price: 400, courseNumber: 1 },
    ],
  },
  {
    name: 'Mains', destination: 'kitchen', defaultCourseNumber: 2,
    items: [
      { name: 'Grilled Steak', price: 1800, courseNumber: 2 },
      { name: 'Margherita Pizza', price: 900, courseNumber: 2 },
      { name: 'Grilled Salmon', price: 1600, courseNumber: 2 },
      { name: 'Pasta Carbonara', price: 1000, courseNumber: 2 },
      { name: 'Chicken Fillet', price: 1200, courseNumber: 2 },
    ],
  },
  {
    name: 'Desserts', destination: 'kitchen', defaultCourseNumber: 3,
    items: [
      { name: 'Tiramisu', price: 500, courseNumber: 3 },
      { name: 'Panna Cotta', price: 450, courseNumber: 3 },
      { name: 'Chocolate Cake', price: 550, courseNumber: 3 },
    ],
  },
];

const BAR_CATEGORIES: CategorySpec[] = [
  {
    name: 'Cocktails', destination: 'bar',
    items: [
      { name: 'Mojito', price: 700 },
      { name: 'Margarita', price: 750 },
      { name: 'Old Fashioned', price: 850 },
      { name: 'Negroni', price: 800 },
      { name: 'Aperol Spritz', price: 700 },
    ],
  },
];

const VENUES: VenueSpec[] = [
  {
    slug: 'happy-resto',
    name: 'Happy Resto',
    venueType: 'happy_restaurant',
    settings: {
      coursesEnabled: true,
      tablesEnabled: true,
      counterServiceEnabled: false,
      kitchenDisplayEnabled: true,
      barDisplayEnabled: false,
      tableNamingMode: 'both',
      loginMethod: 'pin',
    },
    areas: [
      {
        name: 'Main Dining',
        tables: [
          { tableNumber: 1, tableName: 'Window 1' },
          { tableNumber: 2, tableName: 'Window 2' },
          { tableNumber: 3, tableName: 'Corner 3' },
          { tableNumber: 4, tableName: 'Center 4' },
        ],
      },
      {
        name: 'Terrace',
        tables: [
          { tableNumber: 5, tableName: 'Terrace 1' },
          { tableNumber: 6, tableName: 'Terrace 2' },
          { tableNumber: 7, tableName: 'Terrace 3' },
        ],
      },
    ],
    categories: [
      ...RESTAURANT_FOOD_CATEGORIES,
      // happy_restaurant has no bar display — drinks still route to kitchen.
      {
        name: 'Drinks', destination: 'kitchen',
        items: [
          { name: 'House Wine (Glass)', price: 500 },
          { name: 'Craft Beer', price: 400 },
          { name: 'Sparkling Water', price: 200 },
          { name: 'Iced Tea', price: 300 },
          { name: 'Espresso', price: 250 },
        ],
      },
    ],
    modifiers: [
      { ...COOKING_TEMP, attachTo: ['Grilled Steak'] },
      { ...EXTRAS, attachTo: ['Margherita Pizza', 'Chicken Fillet'] },
      { ...ICE, attachTo: ['Iced Tea'] },
    ],
  },
  {
    slug: 'happy-bar',
    name: 'Happy Bar',
    venueType: 'happy_bar',
    settings: {
      coursesEnabled: false, // hard rule for bars
      tablesEnabled: true,
      counterServiceEnabled: true,
      requireTableForOrder: false,
      ticketNumberPrefix: 'B',
      kitchenDisplayEnabled: false,
      barDisplayEnabled: true,
      tableNamingMode: 'name',
      loginMethod: 'both',
    },
    areas: [
      {
        name: 'Bar',
        tables: [
          { tableName: 'Bar Seat 1' },
          { tableName: 'Bar Seat 2' },
          { tableName: 'Bar Seat 3' },
          { tableName: 'Bar Seat 4' },
        ],
      },
      {
        name: 'Lounge',
        tables: [
          { tableName: 'Lounge Sofa A' },
          { tableName: 'Lounge Sofa B' },
          { tableName: 'Lounge Table C' },
        ],
      },
    ],
    categories: [
      ...BAR_CATEGORIES,
      {
        name: 'Beer & Wine', destination: 'bar',
        items: [
          { name: 'Draft Beer', price: 400 },
          { name: 'Bottled Lager', price: 450 },
          { name: 'House Red Wine', price: 500 },
          { name: 'House White Wine', price: 500 },
          { name: 'Prosecco', price: 600 },
        ],
      },
      // Food still routes to kitchen even though this venue has no kitchen
      // display — the general destination rule has no bar-specific exception.
      {
        name: 'Bar Bites', destination: 'kitchen',
        items: [
          { name: 'Bar Burger', price: 900 },
          { name: 'Loaded Fries', price: 550 },
          { name: 'Chicken Wings', price: 700 },
          { name: 'Nachos', price: 600 },
          { name: 'Bruschetta', price: 450 },
        ],
      },
    ],
    modifiers: [
      { ...ICE, attachTo: ['Mojito', 'Margarita'] },
      { ...EXTRAS, attachTo: ['Loaded Fries', 'Nachos'] },
      { ...COOKING_TEMP, attachTo: ['Bar Burger'] },
    ],
  },
  {
    slug: 'happy-hybrid',
    name: 'Happy Hybrid',
    venueType: 'happy_hybrid',
    settings: {
      coursesEnabled: true,
      tablesEnabled: true,
      counterServiceEnabled: true,
      kitchenDisplayEnabled: true,
      barDisplayEnabled: true,
      tableNamingMode: 'number',
      loginMethod: 'email',
    },
    areas: [
      {
        name: 'Dining Room',
        tables: [1, 2, 3, 4, 5].map(n => ({ tableNumber: n })),
      },
      {
        name: 'Bar Area',
        tables: [6, 7, 8].map(n => ({ tableNumber: n })),
      },
    ],
    categories: [
      ...RESTAURANT_FOOD_CATEGORIES,
      ...BAR_CATEGORIES,
      {
        name: 'Wine & Beer', destination: 'bar',
        items: [
          { name: 'Draft Beer', price: 400 },
          { name: 'House Red Wine', price: 500 },
          { name: 'House White Wine', price: 500 },
          { name: 'Prosecco', price: 600 },
        ],
      },
    ],
    modifiers: [
      { ...COOKING_TEMP, attachTo: ['Grilled Steak'] },
      { ...EXTRAS, attachTo: ['Margherita Pizza', 'Chicken Fillet'] },
      { ...ICE, attachTo: ['Mojito', 'Margarita'] },
    ],
  },
];

// ── Driver ───────────────────────────────────────────────────────────────────

interface SummaryRow { venue: string; slug: string; role: string; email: string; pin: string; password: string }

async function seedVenue(spec: VenueSpec, summary: SummaryRow[]) {
  const venue = await prisma.venue.upsert({
    where: { slug: spec.slug },
    update: { name: spec.name, venueType: spec.venueType },
    create: { slug: spec.slug, name: spec.name, venueType: spec.venueType },
  });

  await prisma.restaurantSettings.upsert({
    where: { venueId: venue.id },
    update: spec.settings,
    create: { venueId: venue.id, ...spec.settings },
  });

  // Users — waiter, kitchen, admin. No manager/bar accounts (Phase 2 roles).
  for (const role of ['waiter', 'kitchen', 'admin'] as const) {
    const email = `${role}@${spec.slug}.test`;
    await upsertUser(venue.id, { role, fullName: `${role[0].toUpperCase()}${role.slice(1)} (${spec.name})`, email });
    summary.push({ venue: spec.name, slug: spec.slug, role, email, pin: ROLE_PINS[role], password: PASSWORD });
  }

  // Areas + tables
  let areaSort = 0;
  for (const areaSpec of spec.areas) {
    const area = await upsertArea(venue.id, areaSpec.name, areaSort++);
    let tableSort = 0;
    for (const t of areaSpec.tables) {
      await upsertTable(venue.id, area.id, { tableNumber: t.tableNumber, tableName: t.tableName, seats: t.seats ?? 4, sortOrder: tableSort++ });
    }
  }

  // Menu categories + items
  const itemIdByName = new Map<string, string>();
  let catSort = 0;
  for (const catSpec of spec.categories) {
    const category = await upsertCategory(venue.id, {
      name: catSpec.name,
      destination: catSpec.destination,
      defaultCourseNumber: catSpec.defaultCourseNumber,
      sortOrder: catSort++,
    });
    let itemSort = 0;
    for (const itemSpec of catSpec.items) {
      const item = await upsertItem(venue.id, category.id, {
        name: itemSpec.name,
        price: itemSpec.price,
        destination: catSpec.destination,
        courseNumber: itemSpec.courseNumber,
        sortOrder: itemSort++,
      });
      itemIdByName.set(itemSpec.name, item.id);
    }
  }

  // Modifier groups + options, attached to the relevant items
  let groupSort = 0;
  for (const modSpec of spec.modifiers) {
    const group = await upsertModifierGroup(venue.id, {
      name: modSpec.name,
      type: modSpec.type,
      isRequired: modSpec.isRequired,
      minSelect: modSpec.minSelect,
      maxSelect: modSpec.maxSelect,
      sortOrder: groupSort++,
    });
    let optSort = 0;
    for (const opt of modSpec.options) {
      await upsertModifierOption(group.id, { name: opt.name, priceDelta: opt.priceDelta, sortOrder: optSort++ });
    }
    for (const itemName of modSpec.attachTo) {
      const itemId = itemIdByName.get(itemName);
      if (!itemId) throw new Error(`${spec.slug}: modifier group "${modSpec.name}" references unknown item "${itemName}"`);
      await prisma.menuItemModifierGroup.upsert({
        where: { menuItemId_groupId: { menuItemId: itemId, groupId: group.id } },
        update: {},
        create: { menuItemId: itemId, groupId: group.id },
      });
    }
  }

  // Ticket counter row for today
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await prisma.ticketCounter.upsert({
    where: { venueId_businessDate: { venueId: venue.id, businessDate: today } },
    update: {},
    create: { venueId: venue.id, businessDate: today },
  });

  return venue;
}

function printSummary(rows: SummaryRow[]) {
  console.log('\n=== Seed summary ===\n');
  console.table(
    rows.map(r => ({
      Venue: r.venue,
      Slug: r.slug,
      Role: r.role,
      Email: r.email,
      PIN: r.pin,
      Password: r.password,
    })),
  );
  console.log('Login with either { code: <slug>, pin: <PIN> } or { code: <slug>, email, pin } depending on the venue\'s login_method.\n');
}

async function main() {
  const summary: SummaryRow[] = [];
  for (const spec of VENUES) {
    const venue = await seedVenue(spec, summary);
    console.log(`seeded venue "${venue.slug}" (${venue.venueType})`);
  }
  printSummary(summary);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
