#!/usr/bin/env node
/**
 * Creates the initial MCSManager admin account when none exists yet.
 *
 * A fresh deploy ships with no accounts (mcsmanager/web/data/User is
 * gitignored, correctly, since it holds real credentials), but the signup
 * flow authenticates as `admin` against the web panel's own login API
 * before it can create anyone else's account — which fails with nobody to
 * log in as. MCSManager itself has no unauthenticated first-run bootstrap.
 *
 * This must run BEFORE mcsm-web starts: MCSManager loads its user list into
 * memory once at its own boot and never re-reads the directory afterward,
 * so creating this file while mcsm-web is already running would leave it
 * invisible until the next restart.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = path.resolve(__dirname, '..');

/**
 * Every request reaches the web panel through the local router, so without
 * reverse-proxy mode Koa resolves `ctx.ip` to 127.0.0.1 for *every* visitor.
 * MCSManager bans an IP for 10 minutes after 10 failed logins (loginCheckIp
 * defaults to true), so a shared 127.0.0.1 means any handful of failed
 * logins — including the middleware's own admin-auth retries — locks the
 * entire panel out for everyone, surfacing as "Unable to retrieve identity
 * data, may be banned or network issue".
 *
 * Turning on reverseProxyMode makes Koa read the real client IP from the
 * X-Real-IP header that web/index.js sets, so the ban applies per visitor
 * as intended instead of globally. The panel's data/ directory is
 * gitignored (it holds real credentials), so this can't ship as a committed
 * config file and has to be applied before the web panel boots.
 */
function ensureReverseProxyConfig() {
  const cfgDir = path.join(BASE_DIR, 'mcsmanager/web/data/SystemConfig');
  const cfgPath = path.join(cfgDir, 'config.json');

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* fresh install */ }

  const needsUpdate = cfg.reverseProxyMode !== true
    || cfg.reverseProxyHeader !== 'X-Real-IP'
    || cfg.loginCheckIp !== false;

  if (!needsUpdate) return;

  cfg.reverseProxyMode = true;
  cfg.reverseProxyHeader = 'X-Real-IP';
  cfg.loginCheckIp = false;

  try {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4));
    console.log('[bootstrap] SystemConfig: reverseProxyMode + loginCheckIp=false — brute-force IP ban disabled (panel is behind Replit proxy, ban logic causes false positives).');
  } catch (err) {
    console.error('[bootstrap] Failed to write panel SystemConfig:', err.message);
  }
}

/**
 * The account is only ever *created* when no users exist, so rotating
 * OMEN_ADMIN_PASSWORD afterwards used to do nothing at all — the secret
 * changed, the stored hash didn't, and the new value silently never took
 * effect. The env var is the configured source of truth for this deployment,
 * so bring the stored hash back in line with it when they diverge.
 *
 * Only the admin account named by OMEN_ADMIN_USERNAME is touched; every other
 * user's credentials are left alone. Note this means a password changed
 * through the panel UI is reset on the next boot — the secret wins by design.
 */
function reconcileAdminPassword(userDir, username, password, files) {
  let bcrypt;
  try {
    bcrypt = require(path.join(BASE_DIR, 'mcsmanager/web/node_modules/bcryptjs'));
  } catch (err) {
    console.error('[bootstrap] Cannot verify admin password (bcryptjs unavailable):', err.message);
    return;
  }

  for (const file of files) {
    const userPath = path.join(userDir, file);
    let user;
    try { user = JSON.parse(fs.readFileSync(userPath, 'utf8')); } catch { continue; }
    if (user.userName !== username || user.permission !== 10) continue;

    let matches = false;
    try { matches = bcrypt.compareSync(password, user.passWord || ''); } catch { /* legacy/!bcrypt hash */ }
    if (matches) return;

    user.passWord = bcrypt.hashSync(password, 10);
    user.passWordType = 1;
    try {
      fs.writeFileSync(userPath, JSON.stringify(user, null, 4));
      console.log(`[bootstrap] Admin "${username}" password re-synced from OMEN_ADMIN_PASSWORD.`);
    } catch (err) {
      console.error('[bootstrap] Failed to update admin password:', err.message);
    }
    return;
  }
}

