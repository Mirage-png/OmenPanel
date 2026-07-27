# Cloud Backup Storage

Servers run entirely from local disk while online. When one stops, its
directory is zipped and uploaded; when one starts without local files, the
newest backup is pulled down and extracted first. All of that is automatic.

## Configuration

Everything is read from the environment. **No credentials belong in the repo.**

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_PROVIDER` | `local` | `local`, `b2`, or `s3` |
| `BACKUP_REMOTE_ROOT` | provider-specific | Base folder/prefix for backups |
| `BACKUP_LOCAL_PATH` | `omen-data/backups` | `local` only: where archives go |
| `B2_KEY_ID` | — | Backblaze B2 `applicationKeyId` |
| `B2_APPLICATION_KEY` | — | Backblaze B2 `applicationKey` |
| `B2_BUCKET` | — | B2 bucket name |
| `B2_BUCKET_ID` | — | Optional; skips a bucket lookup |
| `S3_ENDPOINT` | — | s3: full endpoint URL, e.g. `https://s3.filebase.io` |
| `S3_ACCESS_KEY_ID` | — | s3: access key |
| `S3_SECRET_ACCESS_KEY` | — | s3: secret key |
| `S3_BUCKET` | — | s3: bucket name (must already exist) |
| `S3_REGION` | `auto` | s3: optional |

Panel settings (`omen-data/settings.json`):

| Key | Default | Meaning |
|---|---|---|
| `backupEnabled` | `true` | Set `false` to disable the whole subsystem |
| `backupRetention` | `1` | How many backups to keep per server |
| `backupCompressionLevel` | `9` | zlib level 0-9 (env: `BACKUP_COMPRESSION_LEVEL`) |
| `backupStorePrecompressed` | `false` | Store instead of deflating jars/images (env: `BACKUP_STORE_PRECOMPRESSED`) |
| `backupExcludes` | `[]` | Extra glob patterns added to the built-in exclusions |

### Keeping backups small

Measured on a representative server, the archive is **~30% smaller** than the
previous settings, so the same B2 storage holds about **1.4x more servers**.

Almost all of that comes from *excluding junk*, not from the compression level:
level 1 and level 9 differ by ~0.1% because a Minecraft server is dominated by
already-compressed data (jars are ZIPs, `.mca` chunks and `.dat` player files
are zlib/gzip). Level 9 is the default anyway since it costs almost nothing
here, and backups only run once a server has fully exited.

Excluded by default — all regenerated on next start:
`logs/`, `crash-reports/`, `cache/` (incl. nested), `libraries/`, `versions/`,
`bundler/`, `.fabric/`, `debug/`, `dumps/`, `tmp/`, `*.log`, `*.tmp`,
`session.lock`, `*.lock`, `*.pid`, `*.dat_old`, `*.old`, `*.bak`,
`usercache.json`, `hs_err_pid*.log`.

Always kept: `world/` (region, playerdata, advancements, stats, datapacks),
`plugins/` and their configs, `server.properties`, bukkit/spigot/paper YAMLs,
`ops`/`whitelist`/`banned-players`/`banned-ips`, `permissions.yml`, `eula.txt`,
the server icon and `server.jar`. A regression test asserts each of these
survives, so tightening the exclusion list cannot silently break restores.

`backupStorePrecompressed: true` skips deflate on jars/images: roughly 20x less
CPU for ~4% more stored bytes. Worth it only if compression competes with
running servers for CPU.

Every backup records `originalBytes`, `compressedBytes`, `compressionSavedPct`,
`excludedFiles`/`excludedBytes`, `totalSavedPct` and `uploadedBytes` in
`omen-data/backup-history.jsonl` and in `/api/omen/backup/status`.

Backups are stored as `<remoteRoot>/<serverUuid>/<timestamp>.zip`, so each
server owns its folder.

## Provider: `local` (default)

Writes to a directory on this machine or any mounted volume/NAS. Requires no
credentials and works out of the box, which is why it is the default — the
backup pipeline is fully functional before any cloud account is wired up.

```bash
BACKUP_PROVIDER=local BACKUP_LOCAL_PATH=/mnt/backups node middleware/server.js
```

## Provider: `b2` (Backblaze B2)

