import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and configure it.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// Base, unscoped client. Anything that touches a venue-scoped table should
// go through the wrapped client in middleware/venueScope.ts instead, which
// enforces a venue_id filter — this raw client exists for venue-independent
// lookups (e.g. resolving a venue by slug before we know a venueId at all).
export const prisma = new PrismaClient({ adapter });
