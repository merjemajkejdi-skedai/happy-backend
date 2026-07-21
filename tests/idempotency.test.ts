import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Request, Response } from 'express';
import { prisma } from '../src/db/prisma';
import { runIdempotent } from '../src/lib/idempotency';
import { createTestVenue, destroyTestVenue } from './fixtures';

let venueId: string;
let userId: string;

beforeAll(async () => {
  const venue = await createTestVenue('pin', [{ role: 'admin', pin: '9999' }]);
  venueId = venue.id;
  const user = await prisma.user.findFirstOrThrow({ where: { venueId, role: 'admin' } });
  userId = user.id;
});
afterAll(async () => {
  await prisma.idempotencyRequest.deleteMany({ where: { venueId } });
  await destroyTestVenue();
});

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = vi.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

function mockReq(idempotencyKey?: string): Request {
  return {
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    auth: { venueId, userId, role: 'admin' },
  } as unknown as Request;
}

describe('runIdempotent', () => {
  it('with no Idempotency-Key header, just runs the handler and passes the response through', async () => {
    const req = mockReq();
    const res = mockRes();
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { data: { ok: true }, meta: {} } });

    await runIdempotent(req, res, 'TEST /no-key', handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { ok: true }, meta: {} });
  });

  it('replays the stored response on a second call with the same key, without re-running the handler', async () => {
    const key = `replay-${Date.now()}`;
    const handler = vi.fn().mockResolvedValue({ status: 200, body: { data: { id: 'abc' }, meta: {} } });

    const res1 = mockRes();
    await runIdempotent(mockReq(key), res1, 'TEST /replay', handler);
    const res2 = mockRes();
    await runIdempotent(mockReq(key), res2, 'TEST /replay', handler);

    expect(handler).toHaveBeenCalledOnce(); // second call never invoked it
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.json).toHaveBeenCalledWith({ data: { id: 'abc' }, meta: {} });
  });

  it('replays a stored domain-error response too — a replay reproduces the exact same terminal outcome', async () => {
    const key = `replay-error-${Date.now()}`;
    const handler = vi.fn().mockResolvedValue({ status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'bad input' } } });

    const res1 = mockRes();
    await runIdempotent(mockReq(key), res1, 'TEST /replay-error', handler);
    const res2 = mockRes();
    await runIdempotent(mockReq(key), res2, 'TEST /replay-error', handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(res2.status).toHaveBeenCalledWith(422);
    expect(res2.json).toHaveBeenCalledWith({ error: { code: 'VALIDATION_ERROR', message: 'bad input' } });
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS for a concurrent duplicate with the same key', async () => {
    const key = `concurrent-${Date.now()}`;
    let resolveHandler!: () => void;
    const slowHandler = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveHandler = () => resolve({ status: 200, body: { data: {}, meta: {} } }); }),
    );

    const resA = mockRes();
    const resB = mockRes();
    const callA = runIdempotent(mockReq(key), resA, 'TEST /concurrent', slowHandler);
    // Let callA's create() land first before firing the concurrent duplicate.
    await new Promise(r => setTimeout(r, 20));
    const callB = runIdempotent(mockReq(key), resB, 'TEST /concurrent', vi.fn());

    await callB;
    expect(resB.status).toHaveBeenCalledWith(409);
    expect(resB.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' }) }),
    );

    resolveHandler();
    await callA;
    expect(resA.status).toHaveBeenCalledWith(200);
  });

  it('treats an expired completed row as a fresh request and re-runs the handler', async () => {
    const key = `expired-${Date.now()}`;
    const handler = vi.fn().mockResolvedValue({ status: 200, body: { data: { n: 1 }, meta: {} } });

    const res1 = mockRes();
    await runIdempotent(mockReq(key), res1, 'TEST /expired', handler);

    // Backdate the stored row past the 24h replay window.
    await prisma.idempotencyRequest.updateMany({
      where: { venueId, userId, route: 'TEST /expired', idempotencyKey: key },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const handler2 = vi.fn().mockResolvedValue({ status: 200, body: { data: { n: 2 }, meta: {} } });
    const res2 = mockRes();
    await runIdempotent(mockReq(key), res2, 'TEST /expired', handler2);

    expect(handler2).toHaveBeenCalledOnce();
    expect(res2.json).toHaveBeenCalledWith({ data: { n: 2 }, meta: {} });
  });

  it('scopes replay to (venue, user, route, key) — a different route with the same key is a fresh request', async () => {
    const key = `scoped-${Date.now()}`;
    const handlerA = vi.fn().mockResolvedValue({ status: 200, body: { data: { route: 'A' }, meta: {} } });
    const handlerB = vi.fn().mockResolvedValue({ status: 200, body: { data: { route: 'B' }, meta: {} } });

    await runIdempotent(mockReq(key), mockRes(), 'TEST /route-a', handlerA);
    const resB = mockRes();
    await runIdempotent(mockReq(key), resB, 'TEST /route-b', handlerB);

    expect(handlerB).toHaveBeenCalledOnce();
    expect(resB.json).toHaveBeenCalledWith({ data: { route: 'B' }, meta: {} });
  });
});
