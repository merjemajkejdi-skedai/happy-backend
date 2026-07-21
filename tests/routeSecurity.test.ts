import { describe, it, expect } from 'vitest';
import { app } from '../src/app';
import { authRouter } from '../src/modules/auth/routes';
import { authenticate } from '../src/middleware/auth';
import { venueScope } from '../src/middleware/venueScope';

// Routes that intentionally run without authenticate+venueScope. Anything
// discovered below that ISN'T one of these must have both — this list is
// the ONLY place "public" is declared; every other route is found by
// walking the live app, so a new unprotected route fails this test loudly
// instead of silently shipping.
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'POST /login/pin', // on authRouter
  'POST /login/email', // on authRouter
  'POST /refresh', // on authRouter
  'GET /venue-config', // on authRouter
  'GET /api/v1/openapi.json', // registered directly on `app` (full literal path, like /health) — the contract itself, fetchable before a client has credentials
]);

interface DiscoveredRoute {
  method: string;
  path: string;
  isPublicCandidate: boolean;
  middleware: Set<Function>;
}

const rootRouter = (app as any)._router;

// Express 4 internals: a router's `.stack` is a list of Layers. A Layer is
// either a direct route (`layer.route` set, with its own path/methods/
// handler stack) or a plain middleware function, or a mounted sub-router
// (`layer.handle.stack` present). We don't need to reconstruct full literal
// paths across mount boundaries — PUBLIC_ROUTES only needs the route's own
// path within its immediate router, which Express always exposes directly
// on `layer.route.path` (no regex-decompiling required).
function walk(router: any, inherited: Set<Function>): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  // Anything registered as a bare middleware function directly on this
  // router (not a route, not a sub-router) is inherited by every route in
  // this router and everything mounted beneath it — matches this
  // codebase's exclusive convention of `router.use(authenticate, venueScope)`
  // as the first statement in every module's routes.ts.
  const ownMiddleware = new Set<Function>(inherited);
  for (const layer of router.stack) {
    if (!layer.route && layer.handle && typeof layer.handle === 'function' && !layer.handle.stack) {
      ownMiddleware.add(layer.handle);
    }
  }

  for (const layer of router.stack) {
    if (layer.route) {
      const routeMiddleware = new Set(ownMiddleware);
      for (const routeLayer of layer.route.stack) {
        if (typeof routeLayer.handle === 'function') routeMiddleware.add(routeLayer.handle);
      }
      const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
      for (const method of methods) {
        routes.push({
          method: method.toUpperCase(),
          path: layer.route.path,
          isPublicCandidate: router === authRouter || router === rootRouter,
          middleware: routeMiddleware,
        });
      }
    } else if (layer.handle && layer.handle.stack) {
      routes.push(...walk(layer.handle, ownMiddleware));
    }
  }
  return routes;
}

describe('Venue scope audit', () => {
  it('every route either is on the public allowlist or requires authenticate + venueScope', () => {
    const routes = walk(rootRouter, new Set());
    expect(routes.length).toBeGreaterThan(50); // sanity check — make sure the walk actually found the app's routes

    const failures: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      const hasAuth = route.middleware.has(authenticate) && route.middleware.has(venueScope);
      const isAllowlisted = route.isPublicCandidate && PUBLIC_ROUTES.has(key);

      if (!hasAuth && !isAllowlisted) {
        failures.push(`${key} has neither authenticate+venueScope nor is on the public allowlist`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('the public allowlist itself is minimal and exact — nothing extra slips through unauthenticated', () => {
    const routes = walk(rootRouter, new Set());
    const unauthenticated = routes
      .filter(r => !(r.middleware.has(authenticate) && r.middleware.has(venueScope)))
      .map(r => `${r.method} ${r.path}`);

    // Every unauthenticated route found must be explicitly on the allowlist —
    // proves the allowlist isn't accidentally under-covering.
    for (const key of unauthenticated) {
      expect(PUBLIC_ROUTES.has(key)).toBe(true);
    }
    expect(unauthenticated.length).toBe(PUBLIC_ROUTES.size);
  });
});
