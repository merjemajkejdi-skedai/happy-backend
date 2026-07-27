import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { sendData } from '../../lib/response';
import { resolvePermissionsForVenue } from '../../shared/permissions';

export const permissionsRouter = Router();
permissionsRouter.use(authenticate, venueScope);

// GET /api/v1/permissions — the resolved matrix for the CURRENT user's role
// and venue (not the static ceiling). This is what the frontend gates on,
// so it must reflect resolution, not just the static registry — see
// resolvePermissions in shared/permissions.ts.
permissionsRouter.get('/', async (req: Request, res: Response) => {
  const resolved = await resolvePermissionsForVenue(req.auth!.role, req.auth!.venueId);
  sendData(res, {
    role: req.auth!.role,
    permissions: resolved.permissions,
    display_scope: resolved.displayScope,
  });
});
