# Wiring notes for server/index.js (I did NOT edit index.js — this is for the owner)

Three `app.use(...)` lines, in the order they must appear. Everything is tested
except the two mounts themselves.

## 1. Near the top, before any route

Request ids must exist before anything logs, so this goes immediately after the
body parsers, not near the bottom.

```js
const { requestContext, errorHandler } = require('./lib/ops/request-context');
const { installProcessHandlers, logger } = require('./lib/ops/logger');

installProcessHandlers();
app.use(requestContext());
```

`requestContext()` sets `req.requestId`, echoes `X-Request-ID`, and puts the id
into an AsyncLocalStorage store so every `log()` during the request carries it —
verified working even inside the `res.on('finish')` access log.

## 2. Ops routes

Mount with no prefix so `/healthz` stays where the compose healthcheck and CI
already look for it. Delete the existing line 129:

```js
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));
```

replacing it with:

```js
app.use(require('./routes/ops')());
```

This provides `/healthz` (200 healthy / 503 unhealthy — the CI contract is kept),
`/api/healthz`, and the admin-gated `/api/ops/{status,migrations,backups}`.

## 3. Error handler, mounted LAST

It replaces the current one at the end of the file, which only handles multer
errors and leaks `err.message` on a 500.

```js
app.use(errorHandler());
```

Keep the existing multer handler *above* it so upload rejections still map to
400 — `errorHandler()` already understands multer by class, but the existing one
runs first if both are present.

## Result

Every 500 becomes `{ error: 'Internal server error', requestId }` instead of
leaking internal messages, and carries a request id that can be quoted in a bug
report.