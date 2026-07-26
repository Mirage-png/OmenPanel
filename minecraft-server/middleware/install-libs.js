#!/usr/bin/env node
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLATFORM = os.platform();
const ARCH = os.arch();

const SYS_TAG = `${PLATFORM}_${ARCH}`;
const IS_WIN = PLATFORM === 'win32';

const BINARIES = [
  {
    name: 'pty',
    file: `pty_${SYS_TAG}${IS_WIN ? '.exe' : ''}`,
    url: `https://github.com/MCSManager/PTY/releases/download/latest/pty_${SYS_TAG}`,
  },
  {
    name: 'file_zip',
    file: `file_zip_${SYS_TAG}${IS_WIN ? '.exe' : ''}`,
    url: `https://github.com/MCSManager/Zip-Tools/releases/download/v1.0.2/file_zip_${SYS_TAG}`,
  },
  {
    name: '7z',
    file: `7z_${SYS_TAG}${IS_WIN ? '.exe' : ''}`,
    url: `https://github.com/MCSManager/Zip-Tools/releases/download/v1.0.2/7z_${SYS_TAG}`,
  },
];

const TARGET_DIRS = [
  path.resolve(__dirname, '..', 'mcsmanager', 'daemon', 'lib'),
  path.resolve(__dirname, '..', 'mcsmanager', 'web', 'lib'),
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'OmenPanel/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function ensureLibs() {
  const results = [];
  for (const bin of BINARIES) {
    for (const dir of TARGET_DIRS) {
      const dest = path.join(dir, bin.file);
      if (fs.existsSync(dest)) {
        try {
          fs.accessSync(dest, fs.constants.X_OK);
          results.push(`  [OK]   ${bin.file} (exists at ${dir})`);
          continue;
        } catch {
          fs.chmodSync(dest, 0o755);
          results.push(`  [FIX]  ${bin.file} (fixed permissions at ${dir})`);
          continue;
        }
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`  [DL]   ${bin.file} -> ${dir} ...`);
        await download(bin.url, dest);
        fs.chmodSync(dest, 0o755);
        results.push(`  [DONE] ${bin.file} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
      } catch (err) {
        results.push(`  [FAIL] ${bin.file}: ${err.message}`);
        console.error(`  [FAIL] ${bin.file} from ${bin.url}: ${err.message}`);
      }
    }
  }
  return results;
}

if (require.main === module) {
  console.log(`[libs] Detected platform: ${SYS_TAG}`);
  ensureLibs().then((results) => {
    for (const r of results) console.log(r);
    const failed = results.filter((r) => r.startsWith('  [FAIL]'));
    if (failed.length > 0) {
      console.error(`[libs] ${failed.length} binary(s) failed to download — MCSManager may not function fully.`);
      process.exit(1);
    }
    console.log('[libs] All architecture-specific binaries ready.');
  }).catch((err) => {
    console.error('[libs] Fatal:', err.message);
    process.exit(1);
  });
} else {
  module.exports = ensureLibs;
}
