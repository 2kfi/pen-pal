import { useAuth } from '../stores/auth';

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAuth.getState().token;
  const isForm = init.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}
