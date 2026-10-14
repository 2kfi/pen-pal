/**
 * Operational helpers: request ids, structured logging, health, backups.
 *
 * Everything the server needs to be runnable rather than merely runnable-once.
 * Nothing here imports `server/index.js` — route modules require this, not the
 * app entrypoint, which is the whole point of server/lib/auth.js existing.
 */

module.exports = {
  ...require('./logger'),
  ...require('./request-context'),
  ...require('./health'),
  ...require('./backup'),
};