function bootstrapAdminIfNeeded() {
  const userDir = path.join(BASE_DIR, 'mcsmanager/web/data/User');
  const username = process.env.OMEN_ADMIN_USERNAME || 'admin';
  const password = process.env.OMEN_ADMIN_PASSWORD || '';

  if (!password) {
    console.log('[bootstrap] OMEN_ADMIN_PASSWORD not set — skipping admin account creation.');
    return;
  }

  fs.mkdirSync(userDir, { recursive: true });
  const existing = fs.readdirSync(userDir).filter((f) => f.endsWith('.json'));
  if (existing.length > 0) return reconcileAdminPassword(userDir, username, password, existing);

  try {
    const bcrypt = require(path.join(BASE_DIR, 'mcsmanager/web/node_modules/bcryptjs'));
    const uuid = crypto.randomUUID().replace(/-/g, '');
    const user = {
      uuid,
      userName: username,
      passWord: bcrypt.hashSync(password, 10),
      passWordType: 1,
      salt: '',
      permission: 10,
      registerTime: new Date().toLocaleString(),
      loginTime: '',
      instances: [],
      apiKey: '',
      isInit: false,
      secret: '',
      open2FA: false,
      ssoSub: '',
      ssoBound: false
    };
    fs.writeFileSync(path.join(userDir, uuid + '.json'), JSON.stringify(user, null, 4));
    console.log(`[bootstrap] Created initial admin account "${username}" (uuid=${uuid}).`);
  } catch (err) {
    console.error('[bootstrap] Failed to create initial admin account:', err.message);
  }
}

/**
 * The web panel derives both its session cookie's *name* and its signing key
 * from data/.session-key, generating a fresh random one whenever that file is
 * absent. That directory is gitignored and, on an ephemeral filesystem, wiped
 * on every deploy — so each release silently invalidates every existing
 * login. The browser keeps sending a cookie the server no longer recognises,
 * the identity lookup 403s, and the panel reports "Unable to retrieve
 * identity data, may be banned or network issue".
 *
 * Pinning the key to a secret makes sessions survive redeploys. Without one
 * the panel still works, but everyone is logged out by every deploy.
 */
function ensureStableSessionKey() {
  const keyFile = path.join(BASE_DIR, 'mcsmanager/web/data/.session-key');
  const fromEnv = (process.env.OMEN_SESSION_KEY || '').trim();

  let current = '';
  try { current = fs.readFileSync(keyFile, 'utf8').trim(); } catch { /* not created yet */ }

  try {
    if (fromEnv) {
      if (current === fromEnv) return;
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, fromEnv);
      console.log('[bootstrap] Session key pinned from OMEN_SESSION_KEY — logins now survive redeploys.');
      return;
    }

    if (current) return;   // persistent disk kept the previous key; leave it alone

    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomUUID());
    console.warn('[bootstrap] OMEN_SESSION_KEY is not set, so a throwaway session key was generated.');
    console.warn('[bootstrap] Every deploy will log all users out until that secret is set to a fixed random string.');
  } catch (err) {
    console.error('[bootstrap] Could not pin the session key:', err.message);
  }
}

/**
 * The web panel auto-discovers the daemon by reading global.json, but assigns
 * it a *random* UUID.  The middleware hardcodes a different fixed UUID when it
 * creates instances and writes them into the user's instance list.  Because
 * getInstancesByUuid looks up the daemon by that stored daemonId, a mismatch
 * means the panel can never find the daemon → status stays -1 ("Under
 * Maintenance") for every instance.
 *
 * Fix: pre-create a RemoteServiceConfig entry with a deterministic UUID *and*
 * the correct daemon key/port before the web panel boots.  The panel's
 * initialize() finds it, loads it, and connects — skipping the random-UUID
 * auto-discovery path entirely.  The middleware reads the same file at runtime
 * to obtain the daemon UUID, so both sides agree.
 */
const DAEMON_UUID = 'omen-daemon-local';

function ensureDaemonRemoteConfig() {
  const rcDir = path.join(BASE_DIR, 'mcsmanager/web/data/RemoteServiceConfig');
  const rcPath = path.join(rcDir, DAEMON_UUID + '.json');
  if (fs.existsSync(rcPath)) return;   // already bootstrapped

  // Read the daemon's actual key + port from global.json
  const globalPath = path.join(BASE_DIR, 'mcsmanager/daemon/data/Config/global.json');
  let daemonKey = '', daemonPort = 24444;
  try {
    const g = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    daemonKey = g.key || '';
    daemonPort = g.port || 24444;
  } catch {
    console.warn('[bootstrap] Could not read daemon global.json — RemoteServiceConfig may need manual setup.');
    return;
  }

  try {
    fs.mkdirSync(rcDir, { recursive: true });
    fs.writeFileSync(rcPath, JSON.stringify({
      ip: 'localhost',
      port: daemonPort,
      prefix: '',
      remarks: 'Local Daemon',
      apiKey: daemonKey,
      remoteMappings: [],
      connectOpts: {
        multiplex: false,
        reconnectionDelayMax: 5000,
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 10,
        rejectUnauthorized: false
      }
    }, null, 4));
    console.log(`[bootstrap] Pre-created RemoteServiceConfig (uuid=${DAEMON_UUID}, port=${daemonPort}) — panel and middleware will agree on daemon identity.`);
  } catch (err) {
    console.error('[bootstrap] Failed to write RemoteServiceConfig:', err.message);
  }
}

function bootstrap() {
  ensureStableSessionKey();
  ensureReverseProxyConfig();
  ensureDaemonRemoteConfig();
  bootstrapAdminIfNeeded();
}

if (require.main === module) {
  bootstrap();
} else {
  module.exports = bootstrap;
}
