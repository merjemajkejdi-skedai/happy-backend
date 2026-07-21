import { scopedPrisma } from '../../middleware/venueScope';
import type { Area, Destination, Prisma } from '../../generated/prisma/client';
import { err, type DomainError } from '../../lib/domainError';

export type AreaDomainError = DomainError;

export type AreaResult<T> = { ok: true; value: T } | { ok: false; error: AreaDomainError };

export interface ListAreasParams {
  page?: number;
  perPage?: number;
}

export async function listAreas(venueId: string, params: ListAreasParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));
  const where = { venueId, deletedAt: null };

  const [areas, total] = await Promise.all([
    scopedPrisma.area.findMany({ where, orderBy: { sortOrder: 'asc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.area.count({ where }),
  ]);
  return { areas, page, perPage, total };
}

export interface AreaInput {
  name: string;
  sortOrder?: number;
  isActive?: boolean;
  defaultDestination?: Destination | null;
}

export async function createArea(venueId: string, input: AreaInput): Promise<Area> {
  return scopedPrisma.area.create({
    data: {
      venueId,
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      defaultDestination: input.defaultDestination ?? null,
    },
  });
}

export async function updateArea(venueId: string, areaId: string, input: Partial<AreaInput>): Promise<AreaResult<Area>> {
  const existing = await scopedPrisma.area.findFirst({ where: { id: areaId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Area not found') };

  const data: Prisma.AreaUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.defaultDestination !== undefined) data.defaultDestination = input.defaultDestination;

  const area = await scopedPrisma.area.update({ where: { id: areaId }, data });
  return { ok: true, value: area };
}

export async function deleteArea(venueId: string, areaId: string, reassignTo?: string): Promise<AreaResult<null>> {
  const area = await scopedPrisma.area.findFirst({ where: { id: areaId, venueId, deletedAt: null } });
  if (!area) return { ok: false, error: err(404, 'NOT_FOUND', 'Area not found') };

  const activeTables = await scopedPrisma.restaurantTable.findMany({
    where: { areaId, venueId, isActive: true, deletedAt: null },
  });

  if (activeTables.length > 0) {
    if (!reassignTo) {
      return {
        ok: false,
        error: err(409, 'AREA_HAS_ACTIVE_TABLES', 'This area has active tables — pass ?reassign_to=<area_id> to move them first'),
      };
    }
    if (reassignTo === areaId) {
      return { ok: false, error: err(422, 'INVALID_REASSIGN_TARGET', 'reassign_to must be a different area') };
    }
    const target = await scopedPrisma.area.findFirst({ where: { id: reassignTo, venueId, deletedAt: null } });
    if (!target) return { ok: false, error: err(404, 'NOT_FOUND', 'reassign_to area not found') };

    await scopedPrisma.restaurantTable.updateMany({ where: { areaId, venueId }, data: { areaId: target.id } });
  }

  await scopedPrisma.area.update({ where: { id: areaId }, data: { deletedAt: new Date(), isActive: false } });
  return { ok: true, value: null };
}
