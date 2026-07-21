import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authRouter } from './modules/auth/routes';
import { venueRouter } from './modules/venue/routes';
import { settingsRouter } from './modules/settings/routes';
import { usersRouter } from './modules/users/routes';
import { areasRouter } from './modules/areas/routes';
import { tablesRouter } from './modules/tables/routes';
import { menuRouter } from './modules/menu/routes';
import { ordersRouter } from './modules/orders/routes';
import { sendError } from './lib/response';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/venue', venueRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/areas', areasRouter);
app.use('/api/v1/tables', tablesRouter);
app.use('/api/v1/menu', menuRouter);
app.use('/api/v1/orders', ordersRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  sendError(res, 'INTERNAL_ERROR', 'Internal server error');
});

// Migrations are applied via `npx prisma migrate deploy` (or `migrate dev`
// locally) as a separate step — not run automatically on boot.
app.listen(Number(PORT), () => {
  console.log(`happy-backend running at http://localhost:${PORT}`);
});
