/**
 * Thin fetch wrapper.
 *
 * v0.0.2 threw `new Error(await res.text())`, which surfaced raw JSON like
 * `{"error":"Invalid login body: must be at least 3 chars"}` directly into the UI.
 * This parses the server's error envelope and exposes a typed `ApiError`.
 */

import { useAuth } from '../stores/auth';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** 401/403 on an authenticated request almost always means an expired token. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
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
  const { token, logout } = useAuth.getState();
  const isForm = init.body instanceof FormData;

  const res = await fetch(path, {
    ...init,
    headers: {
      ...(isForm || init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const err = new ApiError(res.status, await readError(res));
    if (err.isAuthFailure && token) logout();
    throw err;
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  return (contentType.includes('application/json') ? await res.json() : await res.text()) as T;
}