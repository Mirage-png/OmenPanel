#!/usr/bin/env node
/**
 * OmenHosting Middleware Service
 * - Auto-sleep: shuts down empty servers after 3 minutes
 * - Minekube Connect: auto-installs plugin on server start
 * - Minekube IP: detects and stores the connect address
 * - Signup API: user self-registration
 * - UI injection: status indicators, copy button
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

process.on('uncaughtException', (err) => console.error('[process] Uncaught:', err?.message));
process.on('unhandledRejection', (err) => console.error('[process] Unhandled rejection:', err?.message || err));

const PORT = 29999;
const DAEMON_PORT = 24444;
const DAEMON_ID = '8912fa8ad2c947b183e6f783558e9f21';
const WEB_PORT = 23333;
const BASE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'omen-data');

/**
 * Admin credentials the middleware uses to call the web panel's own admin API
 * (creating signup accounts, syncing instance assignment, and as one path for
 * auto-sleep to stop a server). Read from the environment only — never
 * hardcoded — since a plaintext admin password baked into source code would
 * be exposed the moment this repo is shared or published.
 */
function getAdminCredentials() {
  return {
    username: process.env.OMEN_ADMIN_USERNAME || 'admin',
    password: process.env.OMEN_ADMIN_PASSWORD || ''
  };
}
const MINEKUBE_JAR_URL = 'https://github.com/minekube/connect-java/releases/download/latest/connect-spigot.jar';

// The real bootstrap runs as its own script (bootstrap-admin.js) before the
// web panel starts, since MCSManager loads its user list into memory once
// at its own boot and won't see a file created after the fact. This call is
// just a safety net for the (normal) case where that already ran.
require('./bootstrap-admin')();

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ═══ State ═══
const serverStates = {};  // uuid -> { lastPlayerCount, lastActivity, emptySince, minekubeAddress, sleeping }
const settingsDB = path.join(DATA_DIR, 'settings.json');

// ═══ Cloud Backup ═══
// Populated by initBackupSystem() at startup. Stays null when the storage
// backend cannot be reached, in which case every call site falls through to
// the pre-existing behaviour and the panel keeps working without backups.
const { createProvider, getRemoteRoot } = require('./storage');
const { BackupManager, STATE: BACKUP_STATE } = require('./backup/manager');
const modrinth = require('./mods/modrinth');
const { getInstanceStats } = require('./stats');
const INSTANCE_DATA_DIR = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceData');
let backupManager = null;

// uuid -> { stage, done, total } while a modpack install is running
const modInstallState = {};

// ═══ Queue System ═══
const MAX_RUNNING = 1;
const queue = [];  // Array of { uuid, name, joinedAt }
let runningCount = 0;
const gracePeriods = {};  // uuid -> { endsAt, timeout }

// Starts that have claimed a slot but whose instance is not reporting as
// running yet. Counted during reconciliation so an in-flight start is not
// mistaken for a free slot and handed out twice.
let pendingStarts = 0;

async function refreshRunningCount() {
  try {
    const dir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'global0001.json');
    let count = 0;
    for (const f of files) {
      const uuid = f.replace('.json', '');
      if (await isInstanceRunning(uuid)) count++;
    }

    const actual = count + pendingStarts;
    if (actual !== runningCount) {
      console.log(`[queue] Reconciled running count: ${runningCount} -> ${actual}/${MAX_RUNNING}`);
      runningCount = actual;
    }
    // Slots may have opened up since the last pass.
    queueStartNext();
  } catch (e) {
    console.error('[queue] Refresh error:', e.message);
  }
}

function queueStartNext() {
  // The slot must be claimed synchronously. Incrementing inside .then() left
  // the loop condition unchanged for the whole synchronous pass, so a single
  // call drained the entire queue and started every server at once.
  while (queue.length > 0 && runningCount < MAX_RUNNING) {
    const entry = queue.shift();
    runningCount++;
    pendingStarts++;
    console.log(`[queue] Starting server for ${entry.name || entry.uuid} (${runningCount}/${MAX_RUNNING})`);
    startInstance(entry.uuid)
      .then(() => {
        pendingStarts--;
        console.log(`[queue] Server ${entry.name || entry.uuid} started (${runningCount}/${MAX_RUNNING})`);
      })
      .catch((e) => {
        pendingStarts--;
        if (runningCount > 0) runningCount--;
        console.error(`[queue] Start failed for ${entry.name || entry.uuid}, slot released (${runningCount}/${MAX_RUNNING}):`, e.message);
        queueStartNext();
      });
  }
}

function removeFromQueue(uuid) {
  const idx = queue.findIndex(e => e.uuid === uuid);
  if (idx !== -1) {
    queue.splice(idx, 1);
    console.log(`[queue] Removed ${uuid} from queue (was #${idx + 1})`);
  }
}

/**
 * Launch an instance, restoring it from cloud backup first if its local files
 * are missing. Every queue-driven start funnels through here, so the restore
 * check is automatic and needs no user action.
 */
async function startInstance(uuid) {
  const restored = await ensureServerFiles(uuid);
  if (!restored) throw new Error('Server files are missing and could not be restored from backup');
  return launchInstance(uuid);
}

/** Raw daemon start, with no backup/restore involvement. */
function launchInstance(uuid) {
  return new Promise((resolve, reject) => {
    try {
      let daemonKey = '';
      try {
        const globalConfig = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/Config/global.json'), 'utf8'));
        daemonKey = globalConfig.key || '';
      } catch {}

      const { io } = require('socket.io-client');
      const socket = io(`http://127.0.0.1:${DAEMON_PORT}`, {
        path: '/socket.io', reconnection: false, timeout: 10000, transports: ['websocket']
      });

      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.disconnect(); } catch {}
        // Always reject with an Error — rejecting with a bare string made every
        // caller log "Start error: undefined" and hid the real cause.
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };

      const timer = setTimeout(() => done('timeout waiting for instance/started'), 15000);

      socket.on('connect', () => socket.emit('auth', { uuid: null, data: daemonKey }));
      socket.on('auth', (p) => {
        if (p && p.data === true) {
          // Daemon 4.16.x expects `instanceUuids` (an array); older builds read
          // the singular `instanceUuid`. Sending both keeps either version working.
          socket.emit('instance/open', {
            uuid: null,
            data: { instanceUuids: [uuid], instanceUuid: uuid }
          });
        } else {
          done('auth_failed');
        }
      });
      socket.on('instance/started', () => done(null));
      // The daemon reports start failures as an error reply on the same event,
      // so surface it immediately instead of stalling until the timeout.
      socket.on('instance/open', (p) => {
        if (p && p.status && p.status !== 200) {
          done(new Error((p.data && (p.data.err || p.data.message)) || `daemon status ${p.status}`));
        }
      });
      socket.on('connect_error', (e) => done(e.message));
    } catch (e) { reject(e); }
  });
}

function clearGracePeriod(uuid) {
  if (gracePeriods[uuid]) {
    clearTimeout(gracePeriods[uuid].timeout);
    delete gracePeriods[uuid];
  }
}

// ═══ Auto-Sleep Monitor ═══
function daemonRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: DAEMON_PORT, path, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function webRequest(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: WEB_PORT, path, method, headers: { 'Content-Type': 'application/json', 'x-requested-with': 'xmlhttprequest' } };
    if (cookie) opts.headers['Cookie'] = cookie;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        const rawCookies = res.headers['set-cookie'];
        let cookieStr = '';
        if (rawCookies) {
          cookieStr = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
            .map(c => c.split(';')[0]).join('; ');
        }
        try { resolve({ data: JSON.parse(data), status: res.statusCode, setCookie: cookieStr }); } catch { resolve({ data, status: res.statusCode, setCookie: cookieStr }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══ Settings ═══
function loadSettings() {
  const defaults = {
    autoSleepEnabled: true,
    autoSleepMinutes: 3,
    minekubeAutoInstall: true,
    backupEnabled: true,
    backupRetention: 1,          // keep only the newest backup unless raised
    backupCompressionLevel: 9,   // 0-9; 9 is the smallest and costs little here
    backupStorePrecompressed: false,  // true = ~20x less CPU, ~4% larger
    backupExcludes: []           // extra glob patterns on top of the defaults
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsDB, 'utf8')) };
  } catch {
    return defaults;
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsDB, JSON.stringify(s, null, 4));
}

