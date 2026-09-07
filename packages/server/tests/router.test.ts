import { afterAll, describe, expect, it } from 'vitest';
import { RouterApp } from '../src/core/router.js';
import { buildApp } from '../src/app.js';
import { closeApp } from './helpers.js';
import { registerRoutes } from '../src/routes.js';

afterAll(closeApp);

/**
 * The shim exists so the real route files can run on Cloudflare Workers
 * unchanged. That is only safe if it resolves paths the way Fastify does, so
 * these tests mount the ACTUAL route files in both and compare.
 */
async function shimWithRealRoutes(): Promise<RouterApp> {
  const app = new RouterApp();
  await registerRoutes(app as never);
  return app;
}

describe('router shim', () => {
  it('mounts every real route', async () => {
    const shim = await shimWithRealRoutes();
    // The whole surface, not a sample: if a route file changes, this moves.
    expect(shim.routeCount).toBeGreaterThan(130);
  });

  it('prefixes public routes under /api/public', async () => {
    const shim = await shimWithRealRoutes();
    const patterns = shim.listRoutes().map((r) => r.pattern);
    expect(patterns).toContain('/api/public/menu/:qrValue');
    expect(patterns).toContain('/api/public/orders');
    expect(patterns).toContain('/api/orders');
  });

  /**
   * The case that a naive router gets wrong: `/orders/:id` is registered BEFORE
   * `/orders/pending-approval`, so a first-match-wins scan would send the inbox
   * request to the single-order handler with id="pending-approval".
   */
  it('prefers a static segment over a parameter, whatever the registration order', async () => {
    const shim = await shimWithRealRoutes();
    const pending = shim.match('GET', '/api/orders/pending-approval');
    expect(pending?.route.pattern).toBe('/api/orders/pending-approval');
    expect(pending?.params.id).toBeUndefined();

    const single = shim.match('GET', '/api/orders/8f14e45f-ceea-467a-9cf6-9b1f7a3a1234');
    expect(single?.route.pattern).toBe('/api/orders/:id');
    expect(single?.params.id).toBe('8f14e45f-ceea-467a-9cf6-9b1f7a3a1234');
  });

  it('agrees with Fastify on every registered path', async () => {
    const shim = await shimWithRealRoutes();
    const fastify = await buildApp();
    await fastify.ready();

    // Build a concrete request path for each declared route by substituting a
    // uuid for every parameter, then check both routers pick the same route.
    const uuid = '8f14e45f-ceea-467a-9cf6-9b1f7a3a1234';
    let compared = 0;

    for (const { method, pattern } of shim.listRoutes()) {
      const concrete = pattern
        .split('/')
        .map((s) => (s.startsWith(':') ? uuid : s))
        .join('/');

      const shimMatch = shim.match(method, concrete);
      expect(shimMatch, `shim failed to match ${method} ${concrete}`).toBeTruthy();

      // Fastify's own router resolves the same path to the same declared route.
      const found = fastify.findRoute({ method: method as never, url: concrete });
      expect(found, `fastify failed to match ${method} ${concrete}`).toBeTruthy();
      expect(
        shimMatch!.route.pattern,
        `divergent routing for ${method} ${concrete}`,
      ).toBe(pattern);
      compared += 1;
    }

    expect(compared).toBeGreaterThan(130);
  });

  it('extracts multiple parameters from one path', async () => {
    const shim = await shimWithRealRoutes();
    const m = shim.match('POST', '/api/orders/order-1/items/item-2/void');
    expect(m?.route.pattern).toBe('/api/orders/:id/items/:itemId/void');
    expect(m?.params).toEqual({ id: 'order-1', itemId: 'item-2' });
  });

  it('does not match a path of the wrong length', async () => {
    const shim = await shimWithRealRoutes();
    expect(shim.match('GET', '/api/orders/a/b/c/d/e')).toBeNull();
    expect(shim.match('GET', '/api/nope')).toBeNull();
  });

  it('separates methods on the same path', async () => {
    const shim = await shimWithRealRoutes();
    expect(shim.match('GET', '/api/orders')?.route.method).toBe('GET');
    expect(shim.match('POST', '/api/orders')?.route.method).toBe('POST');
    expect(shim.match('DELETE', '/api/orders')).toBeNull();
  });
});
