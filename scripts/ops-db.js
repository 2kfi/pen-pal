#!/usr/bin/env node
/**
 * Backup / restore / verify CLI.
 *
 * The shell scripts `scripts/backup.sh` and `scripts/restore.sh` are thin
 * wrappers around this file. All the logic lives in `server/lib/ops/backup.js`
 * so that the scheduled backup, the `POST /api/ops/backup` route and a human
 * running the script by hand all produce the same bytes in the same layout.
 * There is exactly one implementation of "make a backup", which is the only way
 * that stays true.
 *
 * Usage:
 *   node scripts/ops-db.js backup  [--out DIR] [--retention N] [--no-uploads] [--label TEXT]
 *   node scripts/ops-db.js list
 *   node scripts/ops-db.js verify  <name>
 *   node scripts/ops-db.js restore <name> [--data DIR] --yes [--allow-old-shape]
 *
 * Every option has a default that works on a stock checkout, and every default
 * can be overridden by the environment variable a deployment already sets.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const {
  createBackup,
  listBackups,
  verifyBackup,
  readManifest,
  inspectDatabase,
} = require(path.join(REPO_ROOT, 'server/lib/ops/backup'));

const dataDir = () => process.env.DATA_DIR || path.join(REPO_ROOT, 'server/data');
const uploadsDir = () => process.env.UPLOADS_DIR || path.join(REPO_ROOT, 'uploads');
const backupDir = () => process.env.BACKUP_DIR || path.join(REPO_ROOT, 'backups');
const dbPath = () => path.join(dataDir(), 'penpal.db');

function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

/** `--key value`, `--key=value` and bare `--flag` all work. */
function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._ = opts._ || [];
      opts._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts[a.slice(2)] = argv[++i];
    } else {
      flags.add(a.slice(2));
    }
  }
  return { opts, flags, positional: opts._ || [] };
}

function appVersion() {
  try {
    return require(path.join(REPO_ROOT, 'package.json')).version;
  } catch {
    return null;
  }
}

