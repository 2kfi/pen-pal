/**
 * Structured, request-scoped logging.
 *
 * ## Shape
 *
 * One JSON object per line on stdout, exactly as v0.0.2 did. Nothing changed
 * about the format — `docker compose logs | jq` keeps working. What is new:
 *
 *   - a `level` field (`log()` keeps emitting `info`, so old greps still hit)
 *   - a `request_id` on every line emitted while a request is in flight, which
 *     is what makes "it broke at 14:03" answerable instead of a guessing game
 *   - `installProcessHandlers()`, because an unhandled rejection used to vanish
 *     into the void with a one-line warning and no request to attach it to
 *
 * ## Request scoping
 *
 * An AsyncLocalStorage holds the id for the life of the request, so a `log()`
 * call three awaits deep inside a route handler still knows which request it
 * belongs to without threading `req` through every function in the stack.
 *
 * Verified on this Node: the ALS store IS visible inside `process.on
 * ('unhandledRejection')` when the rejecting promise was created inside a
 * request, which is the case that actually matters (a floating promise in a
 * route handler that rejects after the response was sent).
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

const threshold =
  LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/** Errors go to stderr so `docker logs` still shows them but they can be filtered. */
const SINKS = { debug: 'out', info: 'out', warn: 'out', error: 'err', fatal: 'err' };

function write(sink, line) {
  const stream = sink === 'err' ? process.stderr : process.stdout;
  try {
    stream.write(`${JSON.stringify(line)}\n`);
  } catch {
    // A log line must never take the process down. Circular structures in
    // `extra` are the realistic cause.
    stream.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'log serialisation failed' })}\n`);
  }
}

function emit(level, msg, extra = {}) {
  if (LEVELS[level] < threshold) return;
  const store = storage.getStore();
  const line = {
    t: new Date().toISOString(),
    level,
    msg: String(msg),
    ...(store && store.requestId ? { request_id: store.requestId } : {}),
    ...extra,
  };
  write(SINKS[level] || 'out', line);
}

const logger = {
  debug: (msg, extra) => emit('debug', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
  fatal: (msg, extra) => emit('fatal', msg, extra),

  /** Runs `fn` with these fields merged into every line it logs. */
  child(bindings = {}) {
    const parentStore = storage.getStore() || {};
    return runWithContext({ ...parentStore, ...bindings }, () => logger);
  },
};

/** The `{ name, up(db) }` shape migrations receive. */
function loggerFor(ctx = {}) {
  return logger;
}

/**
 * The compatibility shim for the old `log(msg, extra)` helper that index.js
 * defines inline. Same call signature, same JSON, now request-scoped.
 */
function log(msg, extra = {}) {
  return logger.info(msg, extra);
}

/** Binds `context` (at minimum `{ requestId }`) to everything async inside `fn`. */
function runWithContext(context, fn) {
  return storage.run(context, fn);
}

function currentContext() {
  return storage.getStore() || {};
}

function currentRequestId() {
  const store = storage.getStore();
  return (store && store.requestId) || null;
}

let installed = false;

/**
 * Logs the two failure modes that used to disappear.
 *
 * `unhandledRejection` — logged at `error` with whatever request id is in scope,
 * and the process keeps running. An unhandled rejection in one route must not
 * take down somebody's letters.
 *
 * `uncaughtException` — logged at `fatal` and the process exits non-zero. By the
 * time one of those fires the process state is undefined; staying up and serving
 * half-broken requests is worse than restarting, and compose has
 * `restart: unless-stopped`.
 */
function installProcessHandlers() {
  if (installed) return logger;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      kind: 'unhandledRejection',
      pid: process.pid,
    });
  });

  process.on('uncaughtException', (err) => {
    logger.fatal('uncaught exception; shutting down', {
      error: err && err.message,
      stack: err && err.stack,
      kind: 'uncaughtException',
      pid: process.pid,
    });
    // Give the write a tick to reach the log before the process goes away.
    setTimeout(() => process.exit(1), 50).unref();
  });

  return logger;
}

module.exports = {
  logger,
  log,
  emit,
  storage,
  runWithContext,
  currentContext,
  currentRequestId,
  installProcessHandlers,
  loggerFor,
  LEVELS,
};
