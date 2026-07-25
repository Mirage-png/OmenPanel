/**
 * OmenHosting — Storage Provider contract
 *
 * The backup/restore logic talks only to this interface, so a different
 * backend (S3, Backblaze B2, Google Drive, …) can be dropped in by adding a
 * module here and registering it in storage/index.js. Nothing in
 * backup/manager.js knows which provider is active.
 *
 * Remote layout owned by the caller, not the provider:
 *   <remoteRoot>/<serverUuid>/<timestamp>.zip
 *
 * Implementation rules:
 *   - Uploads/downloads MUST stream. Never buffer a whole archive in memory;
 *     server directories are routinely larger than the heap.
 *   - Throw on failure with a descriptive Error. Callers translate that into a
 *     retryable state; they never inspect provider-specific error shapes.
 *   - onProgress is advisory. It may be called any number of times, and a
 *     provider that cannot report progress simply never calls it.
 */

/**
 * @typedef {Object} RemoteFile
 * @property {string} path      Full remote path.
 * @property {string} name      Base name.
 * @property {number} size      Size in bytes.
 * @property {number} modified  Last-modified time (epoch ms).
 */

class StorageProvider {
  /** Human-readable provider name, used in logs. */
  get name() {
    return 'unknown';
  }

  /**
   * Verify the backend is reachable and credentials are valid.
   * Called once at startup; failure disables backups rather than crashing.
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error('init() not implemented');
  }

  /**
   * Stream a local file to `remotePath`, creating parent folders as needed.
   * Must overwrite any existing object at that path.
   * @param {string} localPath
   * @param {string} remotePath
   * @param {(uploaded: number, total: number) => void} [onProgress]
   * @returns {Promise<{ size: number }>}
   */
  async upload(localPath, remotePath, onProgress) {
    throw new Error('upload() not implemented');
  }

  /**
   * Stream `remotePath` to `localPath`.
   * @param {string} remotePath
   * @param {string} localPath
   * @param {(downloaded: number, total: number) => void} [onProgress]
   * @returns {Promise<{ size: number }>}
   */
  async download(remotePath, localPath, onProgress) {
    throw new Error('download() not implemented');
  }

  /**
   * List files directly under `remoteDir`, newest first.
   * Returns an empty array when the directory does not exist — a missing
   * folder is "no backups yet", not an error.
   * @param {string} remoteDir
   * @returns {Promise<RemoteFile[]>}
   */
  async list(remoteDir) {
    throw new Error('list() not implemented');
  }

  /**
   * Delete a remote file. Deleting a missing file must resolve, not throw,
   * so retention passes are idempotent.
   * @param {string} remotePath
   * @returns {Promise<void>}
   */
  async remove(remotePath) {
    throw new Error('remove() not implemented');
  }
}

module.exports = { StorageProvider };
