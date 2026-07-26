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

  if (cfg.reverseProxyMode === true && cfg.reverseProxyHeader === 'X-Real-IP') return;

  cfg.reverseProxyMode = true;
  cfg.reverseProxyHeader = 'X-Real-IP';

  try {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4));
    console.log('[bootstrap] Enabled reverse-proxy mode (X-Real-IP) so login bans apply per visitor, not globally.');
  } catch (err) {
    console.error('[bootstrap] Failed to write panel SystemConfig:', err.message);
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
  if (existing.length > 0) return;

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

function bootstrap() {
  ensureReverseProxyConfig();
  bootstrapAdminIfNeeded();
}

if (require.main === module) {
  bootstrap();
} else {
  module.exports = bootstrap;
}
