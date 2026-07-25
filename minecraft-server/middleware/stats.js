/**
 * OmenHosting — per-instance resource usage (CPU / RAM / storage)
 *
 * The daemon tracks CPU/memory for a running process internally (via
 * `pidusage` over a live socket.io session), but that data is only reachable
 * from inside an open terminal session. The panel's own "Basic Infomation"
 * card doesn't expose it as a plain HTTP endpoint, so this module finds the
 * server's OS process independently and reads the same OS counters.
 *
 * Finding the process:
 *   Every instance's working directory is unique (mcsmanager/daemon/data/
 *   InstanceData/<uuid>), so the process is identified by matching PID -> cwd
 *   rather than by name (a box can run several `java` processes at once).
 *
 *   Linux (production target):  /proc/<pid>/cwd is a symlink — read it directly.
 *   Anything else (macOS/dev):  no /proc, so `lsof -d cwd` is used instead.
 *
 * Once the pid is known, `ps` supplies %CPU and RSS — no native dependencies,
 * available on every platform this panel runs on.
 *
 * Storage usage is a plain recursive size sum of the instance directory; nothing
 * here is a hot path, so no caching layer is worth the complexity yet.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PS_TIMEOUT = 5000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: PS_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/**
 * Find the pid of the process whose current working directory is exactly
 * `targetDir`. Returns null if none is found (server not running).
 */
async function findPidByCwd(targetDir) {
  // Both `/proc/<pid>/cwd` and `lsof` report the fully resolved path (e.g.
  // macOS's /tmp -> /private/tmp), so the comparison side must be resolved the
  // same way or every match silently fails on a symlinked path.
  let resolved;
  try {
    resolved = fs.realpathSync(targetDir);
  } catch {
    return null; // directory does not exist -> nothing can be running in it
  }

  if (process.platform === 'linux') {
    let pids;
    try {
      pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return null;
    }
    for (const pid of pids) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === resolved) return Number(pid);
      } catch {
        // Process exited mid-scan, or we lack permission — not our process.
      }
    }
    return null;
  }

  // macOS / other: no /proc, so ask lsof which pids have this dir open as cwd.
  try {
    // -a ANDs the selectors together; -d cwd restricts to the cwd file descriptor.
    const out = await run('lsof', ['-a', '-d', 'cwd', '-Fpn']);
    let currentPid = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) currentPid = Number(line.slice(1));
      else if (line.startsWith('n') && currentPid && line.slice(1) === resolved) {
        return currentPid;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** %CPU and resident set size for a pid, via `ps` (no native deps). */
async function readProcessUsage(pid) {
  try {
    const out = await run('ps', ['-o', 'pcpu=,rss=', '-p', String(pid)]);
    const line = out.trim().split('\n')[0] || '';
    const [cpu, rssKb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return null;
    return { cpuPercent: cpu, memoryBytes: rssKb * 1024 };
  } catch {
    return null; // pid exited between lookup and read
  }
}

/** Recursive byte total for a directory. Symlinks are not followed. */
function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else if (entry.isFile()) {
      try { total += fs.statSync(full).size; } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

/**
 * @param {string} serverDir  Absolute path to the instance's working directory.
 * @returns {Promise<{
 *   running: boolean, pid: number|null,
 *   cpuPercent: number, memoryBytes: number, memoryPercent: number,
 *   systemMemoryBytes: number, diskBytes: number
 * }>}
 */
async function getInstanceStats(serverDir) {
  const diskBytes = directorySize(serverDir);
  const systemMemoryBytes = os.totalmem();

  const pid = await findPidByCwd(serverDir);
  if (!pid) {
    return { running: false, pid: null, cpuPercent: 0, memoryBytes: 0, memoryPercent: 0, systemMemoryBytes, diskBytes };
  }

  const usage = await readProcessUsage(pid);
  if (!usage) {
    return { running: false, pid: null, cpuPercent: 0, memoryBytes: 0, memoryPercent: 0, systemMemoryBytes, diskBytes };
  }

  return {
    running: true,
    pid,
    cpuPercent: usage.cpuPercent,
    memoryBytes: usage.memoryBytes,
    memoryPercent: systemMemoryBytes ? (usage.memoryBytes / systemMemoryBytes) * 100 : 0,
    systemMemoryBytes,
    diskBytes
  };
}

module.exports = { getInstanceStats, findPidByCwd, readProcessUsage, directorySize };
