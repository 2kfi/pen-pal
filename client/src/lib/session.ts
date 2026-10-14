/**
 * The session token, and the one refresh.
 *
 * Both `stores/auth` and `lib/api` need to mint an access token, and they must
 * never mint two at once. The refresh token is single-use: presenting it twice
 * trips the server's reuse detection, which revokes the whole token family and
 * signs the user out everywhere. So the refresh is deduplicated here, in one
 * place, rather than in each caller.
 *
 * That is not hypothetical. React's StrictMode runs mount effects twice in
 * development, so `restore()` fired two concurrent requests on every page load
 * — each carrying the same cookie — and every reload logged you out. The server
 * was right; the client was the attacker.
 *
 * It lives here rather than in either caller so the two can share it without
 * importing each other.
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** The request currently in flight, if any. Callers share it rather than racing. */
let inFlight: Promise<boolean> | null = null;

/**
 * Trade the httpOnly refresh cookie for a fresh access token.
 *
 * Resolves false when there is no live session. That is the ordinary signed-out
 * path, not an error — nothing here throws, and nothing is retried on its own.
 * The caller decides what a missing session means.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'penpal' },
      });
      if (!res.ok) {
        accessToken = null;
        return false;
      }
      const data = (await res.json()) as { token?: string };
      if (!data.token) {
        accessToken = null;
        return false;
      }
      accessToken = data.token;
      return true;
    } catch {
      accessToken = null;
      return false;
    }
  })();

  // Cleared after the microtask queue drains, so every caller that awaited this
  // promise sees the same answer before another refresh can begin. Clearing it
  // synchronously would let the next caller start a second rotation.
  inFlight = inFlight.finally(() => {
    setTimeout(() => {
      inFlight = null;
    }, 0);
  });

  return inFlight;
}