// ═══ Auto-Sleep Monitor ═══
// Track player activity from console logs (Minekube tunneled players don't show in port ping)
const logPlayerActivity = {};  // uuid -> { onlinePlayers: Set }
const installedPlugins = {};  // uuid -> true (tracks which plugins were already installed this session)

function detectPlayerActivity(text, instanceUuid) {
  if (!logPlayerActivity[instanceUuid]) {
    logPlayerActivity[instanceUuid] = { onlinePlayers: new Set() };
  }
  const activity = logPlayerActivity[instanceUuid];

  // Process each line, strip ANSI codes first
  const lines = text.split('\n');
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\[K/g, '');

    // Player logged in: "0m3m[/172.16.12.146:0] logged in with entity id"
    const loginMatch = clean.match(/(\w+)\[\/[\d.]+:\d+\] logged in/);
    if (loginMatch) {
      const name = loginMatch[1].toLowerCase();
      if (!activity.onlinePlayers.has(name)) {
        activity.onlinePlayers.add(name);
        console.log(`[auto-sleep] Player ${loginMatch[1]} joined (${activity.onlinePlayers.size} online)`);
        if (serverStates[instanceUuid]) {
          serverStates[instanceUuid].emptySince = null;
          serverStates[instanceUuid].lastActivity = Date.now();
        }
      }
    }

    // Player left: "0m3m left the game" or "0m3m lost connection"
    const leftMatch = clean.match(/(\w+) left the game/) || clean.match(/(\w+) lost connection/);
    if (leftMatch) {
      const name = leftMatch[1].toLowerCase();
      if (activity.onlinePlayers.has(name)) {
        activity.onlinePlayers.delete(name);
        console.log(`[auto-sleep] Player ${leftMatch[1]} left (${activity.onlinePlayers.size} online)`);
        if (activity.onlinePlayers.size === 0 && serverStates[instanceUuid]) {
          serverStates[instanceUuid].emptySince = Date.now();
          console.log(`[auto-sleep] All players left, starting empty timer`);
        }
      }
    }
  }
}

async function checkAutoSleep() {
  const settings = loadSettings();
  if (!settings.autoSleepEnabled) return;

  try {
    const instanceDir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig');
    if (!fs.existsSync(instanceDir)) return;

    const files = fs.readdirSync(instanceDir).filter(f => f.endsWith('.json') && f !== 'global0001.json');

    for (const file of files) {
      const uuid = file.replace('.json', '');
      const config = JSON.parse(fs.readFileSync(path.join(instanceDir, file), 'utf8'));

      if (!config.type || (!config.type.includes('minecraft') && config.type !== 'universal')) continue;
      if (!config.startCommand || config.startCommand.trim() === '') continue;

      if (!serverStates[uuid]) {
        serverStates[uuid] = { lastPlayerCount: -1, lastActivity: Date.now(), emptySince: null, minekubeAddress: null, sleeping: false };
      }

      const state = serverStates[uuid];

      // Check if server port is open
      const running = await isInstanceRunning(uuid);
      if (!running) {
        if (state.emptySince !== null) {
          console.log(`[auto-sleep] Server ${config.nickname} is no longer running, resetting timer`);
        }
        state.sleeping = false;
        state.emptySince = null;
        continue;
      }

      // Get port from config
      const port = config.basePort || config.pingConfig?.port || 25565;
      const playerCount = await pingMinecraftServer(port);

      console.log(`[auto-sleep] ${config.nickname}: port=${port}, players=${playerCount}, emptySince=${state.emptySince ? Math.floor((Date.now() - state.emptySince) / 1000) + 's' : 'null'}`);

      if (playerCount === -1) {
        // Can't ping but port is open - server is running, assume 0 players
        console.log(`[auto-sleep] Can't ping ${config.nickname}, assuming 0 players`);
      }

      if (playerCount === 0 || playerCount === -1) {
        // Also check log-based player activity (Minekube tunneled players)
        const logPlayers = logPlayerActivity[uuid];
        const hasTunneledPlayers = logPlayers && logPlayers.onlinePlayers.size > 0;

        if (hasTunneledPlayers) {
          // Players connected via tunnel, don't sleep
          state.emptySince = null;
          state.lastActivity = Date.now();
          console.log(`[auto-sleep] ${config.nickname} has ${logPlayers.onlinePlayers.size} tunneled player(s), skipping sleep`);
        } else if (state.emptySince === null) {
          state.emptySince = Date.now();
          console.log(`[auto-sleep] Server ${config.nickname} is empty, timer started`);
        } else {
          const emptyDuration = (Date.now() - state.emptySince) / 1000;
          const threshold = (settings.autoSleepMinutes || 3) * 60;
          console.log(`[auto-sleep] ${config.nickname} empty for ${Math.floor(emptyDuration)}s / ${threshold}s`);
          if (emptyDuration >= threshold && !state.sleeping) {
            console.log(`[auto-sleep] SHUTTING DOWN ${config.nickname}!`);
            state.sleeping = true;
            await stopInstance(uuid, config.nickname);
            setGracePeriod(uuid);
          }
        }
      } else {
        if (state.emptySince !== null) {
          console.log(`[auto-sleep] Server ${config.nickname} now has ${playerCount} players, cancelling timer`);
        }
        state.emptySince = null;
        state.lastPlayerCount = playerCount;
        state.lastActivity = Date.now();
      }
    }
  } catch (err) {
    console.error('[auto-sleep] Error:', err.message);
  }
}

async function isInstanceRunning(uuid) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig', uuid + '.json'), 'utf8'));
    const port = cfg.basePort || cfg.pingConfig?.port || 25565;
    return await checkPort(port);
  } catch { return false; }
}

function checkPort(port) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const client = new net.Socket();
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; client.destroy(); resolve(false); }
      }, 2000);
      client.connect(port, '127.0.0.1', () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); client.destroy(); resolve(true); }
      });
      client.on('error', () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(false); }
      });
    } catch { resolve(false); }
  });
}

function pingMinecraftServer(port) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const client = new net.Socket();
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; client.destroy(); resolve(-1); }
      }, 3000);

      client.connect(port, '127.0.0.1', () => {
        // Send MC Server List Ping (0xFE 0x01)
        const packet = Buffer.from([0xfe, 0x01]);
        client.write(packet);
      });

      client.on('data', (data) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        client.destroy();

        try {
          // Try UTF-16LE first (modern MC)
          const str = data.toString('utf16le');
          const parts = str.split(/\x00\x00/);
          if (parts.length >= 4) {
            const currentPlayers = parseInt(parts[3]) || 0;
            resolve(currentPlayers);
            return;
          }

          // Try UTF-8 (older MC)
          const str8 = data.toString('utf8');
          const match = str8.match(/§\d+.*?(\d+) online/);
          if (match) {
            resolve(parseInt(match[1]) || 0);
            return;
          }

          // If we got any response, server is running but we can't parse player count
          if (data.length > 0) {
            resolve(0); // Assume 0 players if server responds but we can't parse
            return;
          }

          resolve(-1);
        } catch { resolve(-1); }
      });

      client.on('error', () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(-1); }
      });
    } catch { resolve(-1); }
  });
}

