/**
 * Plan step 10, client half: cursor paging, live updates, and the offline outbox.
 *
 * Three transport problems are solved here, and none of them touch the cipher.
 *
 * ── 1. Paging ────────────────────────────────────────────────────────────────
 * The archive is newest-first and the server pages backwards over a
 * `(created_at, id)` tuple, handing back an opaque `X-Next-Cursor`. The old
 * client sent `cursor=<last id>` against an `id > ? ASC` query — a forward cursor
 * over an ascending list, which is incoherent with a newest-first scroll: it
 * either re-serves the page you just read or skips everything written since.
 *
 * With a tuple cursor, a letter that arrives mid-scroll is strictly *newer* than
 * every cursor already issued. It therefore lands above the boundary, is picked
 * up by a refresh of the first page, and can appear in neither the page being
 * read nor any later page. Nothing is skipped and nothing repeats — not because
 * the client dedupes, but because the ordering is total and the direction of
 * travel is the direction of the scroll.
 *
 * The cursor is treated as OPAQUE. The client never builds one; if the server
 * changes its encoding, nothing here changes.
 *
 * ── 2. Live updates ──────────────────────────────────────────────────────────
 * The stream is consumed with `fetch()` + `ReadableStream`, NOT `EventSource`.
 * `EventSource` cannot set an Authorization header, so using it would put a JWT
 * in a query string where proxies log it. `fetch` gives us a normal header, plus
 * an `AbortController` that is the only reliable way to guarantee the connection
 * is gone.
 *
 * Teardown is the part that hangs CI. A leaked stream leaves a socket open, the
 * Node process never exits, and the job runs until it is killed. So `close()` is
 * idempotent and total: it aborts the request, cancels the reader, clears the
 * reconnect timer, and drops every listener. See {@link LetterStream.close}.
 *
 * ── 3. The outbox ────────────────────────────────────────────────────────────
 * A letter sealed while offline waits in IndexedDB and goes out on reconnect.
 * The hard part is not sending it — it is not sending it twice.
 *
 * Every composed letter mints ONE idempotency key, at compose time, and reuses it
 * for every subsequent attempt of that same letter. The server enforces
 * uniqueness on `(sender_id, idempotency_key)`, so a retry whose response was
 * lost is answered with the original row instead of a second copy. Without this,
 * the classic failure — server commits, response dies on the way back, client
 * retries — silently posts a letter twice, and a private letter is the worst
 * possible thing to send twice.
 *
 * ── The cipher ───────────────────────────────────────────────────────────────
 * Nothing in this file encrypts or decrypts. `encrypted_content` is an opaque
 * string produced by lib/crypto.ts, stored verbatim, and sent verbatim. The
 * outbox holds ciphertext and routing metadata ONLY — never plaintext. A queued
 * letter on disk is exactly as unreadable as one on the server, and the user's
 * draft text stays where Compose already keeps it (localStorage), which is why a
 * failed send loses nothing.
 */

/* ══════════════════════════════════════════════════════════════════════════ *
 * Types
 * ══════════════════════════════════════════════════════════════════════════ */

/** The server's lifecycle. Order matters: it is the one-way ratchet order. */
export const LIFECYCLE_STATES = ['draft', 'sealed', 'in_transit', 'opened', 'replied'] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Client-only states. These never appear in a server response.
 *
 * `sending` and `failed` are optimistic: a letter the user just sealed is in the
 * archive immediately, before the network has been told anything.
 */
export type OptimisticState = 'sending' | 'failed';

export type LetterState = LifecycleState | OptimisticState;

export function isLifecycleState(state: string): state is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(state);
}

/** One row of the archive, as the API returns it. */
export interface SyncLetter {
  id: number;
  sender_id: number;
  recipient_id: number;
  /** Opaque envelope from lib/crypto.ts. The server cannot read it. */
  encrypted_content: string;
  encrypted_metadata: string | null;
  photo_paths: string | null;
  sent_at: string;
  delivered_at: string | null;
  /** When it became available to the recipient. Null while still travelling. */
  opened_at: string | null;
  /** When the recipient actually opened it. Different fact from arrival. */
  read_at: string | null;
  replied_to: number | null;
  /** The cursor key. Fixed-width canonical instant, always. */
  created_at: string;
  state: LetterState;
  available_at: string | null;
  /** Client-only: why a queued send failed. */
  local_error?: string | null;
  /** Client-only: the outbox key this optimistic letter will be sent under. */
  idempotency_key?: string | null;
}