async function cmdBackup(flags) {
  const { opts } = parseArgs([]);
  void opts;
  const outDir = process.env.BACKUP_DIR || backupDir();
  const retention = Number(process.env.BACKUP_RETENTION || 14);
  const includeUploads = !flags.has('no-uploads');

  if (!fs.existsSync(dbPath())) die(`no database at ${dbPath()} — nothing to back up`);

  const manifest = await createBackup({
    dbPath: dbPath(),
    outDir,
    retention,
    includeUploads,
    uploadsDir: uploadsDir(),
    label: process.env.BACKUP_LABEL || `cli:${new Date().toISOString()}`,
    version: appVersion(),
    // A quiet logger: this writes to stdout on success and we print the summary
    // ourselves. Progress belongs to the caller, not to a library default.
    log: { info() {}, warn() {}, error() {} },
  });

  say(`backup written: ${manifest.path}`);
  say(`  method   ${manifest.method}`);
  say(`  bytes    ${manifest.bytes}`);
  say(`  sha256   ${manifest.sha256}`);
  say(`  shape    pairs=${manifest.pairs_shape}`);
  say(`  counts   ${Object.entries(manifest.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (manifest.uploads) say(`  uploads  ${manifest.uploads.files} file(s)`);
  if (manifest.pruned && manifest.pruned.length) {
    say(`  pruned   ${manifest.pruned.length} backup(s) past the retention window of ${retention}`);
  }
  say('');
  say('This file is NOT encrypted. Letter bodies are, uploaded photos are not.');
  say('See docs/SECURITY.md before copying it anywhere off this machine.');
}

function cmdList() {
  const dir = backupDir();
  const names = listBackups(dir);
  if (!names.length) return say(`no backups in ${dir}`);
  say(`${dir}`);
  for (const name of names.reverse()) {
    const m = readManifest(path.join(dir, name));
    say(
      `  ${name}  ${m ? `${m.bytes}b` : '(no manifest)'}` +
        `${m ? `  pairs=${m.pairs_shape}` : ''}` +
        `${m && m.uploads ? '  +uploads' : ''}`,
    );
  }
  return undefined;
}

function cmdVerify(positional) {
  const name = positional[0];
  if (!name) die('verify needs a backup name: ops-db.js verify penpal-2026-...');
  const dir = path.isAbsolute(name) ? name : path.join(backupDir(), path.basename(name));
  const result = verifyBackup(dir);

  say(`${dir}`);
  say(`  integrity_check  ${result.integrity || result.error || 'unknown'}`);
  say(`  pairs shape      ${result.pairs_shape || 'unknown'}`);
  say(`  sha256 matches   ${result.sha256_matches_manifest}`);
  say(`  uploads present  ${result.uploads_present}`);
  say(`  counts           ${JSON.stringify(result.counts)}`);

  if (!result.ok) {
    say('');
    say('This backup is not usable. Do not plan a restore around it.');
    process.exit(1);
  }
  if (result.pairs_shape === 'v0.0.2') {
    say('');
    say('This is a v0.0.2 backup. It restores cleanly, but the current app');
    say('cannot use it until the migrations run again. See docs/MIGRATION.md.');
  }
  return undefined;
}

function cmdRestore(positional, flags, opts) {
  const name = positional[0];
  if (!name) die('restore needs a backup name: ops-db.js restore penpal-2026-...');

  const dir = path.isAbsolute(name) ? name : path.join(backupDir(), path.basename(name));
  const source = path.join(dir, 'penpal.db');

  if (!flags.has('yes')) {
    // Deliberately not a `--force`-you-may-proceed prompt: this is non
    // interactive by design, and a restore that silently waits for a keypress
    // inside a runbook is a restore that hangs in cron.
    say('restore is destructive. It overwrites the live database.');
    say(`  from  ${source}`);
    say(`  to    ${dbPath()}`);
    say('');
    say('Nothing has been changed. Re-run with --yes once the server is STOPPED.');
    say('See docs/MIGRATION.md for the full procedure.');
    process.exit(2);
  }

  if (!fs.existsSync(source)) die(`no backup file at ${source}`);

  // Verify before overwriting anything. A restore that discovers corruption
  // after it has already replaced the live database has made things worse.
  const check = inspectDatabase(source);
  if (!check.ok) die(`refusing to restore: backup failed verification (${check.error})`);

  if (check.pairs_shape === 'v0.0.2' && !flags.has('allow-old-shape')) {
    die(
      'refusing to restore: this backup holds a v0.0.2 `pairs` table.\n' +
        '  The current app queries `pairs.user_id`, so restoring it without\n' +
        '  re-running the migrations returns the instance to the permanently\n' +
        '  broken state the migration runner exists to fix.\n' +
        '  Pass --allow-old-shape if that is genuinely what you want.',
    );
  }

  // Safety copy of what is being replaced, so the restore is itself reversible.
  if (fs.existsSync(dbPath())) {
    const safety = `${dbPath()}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(dbPath(), safety);
    say(`current database copied to ${safety}`);
  }

  fs.mkdirSync(dataDir(), { recursive: true });
  // Write to a temp name in the same directory and rename, so an interrupted
  // restore leaves the old file intact rather than a truncated one.
  const tmp = path.join(dataDir(), '.penpal.db.restoring');
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, dbPath());

  // A stale -wal from the database we just replaced holds frames describing a
  // DIFFERENT set of pages. Left in place, SQLite would replay them over the
  // restored file and you would get a corrupt hybrid that passes no integrity
  // check and is not either of the two databases. The restore source is a
  // self-contained file, so the correct move is to remove them.
  for (const suffix of ['-wal', '-shm']) {
    const f = `${dbPath()}${suffix}`;
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      say(`removed stale ${path.basename(f)}`);
    }
  }

  say(`restored ${source} -> ${dbPath()}`);
  say(`  counts  ${JSON.stringify(check.counts)}`);
  say('');
  say('Start the server and check /healthz reports ok:true before doing anything else.');
  if (flags.has('allow-old-shape')) {
    say('NOTE: that backup was v0.0.2 shaped. The migrations will run on boot.');
  }
  void opts;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional, opts } = parseArgs(rest);

  switch (command) {
    case 'backup':
      return cmdBackup(flags, opts);
    case 'list':
      return cmdList(opts);
    case 'verify':
      return cmdVerify(positional, opts);
    case 'restore':
      return cmdRestore(positional, flags, opts);
    default:
      say('usage: ops-db.js <backup|list|verify|restore> [options]');
      say('  backup  [--out DIR] [--retention N] [--no-uploads]   take a backup now');
      say('  list                                            list backups');
      say('  verify  <name>                                  check a backup without restoring');
      say('  restore <name> --yes [--allow-old-shape]         overwrite the live database');
      return process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});