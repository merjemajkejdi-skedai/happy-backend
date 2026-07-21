import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as categoriesService from './categoriesService';

export const categoriesRouter = Router();

categoriesRouter.get('/', async (req: Request, res: Response) => {
  const { is_active } = req.query as Record<string, string>;
  const categories = await categoriesService.listCategories(req.auth!.venueId, {
    isActive: is_active === undefined ? undefined : is_active === 'true',
  });
  sendData(res, categories, { count: categories.length });
});

categoriesRouter.post('/', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { name, description, default_destination, default_course_number, sort_order, is_active, color_hex } = req.body ?? {};
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');

  const result = await categoriesService.createCategory(req.auth!.venueId, {
    name: String(name).trim(),
    description: description ?? null,
    defaultDestination: default_destination,
    defaultCourseNumber: default_course_number,
    sortOrder: sort_order,
    isActive: is_active,
    colorHex: color_hex ?? null,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

categoriesRouter.patch('/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { name, description, default_destination, default_course_number, sort_order, is_active, color_hex } = req.body ?? {};
  const result = await categoriesService.updateCategory(req.auth!.venueId, req.params.id, {
    name: name !== undefined ? String(name).trim() : undefined,
    description,
    defaultDestination: default_destination,
    defaultCourseNumber: default_course_number,
    sortOrder: sort_order,
    isActive: is_active,
    colorHex: color_hex,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

categoriesRouter.delete('/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const result = await categoriesService.deleteCategory(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});