export type Letter = SyncLetter;

/** What `/api/letters/sync` returns: a bare array, plus paging headers. */
export interface PageResult {
  letters: SyncLetter[];
  nextCursor: string | null;
  hasMore: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Ordering and merging
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The total order the server pages by: `(created_at, id)`, newest first.
 *
 * `created_at` alone is not unique — a phone can seal two letters inside one
 * millisecond — and `id` alone would be correct only if ids were assigned in
 * strict arrival order. The pair is a total order, and the pair is what the
 * cursor encodes.
 */
export function compareNewestFirst(a: SyncLetter, b: SyncLetter): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

/** Stable identity for merge/dedupe. Matches the server's tuple exactly. */
export function letterKey(letter: SyncLetter): string {
  return `${letter.created_at}#${letter.id}`;
}

/**
 * Merges a freshly fetched page into what we already hold.
 *
 * Two things have to survive this:
 *
 *  - **No duplicates.** A page boundary and the SSE refresh race constantly: a
 *    letter arrives, `/sync` is re-fetched, the stream pushes again. Keying on the
 *    server's own tuple means an overlap collapses to one row instead of two.
 *
 *  - **No optimistic rows dropped.** A letter still `sending` is keyed on a
 *    negative id and a locally minted `created_at`, so it can never collide with
 *    a server row. When the real one arrives it is reconciled by
 *    {@link reconcileOptimistic}, which is a separate, explicit step.
 *
 * Later data wins for a given key, so re-fetching always moves toward the truth.
 */
export function mergeLetters(existing: SyncLetter[], incoming: SyncLetter[]): SyncLetter[] {
  const byKey = new Map<string, SyncLetter>();
  for (const letter of existing) byKey.set(letterKey(letter), letter);
  for (const letter of incoming) byKey.set(letterKey(letter), letter);
  return Array.from(byKey.values()).sort(compareNewestFirst);
}

/**
 * Replaces an optimistic row with the server's version of the same letter.
 *
 * Matching is on the idempotency key, not the id: the client does not know the
 * id until the server assigns one, so the key is the only thing both sides are
 * guaranteed to agree on. Returns the merged list, unchanged if there was no
 * optimistic row (a letter sealed on another device, say).
 */
export function reconcileOptimistic(
  letters: SyncLetter[],
  serverLetter: SyncLetter,
  byIdempotencyKey: string | null,
): SyncLetter[] {
  if (!byIdempotencyKey) return mergeLetters(letters, [serverLetter]);

  const withoutOptimistic = letters.filter((l) => l.idempotency_key !== byIdempotencyKey);
  return mergeLetters(withoutOptimistic, [serverLetter]);
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Transport
 * ══════════════════════════════════════════════════════════════════════════ */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown for a non-2xx response. Carries the status so callers can branch. */
export class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
  /**
   * 4xx means the letter itself is unacceptable — unpaired, malformed, forbidden.
   * Retrying it unchanged will fail identically, so a permanently failed letter
   * must be moved aside rather than left blocking the queue forever.
   */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    /* not JSON */
  }
  return res.statusText || `Request failed (${res.status})`;
}

export interface SyncClientOptions {
  baseUrl?: string;
  token: string | null;
  fetchImpl?: FetchLike;
}

/**
 * The authenticated transport for the letters endpoints.
 *
 * A thin wrapper over lib/api.ts's error handling rather than a reuse of it: that
 * one reads the token from the auth store on every call and calls `logout()` on a
 * 401, which is right for screens and wrong for the outbox (a queued letter
 * must survive a token refresh, not be destroyed by one).
 */