async function stopInstance(uuid, name) {
  try {
    const markerFile = path.join(DATA_DIR, `autosleep-${uuid}.json`);
    fs.writeFileSync(markerFile, JSON.stringify({ timestamp: Date.now(), reason: 'empty_server', name }));
    console.log(`[auto-sleep] Marker written for ${name}`);

    // Method 1: Web panel HTTP API with login + token
    try {
      const loginData = JSON.stringify(getAdminCredentials());
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: WEB_PORT, path: '/api/auth/login', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData), 'x-requested-with': 'xmlhttprequest' }
        }, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => {
            const cookies = res.headers['set-cookie'];
            const sessionCookie = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
            const match = sessionCookie.match(/=(eyJ.*)/);
            if (match && sessionCookie) {
              const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString());
              const token = decoded.token;
              console.log(`[auto-sleep] Login OK, sending stop via HTTP API`);
              const stopData = JSON.stringify([{ daemonId: DAEMON_ID, instanceUuid: uuid }]);
              const stopReq = http.request({
                hostname: '127.0.0.1', port: WEB_PORT,
                path: '/api/instance/multi_stop?token=' + token, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(stopData), 'x-requested-with': 'xmlhttprequest', 'Cookie': sessionCookie }
              }, (stopRes) => {
                let stopBody = '';
                stopRes.on('data', (c) => stopBody += c);
                stopRes.on('end', () => console.log(`[auto-sleep] Stop API: ${stopRes.statusCode} - ${stopBody.substring(0, 200)}`));
              });
              stopReq.write(stopData);
              stopReq.end();
            }
            resolve();
          });
        });
        req.on('error', (e) => { console.error(`[auto-sleep] Login error:`, e.message); resolve(); });
        req.write(loginData);
        req.end();
      });
    } catch (err) {
      console.error(`[auto-sleep] HTTP API method failed:`, err.message);
    }

    // Method 2: Daemon socket.io directly (with correct protocol format)
    try {
      let daemonKey = '';
      try {
        const globalConfig = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/Config/global.json'), 'utf8'));
        daemonKey = globalConfig.key || '';
      } catch {}

      const { io } = require('socket.io-client');
      const socket = io(`http://127.0.0.1:${DAEMON_PORT}`, {
        path: '/socket.io',
        reconnection: false,
        timeout: 8000,
        transports: ['websocket']
      });

      await new Promise((resolve) => {
        const done = (msg) => {
          console.log(`[auto-sleep] Daemon socket: ${msg}`);
          try { socket.disconnect(); } catch {}
          resolve();
        };

        socket.on('connect', () => {
          console.log(`[auto-sleep] Daemon socket connected, authenticating...`);
          socket.emit('auth', { uuid: null, data: daemonKey });
        });

        socket.on('auth', (protocol) => {
          console.log(`[auto-sleep] Daemon auth: data=${protocol?.data}`);
          if (protocol && protocol.data === true) {
            setTimeout(() => {
              console.log(`[auto-sleep] Sending instance/stop via daemon socket`);
              socket.emit('instance/stop', { uuid: null, data: { instanceUuids: [uuid] } });
            }, 500);
          } else {
            done('auth_failed');
          }
        });

        socket.on('instance/stopped', (protocol) => {
          console.log(`[auto-sleep] Instance stopped:`, JSON.stringify(protocol?.data));
          done('instance_stopped');
        });

        socket.on('connect_error', (err) => done('connect_error: ' + err.message));

        setTimeout(() => done('timeout'), 10000);
      });
    } catch (err) {
      console.error(`[auto-sleep] Daemon socket failed:`, err.message);
    }

  } catch (err) {
    console.error(`[auto-sleep] Failed to stop ${name}:`, err.message);
  }
  // Decrement running count and trigger queue
  if (runningCount > 0) runningCount--;
  console.log(`[queue] Server stopped, running: ${runningCount}/${MAX_RUNNING}`);
  queueStartNext();

  // Back the server up now that it is going down. backup() waits for the
  // process to fully exit before reading the directory, so this does not race
  // the shutdown, and it runs detached so the queue is not held up by it.
  scheduleBackup(uuid, name);
}

// ═══ Cloud Backup & Restore ═══

/**
 * Bring up the storage backend and backup manager.
 *
 * A backend that cannot be reached must not take the panel down with it, so
 * failure here logs and leaves backupManager null; servers then run exactly as
 * they did before this feature existed.
 */
async function initBackupSystem() {
  try {
    const settings = loadSettings();
    if (settings.backupEnabled === false) {
      console.log('[backup] Disabled via settings');
      return;
    }

    const { provider, kind } = createProvider({ dataDir: DATA_DIR });
    await provider.init();

    backupManager = new BackupManager({
      provider,
      providerKind: kind,
      remoteRoot: getRemoteRoot(kind),
      dataDir: DATA_DIR,
      instanceDataDir: INSTANCE_DATA_DIR,
      workDir: path.join(DATA_DIR, 'backup-work'),
      loadSettings,
      isInstanceRunning
    });

    console.log(`[backup] Ready using "${kind}" storage`);
  } catch (err) {
    console.error('[backup] Disabled — storage unavailable:', err.message);
    backupManager = null;
  }
}

/**
 * Back up a server once it has fully exited.
 *
 * Deliberately fire-and-forget: stop paths must not block on a multi-minute
 * upload, and the queue slot is released independently.
 */
function scheduleBackup(uuid, name) {
  if (!backupManager) return;
  if (backupManager.isBusy(uuid)) return;

  backupManager.backup(uuid, { name })
    .catch((err) => console.error(`[backup] ${name || uuid}: unexpected failure:`, err.message));
}

/**
 * Watch for servers that stopped without going through stopInstance() — the
 * panel's own Stop button, a crash, or an operator killing the process. Any
 * running -> stopped transition triggers a backup, which is what makes the
 * feature automatic regardless of how the server went down.
 */
const backupRunState = {};  // uuid -> boolean (was running on last poll)

async function pollForStoppedServers() {
  if (!backupManager) return;

  let files;
  try {
    files = fs.readdirSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig'))
      .filter((f) => f.endsWith('.json') && f !== 'global0001.json');
  } catch {
    return;
  }

  for (const file of files) {
    const uuid = file.replace('.json', '');
    try {
      const running = await isInstanceRunning(uuid);
      const wasRunning = backupRunState[uuid];
      backupRunState[uuid] = running;

      // Only act on a genuine transition. `undefined` on first pass means we
      // have no baseline yet, so a server that was already stopped at startup
      // is not backed up spuriously.
      if (wasRunning === true && running === false) {
        let name = uuid;
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig', file), 'utf8'));
          name = cfg.nickname || uuid;
        } catch {}
        console.log(`[backup] Detected ${name} stopped; scheduling backup`);
        scheduleBackup(uuid, name);
      }
    } catch { /* skip this instance this pass */ }
  }
}

/**
 * Ensure a server's files are on local disk before it starts.
 * Returns true when it is safe to launch.
 */
async function ensureServerFiles(uuid, name) {
  if (!backupManager) return true;   // no backup system: preserve old behaviour
  try {
    const result = await backupManager.ensureRestored(uuid, { name });
    if (!result.ok) {
      console.error(`[restore] ${name || uuid}: cannot start — ${result.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[restore] ${name || uuid}: unexpected failure:`, err.message);
    return false;
  }
}

// ═══ 2-minute grace period handling ═══
function setGracePeriod(uuid) {
  clearGracePeriod(uuid);
  const endsAt = Date.now() + 120000;
  gracePeriods[uuid] = { endsAt, timeout: setTimeout(() => {
    console.log(`[queue] Grace period expired for ${uuid}`);
    delete gracePeriods[uuid];
  }, 120000) };
  console.log(`[queue] Grace period set for ${uuid}, expires in 2min`);
}

// ═══ Minekube Connect Auto-Install ═══
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doDownload = (downloadUrl) => {
      const file = fs.createWriteStream(destPath);
      https.get(downloadUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          doDownload(response.headers.location);
        } else {
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };
    doDownload(url);
  });
}