Uses the [B2 native API](https://www.backblaze.com/apidocs).

```bash
export BACKUP_PROVIDER=b2
export B2_KEY_ID='…'
export B2_APPLICATION_KEY='…'
export B2_BUCKET='my-bucket'
# optional
export BACKUP_REMOTE_ROOT='omenhosting-backups'
```

Objects are stored at `<BACKUP_REMOTE_ROOT>/<serverUuid>/<timestamp>.zip`, so
each server owns a prefix inside the bucket.

### Credentials

Create these in the B2 console under **Application Keys**. Prefer a key scoped
to the single backup bucket over the account **Master Application Key** — a
master key can read, write and delete every bucket and manage other keys, so it
is a poor fit for a long-running service.

Credentials are read from the environment only; nothing is written into the
repository. Export them in your shell or service unit before starting the
middleware.

### How uploads work

- Archives under 100 MB go up in a single `b2_upload_file` request.
- Larger ones use the large-file API (`b2_start_large_file` → `b2_upload_part`
  per part → `b2_finish_large_file`), which is required above 5 GB. A failed
  large upload is cancelled so it does not linger as billable storage.
- B2 requires the SHA-1 of each payload up front, so the archive is hashed in
  one streaming pass and streamed again to upload — never buffered whole.
- Transient failures (`408/429/500/503`) and connection errors are retried with
  exponential backoff, and an expired auth token is refreshed automatically.
- Deletes remove *every version* of a key, so retention actually reclaims
  storage rather than leaving hidden versions behind.

## Provider: `s3` (any S3-compatible service — Filebase, AWS S3, R2, MinIO)

Talks to the S3 REST API directly with hand-rolled SigV4 signing (no AWS SDK
dependency, same philosophy as the B2 provider). Works against Filebase's
IPFS-backed S3-compatible storage as well as real S3 and other compatible
services.

```bash
export BACKUP_PROVIDER=s3
export S3_ENDPOINT='https://s3.filebase.io'
export S3_ACCESS_KEY_ID='…'
export S3_SECRET_ACCESS_KEY='…'
export S3_BUCKET='my-bucket'   # must already exist
# optional
export S3_REGION='auto'
export BACKUP_REMOTE_ROOT='omenhosting-backups'
```

Uploads are single-request PUTs (no multipart), so a single archive is capped
at 5 GB — S3's own hard limit for a non-multipart PUT. A world approaching
that size needs the B2 provider instead, which implements the multipart flow.

Some S3-compatible services (Filebase included) reject `UNSIGNED-PAYLOAD` on
PUT with a bare `AccessDenied`, unlike AWS S3 proper — so uploads are hashed
in a full streaming pass first, same tradeoff the B2 provider already makes
for its required SHA-1.

## Whole-panel state persistence (surviving a redeploy)

This backup system answers "how do I get one server's world back after it's
gone." It does not answer "why is *everything* gone after I republished the
project" — Replit's filesystem is wiped on every redeploy, taking every
account, every instance's config, and every world with it.

`middleware/state-sync.js` (plus its two CLI entry points,
`restore-state.js` and `save-state.js`) is a separate, coarser mechanism for
that: it snapshots `mcsmanager/web/data`, `mcsmanager/daemon/data/InstanceConfig`,
and `mcsmanager/daemon/data/InstanceData` as three archives in the same bucket
configured above (under `STATE_SYNC_ROOT`, default `omen-panel-state`, kept
separate from per-instance backup paths). It activates automatically whenever
`BACKUP_PROVIDER` is `s3` or `b2` — no separate credentials needed.

- `restore-state.js` runs once, **before `mcsm-daemon` starts** (wired into
  `start.sh`/`deploy-start.sh`) — the daemon loads `InstanceConfig` once at
  its own boot and never re-reads it, so restoring after that point would
  leave every recovered server invisible until a second restart.
- `save-state.js` runs on a timer (`STATE_SYNC_INTERVAL_SECONDS`, default
  120) and once more on `SIGTERM`/`SIGINT` — which is what a Replit
  "republish" actually sends before tearing the old container down. The
  interval is short specifically because that shutdown save is not fully
  trustworthy on its own: if the platform's grace period between SIGTERM and
  a hard kill is shorter than a large `InstanceData` upload takes, the
  periodic save is what actually has something recent to fall back on.

Neither silently does nothing without a trace: `GET /api/omen/state-sync/status`
reports whether `BACKUP_PROVIDER` is even set to `s3`/`b2`, and the outcome
(including the error) of the last save and restore attempt. Check this after
any redeploy that was supposed to persist data — an empty/misconfigured
provider produces no error anywhere else visible.

## Adding another provider (Google Drive, …)

The backup logic never names a provider. To add one:

1. Create `middleware/storage/<name>.js` exporting a class that extends
   `StorageProvider` and implements `init`, `upload`, `download`, `list`,
   `remove`. `local.js` is the smallest correct reference.
2. Register it in the `createProvider()` switch in `index.js`.

Contract requirements worth repeating:

- Stream everything; never buffer a whole archive.
- `list()` returns **newest first** and an empty array for a missing folder.
- `remove()` on a missing file resolves rather than throwing.
- Throw a descriptive `Error` on failure; callers turn that into a retryable
  state and never inspect provider-specific error shapes.

## Operational notes

- One backup or restore per server at a time, enforced by an in-process mutex
  plus an on-disk lock so a crash cannot wedge a server permanently.
- A backup never reads a live directory: the manager waits for the process to
  exit and re-checks immediately before compressing.
- A failed upload keeps the ZIP and marks the state retryable; the archive is
  deleted only after the upload is confirmed.
- Archives are CRC-32 verified after compressing and again after downloading.
- `logs/`, `cache/`, `crash-reports/` and `session.lock` are excluded.
- Every attempt is logged to `omen-data/backup-history.jsonl` with timestamp,
  size, durations and outcome.