export class SyncClient {
  /** Public so the stream can be pointed at the same origin without a second option. */
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: SyncClientOptions) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      ...(extra ?? {}),
    };
  }

  /**
   * One page of the archive, oldest-first direction of travel.
   *
   * `cursor` is whatever the previous page handed back — the server's encoding,
   * not ours. `null` means "give me the newest", which is also the correct
   * refresh when a new letter arrives mid-scroll.
   */
  async fetchPage(opts: { cursor?: string | null; limit?: number } = {}): Promise<PageResult> {
    const query = new URLSearchParams();
    query.set('limit', String(opts.limit ?? 50));
    if (opts.cursor) query.set('cursor', opts.cursor);

    const res = await this.fetchImpl(`${this.baseUrl}/api/letters/sync?${query.toString()}`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) throw new SyncHttpError(res.status, await readError(res));

    const letters = (await res.json()) as SyncLetter[];
    const rawCursor = res.headers?.get?.('X-Next-Cursor') ?? null;
    return {
      letters: Array.isArray(letters) ? letters : [],
      // An absent header means "no more pages". The server only sets it when
      // there is genuinely another page, so an empty string is never a cursor.
      nextCursor: rawCursor && rawCursor.length > 0 ? rawCursor : null,
      hasMore: res.headers?.get?.('X-Has-More') === 'true',
    };
  }

  /**
   * Hands the server a sealed envelope.
   *
   * `idempotencyKey` is REQUIRED for every send from the outbox. The server
   * returns the original row for a repeat, and flags it with
   * `Idempotent-Replay: true` so the client can tell "I just made this" from
   * "I already had this" — they return the same body, which is the point.
   */
  async sendLetter(payload: {
    recipientId: number;
    encryptedContent: string;
    encryptedMetadata?: string | null;
    photoPaths?: string | null;
    deliveredAt?: string | null;
    inReplyTo?: number | null;
    idempotencyKey: string;
  }): Promise<{ letter: SyncLetter; duplicate: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/letters/send`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        recipientId: payload.recipientId,
        encryptedContent: payload.encryptedContent,
        encryptedMetadata: payload.encryptedMetadata ?? null,
        photoPaths: payload.photoPaths ?? null,
        deliveredAt: payload.deliveredAt ?? null,
        inReplyTo: payload.inReplyTo ?? null,
        idempotencyKey: payload.idempotencyKey,
      }),
    });

    if (!res.ok) throw new SyncHttpError(res.status, await readError(res));

    const body = (await res.json()) as { letter?: SyncLetter };
    if (!body || !body.letter) throw new Error('The server accepted the letter but returned no record of it.');
    return { letter: body.letter, duplicate: res.headers?.get?.('Idempotent-Replay') === 'true' };
  }

  /** Records that the recipient opened a letter. Separate from GET on purpose. */
  async markRead(letterId: number): Promise<SyncLetter | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/letters/${letterId}/read`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (res.status === 409) return null; // still in transit — not an error
    if (!res.ok) throw new SyncHttpError(res.status, await readError(res));
    const body = (await res.json()) as { letter?: SyncLetter };
    return body?.letter ?? null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * SSE
 * ══════════════════════════════════════════════════════════════════════════ */

export type StreamEventName = 'ready' | 'received' | 'sent' | 'arrived' | 'message';

export interface StreamEvent {
  type: StreamEventName;
  letterId?: number;
  at?: string;
}

export interface SseParser {
  push(chunk: string): void;
  /** Any trailing complete frame. Called when the stream ends. */
  flush(): void;
}

/**
 * A minimal, correct `text/event-stream` parser.
 *
 * Split on the blank-line frame boundary, and ONLY there. The boundary can
 * straddle a chunk, so the remainder is buffered rather than parsed eagerly.
 *
 * `data:` may repeat within one frame and is joined with newlines; a frame with
 * no data is a comment frame (the server's `: keep-alive`) and is discarded. This
 * is what lets a heartbeat flow through without being mistaken for an event.
 */
export function createSseParser(onEvent: (event: StreamEvent) => void): SseParser {
  let buffer = '';

  const handleFrame = (frame: string): void => {
    let type: string | null = null;
    const data: string[] = [];

    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // comment / heartbeat
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // Exactly one optional leading space is part of the framing, not the value.
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }

    if (data.length === 0) return;

    const raw = data.join('\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // a malformed frame must not kill the stream
    }

    const payload = (parsed ?? {}) as Record<string, unknown>;
    onEvent({
      type: (type ?? 'message') as StreamEventName,
      ...(typeof payload.letterId === 'number' ? { letterId: payload.letterId } : {}),
      ...(typeof payload.at === 'string' ? { at: payload.at } : {}),
    });
  };

  const drain = (final: boolean): void => {
    // Normalise CRLF, but hold back a trailing lone '\r': it may be the first
    // half of a '\r\n' whose '\n' is in the next chunk.
    buffer = buffer.replace(/\r\n/g, '\n');
    const boundary = buffer.indexOf('\n\n');
    if (boundary === -1) return;
    let from = 0;
    for (;;) {
      const at = buffer.indexOf('\n\n', from);
      if (at === -1) break;
      handleFrame(buffer.slice(from, at));
      from = at + 2;
    }
    buffer = buffer.slice(from);
    if (final && buffer.trim().length > 0) {
      handleFrame(buffer);
      buffer = '';
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      drain(false);
    },
    flush(): void {
      drain(true);
    },
  };
}

