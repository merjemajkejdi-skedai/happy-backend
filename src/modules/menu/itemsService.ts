import { scopedPrisma } from '../../middleware/venueScope';
import { getVenueContext, validateDestination, validateCourseNumber, type MenuDomainError, err } from './validation';
import { Prisma, type MenuItem, type Destination } from '../../generated/prisma/client';

export type ItemResult<T> = { ok: true; value: T } | { ok: false; error: MenuDomainError };

function isConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export interface ListItemsParams {
  categoryId?: string;
  isAvailable?: boolean;
  search?: string;
  page?: number;
  perPage?: number;
}

export async function listItems(venueId: string, params: ListItemsParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));
  const where: Prisma.MenuItemWhereInput = { venueId, deletedAt: null };
  if (params.categoryId) where.categoryId = params.categoryId;
  if (params.isAvailable !== undefined) where.isAvailable = params.isAvailable;
  if (params.search) where.name = { contains: params.search, mode: 'insensitive' };

  const [items, total] = await Promise.all([
    scopedPrisma.menuItem.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.menuItem.count({ where }),
  ]);

  return { items, page, perPage, total };
}

export async function getItem(venueId: string, itemId: string): Promise<MenuItem | null> {
  return scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  price: number;
  destination?: Destination; // omitted -> inherit the category's default_destination
  courseNumber?: number | null; // omitted -> inherit the category's default_course_number
  sku?: string | null;
  isAvailable?: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
  prepMinutes?: number | null;
  taxRatePercent?: number | null;
}

export async function createItem(venueId: string, input: ItemInput): Promise<ItemResult<MenuItem>> {
  const category = await scopedPrisma.menuCategory.findFirst({ where: { id: input.categoryId, venueId, deletedAt: null } });
  if (!category) return { ok: false, error: err(404, 'NOT_FOUND', 'Category not found') };

  const destination = input.destination ?? category.defaultDestination;
  const courseNumber = input.courseNumber !== undefined ? input.courseNumber : category.defaultCourseNumber;

  const context = await getVenueContext(venueId);
  const destError = validateDestination(context.venueType, destination);
  if (destError) return { ok: false, error: destError };
  const courseError = validateCourseNumber(context.coursesEnabled, courseNumber);
  if (courseError) return { ok: false, error: courseError };

  if (input.sku) {
    const existing = await scopedPrisma.menuItem.findFirst({ where: { venueId, sku: input.sku, deletedAt: null } });
    if (existing) return { ok: false, error: err(409, 'SKU_ALREADY_IN_USE', 'That SKU is already in use at this venue') };
  }

  try {
    const item = await scopedPrisma.menuItem.create({
      data: {
        venueId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        destination,
        courseNumber,
        sku: input.sku ?? null,
        isAvailable: input.isAvailable ?? true,
        sortOrder: input.sortOrder ?? 0,
        imageUrl: input.imageUrl ?? null,
        prepMinutes: input.prepMinutes ?? null,
        taxRatePercent: input.taxRatePercent ?? null,
      },
    });
    return { ok: true, value: item };
  } catch (e) {
    if (isConflict(e)) return { ok: false, error: err(409, 'SKU_ALREADY_IN_USE', 'That SKU is already in use at this venue') };
    throw e;
  }
}

export async function updateItem(venueId: string, itemId: string, input: Partial<ItemInput>): Promise<ItemResult<MenuItem>> {
  const existing = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  if (input.categoryId && input.categoryId !== existing.categoryId) {
    const category = await scopedPrisma.menuCategory.findFirst({ where: { id: input.categoryId, venueId, deletedAt: null } });
    if (!category) return { ok: false, error: err(404, 'NOT_FOUND', 'Category not found') };
  }

  const mergedDestination = input.destination !== undefined ? input.destination : existing.destination;
  const mergedCourseNumber = input.courseNumber !== undefined ? input.courseNumber : existing.courseNumber;

  const context = await getVenueContext(venueId);
  const destError = validateDestination(context.venueType, mergedDestination);
  if (destError) return { ok: false, error: destError };
  const courseError = validateCourseNumber(context.coursesEnabled, mergedCourseNumber);
  if (courseError) return { ok: false, error: courseError };

  if (input.sku && input.sku !== existing.sku) {
    const conflict = await scopedPrisma.menuItem.findFirst({
      where: { venueId, sku: input.sku, deletedAt: null, id: { not: itemId } },
    });
    if (conflict) return { ok: false, error: err(409, 'SKU_ALREADY_IN_USE', 'That SKU is already in use at this venue') };
  }

  const data: Prisma.MenuItemUpdateInput = {};
  if (input.categoryId !== undefined) data.category = { connect: { id: input.categoryId } };
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.price !== undefined) data.price = input.price;
  if (input.destination !== undefined) data.destination = input.destination;
  if (input.courseNumber !== undefined) data.courseNumber = input.courseNumber;
  if (input.sku !== undefined) data.sku = input.sku;
  if (input.isAvailable !== undefined) data.isAvailable = input.isAvailable;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
  if (input.prepMinutes !== undefined) data.prepMinutes = input.prepMinutes;
  if (input.taxRatePercent !== undefined) data.taxRatePercent = input.taxRatePercent;

  try {
    const item = await scopedPrisma.menuItem.update({ where: { id: itemId }, data });
    return { ok: true, value: item };
  } catch (e) {
    if (isConflict(e)) return { ok: false, error: err(409, 'SKU_ALREADY_IN_USE', 'That SKU is already in use at this venue') };
    throw e;
  }
}

export async function deleteItem(venueId: string, itemId: string): Promise<ItemResult<null>> {
  const existing = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  await scopedPrisma.menuItem.update({ where: { id: itemId }, data: { deletedAt: new Date(), isActive: false } });
  return { ok: true, value: null };
}

export async function setItemAvailability(venueId: string, itemId: string, isAvailable: boolean): Promise<ItemResult<MenuItem>> {
  const existing = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const item = await scopedPrisma.menuItem.update({ where: { id: itemId }, data: { isAvailable } });
  return { ok: true, value: item };
}
