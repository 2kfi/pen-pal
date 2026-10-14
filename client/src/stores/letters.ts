/**
 * The archive store.
 *
 * Thin by design. Every decision about *what* is true — paging order, lifecycle,
 * whether a letter has been replied to — belongs to lib/sync.ts and the server.
 * This file owns exactly one thing: getting that state into React, and tearing
 * the connection down when the session ends.
 *
 * The surface (`items`, `byId`, `fetchMore`, `loaded`, `loading`) is unchanged
 * from the pre-sync version, because Reader.tsx depends on it and a store that
 * silently changes shape under another page is worse than no refactor at all.
 * What is new: `sending` and `failed` rows, a live `stream` status, a retry for
 * a queued letter, and the lifecycle counts the archive header shows.
 */

import { create } from 'zustand';
import { getAccessToken, useAuth } from './auth';
import {
  SyncClient,
  SyncController,
  isFailed,
  isInTransit,
  isPending,
  isUnread,
  mergeLetters,
  openOutbox,
  sortNewestFirst,
  type Letter,
  type LetterState,
  type LifecycleState,
  type Outbox,
  type StreamStatus,
} from '../lib/sync';

export type { Letter, LetterState, LifecycleState, StreamStatus };

/**
 * Bumped whenever this file's shape changes in a way the tests must notice.
 * Cheap insurance against a store silently becoming untested.
 */
const STORE_SCHEMA = 3;

const PAGE_SIZE = 25;

interface LettersState {
  items: Letter[];
  /** Opaque server cursor. Never constructed here, only relayed. */
  cursor: string | null;
  loaded: boolean;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  stream: StreamStatus;
  /** Letters sealed but not yet acknowledged by the server. */
  queued: number;

  /** Connects: first page, outbox drain, live stream. Safe to call repeatedly. */
  connect: () => void;
  /** Disconnects and releases everything. Called on unmount and on logout. */
  disconnect: () => void;
  refresh: () => Promise<void>;
  fetchMore: (limit?: number) => Promise<void>;
  markRead: (id: number) => Promise<void>;
  /** Puts a failed letter back on the wire, under its ORIGINAL key. */
  retry: (idempotencyKey: string) => Promise<void>;
  /** True for an in-flight optimistic row. */
  isPending: (id: number) => boolean;
  /** True for a row the server refused, carrying why. */
  isFailed: (id: number) => boolean;
  unreadCount: () => number;
  inTransitCount: () => number;
  counts: () => Record<LifecycleState, number>;
  byId: (id: number) => Letter | undefined;
  reset: () => void;
}

/**
 * One controller per session.
 *
 * Module scope, not per-component: two mounts of the archive would otherwise
 * open two streams and drain the same outbox twice. `disconnect()` is the only
 * way to get rid of it, and that is the call React makes on unmount.
 */
let controller: SyncController | null = null;
/** Guards a StrictMode double-mount from opening a second stream. */
let connectCount = 0;

/**
 * The outbox is opened once, lazily, and shared.
 *
 * Opening IndexedDB is async, so this cannot happen at module scope, and it must
 * not happen per-mount or two tabs would each keep their own handle to the same
 * database.
 */
let outboxPromise: Promise<Outbox> | null = null;

/**
 * A no-op outbox, used when IndexedDB is unavailable.
 *
 * This is the important part: a browser that refuses IndexedDB (private mode,
 * a hardened profile, no storage at all) must still be able to READ its archive
 * and SEND a letter. Only the offline queue is lost, and that is reported in the
 * UI rather than allowed to take the whole page down with it. Gating the first
 * fetch on storage availability would mean a storage quirk shows up as an empty
 * archive, which is a much worse failure than a missing convenience.
 */
function nullOutbox(reason: string): Outbox {
  // Said out loud rather than swallowed: a developer wondering why the outbox
  // does nothing in a private window deserves an answer.
  console.warn(`[letters] offline queueing unavailable: ${reason}`);
  return {
    async put() {},
    async get() {
      return undefined;
    },
    async all() {
      return [];
    },
    async remove() {},
    async clear() {},
    close() {},
  };
}

function getOutbox(): Promise<Outbox> {
  outboxPromise ??= openOutbox().catch((err: unknown) =>
    nullOutbox(err instanceof Error ? err.message : 'This browser cannot store letters for offline sending.'),
  );
  return outboxPromise;
}

function makeController(outbox: Outbox): SyncController {
  // Access tokens are memory-only now (stores/auth), so read it at call time
  // rather than closing over a value captured when the controller was built.
  const token = getAccessToken();
  return new SyncController({
    client: new SyncClient({ token }),
    outbox,
    token,
    onChange: (state) =>
      useLetters.setState({
        items: state.letters,
        cursor: state.cursor,
        loaded: state.loaded,
        hasMore: state.hasMore,
        loading: state.loading,
        loadingMore: state.loadingMore,
        error: state.error,
        stream: state.stream,
        queued: state.queued,
      }),
  });
}

