import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { sendData } from '../../lib/response';
import { categoriesRouter } from './categoriesRoutes';
import { itemsRouter } from './itemsRoutes';
import { modifiersRouter } from './modifiersRoutes';
import { getMenuTree } from './treeService';

export const menuRouter = Router();
menuRouter.use(authenticate, venueScope);

// GET /api/v1/menu — the full active tree in one call. This is what the POS
// caches at login; categories/items/modifier-groups/options CRUD live under
// their own sub-paths below for admin configuration.
menuRouter.get('/', async (req: Request, res: Response) => {
  const tree = await getMenuTree(req.auth!.venueId);
  res.set('ETag', tree.version);
  sendData(res, tree.categories, { menu_version: tree.version });
});

menuRouter.use('/categories', categoriesRouter);
menuRouter.use('/items', itemsRouter);
menuRouter.use('/', modifiersRouter); // /modifier-groups, /modifier-options
