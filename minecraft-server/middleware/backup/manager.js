/**
 * OmenHosting — Backup & restore orchestration
 *
 * Servers run entirely from local disk while online. This module moves a
 * server's directory to cloud storage once it has fully stopped, and pulls it
 * back before it starts again if the local copy is gone.
 *
 * Backup  : Preparing -> Compressing -> Verifying -> Uploading -> Completed
 * Restore : Downloading -> Verifying -> Extracting -> Starting
 *
 * Guarantees
 *   - One operation per server at a time (in-process mutex + on-disk lock, so
 *     a crash mid-backup cannot wedge the server forever).
 *   - A backup never runs while the process is alive: callers must await
 *     waitForExit() first, and runBackup re-checks immediately before reading.
 *   - A failed upload keeps the ZIP on disk and records a retryable state; the
 *     archive is only deleted after the upload is confirmed.
 *   - Archives are CRC-verified after compressing and again after downloading.
 *   - Nothing is buffered in memory: compression, upload, download and
 *     extraction all stream.
 */

const fs = require('fs');
const path = require('path');
const { createZip, verifyZip, extractZip, DEFAULT_EXCLUDES } = require('./archive');
const { BackupHistory } = require('./history');

/** Terminal + transitional states surfaced to the panel. */
const STATE = {
  IDLE: 'idle',
  PREPARING: 'Preparing Backup',
  COMPRESSING: 'Compressing',
  VERIFYING: 'Verifying',
  UPLOADING: 'Uploading',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  DOWNLOADING: 'Downloading',
  EXTRACTING: 'Extracting',
  STARTING: 'Starting'
};

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;  // a 6h-old lock is from a dead run
const EXIT_POLL_MS = 2000;
const EXIT_TIMEOUT_MS = 5 * 60 * 1000;
const EXIT_SETTLE_MS = 3000;               // grace after the port closes

class BackupManager {
  /**
   * @param {Object} deps
   * @param {import('../storage/provider').StorageProvider} deps.provider
   * @param {string} deps.providerKind
   * @param {string} deps.remoteRoot
   * @param {string} deps.dataDir      omen-data
   * @param {string} deps.instanceDataDir  daemon InstanceData root
   * @param {string} deps.workDir      scratch space for archives
   * @param {() => Object} deps.loadSettings
   * @param {(uuid: string) => Promise<boolean>} deps.isInstanceRunning
   */
  constructor(deps) {
    this.provider = deps.provider;
    this.providerKind = deps.providerKind;
    this.remoteRoot = deps.remoteRoot || '';
    this.dataDir = deps.dataDir;
    this.instanceDataDir = deps.instanceDataDir;
    this.workDir = deps.workDir;
    this.loadSettings = deps.loadSettings;
    this.isInstanceRunning = deps.isInstanceRunning;

    this.history = new BackupHistory(deps.dataDir);
    this.locks = new Map();     // uuid -> 'backup' | 'restore'
    this.states = new Map();    // uuid -> status object shown in the panel
    this.enabled = true;

    fs.mkdirSync(this.workDir, { recursive: true });
    this.restoreStaleLocks();
  }

  // ─── Paths ──────────────────────────────────────────────────────

  serverDir(uuid) {
    return path.join(this.instanceDataDir, uuid);
  }

  /** Each server gets its own remote folder keyed by instance UUID. */
  remoteDir(uuid) {
    return this.remoteRoot ? `${this.remoteRoot}/${uuid}` : `/${uuid}`;
  }

  archivePath(uuid) {
    return path.join(this.workDir, `${uuid}.zip`);
  }

  lockPath(uuid) {
    return path.join(this.workDir, `${uuid}.lock`);
  }

  // ─── Locking ────────────────────────────────────────────────────

