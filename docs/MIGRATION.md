# Migration and rollback

How to move from an older PenPal to this version without losing anybody's
letters.

- [Before you start](#before-you-start)
- [What actually changes](#what-actually-changes)
- [What is irreversible](#what-is-irreversible)
- [The upgrade](#the-upgrade)
- [Verifying afterwards](#verifying-afterwards)
- [Rolling back](#rolling-back)
- [When the migration needs a decision](#when-the-migration-needs-a-decision)

---

## Before you start

**Take a backup and verify it, before you touch anything.** The rest of this
document assumes one exists.

```bash
docker compose stop pen-pal        # the server must be stopped for a restore,
                                   # but backups are safe with it running
./scripts/backup.sh
```

That prints the path, the SHA-256, the row counts, and the shape of the `pairs`
table. Check that it says what you expect:

```bash
./scripts/ops-db.js list                       # what backups exist
node scripts/ops-db.js verify penpal-2026-10-14T10-17-58Z
```

`verify` runs `integrity_check` and compares the file against the checksum in
the manifest. If it does not say `integrity_check ok` and
`sha256 matches true`, fix that before going any further.

> **Do not use `cp`.** The database runs in WAL mode, so a copy of
> `penpal.db` taken while the server is up is missing everything recently
> written — in a real instance that is the most recent letters. It does not
> always look broken. `scripts/backup.sh` uses SQLite's online backup API
> instead. See [What a backup does not protect against](SECURITY.md).

A backup you have never restored is a rumour. If you have time to restore one
to a scratch machine, do that first.

---

## What actually changes

Most of this is additive and you will not notice it. Exactly one change alters
the shape of existing data.

| Change | Reversible? | Notes |
|---|---|---|
| `_migrations` table added | yes | bookkeeping only |
| The runner applies schema changes on boot | — | see below |
| **`pairs` table reshaped** | **yes, from the legacy copy** | the one that matters |
| `pairs_legacy_v002` retained | yes | every original row, kept |
| New columns on `letters` | yes | additive, backfilled |
| New columns on `users` | yes | additive |
| Indexes added | yes | no data change |
| `server/db.js` no longer deletes a database it cannot open | yes | behaviour change, no data change |

### The `pairs` reshape, in detail

**v0.0.2 stored one row per relationship:**

```sql
CREATE TABLE pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user1_id INTEGER NOT NULL,
  user2_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**This version stores one row per user:**

```sql
CREATE TABLE pairs (
  user_id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The old table had no uniqueness constraint anywhere. One account could hold any
number of partners, and the query that looked up a partner
(`WHERE user1_id = ? OR user2_id = ?`) returned whichever row the query planner
preferred. That is how a letter could be delivered to the wrong person.

Making `user_id` the primary key turns "one partner at a time" from a
convention into something the storage engine enforces.

The conversion is **one row becomes two** — `(1, 2)` becomes `1 → 2` and
`2 → 1` — because the new table is keyed by "who is asking". Every pairing
survives in both directions.

**What you are NOT losing:**

- every letter, byte-identical, ciphertext untouched
- every user account
- the original `pairs` table, renamed to `pairs_legacy_v002` and left in place
  with all its rows

### Why nothing happens silently any more

The previous version ran one `CREATE TABLE IF NOT EXISTS` blob on every boot.
That works exactly once, for a database that does not exist yet. For an
existing one it does nothing at all, which is fine for an added column and
catastrophic for a reshape: **the old table stayed in the old shape forever and
every pairing query threw `no such column: user_id`.** The data was never lost,
the app was just permanently broken, with no record anywhere of which shape the
file was in.

That is what the runner exists to prevent:

- every change is a numbered file in `server/lib/migrations/`
- applied versions are recorded in a `_migrations` ledger
- **each migration runs inside one transaction together with its own ledger
  row**, so a half-applied migration is a state the app cannot reach, and a
  retry starts from the top
- an upgrade of a populated database gets a pre-migration snapshot first

---

## What is irreversible

Being straight about this, because "you can always roll back" is only true if
you know what you cannot get back.

**The migration itself is reversible, because nothing is destroyed:**

- the old `pairs` table is renamed, never dropped
- `VACUUM INTO` snapshots copy rather than move
- a failed migration rolls back to the pre-migration bytes

**Irreversible in practice:**

1. **Restoring a backup is destructive to everything after that backup.** If you
   restore a pre-upgrade copy, anything written since is gone. The script makes
   a `.pre-restore-<timestamp>` copy of what it is replacing, so the restore
   itself is undoable — but the window only closes when you delete that copy.

2. **If you run `VACUUM` or drop `pairs_legacy_v002`, the old shape is gone.**
   The legacy table is what makes an in-place downgrade possible without a
   backup. Leaving it costs one small table.

3. **If you delete a pre-migration snapshot, that rollback point is gone.**
   They are pruned on a retention window (`PRE_MIGRATION_BACKUP_RETENTION`,
   default 3). Copy the one you care about somewhere else before cleaning up.

4. **Attachments in `uploads/` are not in the database.** A database backup
   restores letters and pairings; restoring photos means restoring the
   directory too. See [`scripts/backup.sh`](https://github.com) — by default
   `uploads/` **is** included, but a backup taken with `--no-uploads` is not.

5. **Anything that happened while the server was running with the old code, and
   was never in a backup, is gone.** That is the general truth about backups,
   but it is sharper right after an upgrade, because the upgrade is the moment
   people are tempted to skip step one.

---

## The upgrade

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on boot. There is no separate step.

**Watch the logs for the first thirty seconds.** The interesting lines look like
this:

```json
{"level":"warn","msg":"took a pre-migration snapshot of the database","kind":"pre_migration_backup","path":"/app/data/pre-migration/penpal-2026-10-14T10-17-58Z","bytes":122880,"counts":{"users":4,"pairs":3,"letters":11},"pairs_shape":"v0.0.2"}
{"level":"info","msg":"migration applied","migration":"001","name":"base-schema","duration_ms":1}
{"level":"info","msg":"migration applied","migration":"020","name":"pairs-user-id-primary-key","duration_ms":2,"details":{"kind":"pairs_reshaped","legacy_rows":3,"rows_written":6,"users_paired":6}}
```

If the server refuses to start, the failure is deliberate: it will not run
against a schema it does not understand. The message names the migration.

`docker compose logs -f pen-pal | grep -i migration` shows the whole story.

### Applying a migration without restarting

```bash
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" localhost:3000/api/ops/migrations | jq
```

Returns what is pending and what ran. `ok: false` means something is pending.

---

## Verifying afterwards

Do these in order. Each one catches a different failure.

**1. Health — is the instance usable?**

```bash
curl -fsS localhost:3000/healthz | jq
```

```json
{
  "ok": true,
  "status": "ok",
  "checks": {
    "uptime":  { "ok": true, "uptime_s": 12 },
    "database": { "ok": true, "latency_ms": 0 },
    "migrations": { "ok": true, "applied": 5, "known": 5, "pending": [] }
  }
}
```

`ok: true` is the assertion that matters. It is `false` (and HTTP 503) if the
database is unreachable, unreadable, corrupt, **or if a migration is pending** —
this endpoint is a readiness check, not just a liveness probe. `pending: []`
is the part that confirms your upgrade finished.

**2. Migrations — is anything still pending?**

```bash
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" localhost:3000/api/ops/migrations | jq '.pending, .current, .latest'
```

Expect `pending: []` and `current == latest`.

**3. Pairings — the one that actually matters.**

```bash
docker compose exec pen-pal node -e "
const db=require('better-sqlite3')('/app/data/penpal.db',{readonly:true});
console.log('new pairs rows: ', db.prepare('SELECT COUNT(*) n FROM pairs').get().n);
console.log('legacy rows:     ', db.prepare('SELECT COUNT(*) n FROM pairs_legacy_v002').get().n);
console.log('asymmetric:      ', db.prepare('SELECT COUNT(*) n FROM pairs p LEFT JOIN pairs r ON r.user_id=p.partner_id AND r.partner_id=p.user_id WHERE r.user_id IS NULL').get().n);
console.log('self-paired:     ', db.prepare('SELECT COUNT(*) n FROM pairs WHERE user_id=partner_id').get().n);
"
```

- **`new pairs rows` should be exactly twice `legacy rows`** for an ordinary
  database. Fewer means some rows were dropped — see
  [the multi-partner case](#a-user-with-more-than-one-partner).
- **`self-paired` must be 0.**
- **`asymmetric` should be 0 — and a non-zero value is explainable rather than
  alarming.** Every ordinary pairing is stored in both directions so that both
  people can find each other. The only way to end up with an asymmetric row is a
  user who had *two* partners in v0.0.2: one of the two reverse rows cannot fit,
  because `user_id` is the primary key. The workaround is to re-pair; the
  diagnosis is below.

**4. Letters — is the correspondence intact?**

```bash
docker compose exec pen-pal node -e "
const db=require('better-sqlite3')('/app/data/penpal.db',{readonly:true});
console.log('letters:', db.prepare('SELECT COUNT(*) n FROM letters').get().n);
console.log(db.prepare('SELECT id,state,created_at FROM letters ORDER BY id DESC LIMIT 5').all());
"
```

Compare the count against your pre-migration backup:

```bash
node scripts/ops-db.js verify penpal-2026-10-14T10-17-58Z | grep letters
```

**The number must not have gone down.** If it has, restore from the backup.

**5. Letters still decrypt.** The only real proof. Have each person open their
most recent letter. Ciphertext survives a migration untouched, and a migration
that broke a letter would show up here and nowhere else.

**6. Ask the users.** If somebody has not received a letter in a week, they did
not exist before this change either. Do not assume the migration is innocent.

---

## Rolling back

### The fast path

```bash
docker compose stop pen-pal

./scripts/restore.sh penpal-2026-10-14T10-17-58Z        # changes nothing, prints the plan
./scripts/restore.sh penpal-2026-10-14T10-17-58Z --yes   # do it

docker compose start pen-pal
curl -fsS localhost:3000/healthz | jq
```

**Stop the server first.** Restoring underneath a running process means the
old handle is still open on the file you replaced.

Without `--yes` the script exits 2 having changed nothing. That is intentional:
a restore should never happen because somebody pasted a command without reading
it.

What it does, in order:

1. refuses without `--yes`
2. runs `integrity_check` on the backup and **refuses if it fails** — it will
   not replace a working database with a broken one
3. **refuses a v0.0.2-shaped backup** unless you pass `--allow-old-shape`.
   Restoring that into the current app returns you to the permanently broken
   state this migration exists to fix
4. copies the current database to `penpal.db.pre-restore-<timestamp>`, so the
   restore is itself reversible
5. copies via a temp file and `rename`, so an interruption leaves the old
   database intact
6. **deletes stale `-wal` and `-shm` files.** Those belong to the database you
   just replaced; SQLite would replay them over the restored file and produce a
   corrupt hybrid that is neither database and passes no integrity check

### After rolling back

The pre-upgrade backup is a v0.0.2 file. To use it you need the v0.0.2 code:

```bash
git checkout <your-v0.0.2-tag>
docker compose up -d --build
```

The old version has no migration runner, so it will happily ignore the
`pairs_legacy_v002` table sitting alongside your data. If you can tolerate a
short outage, a better roll-back is: **keep the current code and re-run the
migration instead.** It is transactional and idempotent. Rolling back means
going back to code that silently destroys data on the next `CREATE TABLE IF NOT
EXISTS` boot, which is the thing we are trying to get away from.

### If a migration failed on its own

A failed migration rolls back to the pre-migration bytes automatically and the
server refuses to start. Nothing is half-applied. Fix the cause — usually a
`pairs_legacy_v002` table that already exists from a previous attempt — and
start again:

```bash
docker compose logs pen-pal | grep -i "migration run failed"
```

---

## When the migration needs a decision

Two v0.0.2 states cannot be represented in the new schema. Neither is silent:
both are logged, and the original rows stay in `pairs_legacy_v002`.

> **2026-10 update.** The pen-pals-plural change (migration `070`) has since
> revoked the one-partner rule this document describes: `pairs` lost the
> `user_id` primary key and gained `UNIQUE(user_id, partner_id)` — many pals,
> never the same pal twice. This section stays because it documents what the
> v0.0.2→v2 path did under the single-partner schema, and it is still what
> happens first in the run order: `020` rekeys on `user_id` and, as below,
> drops every partner but the earliest; `070` runs after it and allows new
> partnerships, but a row `020` already dropped stays dropped. If an upgrading
> account had several v0.0.2 partners, the extras are logged at exactly the
> line below and the rest are re-paired by hand. Nothing about 070 changes
> what 020 already decided.

### A user with more than one partner

v0.0.2 permitted it. `user_id` is a primary key now, so one row per user is all
that fits.

**The rule is "lowest legacy row id wins"** — deterministic and identical on
every machine, independent of SQLite's query planner. Every discarded pairing
is logged at `warn` with both candidates:

```json
{"level":"warn","msg":"user had more than one partner; keeping the earliest and dropping the rest","user_id":1,"kept_partner":2,"dropped_partner":3}
{"level":"warn","msg":"1 account(s) had more than one partner in v0.0.2 and now have exactly one.","affected_users":[1]}
```

**Check for this after upgrading:**

```bash
docker compose logs pen-pal | grep "more than one partner"
```

If anyone appears, go and re-pair them deliberately. Do not leave it to be
discovered as a letter that never arrived.

#### Why you may see an asymmetric row afterwards

A row is *asymmetric* when `user A → B` exists but `B → A` does not. For an
ordinary database this is impossible. After a migration it happens in exactly
one situation, and it is worth understanding rather than panicking about.

Suppose user 1 had **two** partners in v0.0.2 — user 2 (legacy row 1) and user 3
(legacy row 2). The conversion walks those rows oldest first:

| Row | Direction | Outcome |
|---|---|---|
| legacy row 1 `(1,2)` | `1 → 2` | inserted — user 1 is free |
| legacy row 1 `(1,2)` | `2 → 1` | inserted |
| legacy row 2 `(3,1)` | `3 → 1` | inserted — user 3 only ever had user 1 |
| legacy row 2 `(3,1)` | `1 → 3` | **dropped** — user 1 is already taken |

The last row cannot be inserted. `user_id` is the primary key, so user 1 can
occupy exactly one row, and the migration is not going to overwrite the pairing
it already kept. The result is `3 → 1` with no matching `1 → 3`.

**What this means in practice:**

- **user 3 is fine.** Their own lookup (`WHERE user_id = 3`) returns user 1, so
  they can send to and receive from the partner they had.
- **user 1 does not know user 3 exists**, and will not see letters from them.

This is the unavoidable consequence of enforcing one partner per account, which
is the bug the new schema exists to fix. The alternative — letting one account
hold several partners — is what allowed a letter to be delivered to the wrong
person in the first place.

**Fix it by re-pairing:** have user 1 unpair, then re-accept an invite from
user 3 (or vice versa). After that both directions exist and `asymmetric` drops
to 0.

### A self-pairing

`user1_id === user2_id` cannot survive and is dropped with a log line:

```bash
docker compose logs pen-pal | grep "self-pairing"
```

### A `pairs` table in a shape nobody recognises

Not converted. Renamed to `pairs_legacy_v002_unrecognised`, a fresh table is
built, and the app logs an `error` with the columns it found. Your data is
untouched on disk; the app is running. Someone needs to look at it.

### A pairing pointing at a user that no longer exists

Kept rather than dropped, because dropping is data loss, but logged:

```bash
docker compose logs pen-pal | grep "does not exist"
```

Those pairings are inert until that account returns.

---

## Checking the ledger by hand

```bash
docker compose exec pen-pal node -e "
const db=require('better-sqlite3')('/app/data/penpal.db',{readonly:true});
console.table(db.prepare('SELECT version,name,applied_at,duration_ms FROM _migrations ORDER BY version').all());
"
```

`checksum` is the SHA-256 of the migration file at the moment it ran. If you
later edit a migration that has already been applied, the runner will **warn
and refuse to re-run it** — an applied migration is not safely replayable, and
silently re-running one is how databases get corrupted. To fix a bad migration,
write a new one.