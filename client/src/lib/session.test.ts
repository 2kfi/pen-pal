import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression tests for the session refresh.
 *
 * The bug these exist for: `restore()` was called from a boot effect, and React
 * StrictMode runs mount effects twice in development. Both invocations POSTed to
 * /api/auth/refresh carrying the same cookie. The refresh token is single-use,
 * so the second one tripped the server's reuse detection, which revoked the
 * entire token family — signing the user out on every full page load.
 *
 * The server was behaving exactly as designed. The client was the thing at
 * fault, and nothing about it failed in a test, because nothing tested it.
 */

const refreshCalls: string[] = [];
let refreshResult: { status: number; token?: string } = { status: 200, token: 'access-1' };

function stubFetch() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    refreshCalls.push(url);
    const token = refreshResult.token;
    return new Response(
      token ? JSON.stringify({ token }) : JSON.stringify({ ok: false }),
      { status: refreshResult.status, headers: { 'content-type': 'application/json' } },
    );
  });
}

async function freshSessionModule() {
  // The in-flight guard is module state on purpose, so each test needs a module
  // that has never been refreshed. A cache-busting import gives one.
  vi.resetModules();
  return import('./session');
}

describe('session refresh', () => {
  beforeEach(() => {
    refreshCalls.length = 0;
    refreshResult = { status: 200, token: 'access-1' };
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the access token where nothing can read it from storage', async () => {
    const { getAccessToken, refreshSession } = await freshSessionModule();
    expect(getAccessToken()).toBeNull();

    await refreshSession();
    expect(getAccessToken()).toBe('access-1');

    // Proof by construction rather than by asserting on localStorage, which does
    // not exist under the node environment these tests run in — an assertion
    // there would pass whether or not the code ever touched it.
    //
    // If the token had been written to storage, a module loaded AFTER the
    // refresh would read it back, exactly as the v0.0.2 store did. A fresh
    // module instance does not, so nothing persisted it.
    vi.resetModules();
    const reloaded = await import('./session');
    expect(reloaded.getAccessToken()).toBeNull();
  });

  it('presents a single-use refresh token exactly once, however many callers race', async () => {
    const { refreshSession } = await freshSessionModule();

    // StrictMode's double mount, an api.ts 401 and a manual retry, all at once.
    const results = await Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession(),
      refreshSession(),
    ]);

    expect(refreshCalls.filter((u) => u.includes('/api/auth/refresh'))).toHaveLength(1);
    expect(results).toEqual([true, true, true, true]);
  });

  it('reports a missing session as signed out rather than throwing', async () => {
    const { refreshSession, getAccessToken } = await freshSessionModule();
    refreshResult = { status: 401 };

    await expect(refreshSession()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('survives the network being down', async () => {
    const { refreshSession, getAccessToken } = await freshSessionModule();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(refreshSession()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('allows a later refresh after the first one settles', async () => {
    const { refreshSession, getAccessToken } = await freshSessionModule();

    await refreshSession();
    expect(getAccessToken()).toBe('access-1');

    // The guard is cleared on a macrotask, so let it drain before the next one.
    await new Promise((resolve) => setTimeout(resolve, 1));

    refreshResult = { status: 200, token: 'access-2' };
    await refreshSession();

    expect(getAccessToken()).toBe('access-2');
    expect(refreshCalls.filter((u) => u.includes('/api/auth/refresh'))).toHaveLength(2);
  });

  it('sends the cookie, since the refresh token is not readable from JavaScript', async () => {
    const { refreshSession } = await freshSessionModule();
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ token: 'access-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await refreshSession();
    expect(seen[0]?.credentials).toBe('same-origin');
    expect(seen[0]?.method).toBe('POST');
  });
});