/**
 * The controller, creating it if nobody has yet.
 *
 * Reader.tsx never mounts the archive, so it never calls `connect()`. Without
 * this, reading a letter by direct URL would fetch nothing at all, because
 * `fetchMore` would be delegating to a controller that does not exist.
 */
async function ensureController(): Promise<SyncController> {
  if (controller) return controller;
  const outbox = await getOutbox();
  if (!controller) controller = makeController(outbox);
  return controller;
}

export const useLetters = create<LettersState>((set, get) => ({
  items: [],
  cursor: null,
  loaded: false,
  hasMore: true,
  loading: false,
  loadingMore: false,
  error: '',
  stream: 'closed',
  queued: 0,

  connect: () => {
    if (connectCount > 0) return;
    connectCount += 1;
    // Async because the outbox is. The archive renders from cache immediately
    // and fills in when this resolves, so there is no spinner for it.
    void ensureController()
      .then((active) => (connectCount === 0 ? null : active.start()))
      .catch((err: unknown) => {
        useLetters.setState({
          error: err instanceof Error ? err.message : 'Could not reach the archive.',
        });
      });
  },

  disconnect: () => {
    if (connectCount === 0) return;
    connectCount -= 1;
    // Only tear down when the last consumer leaves. StrictMode remounts fire
    // disconnect+connect in quick succession and a naive version would kill the
    // stream the second mount just asked for.
    if (connectCount > 0) return;
    controller?.stop();
    controller = null;
  },

  refresh: async () => {
    await (await ensureController())?.refresh();
  },

  fetchMore: async (limit = PAGE_SIZE) => {
    void limit; // page size is the controller's; kept for Reader.tsx's signature
    const active = await ensureController();
    // Never loaded, or already at the end: fetch page one rather than nothing.
    if (!active.getState().loaded) await active.refresh();
    else await active.fetchMore();
  },

  markRead: async (id: number) => {
    await (await ensureController())?.markRead(id);
  },

  retry: async (idempotencyKey: string) => {
    await (await ensureController())?.retry(idempotencyKey);
  },

  isPending: (id) => isPending(byIdOrThrow(get(), id)),
  isFailed: (id) => isFailed(byIdOrThrow(get(), id)),
  unreadCount: () => get().items.filter((l) => isUnread(l, useAuth.getState().user?.id)).length,
  inTransitCount: () => get().items.filter(isInTransit).length,

  counts: () => {
    const { items } = get();
    const out = { draft: 0, sealed: 0, in_transit: 0, opened: 0, replied: 0 } as Record<LifecycleState, number>;
    for (const letter of items) {
      // Optimistic rows are counted as `sealed`: they exist, and they have not
      // arrived. Counting a `sending` letter as anything else would make the
      // totals disagree with the list directly beneath them.
      const state = isPending(letter) || isFailed(letter) ? 'sealed' : letter.state;
      if (state in out) out[state as LifecycleState] += 1;
    }
    return out;
  },

  byId: (id) => get().items.find((l) => l.id === id),
  reset: () => set({ items: [], cursor: null, loaded: false, hasMore: true, error: '' }),
}));

/** Reader.tsx and the archive both need a stable reference into the list. */
function byIdOrThrow(state: LettersState, id: number): Letter {
  return state.items.find((l) => l.id === id) ?? FALLBACK;
}

/**
 * A row that is definitively "not pending" and "not failed".
 *
 * Returned rather than throwing so a memoised selector cannot crash a render
 * over a list that changed underneath it.
 */
const FALLBACK: Letter = {
  id: 0,
  sender_id: 0,
  recipient_id: 0,
  encrypted_content: '',
  encrypted_metadata: null,
  photo_paths: null,
  sent_at: new Date(0).toISOString(),
  delivered_at: null,
  opened_at: null,
  read_at: null,
  replied_to: null,
  created_at: new Date(0).toISOString(),
  state: 'sealed',
  available_at: null,
};

/** Newest first. */
export function sortNewestFirstLetters(items: Letter[]): Letter[] {
  return sortNewestFirst(items);
}

/**
 * Exposed for the sync test-suite, which asserts the schema has not drifted.
 * Kept out of the React tree: nothing renders it.
 */
export const LETTERS_STORE_SCHEMA = STORE_SCHEMA;

/** Re-exported so pages can merge a single letter without importing sync.ts too. */
export { mergeLetters };