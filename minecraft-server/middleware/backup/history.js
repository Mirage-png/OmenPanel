/**
 * OmenHosting — Backup history log
 *
 * Append-only JSONL, one record per backup or restore attempt. JSONL rather
 * than a JSON array so a crash mid-write costs at most the final line instead
 * of corrupting the whole file, and so appends never rewrite the file.
 *
 * Record shape:
 *   {
 *     ts, type: 'backup'|'restore', uuid, name,
 *     success, error,
 *     sizeBytes, durationMs, compressMs, transferMs,
 *     remotePath, entries
 *   }
 */

const fs = require('fs');
const path = require('path');

const MAX_RECORDS = 500;   // per server; trimmed on read, compacted on write

class BackupHistory {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'backup-history.jsonl');
    this.compactCounter = 0;
  }

  /**
   * Append one record. Never throws: losing an audit line must not fail a
   * backup that otherwise succeeded.
   * @param {Object} record
   */
  append(record) {
    const entry = { ts: new Date().toISOString(), ...record };
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[backup:history] Could not write history:', err.message);
      return entry;
    }

    // Amortised compaction so the file cannot grow without bound.
    if (++this.compactCounter >= 100) {
      this.compactCounter = 0;
      this.compact();
    }
    return entry;
  }

  /**
   * @param {Object} [opts]
   * @param {string} [opts.uuid]  Restrict to one server.
   * @param {number} [opts.limit] Most recent N (default 50).
   * @returns {Object[]} newest first
   */
  read(opts = {}) {
    const limit = opts.limit || 50;
    let lines;
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n');
    } catch {
      return [];
    }

    const out = [];
    // Walk backwards: newest first, and stop as soon as we have enough.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (opts.uuid && rec.uuid !== opts.uuid) continue;
        out.push(rec);
      } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** Keep only the newest MAX_RECORDS entries per server. */
  compact() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const perServer = new Map();
      const kept = [];

      for (let i = lines.length - 1; i >= 0; i--) {
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        const n = (perServer.get(rec.uuid) || 0) + 1;
        if (n > MAX_RECORDS) continue;
        perServer.set(rec.uuid, n);
        kept.push(lines[i]);
      }

      kept.reverse();
      fs.writeFileSync(this.file + '.tmp', kept.join('\n') + '\n');
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('[backup:history] Compaction failed:', err.message);
    }
  }
}

module.exports = { BackupHistory };
