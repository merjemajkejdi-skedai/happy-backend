import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendError } from '../../lib/response';
import * as venueService from './service';

export const venueRouter = Router();
venueRouter.use(authenticate, venueScope);

venueRouter.get('/', async (req: Request, res: Response) => {
  const venue = await venueService.getVenue(req.auth!.venueId);
  if (!venue) return sendError(res, 'NOT_FOUND', 'Venue not found');
  sendData(res, venue);
});

venueRouter.patch('/', requirePermission('venue.write'), async (req: Request, res: Response) => {
  const venue = await venueService.updateVenue(req.auth!.venueId, req.body ?? {});
  sendData(res, venue);
});
