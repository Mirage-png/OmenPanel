#!/usr/bin/env node
/**
 * Restores panel state from S3/B2 before any service that reads it boots.
 * Must run before mcsm-daemon starts — it loads InstanceConfig once at its
 * own boot and never re-reads it, so restoring afterward would leave every
 * recovered server invisible until a second restart. See state-sync.js.
 */
const { restoreState } = require('./state-sync');

restoreState().catch((err) => {
  // Non-fatal: a restore failure should not block the panel from booting
  // with an empty state, which is exactly what would happen anyway without
  // this script.
  console.error('[state-sync] Restore failed, continuing with local data:', err.message);
});
