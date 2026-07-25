/**
 * OmenHosting — Local filesystem storage provider
 *
 * Writes backups to a directory on this machine (or any mounted volume / NAS
 * path). It exists for two reasons:
 *   1. It is the default when no cloud provider is configured, so the backup
 *      and restore pipeline is fully functional out of the box.
 *   2. It is the reference implementation of the StorageProvider contract —
 *      the smallest correct example to copy when adding S3/B2/Drive.
 *
 * Everything is streamed, matching the contract, even though a local copy
 * could cheat with fs.copyFile.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { StorageProvider } = require('./provider');

class LocalProvider extends StorageProvider {
  /**
   * @param {Object} cfg
   * @param {string} cfg.basePath Directory that backing store lives under.
   */
  constructor(cfg) {
    super();
    // Resolved to absolute up front: the containment check below compares
    // against path.resolve() output, so a relative basePath would never match
    // and every operation would be rejected as an escape attempt.
    this.basePath = path.resolve(cfg.basePath);
  }

  get name() {
    return 'local';
  }

  /**
   * Remote paths are POSIX-style and absolute ("/uuid/file.zip"); map them
   * under basePath without letting "..' escape it.
   */
  resolve(remotePath) {
    const rel = path.posix.normalize(remotePath).replace(/^\/+/, '');
    const full = path.resolve(this.basePath, rel);
    if (full !== this.basePath && !full.startsWith(this.basePath + path.sep)) {
      throw new Error(`Refusing to access path outside backup root: ${remotePath}`);
    }
    return full;
  }

  async init() {
    fs.mkdirSync(this.basePath, { recursive: true });
    // Fail fast at startup rather than at the end of a long compression run.
    fs.accessSync(this.basePath, fs.constants.W_OK);
    console.log(`[storage:local] Ready (root=${this.basePath})`);
  }

  async upload(localPath, remotePath, onProgress) {
    const dest = this.resolve(remotePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const total = fs.statSync(localPath).size;
    let copied = 0;

    const read = fs.createReadStream(localPath);
    read.on('data', (chunk) => {
      copied += chunk.length;
      if (onProgress) onProgress(copied, total);
    });

    // Write to a temp name and rename, so an interrupted copy never leaves a
    // half-written archive that looks like a valid backup.
    const tmp = dest + '.partial';
    await pipeline(read, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);

    return { size: total };
  }

  async download(remotePath, localPath, onProgress) {
    const src = this.resolve(remotePath);
    const total = fs.statSync(src).size;
    let copied = 0;

    const read = fs.createReadStream(src);
    read.on('data', (chunk) => {
      copied += chunk.length;
      if (onProgress) onProgress(copied, total);
    });

    await pipeline(read, fs.createWriteStream(localPath));
    return { size: total };
  }

  async list(remoteDir) {
    const dir = this.resolve(remoteDir);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];   // no backups yet
      throw err;
    }

    return names
      .map((name) => {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile() || name.endsWith('.partial')) return null;
          return {
            path: path.posix.join(remoteDir, name),
            name,
            size: st.size,
            modified: st.mtimeMs
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified);
  }

  async remove(remotePath) {
    try {
      fs.unlinkSync(this.resolve(remotePath));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;   // already gone is fine
    }
  }
}

module.exports = { LocalProvider };
