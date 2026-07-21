import { app } from './app';

const PORT = process.env.PORT || 3001;

// Migrations are applied via `npx prisma migrate deploy` (or `migrate dev`
// locally) as a separate step — not run automatically on boot.
app.listen(Number(PORT), () => {
  console.log(`happy-backend running at http://localhost:${PORT}`);
});
