/**
 * The chess engine, off the main thread (plan step 25).
 *
 * v0.0.2 searched on the main thread, synchronously: the page froze for the
 * length of the search and the only way out was to reload. Moving the search
 * into a Worker is what makes "the opponent is thinking" a state the UI can
 * render and a search the user can cancel.
 *
 * ## What this file is (and what it deliberately is not)
 *
 * It contains no chess logic. All of it lives in `lib/chessSearch.ts`; this is
 * the plumbing that hands a position in and receives moves, scores and progress
 * out. The search itself is cooperative — it yields to the event loop every
 * `SLICE_MS` — which is the property that makes the Worker *cancellable*:
 * without a yield, the `message` event carrying `stop` cannot be delivered until
 * the search has already finished, and a `terminate()` would throw away
 * everything it had computed.
 *
 * ## Why it is also importable outside a Worker
 *
 * `createWorkerEndpoint` takes a port-like object instead of reaching for the
 * global `self`, so the same code path that runs in the browser can be driven by
 * a test in Node with a fake port. A test that re-implements the worker proves
 * nothing about the worker; this one moves the real file. `tests/games.test.js`
 * does exactly that, under a bounded timeout, because a search that does not
 * terminate hangs CI rather than failing it.
 */

import { bestMove } from './lib/chessSearch.ts';
import type { EngineRequest, EngineResponse, SearchProgress } from './lib/chessSearch.ts';
import type { GameState } from './lib/chessEngine.ts';

/* ------------------------------------------------------------------ *
 * the port                                                            *
 * ------------------------------------------------------------------ */

/** The part of `DedicatedWorkerGlobalScope` (or a test double) this file uses. */
export interface WorkerPort {
  postMessage(message: EngineResponse): void;
  onmessage: ((event: { data: EngineRequest }) => void) | null;
}

export interface EngineEndpoint {
  /** Handles one request. Exposed so a test can drive it without `onmessage`. */
  handle: (request: EngineRequest) => void;
  /** Aborts every in-flight search. Same thing a `stop` message does. */
  stop: () => void;
  /** Number of searches currently running. */
  readonly active: number;
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'the engine failed for an unknown reason';

/**
 * Wires a port up to the searcher.
 *
 * Two properties worth stating, because both are ways this file could be
 * subtly wrong:
 *
 *  1. A `stop` aborts *every* in-flight search, not just the newest one. The
 *     client only ever has one search outstanding, but a stale search that
 *     ignored the request would keep burning a core after the user walked away.
 *  2. A search that is stopped still produces a `result` message, carrying
 *     whatever it had. The engine client resolves with it. A cancel that
 *     rejects instead would force every caller to distinguish "cancelled" from
 *     "failed", and the answer to both is the same: play the best move so far.
 */
export function createWorkerEndpoint(port: WorkerPort): EngineEndpoint {
  const running = new Set<{ aborted: boolean }>();

  const stopAll = (): void => {
    for (const signal of running) signal.aborted = true;
  };

  const run = async (request: EngineRequest): Promise<void> => {
    if (request.type === 'stop') {
      stopAll();
      return;
    }
    if (request.type !== 'search') return;

    const { id, state, level, budget } = request;
    const signal = { aborted: false };
    running.add(signal);

    try {
      const result = await bestMove(state as GameState, {
        level,
        budget,
        signal,
        onProgress: (p: SearchProgress) => port.postMessage({ type: 'progress', id, ...p }),
      });
      port.postMessage({ type: 'result', id, result });
    } catch (err) {
      port.postMessage({ type: 'error', id, message: messageOf(err) });
    } finally {
      running.delete(signal);
    }
  };

  const handle = (request: EngineRequest): void => {
    void run(request);
  };

  port.onmessage = (event) => handle(event.data);

  return {
    handle,
    stop: stopAll,
    get active() {
      return running.size;
    },
  };
}

/* ------------------------------------------------------------------ *
 * installation                                                       *
 * ------------------------------------------------------------------ */

interface WorkerScope extends WorkerPort {
  /** Set once, so a re-imported module cannot install a second listener. */
  __penpalEngine?: EngineEndpoint;
}

/**
 * `self` exists in a Worker and in a window, and in neither under Node — which
 * is why this module is importable from a test. Installing is guarded rather
 * than assumed, because a second `onmessage` handler would silently swallow
 * every search.
 */
function install(): void {
  if (typeof self === 'undefined') return;
  const scope = self as unknown as WorkerScope;
  if (typeof scope.postMessage !== 'function') return;
  if (scope.__penpalEngine) return;

  scope.__penpalEngine = createWorkerEndpoint(scope);
  scope.postMessage({ type: 'ready' });
}

install();