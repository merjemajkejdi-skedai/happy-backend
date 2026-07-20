import { scopedPrisma } from '../../middleware/venueScope';
import type { Area, Destination, Prisma } from '../../generated/prisma/client';

export interface AreaDomainError {
  status: number;
  code: string;
  message: string;
}

function err(status: number, code: string, message: string): AreaDomainError {
  return { status, code, message };
}

export type AreaResult<T> = { ok: true; value: T } | { ok: false; error: AreaDomainError };

export async function listAreas(venueId: string): Promise<Area[]> {
  return scopedPrisma.area.findMany({ where: { venueId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
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
