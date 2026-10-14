/**
 * Request ids and access logging.
 *
 * Every request gets an id. An inbound `X-Request-ID` is respected (so a reverse
 * proxy or a support email can name the failing request), otherwise one is
 * generated. It is echoed back on the response, attached to every log line the
 * request produces, and included in error responses.
 *
 * The id is put in an AsyncLocalStorage store for the life of the request, so
 * `log('...')` anywhere in the stack picks it up without `req` being passed
 * around. See ./logger.js.
 *
 * Verified on this Node: the store IS still visible inside the `res.on('finish')`
 * listener, so the access log line carries `request_id` even though it runs
 * after the response is already written.
 *
 * ## Inbound ids are sanitised, not trusted
 *
 * A request id ends up in the log stream. An unvalidated one is a log-injection
 * primitive: send `X-Request-ID: {"level":"info","msg":"authenticated"}` and you
 * have written a convincing line into somebody's log. So: printable ASCII only,
 * bounded length, anything else gets a generated id instead. A legitimate proxy
 * that sends UUIDs passes straight through.
 */

const { randomUUID } = require('crypto');
const { logger, runWithContext } = require('./logger');

const HEADER = 'x-request-id';
const MAX_ID_LEN = 200;

/**
 * Allowlist, not a blocklist.
 *
 * A legitimate inbound id is an opaque token: a UUID, an Envoy/ALB trace id, a
 * support ticket reference, `req_9f2c...`. None of those need punctuation
 * beyond ` - _ . : / @ = +`. Anything else — braces, quotes, backslashes,
 * spaces, control characters, non-ASCII — is not something a proxy or a
 * support email produces, so it gets a generated id instead.
 *
 * Note on what is actually doing the work: JSON.stringify escapes a hostile
 * string, so the access log cannot be forged into a fake *line* regardless of
 * what this regex accepts. The regex is about not admitting structured values
 * at all, because log pipelines that auto-detect JSON (Loki, Elastic, and a
 * fair number of `jq 'select(.msg==...)'` shell one-liners) will happily treat
 * `{"level":"info","msg":"authenticated"}` as fields rather than as one string.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_.:/@=+-]{1,200}$/;

/** Returns a usable inbound id, or null if it is not one. */
function sanitizeInboundId(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LEN) return null;
  return SAFE_ID_RE.test(trimmed) ? trimmed : null;
}

function newRequestId() {
  return `req_${randomUUID()}`;
}

/**
 * Express middleware.
 *
 * @param {object}  [options]
 * @param {object}  [options.logger]
 * @param {boolean} [options.logRequests=true]  emit one line per completed request
 * @param {boolean} [options.logBodies=false]   never enable this in production
 */
function requestContext(options = {}) {
  const log = options.logger || logger;
  const logRequests = options.logRequests !== false;

  return function requestContextMiddleware(req, res, next) {
    const inbound = sanitizeInboundId(req.headers[HEADER]);
    const requestId = inbound || newRequestId();

    req.requestId = requestId;
    req.id = requestId; // short alias, matches what most middleware expects
    res.setHeader('X-Request-ID', requestId);

    if (logRequests) {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const status = res.statusCode;
        const line = {
          method: req.method,
          // `req.path`, never `req.originalUrl`: a query string is attacker
          // controlled and would put unbounded text into the log.
          path: req.path,
          status,
          duration_ms: Math.round(durationMs * 100) / 100,
          ip: req.ip,
          ...(req.user ? { user_id: req.user.id } : {}),
          kind: 'http_access',
        };
        if (status >= 500) log.error('request', line);
        else if (status >= 400) log.warn('request', line);
        else log.info('request', line);
      });

      // A client that hangs up mid-request still gets one line, so the gap in
      // the access log has a reason attached to it.
      res.on('close', () => {
        if (!res.writableEnded) {
          log.warn('request aborted by the client', {
            method: req.method,
            path: req.path,
            ip: req.ip,
            kind: 'http_aborted',
          });
        }
      });
    }

    runWithContext({ requestId }, () => next());
  };
}

/**
 * Terminal error handler.
 *
 * Mount this LAST, after every route. It replaces the one in index.js so that
 * an unexpected throw produces a 500 with a `requestId` in the body instead of
 * the default HTML error page, and a log line that says which request died.
 *
 * 4xx errors raised deliberately (auth, validation) keep their status; anything
 * else is a 500 and its message is NOT echoed to the client.
 */
function errorHandler(options = {}) {
  const log = options.logger || logger;

  // eslint-disable-next-line no-unused-vars
  return function opsErrorHandler(err, req, res, next) {
    const requestId = req.requestId || null;
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    // Multer and the upload pipeline signal 4xx by class/name, not by .status.
    const isClientError = status < 500 || err?.name === 'UploadRejected' || /Only image/.test(err?.message || '');

    const line = {
      request_id: requestId,
      method: req?.method,
      path: req?.path,
      status,
      error: err?.message,
      stack: err?.stack,
      kind: 'request_error',
    };

    if (isClientError) log.warn('request rejected', line);
    else log.error('unhandled request error', line);

    if (res.headersSent) {
      // Too late to change the status. Do not pretend we reported it.
      return res.end();
    }
    return res.status(status).json({
      error: isClientError ? err.message : 'Internal server error',
      requestId,
    });
  };
}

module.exports = {
  requestContext,
  errorHandler,
  sanitizeInboundId,
  newRequestId,
  REQUEST_ID_HEADER: 'x-request-id',
};