  /**
   * On-disk locks outlive the process, so a crash mid-backup would otherwise
   * block that server permanently. Anything older than LOCK_STALE_MS, or owned
   * by a pid that no longer exists, is cleared at startup.
   */
  restoreStaleLocks() {
    let files;
    try { files = fs.readdirSync(this.workDir); } catch { return; }

    for (const file of files.filter((f) => f.endsWith('.lock'))) {
      const full = path.join(this.workDir, file);
      try {
        const lock = JSON.parse(fs.readFileSync(full, 'utf8'));
        const age = Date.now() - (lock.at || 0);
        let ownerAlive = false;
        if (lock.pid) {
          try { process.kill(lock.pid, 0); ownerAlive = true; } catch { ownerAlive = false; }
        }
        if (!ownerAlive || age > LOCK_STALE_MS) {
          fs.unlinkSync(full);
          console.log(`[backup] Cleared stale ${lock.op || 'operation'} lock for ${lock.uuid || file}`);
        }
      } catch {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  }

  isBusy(uuid) {
    return this.locks.has(uuid);
  }

  acquireLock(uuid, op) {
    if (this.locks.has(uuid)) return false;
    this.locks.set(uuid, op);
    try {
      fs.writeFileSync(this.lockPath(uuid), JSON.stringify({ uuid, op, pid: process.pid, at: Date.now() }));
    } catch (err) {
      console.error('[backup] Could not write lock file:', err.message);
    }
    return true;
  }

  releaseLock(uuid) {
    this.locks.delete(uuid);
    try { fs.unlinkSync(this.lockPath(uuid)); } catch {}
  }

  // ─── Status ─────────────────────────────────────────────────────

  setState(uuid, state, extra = {}) {
    const status = {
      uuid,
      state,
      progress: 0,
      message: '',
      updatedAt: Date.now(),
      ...this.states.get(uuid),
      ...extra
    };
    status.state = state;
    status.updatedAt = Date.now();
    this.states.set(uuid, status);
    return status;
  }

  getState(uuid) {
    return this.states.get(uuid) || { uuid, state: STATE.IDLE, progress: 0 };
  }

  getAllStates() {
    const out = {};
    for (const [uuid, status] of this.states) out[uuid] = status;
    return out;
  }

  // ─── Process-exit gate ──────────────────────────────────────────

  /**
   * Block until the instance has genuinely exited. Reading the directory while
   * the JVM still holds files open produces a torn archive, so this is a hard
   * precondition for backup.
   *
   * @returns {Promise<boolean>} false if it never stopped within the timeout
   */
  async waitForExit(uuid) {
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.isInstanceRunning(uuid))) {
        // The port closes slightly before the JVM finishes flushing region
        // files, so settle briefly and re-confirm rather than racing it.
        await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS));
        if (!(await this.isInstanceRunning(uuid))) return true;
      }
      await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
    }
    return false;
  }

  /**
   * Compression knobs, resolved per run so a settings change takes effect on
   * the next backup without a restart.
   *
   *   backupCompressionLevel   0-9, default 9
   *   backupStorePrecompressed trade ~4% size for ~20x less CPU on jar-heavy
   *                            servers; off by default
   *   backupExcludes           extra glob patterns appended to the defaults
   */
  compressionOptions() {
    const settings = this.loadSettings() || {};

    const rawLevel = settings.backupCompressionLevel !== undefined
      ? settings.backupCompressionLevel
      : process.env.BACKUP_COMPRESSION_LEVEL;
    const parsed = parseInt(rawLevel, 10);
    const level = Number.isInteger(parsed) ? Math.min(9, Math.max(0, parsed)) : undefined;

    const storePrecompressed = settings.backupStorePrecompressed !== undefined
      ? !!settings.backupStorePrecompressed
      : process.env.BACKUP_STORE_PRECOMPRESSED === 'true';

    const extra = Array.isArray(settings.backupExcludes) ? settings.backupExcludes : [];
    const excludes = extra.length ? DEFAULT_EXCLUDES.concat(extra) : DEFAULT_EXCLUDES;

    return { level, storePrecompressed, excludes };
  }

  // ─── Backup ─────────────────────────────────────────────────────

  /**
   * Compress the server directory and upload it.
   *
   * @param {string} uuid
   * @param {Object} [opts]
   * @param {string} [opts.name]      Display name for logs.
   * @param {boolean} [opts.skipWait] Caller already confirmed the exit.
   * @returns {Promise<{ success: boolean, error?: string, retryable?: boolean }>}
   */
  async backup(uuid, opts = {}) {
    const name = opts.name || uuid;

    if (!this.enabled) return { success: false, error: 'Backups are disabled' };
    if (!this.acquireLock(uuid, 'backup')) {
      console.log(`[backup] ${name}: already busy (${this.locks.get(uuid)}), skipping`);
      return { success: false, error: `A ${this.locks.get(uuid)} is already running for this server` };
    }

    const started = Date.now();
    let compressMs = 0;
    let transferMs = 0;
    let sizeBytes = 0;
    let stats = null;
    const zipPath = this.archivePath(uuid);

    try {
      this.setState(uuid, STATE.PREPARING, { progress: 0, message: 'Waiting for server to stop', error: null });

      if (!opts.skipWait) {
        const exited = await this.waitForExit(uuid);
        if (!exited) throw new Error('Server did not fully stop within 5 minutes; backup aborted');
      } else if (await this.isInstanceRunning(uuid)) {
        // Defence in depth: never archive a live server even if told to.
        throw new Error('Server is still running; refusing to back up a live directory');
      }

      const dir = this.serverDir(uuid);
      if (!fs.existsSync(dir)) throw new Error(`Server directory does not exist: ${dir}`);

      // --- Compress -------------------------------------------------
      this.setState(uuid, STATE.COMPRESSING, { progress: 0, message: 'Compressing server files' });
      const compressStart = Date.now();

      // A leftover archive from a previous failed upload is rebuilt: the
      // directory may have changed since, and stale content is worse than slow.
      try { fs.unlinkSync(zipPath); } catch {}

      const zipResult = await createZip(dir, zipPath, {
        ...this.compressionOptions(),
        onProgress: (bytes, entries) => {
          this.setState(uuid, STATE.COMPRESSING, {
            message: `Compressing — ${entries} files, ${formatBytes(bytes)}`
          });
        }
      });
      compressMs = Date.now() - compressStart;
      sizeBytes = zipResult.size;

      stats = {
        originalBytes: zipResult.originalBytes,
        compressedBytes: zipResult.size,
        compressionSavedPct: Number(zipResult.savedPct.toFixed(1)),
        excludedFiles: zipResult.skippedFiles,
        excludedBytes: zipResult.skippedBytes,
        // What the directory would have cost without exclusions or compression.
        totalOnDiskBytes: zipResult.originalBytes + zipResult.skippedBytes,
        compressionLevel: zipResult.level
      };
      // The number that actually decides the B2 bill.
      stats.totalSavedPct = stats.totalOnDiskBytes
        ? Number(((1 - zipResult.size / stats.totalOnDiskBytes) * 100).toFixed(1))
        : 0;

      console.log(
        `[backup] ${name}: ${zipResult.entries} files, ` +
        `${formatBytes(zipResult.originalBytes)} -> ${formatBytes(sizeBytes)} ` +
        `(${stats.compressionSavedPct}% by compression, ` +
        `${zipResult.skippedFiles} files / ${formatBytes(zipResult.skippedBytes)} excluded, ` +
        `${stats.totalSavedPct}% smaller than the directory) in ${compressMs}ms`
      );

      // --- Verify before upload -------------------------------------
      this.setState(uuid, STATE.VERIFYING, { progress: 0, message: 'Verifying archive integrity' });
      await verifyZip(zipPath);

      // --- Upload ---------------------------------------------------
      const remotePath = `${this.remoteDir(uuid)}/${timestampName()}.zip`;
      this.setState(uuid, STATE.UPLOADING, { progress: 0, message: `Uploading ${formatBytes(sizeBytes)}` });
      const uploadStart = Date.now();

      await this.provider.upload(zipPath, remotePath, (sent, total) => {
        const pct = total ? Math.round((sent / total) * 100) : 0;
        this.setState(uuid, STATE.UPLOADING, {
          progress: pct,
          message: `Uploading — ${formatBytes(sent)} / ${formatBytes(total)}`
        });
      });
      transferMs = Date.now() - uploadStart;

      // --- Only now is it safe to reclaim the disk ------------------
      try {
        fs.unlinkSync(zipPath);
      } catch (err) {
        console.error(`[backup] ${name}: uploaded but could not delete local archive:`, err.message);
      }

      await this.applyRetention(uuid, name);

      const durationMs = Date.now() - started;
      this.setState(uuid, STATE.COMPLETED, {
        progress: 100,
        message:
          `Backed up ${formatBytes(stats.totalOnDiskBytes)} -> ${formatBytes(sizeBytes)} ` +
          `(${stats.totalSavedPct}% saved) in ${Math.round(durationMs / 1000)}s`,
        remotePath,
        sizeBytes,
        stats,
        completedAt: Date.now(),
        error: null
      });

      this.history.append({
        type: 'backup', uuid, name, success: true,
        sizeBytes, durationMs, compressMs, transferMs,
        remotePath, entries: zipResult.entries,
        provider: this.providerKind,
        // Storage accounting: what was on disk, what was excluded, what was
        // uploaded, and the percentage saved overall.
        originalBytes: stats.originalBytes,
        totalOnDiskBytes: stats.totalOnDiskBytes,
        excludedFiles: stats.excludedFiles,
        excludedBytes: stats.excludedBytes,
        compressionSavedPct: stats.compressionSavedPct,
        totalSavedPct: stats.totalSavedPct,
        compressionLevel: stats.compressionLevel,
        uploadedBytes: sizeBytes
      });

      console.log(`[backup] ${name}: uploaded ${formatBytes(sizeBytes)} to ${remotePath} in ${transferMs}ms`);
      return { success: true, remotePath, sizeBytes };

    } catch (err) {
      const durationMs = Date.now() - started;
      // The archive is deliberately left on disk so a retry can reuse it.
      const zipKept = fs.existsSync(zipPath);

      this.setState(uuid, STATE.FAILED, {
        progress: 0,
        message: err.message,
        error: err.message,
        retryable: zipKept,
        failedAt: Date.now()
      });

      this.history.append({
        type: 'backup', uuid, name, success: false,
        error: err.message, sizeBytes, durationMs, compressMs, transferMs,
        archiveKept: zipKept, provider: this.providerKind
      });

      console.error(`[backup] ${name}: FAILED — ${err.message}${zipKept ? ' (archive kept for retry)' : ''}`);
      return { success: false, error: err.message, retryable: zipKept };

    } finally {
      this.releaseLock(uuid);
    }
  }

  /**
   * Re-upload an archive kept by a failed backup, skipping compression.
   * Falls back to a full backup when no archive survived.
   */
  async retryBackup(uuid, opts = {}) {
    const name = opts.name || uuid;
    const zipPath = this.archivePath(uuid);

    if (!fs.existsSync(zipPath)) {
      console.log(`[backup] ${name}: no kept archive, running a full backup instead`);
      return this.backup(uuid, opts);
    }
    if (!this.acquireLock(uuid, 'backup')) {
      return { success: false, error: `A ${this.locks.get(uuid)} is already running for this server` };
    }

    const started = Date.now();
    try {
      // The kept archive may itself be why the run failed.
      this.setState(uuid, STATE.VERIFYING, { progress: 0, message: 'Verifying kept archive', error: null });
      await verifyZip(zipPath);

      const sizeBytes = fs.statSync(zipPath).size;
      const remotePath = `${this.remoteDir(uuid)}/${timestampName()}.zip`;

      this.setState(uuid, STATE.UPLOADING, { progress: 0, message: `Retrying upload of ${formatBytes(sizeBytes)}` });
      const uploadStart = Date.now();
      await this.provider.upload(zipPath, remotePath, (sent, total) => {
        const pct = total ? Math.round((sent / total) * 100) : 0;
        this.setState(uuid, STATE.UPLOADING, {
          progress: pct,
          message: `Uploading — ${formatBytes(sent)} / ${formatBytes(total)}`
        });
      });
      const transferMs = Date.now() - uploadStart;

      try { fs.unlinkSync(zipPath); } catch {}
      await this.applyRetention(uuid, name);

      const durationMs = Date.now() - started;
      this.setState(uuid, STATE.COMPLETED, {
        progress: 100,
        message: `Backed up ${formatBytes(sizeBytes)} in ${Math.round(durationMs / 1000)}s`,
        remotePath, sizeBytes, completedAt: Date.now(), error: null, retryable: false
      });
      this.history.append({
        type: 'backup', uuid, name, success: true, retry: true,
        sizeBytes, durationMs, transferMs, remotePath, provider: this.providerKind
      });

      console.log(`[backup] ${name}: retry succeeded (${formatBytes(sizeBytes)})`);
      return { success: true, remotePath, sizeBytes };

    } catch (err) {
      this.setState(uuid, STATE.FAILED, {
        progress: 0, message: err.message, error: err.message,
        retryable: fs.existsSync(zipPath), failedAt: Date.now()
      });
      this.history.append({
        type: 'backup', uuid, name, success: false, retry: true,
        error: err.message, durationMs: Date.now() - started, provider: this.providerKind
      });
      console.error(`[backup] ${name}: retry FAILED — ${err.message}`);
      return { success: false, error: err.message, retryable: fs.existsSync(zipPath) };

    } finally {
      this.releaseLock(uuid);
    }
  }

  /**
   * Keep only the newest `backupRetention` archives (default 1).
   * Retention failures are logged but never fail the backup that just
   * succeeded — the data is safely stored either way.
   */
  async applyRetention(uuid, name) {
    try {
      const settings = this.loadSettings() || {};
      const keep = Math.max(1, parseInt(settings.backupRetention, 10) || 1);

      const files = await this.provider.list(this.remoteDir(uuid));
      if (files.length <= keep) return;

      // Shrink guard. A server directory that was only partially populated
      // (an interrupted restore, a wiped volume, a half-finished install)
      // still produces a valid archive — and at the default retention of 1 that
      // archive would evict the last good backup. If the newest is drastically
      // smaller than the one before it, keep the older copy this round.
      const [newest, previous] = files;
      if (previous && newest.size < previous.size * 0.5) {
        console.warn(
          `[backup] ${name}: new backup is ${formatBytes(newest.size)} vs ` +
          `${formatBytes(previous.size)} previously — keeping the older copy as a safety net`
        );
        const doomed = files.slice(Math.max(keep, 2));
        for (const file of doomed) {
          await this.provider.remove(file.path);
          console.log(`[backup] ${name}: retention removed ${file.name}`);
        }
        return;
      }

      for (const file of files.slice(keep)) {
        await this.provider.remove(file.path);
        console.log(`[backup] ${name}: retention removed ${file.name}`);
      }
    } catch (err) {
      console.error(`[backup] ${name}: retention pass failed:`, err.message);
    }
  }

  // ─── Restore ────────────────────────────────────────────────────

  /** A server directory with no real content counts as missing. */
  hasLocalFiles(uuid) {
    const dir = this.serverDir(uuid);
    try {
      return fs.readdirSync(dir).some((f) => f !== '.' && f !== '..');
    } catch {
      return false;
    }
  }

  /**
   * Guarantee local files exist before a start. No-op when they already do,
   * so this is safe to call on every start.
   *
   * @returns {Promise<{ ok: boolean, restored: boolean, error?: string }>}
   */
  async ensureRestored(uuid, opts = {}) {
    const name = opts.name || uuid;

    if (this.hasLocalFiles(uuid)) return { ok: true, restored: false };
    if (!this.enabled) return { ok: false, restored: false, error: 'Backups are disabled; cannot restore' };

    if (!this.acquireLock(uuid, 'restore')) {
      return { ok: false, restored: false, error: `A ${this.locks.get(uuid)} is already running for this server` };
    }

    const started = Date.now();
    const zipPath = this.archivePath(uuid);
    let sizeBytes = 0;

    try {
      this.setState(uuid, STATE.DOWNLOADING, { progress: 0, message: 'Locating newest backup', error: null });

      const files = await this.provider.list(this.remoteDir(uuid));
      if (!files.length) {
        // A brand-new server has no backup yet; that is not an error, it just
        // starts empty and gets backed up on first stop.
        this.setState(uuid, STATE.IDLE, { progress: 0, message: 'No backup found; starting fresh' });
        console.log(`[restore] ${name}: no backups in ${this.remoteDir(uuid)}, starting fresh`);
        return { ok: true, restored: false };
      }

      const newest = files[0];   // provider contract guarantees newest first
      console.log(`[restore] ${name}: restoring ${newest.name} (${formatBytes(newest.size)})`);

      // --- Download -------------------------------------------------
      this.setState(uuid, STATE.DOWNLOADING, { progress: 0, message: `Downloading ${formatBytes(newest.size)}` });
      const downloadStart = Date.now();
      try { fs.unlinkSync(zipPath); } catch {}

      await this.provider.download(newest.path, zipPath, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        this.setState(uuid, STATE.DOWNLOADING, {
          progress: pct,
          message: `Downloading — ${formatBytes(got)} / ${formatBytes(total)}`
        });
      });
      const transferMs = Date.now() - downloadStart;
      sizeBytes = fs.statSync(zipPath).size;

      // --- Verify before extracting ---------------------------------
      this.setState(uuid, STATE.VERIFYING, { progress: 0, message: 'Verifying downloaded archive' });
      await verifyZip(zipPath);

      // --- Extract --------------------------------------------------
      const dir = this.serverDir(uuid);
      fs.mkdirSync(dir, { recursive: true });
      this.setState(uuid, STATE.EXTRACTING, { progress: 0, message: 'Extracting server files' });

      const extracted = await extractZip(zipPath, dir, (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        this.setState(uuid, STATE.EXTRACTING, {
          progress: pct,
          message: `Extracting — ${done} / ${total} files`
        });
      });

      // --- Confirm the extraction actually produced files -----------
      if (!extracted.entries || !this.hasLocalFiles(uuid)) {
        throw new Error('Extraction completed but the server directory is still empty');
      }

      // Only delete the download once extraction is confirmed.
      try { fs.unlinkSync(zipPath); } catch (err) {
        console.error(`[restore] ${name}: could not delete downloaded archive:`, err.message);
      }

      const durationMs = Date.now() - started;
      this.setState(uuid, STATE.STARTING, {
        progress: 100,
        message: `Restored ${extracted.entries} files in ${Math.round(durationMs / 1000)}s`,
        completedAt: Date.now(), error: null
      });

      this.history.append({
        type: 'restore', uuid, name, success: true,
        sizeBytes, durationMs, transferMs,
        remotePath: newest.path, entries: extracted.entries,
        provider: this.providerKind
      });

      console.log(`[restore] ${name}: restored ${extracted.entries} files in ${durationMs}ms`);
      return { ok: true, restored: true };

    } catch (err) {
      // Leave the download in place; a retry can reuse it.
      this.setState(uuid, STATE.FAILED, {
        progress: 0, message: err.message, error: err.message, failedAt: Date.now()
      });
      this.history.append({
        type: 'restore', uuid, name, success: false,
        error: err.message, sizeBytes, durationMs: Date.now() - started,
        provider: this.providerKind
      });
      console.error(`[restore] ${name}: FAILED — ${err.message}`);
      return { ok: false, restored: false, error: err.message };

    } finally {
      this.releaseLock(uuid);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/** 2026-07-24T18-40-05 — sorts lexicographically and is filename-safe. */
function timestampName() {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = { BackupManager, STATE, formatBytes };
