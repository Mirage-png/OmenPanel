#!/usr/bin/env node
/**
 * Launch a command fully detached into its own session, then exit.
 *
 * The supervisor scripts previously backgrounded services with plain
 * `cmd &`, which leaves the child in the same process group as the launching
 * shell. Anything that signals that group — a terminal closing, Ctrl+C, or a
 * tool harness tearing down the shell it spawned for one command — takes the
 * "backgrounded" children down with it, even though they were meant to
 * outlive the shell that started them.
 *
 * The traditional fix is `setsid`, but that binary is not guaranteed to
 * exist (confirmed absent both on Replit's container and on macOS). Node's
 * own child_process.spawn supports `detached: true`, which calls setsid()
 * internally on POSIX — same effect, no external dependency, works
 * identically on both platforms since Node is the one thing already
 * guaranteed present everywhere this project runs.
 *
 * Usage: node spawn-detached.js <logfile> <cmd> [args...]
 * Prints the child's PID to stdout as the only line, then exits immediately.
 * The child keeps running, reparented to init once this process exits.
 */
const { spawn } = require('child_process');
const fs = require('fs');

const [, , logFile, cmd, ...args] = process.argv;

if (!logFile || !cmd) {
  console.error('usage: spawn-detached.js <logfile> <cmd> [args...]');
  process.exit(1);
}

const out = fs.openSync(logFile, 'a');

const child = spawn(cmd, args, {
  detached: true,
  stdio: ['ignore', out, out]
});

child.on('error', (err) => {
  // The parent shell reads our stdout for a PID; a spawn failure must be
  // reported on stderr and with a non-zero exit, not a blank PID line.
  console.error(`spawn-detached: failed to launch ${cmd}: ${err.message}`);
  process.exit(1);
});

// Once spawn succeeds the child has its own PID and session; nothing here
// needs to keep running to keep it alive.
child.unref();
console.log(child.pid);
