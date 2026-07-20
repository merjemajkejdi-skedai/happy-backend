import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { tablesRouter } from './routes/tables';
import { menuRouter } from './routes/menu';
import { ordersRouter } from './routes/orders';
import { kitchenRouter } from './routes/kitchen';
import { sendError } from './lib/response';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use('/auth', authRouter);
app.use('/tables', tablesRouter);
app.use('/menu', menuRouter);
app.use('/orders', ordersRouter);
app.use('/', kitchenRouter); // exposes /kitchen/events, /bar/events, /order-items/:id/status

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  sendError(res, 'INTERNAL_ERROR', 'Internal server error');
});

// Migrations are applied via `npx prisma migrate deploy` (or `migrate dev`
// locally) as a separate step — not run automatically on boot.
app.listen(Number(PORT), () => {
  console.log(`happy-backend running at http://localhost:${PORT}`);
});