export interface LetterStreamOptions {
  client: SyncClient;
  url?: string;
  token?: string | null;
  fetchImpl?: FetchLike;
  onEvent: (event: StreamEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Reconnect backoff ceiling, ms. 0 disables reconnection (used by tests). */
  reconnectMaxMs?: number;
}

export type StreamStatus = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface LetterStream {
  /** Idempotent and total. After this returns, nothing is running. */
  close(): void;
  readonly status: () => StreamStatus;
  /** Test seam: the in-flight reconnect timer, if any. */
  readonly pendingReconnect: () => number;
}

/**
 * The live connection.
 *
 * Built on `fetch` + `ReadableStream` so the request carries an Authorization
 * header and so that `AbortController` is in our hands — `EventSource` offers
 * neither, and would leave a JWT in a URL that proxies log.
 *
 * **Teardown.** `close()` must leave nothing behind, because anything left is a
 * CI job that will not exit. It is idempotent (close is reachable from the
 * component unmount, from an auth change, and from an error path, and running it
 * twice must be harmless), and it does all four of: clear the reconnect timer,
 * abort the controller, cancel the stream reader, and drop the listeners.
 */
export function openLetterStream(options: LetterStreamOptions): LetterStream {
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const url = options.url ?? `${options.client.baseUrl}/api/letters/stream`;
  const reconnectMaxMs = options.reconnectMaxMs ?? 15_000;

  let status: StreamStatus = 'closed';
  let controller: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  /** Bumped on every close() so an in-flight connect cannot resurrect itself. */
  let generation = 0;

  const setStatus = (next: StreamStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /** Detaches the current request without touching the reconnect policy. */
  const teardownRequest = (): void => {
    const active = reader;
    reader = null;
    if (active) {
      // cancel() releases the socket. It is called without awaiting: a caller
      // closing the stream should not have to wait on the network to unmount,
      // and an already-aborted stream rejects the promise harmlessly.
      void Promise.resolve(active.cancel()).catch(() => {});
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  const scheduleReconnect = (gen: number): void => {
    if (gen !== generation || reconnectMaxMs <= 0) return;
    attempt += 1;
    // Exponential backoff, capped. A server restart must not turn every client
    // into a thundering herd at the same fixed interval.
    const delay = Math.min(500 * 2 ** (attempt - 1), reconnectMaxMs);
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (gen === generation) void connect(gen);
    }, delay);
  };

  async function connect(gen: number): Promise<void> {
    if (gen !== generation) return; // closed while we were queued
    teardownRequest();
    setStatus('connecting');

    controller = new AbortController();
    const parser = createSseParser((event) => {
      if (event.type === 'ready') attempt = 0; // connected: reset the backoff
      options.onEvent(event);
    });

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        signal: controller.signal,
      });

      if (gen !== generation) return;

      if (!res.ok || !res.body) {
        // The body still has to be drained or the socket is not released.
        await res.text().catch(() => '');
        throw new SyncHttpError(res.status, `Stream refused (${res.status})`);
      }

      setStatus('open');
      reader = res.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (gen !== generation) return;
        if (value) parser.push(decoder.decode(value, { stream: true }));
      }
      parser.flush();

      if (gen !== generation) return; // closed: do not reconnect
      scheduleReconnect(gen);
    } catch {
      // AbortError lands here too, and is the expected path on close().
      if (gen !== generation) return;
      teardownRequest();
      if (gen === generation) scheduleReconnect(gen);
    }
  }

  generation += 1;
  const gen = generation;
  void connect(gen);

  return {
    close(): void {
      // Idempotent: closing twice is not an error, and after the first call the
      // generation bump makes every in-flight continuation a no-op.
      generation += 1;
      clearReconnect();
      teardownRequest();
      setStatus('closed');
    },
    status: () => status,
    pendingReconnect: () => (reconnectTimer === null ? 0 : 1),
  };
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Outbox (IndexedDB)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One queued letter.
 *
 * `idempotency_key` is the PRIMARY KEY and is also the server's dedupe key. The
 * two are deliberately the same string: there is no mapping to get out of sync.
 *
 * There is NO PLAINTEXT FIELD, and there must never be one. Compose's draft text
 * lives in localStorage where it already was; the outbox holds the sealed
 * envelope, which is unreadable without the recipient's private key. A queued
 * letter on disk is no more legible than one on the server.
 */
