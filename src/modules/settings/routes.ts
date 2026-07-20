import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { serializeSettings } from '../../shared/settingsSerializer';
import * as settingsService from './service';

export const settingsRouter = Router();
settingsRouter.use(authenticate, venueScope);

settingsRouter.get('/', async (req: Request, res: Response) => {
  const settings = await settingsService.getSettingsRow(req.auth!.venueId);
  if (!settings) return sendError(res, 'NOT_FOUND', 'Settings not found');
  sendData(res, serializeSettings(settings));
});

settingsRouter.patch('/', requirePermission('settings.write'), async (req: Request, res: Response) => {
  const result = await settingsService.updateSettings(req.auth!.venueId, req.auth!.userId, req.body ?? {});
  if (!result.ok) return sendDomainError(res, 422, result.error.code, result.error.message);
  sendData(res, serializeSettings(result.settings));
});