async function setupPurpurServer(instanceUuid) {
  const dataDir = path.join(BASE_DIR, `mcsmanager/daemon/data/InstanceData/${instanceUuid}`);
  const jarPath = path.join(dataDir, 'server.jar');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 1024 * 1024) return;

  const https = require('https');
  const version = '26.1.2';
  const build = '2592';

  console.log(`[purpur] Downloading Purpur ${version} build ${build} for ${instanceUuid}...`);
  const url = `https://api.purpurmc.org/v2/purpur/${version}/${build}/download`;

  try {
    return new Promise((resolve, reject) => {
      const get = (u, redir = 0) => {
        if (redir > 5) return reject(new Error('Too many redirects'));
        const mod = u.startsWith('https') ? https : require('http');
        mod.get(u, { timeout: 120000, headers: { 'User-Agent': 'OmenHosting/1.0' } }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location, redir + 1);
          if (r.statusCode !== 200) { createMinimalFiles(dataDir, version); return resolve(); }
          const f = fs.createWriteStream(jarPath);
          r.pipe(f);
          f.on('finish', () => { f.close(); console.log(`[purpur] OK: ${(fs.statSync(jarPath).size / 1024 / 1024).toFixed(1)}MB`); resolve(); });
          f.on('error', (e) => { fs.unlink(jarPath, () => {}); reject(e); });
        }).on('error', reject);
      };
      get(url);
    });
  } catch (e) {
    console.log(`[purpur] Error: ${e.message}`);
    createMinimalFiles(dataDir, version);
  }
}

function createMinimalFiles(dataDir, version) {
  fs.writeFileSync(path.join(dataDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dataDir, 'server.properties'),
    `server-port=25565\nlevel-name=world\nmotd=OmenHosting Server\nonline-mode=true\ndifficulty=easy\nmax-players=20\n`);
}

async function installMinekubePlugin(instanceUuid) {
  const settings = loadSettings();
  if (!settings.minekubeAutoInstall) return;

  const instanceDir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceData', instanceUuid);
  const pluginsDir = path.join(instanceDir, 'plugins');
  const jarPath = path.join(pluginsDir, 'connect-java-plugin.jar');

  // Already installed and valid (>1MB) - skip
  if (installedPlugins[instanceUuid] && fs.existsSync(jarPath)) {
    const stats = fs.statSync(jarPath);
    if (stats.size > 1000000) return; // >1MB = valid JAR
  }

  try {
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    // Check if valid plugin already exists
    if (fs.existsSync(jarPath)) {
      const existingStats = fs.statSync(jarPath);
      if (existingStats.size > 1000000) {
        console.log(`[minekube] Plugin already installed for ${instanceUuid}`);
        installedPlugins[instanceUuid] = true;
        return;
      }
    }

    console.log(`[minekube] Downloading Connect plugin for ${instanceUuid}...`);
    await downloadFile(MINEKUBE_JAR_URL, jarPath);

    const stats = fs.statSync(jarPath);
    console.log(`[minekube] Plugin installed (${(stats.size / 1024 / 1024).toFixed(1)}MB) at ${jarPath}`);
    installedPlugins[instanceUuid] = true;

    // Generate default config if needed
    const configDir = path.join(instanceDir, 'plugins', 'connect');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const configFile = path.join(configDir, 'config.yml');
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, `# Minekube Connect Configuration
# Auto-generated by OmenHosting
enabled: true
port: 25565
# The connect address will be detected automatically from console output
`);
      console.log(`[minekube] Default config generated at ${configFile}`);
    }

    // Configure server.properties for Connect plugin compatibility
    const serverPropsPath = path.join(instanceDir, 'server.properties');
    if (fs.existsSync(serverPropsPath)) {
      let props = fs.readFileSync(serverPropsPath, 'utf8');
      props = props.replace(/^enforce-secure-profile=.*/m, 'enforce-secure-profile=false');
      if (!/^enforce-secure-profile=/m.test(props)) props += '\nenforce-secure-profile=false';
      props = props.replace(/^online-mode=.*/m, 'online-mode=false');
      fs.writeFileSync(serverPropsPath, props);
    }

    // Configure bukkit.yml for Connect plugin compatibility
    const bukkitYmlPath = path.join(instanceDir, 'bukkit.yml');
    if (fs.existsSync(bukkitYmlPath)) {
      let yml = fs.readFileSync(bukkitYmlPath, 'utf8');
      yml = yml.replace(/^(\s*)connection-throttle:.*/m, '$1connection-throttle: -1');
      if (!/connection-throttle:/.test(yml)) {
        yml = yml.replace(/^settings:/m, 'settings:\n  connection-throttle: -1');
      }
      fs.writeFileSync(bukkitYmlPath, yml);
    }
  } catch (err) {
    console.error(`[minekube] Failed to install plugin:`, err.message);
  }
}

// ═══ Minekube IP Detection from Console Logs ═══
function parseMinekubeAddress(text, instanceUuid) {
  // Find ALL Mineube addresses, use the LAST one (most recent)
  const matches = [...text.matchAll(/([a-zA-Z0-9_-]+\.)*[a-zA-Z0-9_-]+\.play\.minekube\.net/g)];
  if (matches.length === 0) return;

  const addr = matches[matches.length - 1][0];

  // Ensure serverStates entry exists
  if (!serverStates[instanceUuid]) {
    serverStates[instanceUuid] = { lastPlayerCount: -1, lastActivity: Date.now(), emptySince: null, minekubeAddress: null, sleeping: false };
  }

  if (serverStates[instanceUuid].minekubeAddress !== addr) {
    serverStates[instanceUuid].minekubeAddress = addr;
    console.log(`[minekube] Detected address for ${instanceUuid}: ${addr}`);

    // Save to file
    const addrFile = path.join(DATA_DIR, `minekube-${instanceUuid}.json`);
    fs.writeFileSync(addrFile, JSON.stringify({ address: addr, detectedAt: Date.now() }));

    // The address is shown in the panel's own "Server Address" box, which has
    // a copy button — so the instance keeps whatever name its owner chose
    // rather than being renamed to the connection address.
  }
}

// ═══ Signup API ═══
// Creates real MCSManager web panel users (not separate file)
function handleSignup(req, res) {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', async () => {
    try {
      const { username, password } = JSON.parse(body);

      if (!username || !password) {
        return sendJSON(res, 400, { error: 'Username and password required' });
      }
      if (username.length < 3 || username.length > 20) {
        return sendJSON(res, 400, { error: 'Username must be 3-20 characters' });
      }
      if (password.length < 6) {
        return sendJSON(res, 400, { error: 'Password must be at least 6 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return sendJSON(res, 400, { error: 'Username can only contain letters, numbers, and underscores' });
      }

      // Authenticate as admin to use web panel's user creation API
      const loginResp = await webRequest('POST', '/api/auth/login', getAdminCredentials(), '');
      if (loginResp.status !== 200 || !loginResp.data || loginResp.data.status !== 200) {
        return sendJSON(res, 500, { error: 'Admin authentication failed' });
      }
      const adminCookie = loginResp.setCookie;
      const adminToken = loginResp.data.data; // Session token from login response

      // Create user via web panel's admin API (adds to in-memory cache + writes file)
      const createResp = await webRequest('POST', `/api/auth/?token=${adminToken}`, { username, password, permission: 1 }, adminCookie);

      // The panel reports failures two ways: a non-200 HTTP status, or a 200
      // carrying an error envelope. Checking only the former would report a
      // rejected signup as success.
      const created = createResp.data;
      const envelopeFailed = created && typeof created === 'object'
        && created.status !== undefined && created.status !== 200;

      if (createResp.status !== 200 || envelopeFailed) {
        // The panel puts its human-readable reason (e.g. "Username is already
        // taken") in the envelope's `data` field, so surface that instead of a
        // generic message the person signing up can't act on.
        const errMsg =
          (created && typeof created.data === 'string' && created.data)
          || created?.error
          || created?.message
          || 'Failed to create user';
        return sendJSON(res, 409, { error: errMsg });
      }
      console.log(`[signup] New user created: ${username}`);
      sendJSON(res, 200, { success: true, message: 'Account created successfully' });
    } catch (err) {
      console.error('[signup] Error:', err.message);
      sendJSON(res, 500, { error: 'Failed to create account' });
    }
  });
}

// ═══ UI Assets (theme.css + inject.js) ═══
// Served from middleware/public/ with an in-memory cache keyed on mtime, so a
// hot request does no disk I/O and repeat visits get a 304 off the ETag.
const PUBLIC_DIR = path.join(__dirname, 'public');
const assetCache = new Map();

