#!/usr/bin/env node
/**
 * Restores panel state from S3/B2 before any service that reads it boots.
 * Must run before mcsm-daemon starts — it loads InstanceConfig once at its
 * own boot and never re-reads it, so restoring afterward would leave every
 * recovered server invisible until a second restart. See state-sync.js.
 */
const { restoreState } = require('./state-sync');
const { ensureInstanceConfigPaths } = require('./bootstrap-admin');

restoreState()
  .catch((err) => {
    // Non-fatal: a restore failure should not block the panel from booting
    // with an empty state, which is exactly what would happen anyway without
    // this script.
    console.error('[state-sync] Restore failed, continuing with local data:', err.message);
  })
  .then(() => {
    // Runs unconditionally, not just after a restore — the same stale-path
    // problem exists for local data carried over by hand (or between
    // Replit/Render/local dev), not just an S3/B2 restore. Must happen here,
    // before mcsm-daemon starts either way.
    ensureInstanceConfigPaths();
  });
