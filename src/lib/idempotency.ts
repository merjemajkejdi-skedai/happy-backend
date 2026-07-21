import { Request, Response } from 'express';
import { prisma } from '../db/prisma';
import { sendDomainError } from './response';
import { Prisma } from '../generated/prisma/client';

const REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a completed response is replayable for this long
const IN_PROGRESS_STALE_MS = 5 * 60 * 1000; // not spec'd — a crashed request shouldn't wedge a key forever

export interface IdempotentResult {
  status: number;
  body: unknown;
}

function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function sendStored(res: Response, responseStatus: number, responseBody: unknown) {
  res.status(responseStatus).json(responseBody);
}

// Generic Idempotency-Key handling for POST /orders, POST /orders/:id/items,
// and POST /orders/:id/send — supersedes the ad-hoc per-column approach from
// Prompts 7-8. `handler()` must return the FULL terminal response (success
// AND domain-error outcomes) since a replay has to reproduce the exact same
// result, not silently re-run business logic that would fail identically.
export async function runIdempotent(req: Request, res: Response, route: string, handler: () => Promise<IdempotentResult>): Promise<void> {
  const key = req.headers['idempotency-key'] as string | undefined;
  if (!key) {
    const result = await handler();
    res.status(result.status).json(result.body);
    return;
  }

  const venueId = req.auth!.venueId;
  const userId = req.auth!.userId;
  const where = { venueId_userId_route_idempotencyKey: { venueId, userId, route, idempotencyKey: key } };

  const existing = await prisma.idempotencyRequest.findUnique({ where });
  if (existing) {
    const age = Date.now() - existing.createdAt.getTime();
    if (existing.status === 'completed' && age < REPLAY_TTL_MS) {
      return sendStored(res, existing.responseStatus!, existing.responseBody);
    }
    if (existing.status === 'in_progress' && age < IN_PROGRESS_STALE_MS) {
      return sendDomainError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already being processed');
    }
    // Expired completed row, or a stale in_progress row left by a crashed
    // request — clear it and proceed as a fresh request.
    await prisma.idempotencyRequest.delete({ where: { id: existing.id } }).catch(() => {});
  }

  try {
    await prisma.idempotencyRequest.create({ data: { venueId, userId, route, idempotencyKey: key, status: 'in_progress' } });
  } catch (e) {
    if (isUniqueConflict(e)) {
      return sendDomainError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is already being processed');
    }
    throw e;
  }

  const result = await handler();

  await prisma.idempotencyRequest.update({
    where,
    data: {
      status: 'completed',
      responseStatus: result.status,
      responseBody: result.body as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });

  res.status(result.status).json(result.body);
}
