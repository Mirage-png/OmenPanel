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

if (require.main === module) {
  bootstrapAdminIfNeeded();
} else {
  module.exports = bootstrapAdminIfNeeded;
}
