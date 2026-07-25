# Cloud Backup Storage

Servers run entirely from local disk while online. When one stops, its
directory is zipped and uploaded; when one starts without local files, the
newest backup is pulled down and extracted first. All of that is automatic.

## Configuration

Everything is read from the environment. **No credentials belong in the repo.**

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_PROVIDER` | `local` | `local` or `b2` |
| `BACKUP_REMOTE_ROOT` | provider-specific | Base folder/prefix for backups |
| `BACKUP_LOCAL_PATH` | `omen-data/backups` | `local` only: where archives go |
| `B2_KEY_ID` | — | Backblaze B2 `applicationKeyId` |
| `B2_APPLICATION_KEY` | — | Backblaze B2 `applicationKey` |
| `B2_BUCKET` | — | B2 bucket name |
| `B2_BUCKET_ID` | — | Optional; skips a bucket lookup |

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

## Adding another provider (S3, B2, Google Drive…)

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
