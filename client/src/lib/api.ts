/**
 * Thin fetch wrapper.
 *
 * Holds the access token in memory (see stores/auth) and transparently refreshes
 * it once when it expires. Because the token is never persisted, an expired one
 * is a normal event rather than a sign-out.
 */

import { getAccessToken, refreshSession } from './session';
import { useAuth } from '../stores/auth';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    /* not JSON — fall through */
  }
  return res.statusText || `Request failed (${res.status})`;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;

  const send = (): Promise<Response> => {
    const token = getAccessToken();
    return fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(isForm || init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  };

  let res = await send();

  // One silent refresh, one retry. Never loop: a server that 401s forever must
  // not turn into a request storm. The refresh itself is deduplicated in
  // lib/session, so N parallel 401s — or a 401 racing the boot refresh — cost
  // one rotation rather than N.
  if (res.status === 401 && !path.includes('/auth/refresh')) {
    const ok = await refreshSession();
    if (ok) {
      res = await send();
    } else {
      useAuth.getState().signOut();
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  return (contentType.includes('application/json') ? await res.json() : await res.text()) as T;
}