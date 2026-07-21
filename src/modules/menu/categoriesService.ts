import { scopedPrisma } from '../../middleware/venueScope';
import { getVenueContext, validateDestination, validateCourseNumber, type MenuDomainError, err } from './validation';
import type { MenuCategory, Prisma, Destination } from '../../generated/prisma/client';

export type CategoryResult<T> = { ok: true; value: T } | { ok: false; error: MenuDomainError };

export interface ListCategoriesParams {
  isActive?: boolean;
}

export async function listCategories(venueId: string, params: ListCategoriesParams): Promise<MenuCategory[]> {
  const where: Prisma.MenuCategoryWhereInput = { venueId, deletedAt: null };
  if (params.isActive !== undefined) where.isActive = params.isActive;
  return scopedPrisma.menuCategory.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

export interface CategoryInput {
  name: string;
  description?: string | null;
  defaultDestination?: Destination;
  defaultCourseNumber?: number | null;
  sortOrder?: number;
  isActive?: boolean;
  colorHex?: string | null;
}

export async function createCategory(venueId: string, input: CategoryInput): Promise<CategoryResult<MenuCategory>> {
  const destination = input.defaultDestination ?? 'kitchen';
  const context = await getVenueContext(venueId);
  const destError = validateDestination(context.venueType, destination);
  if (destError) return { ok: false, error: destError };
  const courseError = validateCourseNumber(context.coursesEnabled, input.defaultCourseNumber);
  if (courseError) return { ok: false, error: courseError };

  const category = await scopedPrisma.menuCategory.create({
    data: {
      venueId,
      name: input.name,
      description: input.description ?? null,
      defaultDestination: destination,
      defaultCourseNumber: input.defaultCourseNumber ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      colorHex: input.colorHex ?? null,
    },
  });
  return { ok: true, value: category };
}

export async function updateCategory(
  venueId: string,
  categoryId: string,
  input: Partial<CategoryInput>,
): Promise<CategoryResult<MenuCategory>> {
  const existing = await scopedPrisma.menuCategory.findFirst({ where: { id: categoryId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Category not found') };

  const mergedDestination = input.defaultDestination !== undefined ? input.defaultDestination : existing.defaultDestination;
  const mergedCourseNumber = input.defaultCourseNumber !== undefined ? input.defaultCourseNumber : existing.defaultCourseNumber;

  const context = await getVenueContext(venueId);
  const destError = validateDestination(context.venueType, mergedDestination);
  if (destError) return { ok: false, error: destError };
  const courseError = validateCourseNumber(context.coursesEnabled, mergedCourseNumber);
  if (courseError) return { ok: false, error: courseError };

  const data: Prisma.MenuCategoryUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.defaultDestination !== undefined) data.defaultDestination = input.defaultDestination;
  if (input.defaultCourseNumber !== undefined) data.defaultCourseNumber = input.defaultCourseNumber;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.colorHex !== undefined) data.colorHex = input.colorHex;

  const category = await scopedPrisma.menuCategory.update({ where: { id: categoryId }, data });
  return { ok: true, value: category };
}

export async function deleteCategory(venueId: string, categoryId: string): Promise<CategoryResult<null>> {
  const existing = await scopedPrisma.menuCategory.findFirst({ where: { id: categoryId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Category not found') };

  const activeItem = await scopedPrisma.menuItem.findFirst({ where: { categoryId, venueId, isActive: true, deletedAt: null } });
  if (activeItem) {
    return { ok: false, error: err(409, 'CATEGORY_HAS_ACTIVE_ITEMS', 'This category has active items — deactivate or move them first') };
  }

  await scopedPrisma.menuCategory.update({ where: { id: categoryId }, data: { deletedAt: new Date(), isActive: false } });
  return { ok: true, value: null };
}