function loadAsset(name) {
  const file = path.join(PUBLIC_DIR, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = assetCache.get(name);
  if (hit && hit.mtime === stat.mtimeMs) return hit;

  const body = fs.readFileSync(file);
  const entry = {
    body,
    mtime: stat.mtimeMs,
    etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"'
  };
  assetCache.set(name, entry);
  return entry;
}

function sendAsset(req, res, name, type) {
  const asset = loadAsset(name);
  if (!asset) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  // Revalidate every load so edits appear immediately, but skip the payload
  // when the browser already has the current version.
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ETag: asset.etag
  };

  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  headers['Content-Length'] = asset.body.length;
  res.writeHead(200, headers);
  res.end(asset.body);
}

// ═══ Create Server ═══
function getNextPort() {
  // Find used ports from instance configs
  const instanceDir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig');
  const usedPorts = new Set();
  try {
    const files = fs.readdirSync(instanceDir).filter(f => f.endsWith('.json') && f !== 'global0001.json');
    for (const file of files) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(instanceDir, file), 'utf8'));
        if (cfg.basePort) usedPorts.add(cfg.basePort);
      } catch {}
    }
  } catch {}
  // Start from 10216, skip used ports
  let port = 10216;
  while (usedPorts.has(port)) port++;
  return port;
}

function handleCreateServer(req, res, body) {
  try {
    const { nickname, userUuid } = JSON.parse(body);
    const name = (nickname || 'minecraft-server').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30) || 'minecraft-server';

    // Per-user limit: check if this user already has an instance
    if (userUuid) {
      const userPath = path.join(BASE_DIR, 'mcsmanager/web/data/User', userUuid + '.json');
      try {
        const userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
        if (userData.permission !== 10 && userData.instances && userData.instances.length > 0) {
          return sendJSON(res, 403, { error: 'You can only create 1 server per account' });
        }
      } catch {}
    } else {
      // Fallback: check all non-admin users (system-wide limit)
      const userDir = path.join(BASE_DIR, 'mcsmanager/web/data/User');
      const userFiles = fs.readdirSync(userDir).filter(f => f.endsWith('.json'));
      for (const f of userFiles) {
        try {
          const userData = JSON.parse(fs.readFileSync(path.join(userDir, f), 'utf8'));
          if (userData.permission !== 10 && userData.instances && userData.instances.length > 0) {
            return sendJSON(res, 403, { error: 'You can only create 1 server per account' });
          }
        } catch {}
      }
    }

    const port = getNextPort();

    const instanceConfig = {
      nickname: name,
      startCommand: '{mcsm_java} -Xms256M -Xmx512M -jar server.jar nogui',
      stopCommand: 'stop',
      stopTimeout: 0,
      ie: 'utf-8',
      oe: 'utf-8',
      type: 'minecraft/java/purpur',
      tag: [],
      endTime: 0,
      fileCode: 'utf8',
      processType: 'general',
      updateCommand: '',
      runAs: '',
      crlf: 1,
      category: 0,
      basePort: port,
      enableRcon: false,
      rconPassword: '',
      rconPort: 0,
      rconIp: '',
      actionCommandList: [],
      terminalOption: { haveColor: false, pty: true, ptyWindowCol: 164, ptyWindowRow: 40 },
      eventTask: { autoStart: false, autoRestart: false, autoRestartMaxTimes: -1, ignore: true },
      java: { id: 'zulu_8' },
      docker: {
        updateCommandImage: '', containerName: null, image: null,
        uploadSpeedLimit: 0, downloadSpeedLimit: 0, ports: null,
        extraVolumes: [], capAdd: [], capDrop: [], devices: [],
        privileged: false, memory: 512, memorySwap: 512, memorySwappiness: null,
        networkMode: 'bridge', networkAliases: [], cpusetCpus: '', cpuUsage: 50,
        maxSpace: 5368709120, io: 0, network: 0, workingDir: null, env: null,
        changeWorkdir: false, labels: [], gpuEnabled: false, gpuCount: -1,
        gpuDeviceIds: [], gpuDriver: 'nvidia', deviceReadBps: [], deviceWriteBps: []
      },
      pingConfig: { ip: '', port: 25565, type: 1 },
      extraServiceConfig: { openFrpTunnelId: '', openFrpToken: '' }
    };

    // Create instance via daemon socket
    let daemonKey = '';
    try {
      const globalConfig = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'mcsmanager/daemon/data/Config/global.json'), 'utf8'));
      daemonKey = globalConfig.key || '';
    } catch {}

    const { io } = require('socket.io-client');
    const socket = io(`http://127.0.0.1:${DAEMON_PORT}`, {
      path: '/socket.io', reconnection: false, timeout: 10000, transports: ['websocket']
    });

    const timeout = setTimeout(() => {
      try { socket.disconnect(); } catch {}
      sendJSON(res, 500, { error: 'Daemon timeout' });
    }, 15000);

    socket.on('connect', () => {
      socket.emit('auth', { uuid: null, data: daemonKey });
    });

    socket.on('auth', (p) => {
      if (p && p.data === true) {
        socket.emit('instance/new', { uuid: null, data: instanceConfig });
      } else {
        clearTimeout(timeout);
        socket.disconnect();
        sendJSON(res, 500, { error: 'Daemon auth failed' });
      }
    });

    socket.on('instance/new', (protocol) => {
      clearTimeout(timeout);
      const result = protocol?.data;
      if (result && result.instanceUuid) {
        console.log(`[create-server] Created instance: ${result.instanceUuid} (${name}) on port ${port}`);
        // Download Purpur 26.1.2
        setupPurpurServer(result.instanceUuid).catch(e => console.error('[purpur] Download error:', e.message));
        // Auto-install Minekube plugin
        installMinekubePlugin(result.instanceUuid).catch(() => {});
        // Auto-assign to the requesting user (or fallback: non-admin with 0 instances)
        try {
          const userDir = path.join(BASE_DIR, 'mcsmanager/web/data/User');
          let targetUuid = userUuid;
          if (!targetUuid) {
            // Fallback: find first non-admin with 0 instances
            const userFiles = fs.readdirSync(userDir).filter(f => f.endsWith('.json'));
            for (const f of userFiles) {
              const u = JSON.parse(fs.readFileSync(path.join(userDir, f), 'utf8'));
              if (!u.instances) u.instances = [];
              if (u.instances.length === 0 && u.permission !== 10) {
                targetUuid = u.uuid;
                break;
              }
            }
          }
          if (targetUuid) {
            const userPath = path.join(userDir, targetUuid + '.json');
            if (fs.existsSync(userPath)) {
              const userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
              if (!userData.instances) userData.instances = [];
              if (userData.instances.length === 0) {
                userData.instances.push({ instanceUuid: result.instanceUuid, daemonId: DAEMON_ID });
                fs.writeFileSync(userPath, JSON.stringify(userData, null, 2));
                console.log(`[create-server] Assigned to: ${userData.userName}`);
                // Sync assignment to web panel's in-memory cache via admin API
                webRequest('POST', '/api/auth/login', getAdminCredentials(), '').then(loginResp => {
                  if (loginResp.status === 200 && loginResp.data?.status === 200) {
                    const cookie = loginResp.setCookie;
                    const token = loginResp.data.data;
                    webRequest('PUT', `/api/auth/?token=${token}`, { uuid: targetUuid, config: { instances: userData.instances } }, cookie).catch(() => {});
                  }
                }).catch(() => {});
              }
            }
          }
        } catch (e) { console.error('[create-server] Assign error:', e.message); }
        sendJSON(res, 200, { success: true, uuid: result.instanceUuid, port, nickname: name });
      } else {
        sendJSON(res, 500, { error: 'Failed to create instance', details: result });
      }
      socket.disconnect();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      sendJSON(res, 500, { error: 'Daemon connection failed: ' + err.message });
    });

  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
}

function handleGetInstances(req, res) {
  const instanceDir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig');
  const instances = [];
  try {
    const files = fs.readdirSync(instanceDir).filter(f => f.endsWith('.json') && f !== 'global0001.json');
    for (const file of files) {
      try {
        const uuid = file.replace('.json', '');
        const cfg = JSON.parse(fs.readFileSync(path.join(instanceDir, file), 'utf8'));
        const state = serverStates[uuid] || {};
        instances.push({
          uuid,
          nickname: cfg.nickname,
          type: cfg.type,
          port: cfg.basePort,
          minekubeAddress: state.minekubeAddress || null,
          sleeping: state.sleeping || false,
          playerCount: state.lastPlayerCount || -1
        });
      } catch {}
    }
  } catch {}
  sendJSON(res, 200, instances);
}

