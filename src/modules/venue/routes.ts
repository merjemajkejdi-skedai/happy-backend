import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendError } from '../../lib/response';
import { getSettingsRow } from '../settings/service';
import * as venueService from './service';
import { serializeVenue } from './serializers';

export const venueRouter = Router();
venueRouter.use(authenticate, venueScope);

venueRouter.get('/', async (req: Request, res: Response) => {
  const [venue, settings] = await Promise.all([
    venueService.getVenue(req.auth!.venueId),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!venue) return sendError(res, 'NOT_FOUND', 'Venue not found');
  sendData(res, serializeVenue(venue, settings?.pmsEnabled));
});

venueRouter.patch('/', requirePermission('venue.write'), async (req: Request, res: Response) => {
  const [venue, settings] = await Promise.all([
    venueService.updateVenue(req.auth!.venueId, req.body ?? {}),
    getSettingsRow(req.auth!.venueId),
  ]);
  sendData(res, serializeVenue(venue, settings?.pmsEnabled));
});
