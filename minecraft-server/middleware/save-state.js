#!/usr/bin/env node
/**
 * Snapshots panel state to S3/B2. Run periodically as a safety net and once
 * more on shutdown so a "republish" (which sends SIGTERM) captures whatever
 * changed since the last periodic save. See state-sync.js.
 */
const { saveState } = require('./state-sync');

saveState().catch((err) => {
  console.error('[state-sync] Save failed:', err.message);
  process.exitCode = 1;
});