// ═══ HTTP Server ═══
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Signup API
  if (url.pathname === '/api/omen/signup' && req.method === 'POST') {
    return handleSignup(req, res);
  }

  // Diagnostic: echo how this request's client IP is being resolved.
  //
  // The panel bans an IP after repeated failed logins, so if X-Real-IP
  // collapses to one shared address every visitor shares a ban. The correct
  // entry to pick out of X-Forwarded-For depends on how many proxies the
  // hosting platform puts in front of us, which is not knowable from here —
  // this reports the raw chain so it can be determined from evidence.
  //
  // Only reflects the caller's own headers; it exposes nothing about anyone else.
  if (url.pathname === '/api/omen/debug/ip' && req.method === 'GET') {
    const xff = req.headers['x-forwarded-for'] || null;
    return sendJSON(res, 200, {
      xForwardedFor: xff,
      xForwardedForParts: xff ? String(xff).split(',').map((s) => s.trim()) : [],
      xRealIp: req.headers['x-real-ip'] || null,   // what the router computed
      forwarded: req.headers['forwarded'] || null,
      socketRemoteAddress: req.socket.remoteAddress || null
    });
  }

  // Check if username exists (in MCSManager users)
  if (url.pathname === '/api/omen/check-user' && req.method === 'GET') {
    const username = url.searchParams.get('username');
    const userDir = path.join(BASE_DIR, 'mcsmanager/web/data/User');
    let exists = false;
    try {
      const files = fs.readdirSync(userDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const u = JSON.parse(fs.readFileSync(path.join(userDir, f), 'utf8'));
        if (u.userName && u.userName.toLowerCase() === (username || '').toLowerCase()) { exists = true; break; }
      }
    } catch {}
    return sendJSON(res, 200, { exists });
  }

  // Get current user UUID from session
  if (url.pathname === '/api/omen/whoami' && req.method === 'GET') {
    const cookie = req.headers['cookie'] || '';
    webRequest('GET', '/api/auth/', null, cookie).then(({ data: resp }) => {
      const userData = resp?.data;
      if (userData && userData.uuid) {
        sendJSON(res, 200, { uuid: userData.uuid, userName: userData.userName, permission: userData.permission, instances: userData.instances || [] });
      } else {
        sendJSON(res, 200, { uuid: null, userName: null, instances: [] });
      }
    }).catch(() => sendJSON(res, 200, { uuid: null, userName: null, instances: [] }));
    return;
  }

  // Get Minekube address for instance
  if (url.pathname.startsWith('/api/omen/minekube/')) {
    const uuid = url.pathname.split('/').pop();
    const state = serverStates[uuid] || {};
    const addrFile = path.join(DATA_DIR, `minekube-${uuid}.json`);
    let address = state.minekubeAddress;
    if (!address && fs.existsSync(addrFile)) {
      try { address = JSON.parse(fs.readFileSync(addrFile, 'utf8')).address; } catch {}
    }
    return sendJSON(res, 200, { address: address || null });
  }

  // Check auto-sleep status
  if (url.pathname.startsWith('/api/omen/autosleep/')) {
    const uuid = url.pathname.split('/').pop();
    const markerFile = path.join(DATA_DIR, `autosleep-${uuid}.json`);
    let sleeping = false;
    if (fs.existsSync(markerFile)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        sleeping = true;
      } catch {}
    }
    return sendJSON(res, 200, { sleeping });
  }

  // Get settings
  if (url.pathname === '/api/omen/settings' && req.method === 'GET') {
    return sendJSON(res, 200, loadSettings());
  }

  // Update settings
  if (url.pathname === '/api/omen/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const settings = loadSettings();
        const updates = JSON.parse(body);
        Object.assign(settings, updates);
        saveSettings(settings);

        // Apply the backup toggle immediately rather than at the next restart.
        // Retention is read per-run, so it needs no wiring here.
        if (updates.backupEnabled !== undefined) {
          if (backupManager) {
            backupManager.enabled = updates.backupEnabled !== false;
            console.log(`[backup] ${backupManager.enabled ? 'Enabled' : 'Disabled'} via settings`);
          } else if (updates.backupEnabled) {
            initBackupSystem();   // was off at startup; bring it up now
          }
        }

        sendJSON(res, 200, { success: true });
      } catch { sendJSON(res, 400, { error: 'Invalid request' }); }
    });
    return;
  }

  // Get all server statuses
  // ─── Resource usage (CPU / RAM / storage) ───────────────────────
  // Feeds the extra rows added to the panel's "Basic Infomation" card. The
  // daemon only exposes this over a live terminal session, so it is read
  // directly from the OS here instead.
  if (url.pathname === '/api/omen/instance-stats' && req.method === 'GET') {
    const uuid = url.searchParams.get('uuid') || '';
    const cfgPath = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig', uuid + '.json');
    if (!/^[a-zA-Z0-9-]+$/.test(uuid) || !fs.existsSync(cfgPath)) {
      return sendJSON(res, 404, { error: 'Unknown instance' });
    }

    // Each instance already carries its own storage quota (set at creation,
    // see handleCreateServer); read it so the panel can show a real
    // percentage instead of a bare byte count with nothing to compare it to.
    const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5GB, matches the plan default
    let quotaBytes = DEFAULT_QUOTA_BYTES;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.docker && cfg.docker.maxSpace) quotaBytes = Number(cfg.docker.maxSpace);
    } catch { /* fall back to the default above */ }

    getInstanceStats(path.join(INSTANCE_DATA_DIR, uuid))
      .then((stats) => sendJSON(res, 200, { ...stats, quotaBytes }))
      .catch((err) => {
        console.error('[stats] Failed for', uuid, ':', err.message);
        sendJSON(res, 500, { error: 'Could not read resource usage' });
      });
    return;
  }

  // ─── Modpack installer & plugin manager ─────────────────────────
  // Backed by Modrinth's public API. Installs land in the instance's own
  // directory, and every remote-supplied path is checked before it is written.

  /** Resolve the instance directory for a uuid, or null if it is unknown. */
  const instanceDirFor = (uuid) => {
    if (!uuid || !/^[a-zA-Z0-9-]+$/.test(uuid)) return null;
    const cfg = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig', uuid + '.json');
    if (!fs.existsSync(cfg)) return null;
    return path.join(INSTANCE_DATA_DIR, uuid);
  };

  // Search plugins / mods / modpacks.
  if (url.pathname === '/api/omen/mods/search' && req.method === 'GET') {
    const type = url.searchParams.get('type') || 'plugin';
    if (!['plugin', 'mod', 'modpack'].includes(type)) {
      return sendJSON(res, 400, { error: 'type must be plugin, mod or modpack' });
    }
    modrinth.search({
      type,
      query: url.searchParams.get('q') || '',
      gameVersion: url.searchParams.get('gameVersion') || undefined,
      limit: parseInt(url.searchParams.get('limit'), 10) || 20
    })
      .then((results) => sendJSON(res, 200, { results }))
      .catch((err) => {
        console.error('[mods] Search failed:', err.message);
        sendJSON(res, 502, { error: err.message });
      });
    return;
  }

  // Versions available for a project.
  if (url.pathname === '/api/omen/mods/versions' && req.method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) return sendJSON(res, 400, { error: 'projectId is required' });
    modrinth.versions(projectId, {
      loader: url.searchParams.get('loader') || undefined,
      gameVersion: url.searchParams.get('gameVersion') || undefined
    })
      .then((list) => sendJSON(res, 200, { versions: list }))
      .catch((err) => sendJSON(res, 502, { error: err.message }));
    return;
  }

  // What is installed right now.
  if (url.pathname === '/api/omen/mods/installed' && req.method === 'GET') {
    const dir = instanceDirFor(url.searchParams.get('uuid'));
    if (!dir) return sendJSON(res, 404, { error: 'Unknown instance' });
    try {
      return sendJSON(res, 200, modrinth.listInstalled(dir));
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // Install a plugin/mod jar, or a whole modpack.
  if (url.pathname === '/api/omen/mods/install' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid request' }); }

      const { uuid, versionId, type } = payload;
      const dir = instanceDirFor(uuid);
      if (!dir) return sendJSON(res, 404, { error: 'Unknown instance' });
      if (!versionId) return sendJSON(res, 400, { error: 'versionId is required' });

      // A modpack rewrites large parts of the directory; doing that under a
      // live server would corrupt whatever it is holding open.
      if (type === 'modpack' && await isInstanceRunning(uuid)) {
        return sendJSON(res, 409, { error: 'Stop the server before installing a modpack' });
      }
      if (backupManager && backupManager.isBusy(uuid)) {
        return sendJSON(res, 409, { error: 'A backup or restore is running for this server' });
      }

      try {
        fs.mkdirSync(dir, { recursive: true });
        if (type === 'modpack') {
          const result = await modrinth.installModpack({
            serverDir: dir,
            versionId,
            workDir: path.join(DATA_DIR, 'mod-work'),
            onProgress: (stage, done, total) => {
              modInstallState[uuid] = { stage, done, total, at: Date.now() };
            }
          });
          delete modInstallState[uuid];
          console.log(`[mods] Installed modpack "${result.name}" (${result.files} files) into ${uuid}`);
          return sendJSON(res, 200, { success: true, ...result });
        }

        const result = await modrinth.installJar({ serverDir: dir, versionId, type: type === 'mod' ? 'mod' : 'plugin' });
        console.log(`[mods] Installed ${result.folder}/${result.installed} into ${uuid}`);
        return sendJSON(res, 200, { success: true, ...result });
      } catch (err) {
        delete modInstallState[uuid];
        console.error('[mods] Install failed:', err.message);
        return sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // Progress for a long-running modpack install.
  if (url.pathname === '/api/omen/mods/progress' && req.method === 'GET') {
    const uuid = url.searchParams.get('uuid') || '';
    return sendJSON(res, 200, modInstallState[uuid] || { stage: null });
  }

  // Remove or enable/disable an installed jar.
  if (url.pathname === '/api/omen/mods/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const { uuid, folder, filename } = JSON.parse(body);
        const dir = instanceDirFor(uuid);
        if (!dir) return sendJSON(res, 404, { error: 'Unknown instance' });
        sendJSON(res, 200, modrinth.removeJar(dir, folder, filename));
      } catch (err) { sendJSON(res, 400, { error: err.message }); }
    });
    return;
  }

  if (url.pathname === '/api/omen/mods/toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const { uuid, folder, filename } = JSON.parse(body);
        const dir = instanceDirFor(uuid);
        if (!dir) return sendJSON(res, 404, { error: 'Unknown instance' });
        sendJSON(res, 200, modrinth.toggleJar(dir, folder, filename));
      } catch (err) { sendJSON(res, 400, { error: err.message }); }
    });
    return;
  }

  // ─── Backup & restore ───────────────────────────────────────────

  // Live backup/restore progress for every server, polled by the panel UI.
  if (url.pathname === '/api/omen/backup/status' && req.method === 'GET') {
    if (!backupManager) return sendJSON(res, 200, { enabled: false, states: {} });
    return sendJSON(res, 200, {
      enabled: true,
      provider: backupManager.providerKind,
      states: backupManager.getAllStates()
    });
  }

  // Backup/restore audit log. ?uuid= filters to one server.
  if (url.pathname === '/api/omen/backup/history' && req.method === 'GET') {
    if (!backupManager) return sendJSON(res, 200, { enabled: false, records: [] });
    const uuid = url.searchParams.get('uuid') || undefined;
    const limit = Math.min(200, parseInt(url.searchParams.get('limit'), 10) || 50);
    return sendJSON(res, 200, {
      enabled: true,
      records: backupManager.history.read({ uuid, limit })
    });
  }

  // Consulted by the router before it forwards a start request to the panel.
  // Answers "are this server's files on disk?" and, when they are not, kicks
  // off a restore that launches the server as soon as it finishes — so a start
  // issued from anywhere in the panel still gets its files back automatically.
  if (url.pathname === '/api/omen/prestart' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      // Fail open: if backups are not configured, starts behave exactly as
      // they did before this feature existed.
      if (!backupManager) return sendJSON(res, 200, { ready: true });

      let uuids = [];
      try {
        const parsed = JSON.parse(body);
        uuids = Array.isArray(parsed.uuids) ? parsed.uuids.filter(Boolean) : [];
      } catch { return sendJSON(res, 200, { ready: true }); }

      if (!uuids.length) return sendJSON(res, 200, { ready: true });

      const restoring = [];
      for (const uuid of uuids) {
        if (backupManager.hasLocalFiles(uuid)) continue;

        if (backupManager.isBusy(uuid)) {
          restoring.push(uuid);
          continue;
        }

        let name = uuid;
        try {
          const cfg = JSON.parse(fs.readFileSync(
            path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceConfig', uuid + '.json'), 'utf8'));
          name = cfg.nickname || uuid;
        } catch {}

        // Detached: restoring a large world takes minutes and the panel's
        // request must not hang on it. The panel polls backup/status for
        // progress, and the server starts by itself when the restore lands.
        restoring.push(uuid);
        (async () => {
          const result = await backupManager.ensureRestored(uuid, { name });
          if (!result.ok) {
            console.error(`[restore] ${name}: not starting — ${result.error}`);
            return;
          }
          if (!result.restored) {
            console.log(`[restore] ${name}: nothing to restore, launching`);
          }
          try {
            await launchInstance(uuid);
            console.log(`[restore] ${name}: started after restore`);
            backupManager.setState(uuid, BACKUP_STATE.IDLE, { progress: 0, message: '' });
          } catch (err) {
            // The files are safely back; only the launch failed. Surface that
            // instead of leaving the panel stuck on "Starting" forever.
            console.error(`[restore] ${name}: restored but failed to start:`, err.message);
            backupManager.setState(uuid, BACKUP_STATE.FAILED, {
              progress: 0,
              message: `Files restored, but the server failed to start: ${err.message}`,
              error: err.message,
              retryable: false,
              failedAt: Date.now()
            });
          }
        })().catch((err) => console.error(`[restore] ${name}: unexpected failure:`, err.message));
      }

      if (!restoring.length) return sendJSON(res, 200, { ready: true });
      sendJSON(res, 200, { ready: false, restoring });
    });
    return;
  }

  // Manual backup. Returns immediately; progress is polled from /status.
  if (url.pathname === '/api/omen/backup/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      if (!backupManager) return sendJSON(res, 503, { error: 'Backups are not configured' });
      try {
        const { uuid, name } = JSON.parse(body);
        if (!uuid) return sendJSON(res, 400, { error: 'uuid is required' });
        if (backupManager.isBusy(uuid)) return sendJSON(res, 409, { error: 'A backup or restore is already running' });
        scheduleBackup(uuid, name || uuid);
        sendJSON(res, 202, { started: true });
      } catch { sendJSON(res, 400, { error: 'Invalid request' }); }
    });
    return;
  }

  // Retry a failed upload, reusing the archive that was kept on disk.
  if (url.pathname === '/api/omen/backup/retry' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      if (!backupManager) return sendJSON(res, 503, { error: 'Backups are not configured' });
      try {
        const { uuid, name } = JSON.parse(body);
        if (!uuid) return sendJSON(res, 400, { error: 'uuid is required' });
        if (backupManager.isBusy(uuid)) return sendJSON(res, 409, { error: 'A backup or restore is already running' });
        backupManager.retryBackup(uuid, { name: name || uuid })
          .catch((err) => console.error('[backup] Retry failed:', err.message));
        sendJSON(res, 202, { started: true });
      } catch { sendJSON(res, 400, { error: 'Invalid request' }); }
    });
    return;
  }

  if (url.pathname === '/api/omen/status') {
    const statuses = {};
    for (const [uuid, state] of Object.entries(serverStates)) {
      statuses[uuid] = {
        playerCount: state.lastPlayerCount,
        minekubeAddress: state.minekubeAddress,
        sleeping: state.sleeping,
        emptySince: state.emptySince
    };
  }

  // Also include addresses from files for instances not yet in memory
    try {
      const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('minekube-') && f.endsWith('.json'));
      for (const file of dataFiles) {
        const uuid = file.replace('minekube-', '').replace('.json', '');
        if (!statuses[uuid] || !statuses[uuid].minekubeAddress) {
          try {
            const addrData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
            if (!statuses[uuid]) statuses[uuid] = {};
            statuses[uuid].minekubeAddress = addrData.address;
          } catch {}
        }
      }
    } catch {}
    return sendJSON(res, 200, statuses);
  }

  // Install Minekube plugin for an instance
  if (url.pathname.startsWith('/api/omen/install-minekube/') && req.method === 'POST') {
    const uuid = url.pathname.split('/').pop();
    installMinekubePlugin(uuid).then(() => {
      sendJSON(res, 200, { success: true });
    }).catch(err => {
      sendJSON(res, 500, { error: err.message });
    });
    return;
  }

  // Create new Minecraft server
  if (url.pathname === '/api/omen/create-server' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      handleCreateServer(req, res, body);
    });
    return;
  }

  // Get list of instances
  if (url.pathname === '/api/omen/instances' && req.method === 'GET') {
    handleGetInstances(req, res);
    return;
  }

  // Queue: get count
  if (url.pathname === '/api/omen/queue/count' && req.method === 'GET') {
    return sendJSON(res, 200, { running: runningCount, max: MAX_RUNNING, queued: queue.length });
  }

  // Queue: get position
  if (url.pathname === '/api/omen/queue/position' && req.method === 'GET') {
    // `url` is already a URL instance; it has searchParams, not the legacy
    // `.query` of url.parse(). Reading `.query` made this always return null.
    const uuid = url.searchParams.get('uuid') || '';
    const idx = queue.findIndex(e => e.uuid === uuid);
    return sendJSON(res, 200, { position: idx === -1 ? null : idx + 1, running: runningCount, max: MAX_RUNNING });
  }

  // Queue: join
  if (url.pathname === '/api/omen/queue/join' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const { uuid, name } = JSON.parse(body);
        if (!uuid) return sendJSON(res, 400, { error: 'uuid required' });
        // Check grace period
        if (gracePeriods[uuid]) {
          clearGracePeriod(uuid);
          return sendJSON(res, 200, { position: 0, grace: true, message: 'Grace period active, starting immediately' });
        }
        // Check if already in queue
        if (queue.find(e => e.uuid === uuid)) {
          const idx = queue.findIndex(e => e.uuid === uuid);
          return sendJSON(res, 200, { position: idx + 1, running: runningCount, max: MAX_RUNNING });
        }
        // Check if slot available. The slot is reserved up front so two
        // simultaneous joins can't both claim it, then released if the start
        // fails — otherwise a failed start leaves the slot occupied by a
        // phantom server and every later user queues behind it forever.
        if (runningCount < MAX_RUNNING) {
          runningCount++;
          pendingStarts++;
          console.log(`[queue] Direct start for ${name || uuid} (${runningCount}/${MAX_RUNNING})`);
          startInstance(uuid)
            .then(() => { pendingStarts--; })
            .catch((e) => {
              pendingStarts--;
              if (runningCount > 0) runningCount--;
              console.error(`[queue] Start failed for ${name || uuid}, slot released (${runningCount}/${MAX_RUNNING}):`, e.message);
              queueStartNext();
            });
          return sendJSON(res, 200, { position: 0, running: runningCount, max: MAX_RUNNING });
        }
        // Queue
        queue.push({ uuid, name: name || uuid, joinedAt: Date.now() });
        const pos = queue.length;
        console.log(`[queue] ${name || uuid} joined queue at #${pos} (${runningCount}/${MAX_RUNNING})`);
        sendJSON(res, 200, { position: pos, running: runningCount, max: MAX_RUNNING });
      } catch { sendJSON(res, 400, { error: 'Invalid request' }); }
    });
    return;
  }

  // Queue: leave
  if (url.pathname === '/api/omen/queue/leave' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      try {
        const { uuid } = JSON.parse(body);
        removeFromQueue(uuid);
        sendJSON(res, 200, { success: true });
      } catch { sendJSON(res, 400, { error: 'Invalid request' }); }
    });
    return;
  }

  // Panel skin + enhancement script
  if (url.pathname === '/api/omen/inject.js') {
    return sendAsset(req, res, 'inject.js', 'application/javascript; charset=utf-8');
  }

  if (url.pathname === '/api/omen/theme.css') {
    return sendAsset(req, res, 'theme.css', 'text/css; charset=utf-8');
  }

  sendJSON(res, 404, { error: 'Not found' });
});

