/**
 * OmenHosting — Storage provider factory
 *
 * Chooses the backend from configuration and hands back a StorageProvider.
 * This is the only file that needs editing to add a new backend; the backup
 * and restore logic never names a provider.
 *
 * Configuration is read from the environment so credentials never live in the
 * repository. See middleware/storage/README.md.
 *
 *   BACKUP_PROVIDER       local (default) | b2
 *   BACKUP_REMOTE_ROOT    base folder/prefix for backups on the remote
 *   BACKUP_LOCAL_PATH     local: directory to store archives in
 *   B2_KEY_ID             b2: applicationKeyId
 *   B2_APPLICATION_KEY    b2: applicationKey
 *   B2_BUCKET             b2: bucket name
 *   B2_BUCKET_ID          b2: optional, skips a bucket lookup
 */

const path = require('path');
const { LocalProvider } = require('./local');
const { B2Provider } = require('./b2');

/** Key prefix used inside the B2 bucket unless overridden. */
const DEFAULT_B2_ROOT = 'omenhosting-backups';

/**
 * @param {Object} opts
 * @param {string} opts.dataDir Where provider state is kept.
 * @returns {{ provider: import('./provider').StorageProvider, kind: string }}
 */
function createProvider(opts) {
  const kind = (process.env.BACKUP_PROVIDER || 'local').toLowerCase();

  if (kind === 'b2') {
    const keyId = process.env.B2_KEY_ID;
    const applicationKey = process.env.B2_APPLICATION_KEY;
    const bucket = process.env.B2_BUCKET;

    const missing = [
      ['B2_KEY_ID', keyId],
      ['B2_APPLICATION_KEY', applicationKey],
      ['B2_BUCKET', bucket]
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) {
      throw new Error(
        `Backblaze B2 selected but missing: ${missing.join(', ')}. ` +
        'See middleware/storage/README.md.'
      );
    }

    return {
      kind,
      provider: new B2Provider({
        keyId,
        applicationKey,
        bucket,
        bucketId: process.env.B2_BUCKET_ID,
        remoteRoot: process.env.BACKUP_REMOTE_ROOT || DEFAULT_B2_ROOT
      })
    };
  }

  if (kind === 'local') {
    return {
      kind,
      provider: new LocalProvider({
        basePath: process.env.BACKUP_LOCAL_PATH || path.join(opts.dataDir, 'backups')
      })
    };
  }

  throw new Error(`Unknown BACKUP_PROVIDER "${kind}" (expected: local, b2)`);
}

/**
 * The remote root differs per provider, so the manager asks rather than
 * assuming. B2 keys have no leading slash, so the prefix is applied inside the
 * provider and the manager keeps working in "/uuid/file.zip" terms.
 */
function getRemoteRoot(kind) {
  if (kind === 'b2') return '';
  return process.env.BACKUP_REMOTE_ROOT || '';
}

module.exports = { createProvider, getRemoteRoot, DEFAULT_B2_ROOT };