export interface OutboxRecord {
  idempotency_key: string;
  recipient_id: number;
  /** JSON-stringified LetterEnvelope. Opaque. */
  encrypted_content: string;
  encrypted_metadata: string | null;
  photo_paths: string | null;
  delivered_at: string | null;
  in_reply_to: number | null;
  /** Local mint time; becomes the optimistic row's created_at. */
  client_created_at: string;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

const DB_NAME = 'penpal-outbox';
const DB_VERSION = 1;
const STORE_NAME = 'letters';

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface Outbox {
  put(record: OutboxRecord): Promise<void>;
  get(key: string): Promise<OutboxRecord | undefined>;
  all(): Promise<OutboxRecord[]>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

/**
 * Opens the outbox.
 *
 * IndexedDB is resolved at CALL time, never at module scope: `globalThis` is not
 * defined during SSR/prerender in some setups, and touching it at import time
 * would hard-crash the bundle before React mounts — the exact class of bug that
 * v0.0.2 had with its bare `JSON.parse(localStorage...)`.
 */
export async function openOutbox(factory?: IDBFactory): Promise<Outbox> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) throw new Error('This browser has no IndexedDB, so a letter cannot be queued for offline.');

  const handle = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'idempotency_key' });
        store.createIndex('by_created', 'client_created_at');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the outbox'));
  });

  return {
    async put(record) {
      const tx = handle.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      await txDone(tx);
    },
    async get(key) {
      const tx = handle.transaction(STORE_NAME, 'readonly');
      const found = await req<OutboxRecord | undefined>(tx.objectStore(STORE_NAME).get(key));
      return found;
    },
    async all() {
      const tx = handle.transaction(STORE_NAME, 'readonly');
      const rows = await req<OutboxRecord[]>(tx.objectStore(STORE_NAME).getAll());
      // Oldest first: a letter is a letter, but two of them are a conversation,
      // and delivering them out of order would be a small cruelty.
      return rows.sort((a, b) => (a.client_created_at < b.client_created_at ? -1 : 1));
    },
    async remove(key) {
      const tx = handle.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      await txDone(tx);
    },
    async clear() {
      const tx = handle.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      await txDone(tx);
    },
    close() {
      handle.close();
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Idempotency keys
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Mints the key a letter will be retried under, ONCE, at compose time.
 *
 * Not at send time. A key generated per attempt is not an idempotency key at
 * all — it is a request id, and it makes every retry a fresh letter.
 *
 * `randomUUID` where available, and a `getRandomValues` fallback otherwise, since
 * `Math.random` is nowhere near enough entropy for something that gates whether
 * a private letter gets posted twice.
 */
export function mintIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * The controller
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Negative ids for optimistic rows.
 *
 * Server ids are positive (autoincrement), so a negative id can never collide
 * with one, which means an optimistic letter and its server replacement can both
 * be in the list during reconciliation without either shadowing the other. They
 * differ exactly when they must, and are identical when they must not.
 */
let tempIdCounter = 0;
export function nextTempId(): number {
  tempIdCounter -= 1;
  return tempIdCounter;
}

/** Injectable so tests can run this without a real IndexedDB. */
export interface SyncControllerOptions {
  client: SyncClient;
  outbox: Outbox;
  token?: string | null;
  fetchImpl?: FetchLike;
  streamUrl?: string;
  reconnectMaxMs?: number;
  pageSize?: number;
  /** Broadcast to the store. Called for every state change. */
  onChange?: (state: SyncState) => void;
  onLetter?: (letter: SyncLetter) => void;
  onError?: (message: string) => void;
}

export interface SyncState {
  letters: SyncLetter[];
  /** Opaque; pass straight back to fetchPage. `null` before the first page. */
  cursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  /** True while a page is being fetched; a scroll guard, not a spinner. */
  loadingMore: boolean;
  error: string;
  stream: StreamStatus;
  queued: number;
}

const initialState = (): SyncState => ({
  letters: [],
  cursor: null,
  hasMore: true,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: '',
  stream: 'closed',
  queued: 0,
});

/**
 * Ties paging, the stream, and the outbox together.
 *
 * Deliberately a plain object with explicit `start()`/`stop()` rather than a hook:
 * the teardown contract is the part of this feature most likely to be broken by
 * a future refactor, and an explicit stop() is auditable in a way that a
 * `useEffect` cleanup callback three files away is not.
 */
export class SyncController {
  private state: SyncState = initialState();
  private stream: LetterStream | null = null;
  private started = false;
  private disposed = false;
  private flushing: Promise<void> | null = null;
  /** Set when a flush is asked for while one is already running. See flush(). */
  private pendingFlush = false;
  /** One in-flight attempt per key, so a retry storm cannot double-send. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: SyncControllerOptions) {}

  getState(): SyncState {
    return this.state;
  }

  private patch(next: Partial<SyncState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    this.options.onChange?.(this.state);
  }

  /**
   * Fetches page one, drains the outbox, and opens the stream. Idempotent.
   *
   * Order matters: drain BEFORE streaming, so a letter queued while offline is
   * reconciled into the first page rather than racing it, and so the server's
   * `sent` push for a letter we just sent cannot arrive before we know its id.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      await this.refresh();
      await this.flush();
      this.openStream();
    } catch {
      /* refresh/flush report their own errors */
    }
  }

  /**
   * Releases every resource. Idempotent, and safe to call before `start()`.
   *
   * After this the controller holds no timers, no stream, and no open database.
   */
  stop(): void {
    this.disposed = true;
    this.started = false;
    this.stream?.close();
    this.stream = null;
    this.inFlight.clear();
  }

  /* ---------------------------------------------------------------- paging -- */

  /** Page one again — the refresh path, and the SSE-driven re-read. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.patch({ loading: true, error: '' });
    try {
      const page = await this.options.client.fetchPage({
        cursor: null,
        limit: this.options.pageSize ?? 50,
      });
      // A refresh must NOT reset the scroll cursor. Throwing `cursor` away here
      // is how "Load more" starts re-serving page one forever.
      const keepOlderPages = this.state.cursor !== null;
      this.patch({
        letters: keepOlderPages ? mergeLetters(this.state.letters, page.letters) : mergeLetters([], page.letters),
        cursor: keepOlderPages ? this.state.cursor : page.nextCursor,
        hasMore: keepOlderPages ? this.state.hasMore : page.hasMore,
        loading: false,
        loaded: true,
        queued: await this.queuedCount(),
      });
    } catch (err) {
      this.patch({
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : 'Could not reach the archive.',
      });
    }
  }

  /**
   * The next page of OLDER letters.
   *
   * Concurrent calls are collapsed, because a scroll fires this faster than a
   * request completes and two in flight would both read the same cursor and
   * hand back the same page twice.
   */
  async fetchMore(): Promise<void> {
    const { cursor, hasMore, loading, loadingMore, loaded } = this.state;
    if (this.disposed || loading || loadingMore) return;
    if (loaded && !hasMore) return;
    if (!cursor) return; // first page still in flight; refresh() will set it

    this.patch({ loadingMore: true, error: '' });
    try {
      const page = await this.options.client.fetchPage({
        cursor,
        limit: this.options.pageSize ?? 50,
      });
      this.patch({
        letters: mergeLetters(this.state.letters, page.letters),
        cursor: page.nextCursor ?? cursor,
        hasMore: page.hasMore,
        loadingMore: false,
        loaded: true,
      });
    } catch (err) {
      this.patch({
        loadingMore: false,
        error: err instanceof Error ? err.message : 'Could not reach the archive.',
      });
    }
  }

  /* ------------------------------------------------------------- optimistic -- */

  /**
   * Queues a sealed letter and shows it immediately.
   *
   * The order is load-bearing and is the whole design:
   *
   *   1. mint the key        — once, now, reused by every retry forever
   *   2. write the outbox    — durable before anything is shown as sent
   *   3. show `sending`      — now the network knows nothing
   *   4. flush               — and only now does it find out
   *
   * Step 2 before step 3 is what makes this safe: the row can never appear as
   * `sending` without a durable record behind it, so a crash, a closed tab, or a
   * killed process cannot lose the letter.
   *
   * Returns the optimistic letter so a caller can navigate straight to it.
   */
  async sendLetter(input: {
    recipientId: number;
    encryptedContent: string;
    encryptedMetadata?: string | null;
    photoPaths?: string | null;
    deliveredAt?: string | null;
    inReplyTo?: number | null;
    /** Supply to resume an existing letter; otherwise one is minted. */
    idempotencyKey?: string;
  }): Promise<SyncLetter> {
    const idempotencyKey = input.idempotencyKey ?? mintIdempotencyKey();
    const now = new Date().toISOString();

    const record: OutboxRecord = {
      idempotency_key: idempotencyKey,
      recipient_id: input.recipientId,
      encrypted_content: input.encryptedContent,
      encrypted_metadata: input.encryptedMetadata ?? null,
      photo_paths: input.photoPaths ?? null,
      delivered_at: input.deliveredAt ?? null,
      in_reply_to: input.inReplyTo ?? null,
      client_created_at: now,
      attempts: 0,
      last_error: null,
      updated_at: now,
    };

    const optimistic: SyncLetter = {
      id: nextTempId(),
      sender_id: 0,
      recipient_id: input.recipientId,
      encrypted_content: input.encryptedContent,
      encrypted_metadata: input.encryptedMetadata ?? null,
      photo_paths: input.photoPaths ?? null,
      sent_at: now,
      delivered_at: input.deliveredAt ?? null,
      opened_at: null,
      read_at: null,
      replied_to: input.inReplyTo ?? null,
      created_at: now,
      state: 'sending',
      available_at: input.deliveredAt ?? now,
      local_error: null,
      idempotency_key: idempotencyKey,
    };

    await this.options.outbox.put(record);
    this.patch({
      letters: mergeLetters(this.state.letters, [optimistic]),
      queued: this.state.queued + 1,
    });

    void this.flush();
    return optimistic;
  }

  /**
   * Sends everything queued.
   *
   * Single-flight, but NOT single-pass — and the difference matters. `drain()`
   * snapshots the queue when it starts, so a letter sealed a moment later would
   * be stranded: it arrived after the snapshot, and the flush that joined the
   * running one returns without ever looking at it. So a flush requested while
   * a drain is in flight sets a flag, and the drain loops.
   *
   * The loop is bounded by {@link attempted}: a key already tried in this pass
   * is not tried again, so the loop picks up letters that were genuinely new
   * and does NOT immediately re-send one that just failed. Retrying a failed
   * letter is {@link retry}'s job, and it should be the user's decision, not a
   * side effect of the queue draining.
   *
   * Within a drain each key is also claimed with an in-flight guard, so even a
   * caller that forces a retry cannot put the same key on the wire twice.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.pendingFlush = true;
      return this.flushing;
    }
    this.flushing = this.drainLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drainLoop(): Promise<void> {
    const attempted = new Set<string>();
    do {
      this.pendingFlush = false;
      await this.drain(attempted);
    } while (this.pendingFlush && !this.disposed);
  }

  private async drain(attempted: Set<string>): Promise<void> {
    const records = await this.options.outbox.all();
    let sent = 0;

    for (const record of records) {
      if (this.disposed) return;
      if (this.inFlight.has(record.idempotency_key)) continue;
      if (attempted.has(record.idempotency_key)) continue; // already tried this pass
      attempted.add(record.idempotency_key);
      this.inFlight.add(record.idempotency_key);

      try {
        const { letter, duplicate } = await this.options.client.sendLetter({
          recipientId: record.recipient_id,
          encryptedContent: record.encrypted_content,
          encryptedMetadata: record.encrypted_metadata,
          photoPaths: record.photo_paths,
          deliveredAt: record.delivered_at,
          inReplyTo: record.in_reply_to,
          idempotencyKey: record.idempotency_key,
        });

        // Remove only on a confirmed success. `duplicate: true` is still a
        // success — the letter exists, and it exists exactly once.
        await this.options.outbox.remove(record.idempotency_key);
        this.patch({
          letters: reconcileOptimistic(this.state.letters, letter, record.idempotency_key),
          queued: Math.max(0, this.state.queued - 1),
        });
        if (!duplicate) sent += 1;
        this.options.onLetter?.(letter);
      } catch (err) {
        const permanent = err instanceof SyncHttpError && err.isPermanent;
        const message = err instanceof Error ? err.message : 'Could not send the letter.';

        if (permanent) {
          // Retrying unchanged will fail identically, so this must stop blocking
          // the letters behind it. The row stays visible as `failed`, with an
          // honest reason, and the outbox entry is kept so a retry is possible
          // once the cause is fixed.
          await this.options.outbox.put({
            ...record,
            attempts: record.attempts + 1,
            last_error: message,
            updated_at: new Date().toISOString(),
          });
          this.patch({
            letters: mergeLetters(
              this.state.letters.map((l) =>
                l.idempotency_key === record.idempotency_key ? { ...l, state: 'failed' as const, local_error: message } : l,
              ),
              [],
            ),
            queued: this.state.queued,
            error: message,
          });
          this.options.onError?.(message);
          continue;
        }

        // Transient: the network, or the server. The record is left untouched
        // so the very next drain retries under the SAME key — which is exactly
        // what makes the retry safe.
        await this.options.outbox.put({
          ...record,
          attempts: record.attempts + 1,
          last_error: message,
          updated_at: new Date().toISOString(),
        });
        this.patch({ error: message });
        this.options.onError?.(message);
        return; // stop the drain; the rest will follow on reconnect
      } finally {
        this.inFlight.delete(record.idempotency_key);
      }
    }

    if (sent > 0) this.patch({ error: '' });
  }

  private async queuedCount(): Promise<number> {
    try {
      return (await this.options.outbox.all()).length;
    } catch {
      return this.state.queued;
    }
  }

  /**
   * Puts one failed letter back on the wire.
   *
   * The key is not regenerated. That is the entire point: a retry under a fresh
   * key would be a new letter, and the user would receive the one they had
   * already sent a second time.
   *
   * The row flips to `sending` immediately so the button responds, but the
   * outbox record was never removed on failure, so nothing has been lost either
   * way. If it fails again it comes back as `failed` with the new reason.
   */
  async retry(idempotencyKey: string): Promise<void> {
    if (this.disposed) return;
    this.patch({
      letters: this.state.letters.map((l) =>
        l.idempotency_key === idempotencyKey && l.state === 'failed'
          ? { ...l, state: 'sending' as const, local_error: null }
          : l,
      ),
      error: '',
    });
    await this.flush();
  }

  /* ---------------------------------------------------------------- stream -- */

  private openStream(): void {
    if (this.disposed || this.stream) return;
    this.stream = openLetterStream({
      client: this.options.client,
      url: this.options.streamUrl,
      token: this.options.token,
      fetchImpl: this.options.fetchImpl,
      reconnectMaxMs: this.options.reconnectMaxMs,
      onStatus: (stream) => this.patch({ stream }),
      onEvent: (event) => {
        if (this.disposed) return;
        // Signals, not payloads — the server sends `{type, letterId}` and
        // nothing more. Re-reading the page is cheap and is the only way to
        // stay correct: a `replied` flag can flip from a letter this client
        // never sent, and only the page knows that.
        if (event.type === 'received' || event.type === 'arrived' || event.type === 'sent') {
          void this.refresh();
        }
      },
    });
  }

  /* -------------------------------------------------------------- read rec -- */

  /** Records that a letter was opened. Optimistically local, reconciled by the server. */
  async markRead(letterId: number): Promise<void> {
    try {
      const letter = await this.options.client.markRead(letterId);
      if (!letter || this.disposed) return;
      this.patch({ letters: mergeLetters(this.state.letters, [letter]) });
    } catch {
      /* a missed read receipt is not worth interrupting the reader for */
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Queries the UI needs
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `replied` is derived by the server — a letter is answered when its recipient
 * has sent something after it became available to them. This is a display
 * convenience only; it reads a column the server already computed, so the client
 * can never disagree with the database about whether a letter was answered.
 */
export function isReplied(letter: SyncLetter): boolean {
  return letter.state === 'replied';
}

export function isInTransit(letter: SyncLetter): boolean {
  return letter.state === 'in_transit';
}

/** True while the client is pretending it sent something. */
export function isPending(letter: SyncLetter): boolean {
  return letter.state === 'sending';
}

export function isFailed(letter: SyncLetter): boolean {
  return letter.state === 'failed';
}

/**
 * When a travelling letter arrives. Null for anything that has already landed.
 *
 * `delivered_at` is the server's field of record; `available_at` is its
 * canonical projection of the same thing.
 */
export function arrivesAt(letter: SyncLetter): string | null {
  if (!isInTransit(letter)) return null;
  return letter.delivered_at ?? letter.available_at ?? null;
}

export function isMine(letter: SyncLetter, userId: number | null | undefined): boolean {
  return userId != null && letter.sender_id === userId;
}

/** Newest first. The server already returns this order; kept as a guard. */
export function sortNewestFirst(items: SyncLetter[]): SyncLetter[] {
  return [...items].sort(compareNewestFirst);
}

/** Unread means delivered to you and not yet opened. Not "not replied to". */
export function isUnread(letter: SyncLetter, userId: number | null | undefined): boolean {
  if (userId == null) return false;
  return letter.recipient_id === userId && !letter.read_at && letter.state !== 'in_transit';
}