// ═══ Console Log Monitor (watches daemon logs for Minekube addresses) ═══
function startLogMonitor() {
  const logDir = path.join(BASE_DIR, 'mcsmanager/daemon/data/InstanceLog');
  if (!fs.existsSync(logDir)) {
    console.log('[minekube] Log directory not found:', logDir);
    return;
  }

  console.log('[minekube] Starting log monitor for:', logDir);
  const watchedFiles = {};  // uuid -> { mtime, readPos }

  setInterval(() => {
    try {
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      for (const file of files) {
        const uuid = file.replace('.log', '');
        const filePath = path.join(logDir, file);
        const stat = fs.statSync(filePath);

        const prev = watchedFiles[uuid];

        // First time seeing this file - read last 64KB for Mineube address, then skip old data
        if (!prev) {
          const readSize = Math.min(65536, stat.size);
          if (readSize > 0) {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
            fs.closeSync(fd);
            parseMinekubeAddress(buffer.toString('utf8'), uuid);
          }
          watchedFiles[uuid] = { mtime: stat.mtimeMs, readPos: stat.size };
          continue;
        }

        // Only read if file changed
        if (stat.mtimeMs > prev.mtime) {
          const startRead = Math.max(0, prev.readPos);
          const readSize = stat.size - startRead;

          if (readSize > 0) {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, startRead);
            fs.closeSync(fd);

            const text = buffer.toString('utf8');
            parseMinekubeAddress(text, uuid);

            // When server starts fresh, reset player tracking
            if (text.includes('Done') && text.includes('For help')) {
              // Clear grace period on manual start
              clearGracePeriod(uuid);
              // Increment running count
              const was = runningCount;
              runningCount = Math.min(runningCount + 1, MAX_RUNNING);
              if (was !== runningCount) console.log(`[queue] Server started, running: ${runningCount}/${MAX_RUNNING}`);
              if (!logPlayerActivity[uuid]) logPlayerActivity[uuid] = { onlinePlayers: new Set() };
              logPlayerActivity[uuid].onlinePlayers.clear();
              installMinekubePlugin(uuid);
            }

            detectPlayerActivity(text, uuid);
          }

          watchedFiles[uuid] = { mtime: stat.mtimeMs, readPos: stat.size };
        }
      }
    } catch (err) {
      console.error('[mineube] Log monitor error:', err.message);
    }
  }, 5000);
}

// ═══ Start ═══
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[omen] Middleware service running on port ${PORT}`);
  console.log(`[omen] Auto-sleep: enabled (3 min timeout)`);
  console.log(`[omen] Minekube Connect: auto-install enabled`);
  console.log(`[omen] Queue: max ${MAX_RUNNING} running servers`);
});

// Start monitoring
setInterval(checkAutoSleep, 30000);  // Check every 30 seconds
// Reconcile the slot count against reality so the queue recovers on its own
// if accounting ever drifts, instead of wedging until a manual restart.
setInterval(refreshRunningCount, 60000);
startLogMonitor();
refreshRunningCount();

// Bring up cloud backups, then watch for servers stopping by any route
// (panel Stop button, crash, auto-sleep) so backups stay automatic.
initBackupSystem().then(() => {
  if (backupManager) setInterval(pollForStoppedServers, 15000);
});

console.log('[omen] OmenHosting middleware started');
