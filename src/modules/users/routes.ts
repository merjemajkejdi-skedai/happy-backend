import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import { serializeUser } from '../../shared/userSerializer';
import * as usersService from './service';
import type { UserResult, UserDomainError } from './service';

export const usersRouter = Router();
usersRouter.use(authenticate, venueScope, requirePermission('user.manage'));

function sendUserError(res: Response, error: UserDomainError) {
  sendDomainError(res, error.status, error.code, error.message);
}

function respond<T>(res: Response, result: UserResult<T>, map: (value: T) => unknown) {
  if (!result.ok) return sendUserError(res, result.error);
  sendData(res, map(result.value));
}

usersRouter.get('/', async (req: Request, res: Response) => {
  const { role, is_active } = req.query as Record<string, string>;
  const { page, perPage } = parsePagination(req.query);
  const result = await usersService.listUsers(req.auth!.venueId, {
    role,
    isActive: is_active === undefined ? undefined : is_active === 'true',
    page,
    perPage,
  });
  sendData(res, result.users.map(serializeUser), buildPaginationMeta(result.page, result.perPage, result.total));
});

usersRouter.post('/', async (req: Request, res: Response) => {
  const { full_name, role, email, password, pin } = req.body ?? {};
  if (!full_name?.trim() || !role) return sendError(res, 'VALIDATION_ERROR', 'full_name and role are required');

  const result = await usersService.createUser(req.auth!.venueId, {
    fullName: String(full_name).trim(),
    role: String(role),
    email: email ? String(email).trim() : null,
    password: password ? String(password) : undefined,
    pin: pin ? String(pin) : undefined,
  });
  respond(res, result, serializeUser);
});

usersRouter.get('/:id', async (req: Request, res: Response) => {
  const user = await usersService.getUser(req.auth!.venueId, req.params.id);
  if (!user) return sendError(res, 'NOT_FOUND', 'User not found');
  sendData(res, serializeUser(user));
});

usersRouter.patch('/:id', async (req: Request, res: Response) => {
  const { full_name, role, is_active, email } = req.body ?? {};
  const result = await usersService.updateUser(req.auth!.venueId, req.auth!.userId, req.params.id, {
    fullName: full_name !== undefined ? String(full_name).trim() : undefined,
    role: role !== undefined ? String(role) : undefined,
    isActive: is_active !== undefined ? Boolean(is_active) : undefined,
    email: email !== undefined ? (email ? String(email).trim() : null) : undefined,
  });
  respond(res, result, serializeUser);
});

usersRouter.delete('/:id', async (req: Request, res: Response) => {
  const result = await usersService.softDeleteUser(req.auth!.venueId, req.auth!.userId, req.params.id);
  respond(res, result, () => ({ deleted: true }));
});

usersRouter.post('/:id/reset-pin', async (req: Request, res: Response) => {
  const { pin } = req.body ?? {};
  if (!pin?.trim()) return sendError(res, 'VALIDATION_ERROR', 'pin is required');
  const result = await usersService.resetPin(req.auth!.venueId, req.params.id, String(pin));
  respond(res, result, serializeUser);
});

usersRouter.post('/:id/reset-password', async (req: Request, res: Response) => {
  const { password } = req.body ?? {};
  if (!password?.trim()) return sendError(res, 'VALIDATION_ERROR', 'password is required');
  const result = await usersService.resetPassword(req.auth!.venueId, req.params.id, String(password));
  respond(res, result, serializeUser);
});
