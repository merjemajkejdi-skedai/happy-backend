import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as areasService from './service';

export const areasRouter = Router();
areasRouter.use(authenticate, venueScope);

areasRouter.get('/', async (req: Request, res: Response) => {
  const areas = await areasService.listAreas(req.auth!.venueId);
  sendData(res, areas, { count: areas.length });
});

areasRouter.post('/', requirePermission('table.write'), async (req: Request, res: Response) => {
  const { name, sort_order, is_active, default_destination } = req.body ?? {};
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');
  const area = await areasService.createArea(req.auth!.venueId, {
    name: String(name).trim(),
    sortOrder: sort_order,
    isActive: is_active,
    defaultDestination: default_destination ?? null,
  });
  sendData(res, area);
});

areasRouter.patch('/:id', requirePermission('table.write'), async (req: Request, res: Response) => {
  const { name, sort_order, is_active, default_destination } = req.body ?? {};
  const result = await areasService.updateArea(req.auth!.venueId, req.params.id, {
    name: name !== undefined ? String(name).trim() : undefined,
    sortOrder: sort_order,
    isActive: is_active,
    defaultDestination: default_destination,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

areasRouter.delete('/:id', requirePermission('table.write'), async (req: Request, res: Response) => {
  const reassignTo = typeof req.query.reassign_to === 'string' ? req.query.reassign_to : undefined;
  const result = await areasService.deleteArea(req.auth!.venueId, req.params.id, reassignTo);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});
