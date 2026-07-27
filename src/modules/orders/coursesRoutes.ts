import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as coursesService from './coursesService';

// mergeParams: true — mounted at /orders/:id, same as lifecycleRouter.
export const coursesRouter = Router({ mergeParams: true });

coursesRouter.get('/courses', requirePermission('order.create'), async (req: Request, res: Response) => {
  const result = await coursesService.listCourses(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

coursesRouter.post('/courses/:n/fire', requirePermission('order.fire'), async (req: Request, res: Response) => {
  const courseNumber = Number(req.params.n);
  const result = await coursesService.fireCourse(req.auth!.venueId, req.auth!.userId, req.params.id, courseNumber);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

coursesRouter.post('/courses/:n/hold', requirePermission('order.fire'), async (req: Request, res: Response) => {
  const courseNumber = Number(req.params.n);
  const result = await coursesService.holdCourse(req.auth!.venueId, req.auth!.userId, req.params.id, courseNumber);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

coursesRouter.post('/courses/reorder', requirePermission('order.fire'), async (req: Request, res: Response) => {
  const { course_numbers } = req.body ?? {};
  if (!Array.isArray(course_numbers)) return sendError(res, 'VALIDATION_ERROR', 'course_numbers must be an array');
  const result = await coursesService.reorderCourses(req.auth!.venueId, req.auth!.userId, req.params.id, course_numbers);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

coursesRouter.patch('/items/:itemId/course', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { course_number } = req.body ?? {};
  if (course_number !== null && course_number !== undefined && !Number.isInteger(course_number)) {
    return sendError(res, 'VALIDATION_ERROR', 'course_number must be an integer or null');
  }
  const result = await coursesService.moveItemCourse(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.itemId, course_number ?? null);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { moved: true });
});
