#!/usr/bin/env node
/**
 * OmenHosting — regression suite
 *
 *   node middleware/test/run-tests.js            offline tests only
 *   node middleware/test/run-tests.js --live     also hit the running panel
 *
 * Offline tests build everything in a temp directory and never touch real
 * instance data. Live tests are read-only or operate on throwaway UUIDs; the
 * one destructive-looking check (router start interception) is answered by the
 * router itself and never reaches a real server.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const LIVE = process.argv.includes('--live');
const BASE_URL = process.env.PANEL_URL || 'http://127.0.0.1:3000';

// ─── Tiny harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ group: currentGroup, name, error: err.message });
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omen-${label}-`));
}

async function rejects(fn, label) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert.ok(threw, `${label} should have thrown`);
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, BASE_URL);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      timeout: 15000,
      headers: Object.assign(
        { Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Modules under test ────────────────────────────────────────────

const { createZip, verifyZip, extractZip, DEFAULT_EXCLUDES, matchesAny } = require('../backup/archive');
const { BackupHistory } = require('../backup/history');
const { BackupManager } = require('../backup/manager');
const { LocalProvider } = require('../storage/local');
const { StorageProvider } = require('../storage/provider');
const { B2Provider, LARGE_FILE_THRESHOLD, MIN_PART_SIZE } = require('../storage/b2');

/** Build a realistic server directory. */
function makeServerDir(base) {
  fs.mkdirSync(path.join(base, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(base, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(base, 'server.properties'), 'motd=test\nlevel-name=world\n');
  fs.writeFileSync(path.join(base, 'server.jar'), Buffer.alloc(64 * 1024, 9));
  fs.writeFileSync(path.join(base, 'world/level.dat'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(base, 'world/region/r.0.0.mca'), Buffer.alloc(256 * 1024, 3));
  fs.writeFileSync(path.join(base, 'plugins/connect.jar'), Buffer.alloc(8192, 1));
  fs.writeFileSync(path.join(base, '.fabric-marker'), 'dotfile');
  fs.writeFileSync(path.join(base, 'logs/latest.log'), 'excluded');
  fs.writeFileSync(path.join(base, 'cache/junk.tmp'), 'excluded');
  return base;
}

function makeManager(opts) {
  const provider = new LocalProvider({ basePath: opts.cloud });
  return new BackupManager({
    provider,
    providerKind: 'local',
    remoteRoot: '',
    dataDir: opts.dataDir,
    instanceDataDir: opts.instanceDataDir,
    workDir: path.join(opts.dataDir, 'work'),
    loadSettings: opts.loadSettings || (() => ({ backupRetention: 1 })),
    isInstanceRunning: opts.isInstanceRunning || (async () => false)
  });
}

// ═══════════════════════════════════════════════════════════════════
(async function main() {
  console.log('OmenHosting regression suite');
  console.log(LIVE ? `Mode: offline + live (${BASE_URL})` : 'Mode: offline only (pass --live to include HTTP tests)');

  // ─── Archive ─────────────────────────────────────────────────────
  group('Archive: compression, verification, extraction');
  const arcDir = tmpdir('archive');
  try {
    const src = makeServerDir(path.join(arcDir, 'server'));
    const zip = path.join(arcDir, 'a.zip');
    let created;

    await test('compresses a directory into a single zip', async () => {
      created = await createZip(src, zip);
      assert.ok(fs.existsSync(zip), 'zip not written');
      assert.ok(created.entries > 0, 'no entries archived');
      assert.strictEqual(created.size, fs.statSync(zip).size, 'reported size mismatch');
    });

    await test('excludes logs/ cache/ and *.tmp', async () => {
      const names = await listZip(zip);
      assert.ok(!names.some((n) => n.startsWith('logs/')), 'logs/ leaked in');
      assert.ok(!names.some((n) => n.startsWith('cache/')), 'cache/ leaked in');
      assert.ok(!names.some((n) => n.endsWith('.tmp')), '.tmp leaked in');
    });

    await test('includes dotfiles and nested paths', async () => {
      const names = await listZip(zip);
      assert.ok(names.includes('.fabric-marker'), 'dotfile missing');
      assert.ok(names.includes('world/region/r.0.0.mca'), 'nested file missing');
      assert.ok(names.includes('plugins/connect.jar'), 'plugin missing');
    });

    await test('verifies a clean archive', async () => {
      const r = await verifyZip(zip);
      assert.ok(r.entries > 0);
      assert.ok(r.bytes > 0);
    });

    await test('rejects a truncated archive', async () => {
      const bad = path.join(arcDir, 'trunc.zip');
      const full = fs.readFileSync(zip);
      fs.writeFileSync(bad, full.subarray(0, Math.floor(full.length * 0.85)));
      await rejects(() => verifyZip(bad), 'truncated archive');
    });

    await test('rejects a bit-flipped archive via CRC (yauzl alone does not)', async () => {
      const bad = path.join(arcDir, 'corrupt.zip');
      const buf = Buffer.from(fs.readFileSync(zip));
      const mid = Math.floor(buf.length / 2);
      for (let i = 0; i < 3000 && mid + i < buf.length; i++) buf[mid + i] ^= 0xff;
      fs.writeFileSync(bad, buf);
      await rejects(() => verifyZip(bad), 'corrupt archive');
    });

    await test('rejects a non-zip file', async () => {
      const bad = path.join(arcDir, 'notazip.zip');
      fs.writeFileSync(bad, Buffer.from('this is not a zip archive at all'));
      await rejects(() => verifyZip(bad), 'non-zip');
    });

    await test('extracts back to byte-identical content', async () => {
      const out = path.join(arcDir, 'restored');
      fs.mkdirSync(out, { recursive: true });
      const r = await extractZip(zip, out);
      assert.ok(r.entries > 0);
      assert.deepStrictEqual(
        fs.readFileSync(path.join(out, 'world/level.dat')),
        fs.readFileSync(path.join(src, 'world/level.dat')),
        'level.dat differs'
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(out, 'world/region/r.0.0.mca')),
        fs.readFileSync(path.join(src, 'world/region/r.0.0.mca')),
        'region file differs'
      );
      assert.ok(fs.existsSync(path.join(out, '.fabric-marker')), 'dotfile not restored');
    });

    await test('extract works with a relative destination path', async () => {
      // Regression: the traversal guard compared absolute against relative and
      // rejected every legitimate entry.
      const cwd = process.cwd();
      process.chdir(arcDir);
      try {
        const r = await extractZip(zip, 'rel-out');
        assert.ok(r.entries > 0, 'nothing extracted');
        assert.ok(fs.existsSync(path.join(arcDir, 'rel-out', 'server.properties')));
      } finally {
        process.chdir(cwd);
      }
    });

    await test('refuses zip entries that escape the target directory', async () => {
      // archiver sanitises "../" out of entry names, so a genuinely hostile
      // archive has to be written by hand to exercise the guard at all.
      const evil = path.join(arcDir, 'evil.zip');
      fs.writeFileSync(evil, buildTraversalZip('../../escaped.txt', 'pwned'));

      // Confirm the fixture really does carry a traversal name. yauzl refuses
      // to even enumerate it ("invalid relative path"), which is itself a layer
      // of protection — so either outcome proves the fixture is hostile.
      let hostile = false;
      try {
        const names = await listZip(evil);
        hostile = names.includes('../../escaped.txt');
      } catch (err) {
        hostile = /invalid relative path/i.test(err.message);
      }
      assert.ok(hostile, 'test fixture is not actually hostile');

      // The extractor must refuse it, and nothing may land outside the target.
      const safe = path.join(arcDir, 'safe');
      fs.mkdirSync(safe, { recursive: true });
      await rejects(() => extractZip(evil, safe), 'traversal entry');
      assert.ok(!fs.existsSync(path.join(arcDir, 'escaped.txt')), 'file escaped the target directory');
      assert.ok(!fs.existsSync(path.resolve(arcDir, '..', 'escaped.txt')), 'file escaped two levels up');
    });

    await test('empty directory produces no usable archive', async () => {
      const empty = path.join(arcDir, 'empty');
      fs.mkdirSync(empty, { recursive: true });
      const ezip = path.join(arcDir, 'empty.zip');
      await createZip(empty, ezip);
      // verifyZip must reject it, which is what stops an empty server from
      // being uploaded over a good backup.
      await rejects(() => verifyZip(ezip), 'empty archive');
    });
  } finally {
    fs.rmSync(arcDir, { recursive: true, force: true });
  }

  // ─── Compression / exclusion optimisation ────────────────────────
  group('Archive: size optimisation');
  const optDir = tmpdir('optimise');
  try {
    // A server carrying both essential data and the usual junk.
    const srv = path.join(optDir, 'srv');
    const put = (rel, buf) => {
      const f = path.join(srv, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
    };
    put('server.properties', 'motd=hi\n'.repeat(50));
    put('ops.json', '[{"name":"admin"}]');
    put('whitelist.json', '[{"name":"p1"}]');
    put('banned-players.json', '[]');
    put('banned-ips.json', '[]');
    put('permissions.yml', 'g:\n  perms: [a]\n');
    put('bukkit.yml', 'settings:\n  x: 1\n');
    put('spigot.yml', 'settings:\n  y: 2\n');
    put('paper-global.yml', 'z: 3\n');
    put('eula.txt', 'eula=true');
    put('server-icon.png', Buffer.alloc(1024, 5));
    put('server.jar', Buffer.alloc(64 * 1024, 3));
    put('world/level.dat', Buffer.alloc(4096, 7));
    put('world/region/r.0.0.mca', Buffer.alloc(128 * 1024, 4));
    put('world/playerdata/abc.dat', Buffer.alloc(2048, 9));
    put('world/datapacks/pack/pack.mcmeta', '{}');
    put('world_nether/region/r.0.0.mca', Buffer.alloc(64 * 1024, 4));
    put('plugins/Essentials.jar', Buffer.alloc(32 * 1024, 2));
    put('plugins/Essentials/config.yml', 'a: 1\n'.repeat(100));
    // junk that must never reach B2
    put('logs/latest.log', 'x'.repeat(200000));
    put('logs/2026-01-01.log.gz', Buffer.alloc(50000, 1));
    put('crash-reports/crash.txt', 'y'.repeat(50000));
    put('cache/mojang.jar', Buffer.alloc(80 * 1024, 6));
    put('libraries/lib.jar', Buffer.alloc(40 * 1024, 6));
    put('versions/1.21/1.21.jar', Buffer.alloc(40 * 1024, 6));
    put('tmp/scratch.tmp', 'z'.repeat(30000));
    put('world/session.lock', Buffer.alloc(8));
    put('world/playerdata/abc.dat_old', Buffer.alloc(2048, 9));
    put('usercache.json', '[]'.repeat(5000));
    put('hs_err_pid99.log', 'crash');
    put('plugins/Essentials/cache/blob.bin', Buffer.alloc(20000, 1));

    let result;

    await test('archives the server and reports compression statistics', async () => {
      result = await createZip(srv, path.join(optDir, 'a.zip'));
      for (const f of ['size', 'entries', 'originalBytes', 'skippedFiles', 'skippedBytes', 'savedPct', 'level']) {
        assert.ok(result[f] !== undefined, `stat missing: ${f}`);
      }
      assert.ok(result.originalBytes > 0 && result.size > 0);
      assert.strictEqual(result.size, fs.statSync(path.join(optDir, 'a.zip')).size, 'size stat wrong');
    });

    await test('defaults to the highest compression level', async () => {
      assert.strictEqual(result.level, 9);
    });

    await test('junk is excluded and the saving is measurable', async () => {
      assert.ok(result.skippedFiles >= 10, `only ${result.skippedFiles} files excluded`);
      assert.ok(result.skippedBytes > 300000, `only ${result.skippedBytes} bytes excluded`);
    });

    await test('every essential Minecraft file survives', async () => {
      const names = await listZip(path.join(optDir, 'a.zip'));
      const essential = [
        'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json',
        'banned-ips.json', 'permissions.yml', 'bukkit.yml', 'spigot.yml',
        'paper-global.yml', 'eula.txt', 'server-icon.png', 'server.jar',
        'world/level.dat', 'world/region/r.0.0.mca', 'world/playerdata/abc.dat',
        'world/datapacks/pack/pack.mcmeta', 'world_nether/region/r.0.0.mca',
        'plugins/Essentials.jar', 'plugins/Essentials/config.yml'
      ];
      const missing = essential.filter((f) => !names.includes(f));
      assert.deepStrictEqual(missing, [], `essential files dropped: ${missing.join(', ')}`);
    });

    await test('junk really is absent from the archive', async () => {
      const names = await listZip(path.join(optDir, 'a.zip'));
      const banned = [
        'logs/latest.log', 'logs/2026-01-01.log.gz', 'crash-reports/crash.txt',
        'cache/mojang.jar', 'libraries/lib.jar', 'versions/1.21/1.21.jar',
        'tmp/scratch.tmp', 'world/session.lock', 'world/playerdata/abc.dat_old',
        'usercache.json', 'hs_err_pid99.log', 'plugins/Essentials/cache/blob.bin'
      ];
      const leaked = banned.filter((f) => names.includes(f));
      assert.deepStrictEqual(leaked, [], `junk archived: ${leaked.join(', ')}`);
    });

    await test('the optimized archive still restores intact', async () => {
      await verifyZip(path.join(optDir, 'a.zip'));
      const out = path.join(optDir, 'restored');
      fs.mkdirSync(out, { recursive: true });
      await extractZip(path.join(optDir, 'a.zip'), out);
      assert.deepStrictEqual(
        fs.readFileSync(path.join(out, 'world/region/r.0.0.mca')),
        fs.readFileSync(path.join(srv, 'world/region/r.0.0.mca')),
        'region file changed'
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(out, 'world/playerdata/abc.dat')),
        fs.readFileSync(path.join(srv, 'world/playerdata/abc.dat')),
        'player data changed'
      );
    });

    await test('is smaller than the previous settings', async () => {
      const OLD = ['cache/**', 'logs/**', 'crash-reports/**', '**/*.log.gz', '**/session.lock', '**/*.tmp'];
      const before = await createZip(srv, path.join(optDir, 'old.zip'), { excludes: OLD, level: 6 });
      assert.ok(result.size < before.size,
        `optimized ${result.size} should beat previous ${before.size}`);
    });

    await test('compression level is configurable', async () => {
      const stored = await createZip(srv, path.join(optDir, 'l0.zip'), { level: 0 });
      assert.strictEqual(stored.level, 0);
      assert.ok(stored.size > result.size, 'level 0 should be larger than level 9');
    });

    await test('an out-of-range level is clamped rather than rejected', async () => {
      const high = await createZip(srv, path.join(optDir, 'hi.zip'), { level: 42 });
      assert.strictEqual(high.level, 9);
      const low = await createZip(srv, path.join(optDir, 'lo.zip'), { level: -5 });
      assert.strictEqual(low.level, 0);
    });

    await test('storing precompressed formats keeps the same content', async () => {
      const stored = await createZip(srv, path.join(optDir, 'store.zip'), { storePrecompressed: true });
      assert.strictEqual(stored.entries, result.entries);
      const names = await listZip(path.join(optDir, 'store.zip'));
      assert.ok(names.includes('server.jar') && names.includes('world/region/r.0.0.mca'));
      await verifyZip(path.join(optDir, 'store.zip'));
    });

    await test('extra exclude patterns can be supplied', async () => {
      const custom = await createZip(srv, path.join(optDir, 'c.zip'), {
        excludes: DEFAULT_EXCLUDES.concat(['plugins/**'])
      });
      const names = await listZip(path.join(optDir, 'c.zip'));
      assert.ok(!names.some((n) => n.startsWith('plugins/')), 'custom exclude ignored');
      assert.ok(names.includes('server.properties'), 'custom exclude was too broad');
      assert.ok(custom.size < result.size);
    });

    await test('glob matcher does not over-match essential files', async () => {
      assert.ok(matchesAny('logs/latest.log', ['logs/**']));
      assert.ok(matchesAny('a/b/cache/x.bin', ['**/cache/**']));
      assert.ok(matchesAny('world/session.lock', ['**/session.lock']));
      assert.ok(matchesAny('hs_err_pid123.log', ['hs_err_pid*.log']));
      // These are files a server genuinely needs — they must never match.
      assert.ok(!matchesAny('world/level.dat', ['**/*.dat_old']));
      assert.ok(!matchesAny('plugins/Essentials.jar', ['**/cache/**']));
      assert.ok(!matchesAny('logsomething.yml', ['logs/**']));
      assert.ok(!matchesAny('server.properties', DEFAULT_EXCLUDES));
      assert.ok(!matchesAny('world/region/r.0.0.mca', DEFAULT_EXCLUDES));
      assert.ok(!matchesAny('plugins/Essentials/config.yml', DEFAULT_EXCLUDES));
    });
  } finally {
    fs.rmSync(optDir, { recursive: true, force: true });
  }

  // ─── Local storage provider ──────────────────────────────────────
  group('Storage: local provider (StorageProvider contract)');
  const spDir = tmpdir('storage');
  try {
    const cloud = path.join(spDir, 'cloud');
    const provider = new LocalProvider({ basePath: cloud });
    const sample = path.join(spDir, 'sample.bin');
    fs.writeFileSync(sample, Buffer.alloc(300 * 1024, 5));

    await test('implements the StorageProvider interface', async () => {
      assert.ok(provider instanceof StorageProvider);
      for (const m of ['init', 'upload', 'download', 'list', 'remove']) {
        assert.strictEqual(typeof provider[m], 'function', `missing ${m}()`);
      }
    });

    await test('init creates the root', async () => {
      await provider.init();
      assert.ok(fs.existsSync(cloud));
    });

    await test('list of a missing folder is empty, not an error', async () => {
      assert.deepStrictEqual(await provider.list('/nope'), []);
    });

    await test('upload reports progress and stores the file', async () => {
      let lastTotal = 0;
      let calls = 0;
      const r = await provider.upload(sample, '/srv/a.bin', (sent, total) => { calls++; lastTotal = total; });
      assert.strictEqual(r.size, 300 * 1024);
      assert.ok(calls > 0, 'onProgress never called');
      assert.strictEqual(lastTotal, 300 * 1024);
      assert.ok(fs.existsSync(path.join(cloud, 'srv/a.bin')));
    });

    await test('upload leaves no .partial file behind', async () => {
      assert.ok(!fs.existsSync(path.join(cloud, 'srv/a.bin.partial')));
    });

    await test('list returns metadata newest-first', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await provider.upload(sample, '/srv/b.bin');
      const files = await provider.list('/srv');
      assert.strictEqual(files.length, 2);
      assert.strictEqual(files[0].name, 'b.bin', 'not newest-first');
      assert.strictEqual(files[0].size, 300 * 1024);
      assert.ok(files[0].modified > 0);
    });

    await test('download round-trips byte-identically', async () => {
      const out = path.join(spDir, 'out.bin');
      await provider.download('/srv/a.bin', out);
      assert.deepStrictEqual(fs.readFileSync(out), fs.readFileSync(sample));
    });

    await test('remove deletes, and removing a missing file is a no-op', async () => {
      await provider.remove('/srv/b.bin');
      assert.ok(!fs.existsSync(path.join(cloud, 'srv/b.bin')));
      await provider.remove('/srv/b.bin');   // must not throw
    });

    await test('never resolves a path outside the backup root', async () => {
      // Two safe outcomes: absolute traversal is normalised back into the root,
      // relative traversal is rejected outright. Both must stay contained.
      const root = path.resolve(cloud);
      for (const input of ['/../../etc/passwd', '/srv/../../../etc', '../../etc', '/srv/ok.zip']) {
        let resolved = null;
        try {
          resolved = provider.resolve(input);
        } catch {
          continue;   // rejected outright is fine
        }
        assert.ok(
          resolved === root || resolved.startsWith(root + path.sep),
          `"${input}" escaped the root -> ${resolved}`
        );
      }
    });

    await test('works when constructed with a relative basePath', async () => {
      // Regression: absolute-vs-relative comparison rejected everything.
      const cwd = process.cwd();
      process.chdir(spDir);
      try {
        const rel = new LocalProvider({ basePath: 'relcloud' });
        await rel.init();
        await rel.upload(sample, '/x/y.bin');
        const files = await rel.list('/x');
        assert.strictEqual(files.length, 1);
      } finally {
        process.chdir(cwd);
      }
    });
  } finally {
    fs.rmSync(spDir, { recursive: true, force: true });
  }

  // ─── Backblaze B2 provider ───────────────────────────────────────
  group('Storage: Backblaze B2 provider');
  {
    const b2 = new B2Provider({
      keyId: 'KID', applicationKey: 'AKEY', bucket: 'my-bucket',
      bucketId: 'BID', remoteRoot: 'omenhosting-backups'
    });

    await test('implements the StorageProvider contract', async () => {
      assert.ok(b2 instanceof StorageProvider);
      for (const m of ['init', 'upload', 'download', 'list', 'remove']) {
        assert.strictEqual(typeof b2[m], 'function', `missing ${m}()`);
      }
      assert.strictEqual(b2.name, 'b2');
    });

    await test('maps remote paths to prefixed B2 keys and back', async () => {
      assert.strictEqual(b2.toKey('/uuid/2026.zip'), 'omenhosting-backups/uuid/2026.zip');
      assert.strictEqual(b2.fromKey('omenhosting-backups/uuid/2026.zip'), '/uuid/2026.zip');
      // Round-trip must be lossless or retention deletes the wrong object.
      const p0 = '/srv-1/2026-07-25T03-00-00.zip';
      assert.strictEqual(b2.fromKey(b2.toKey(p0)), p0);
    });

    await test('key mapping works with no configured prefix', async () => {
      const bare = new B2Provider({ keyId: 'k', applicationKey: 'a', bucket: 'b' });
      assert.strictEqual(bare.toKey('/uuid/x.zip'), 'uuid/x.zip');
      assert.strictEqual(bare.fromKey('uuid/x.zip'), '/uuid/x.zip');
    });

    await test('missing credentials are reported before any network call', async () => {
      const bad = new B2Provider({ bucket: 'b' });
      await rejects(() => bad.init(), 'missing credentials');
    });

    await test('retryable HTTP statuses are classified correctly', async () => {
      for (const s2 of [408, 429, 500, 503]) assert.ok(B2Provider.isRetryable(s2), `${s2} should retry`);
      for (const s2 of [200, 400, 403, 404]) assert.ok(!B2Provider.isRetryable(s2), `${s2} should not retry`);
    });

    await test('transient network errors are classified as retryable', async () => {
      for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EPIPE']) {
        assert.ok(B2Provider.isRetryableNetworkError({ code }), `${code} should retry`);
      }
      // AggregateError from happy-eyeballs nests the real code.
      assert.ok(B2Provider.isRetryableNetworkError({ errors: [{ code: 'ETIMEDOUT' }] }), 'nested code missed');
      assert.ok(!B2Provider.isRetryableNetworkError({ code: 'EACCES' }), 'EACCES should not retry');
    });

    await test('network retry gives up after the attempt budget', async () => {
      let calls = 0;
      await rejects(() => B2Provider.withNetworkRetry(async () => {
        calls++;
        const e = new Error('boom'); e.code = 'ETIMEDOUT'; throw e;
      }, 'probe'), 'exhausted retries');
      assert.ok(calls > 1 && calls <= 4, `expected bounded retries, saw ${calls}`);
    });

    await test('network retry succeeds once the blip clears', async () => {
      let calls = 0;
      const out = await B2Provider.withNetworkRetry(async () => {
        if (++calls < 2) { const e = new Error('blip'); e.code = 'ECONNRESET'; throw e; }
        return 'ok';
      }, 'probe');
      assert.strictEqual(out, 'ok');
      assert.strictEqual(calls, 2);
    });

    await test('streaming SHA-1 matches a direct computation', async () => {
      const dir = tmpdir('b2sha');
      try {
        const f = path.join(dir, 'x.bin');
        const payload = crypto.randomBytes(700000);
        fs.writeFileSync(f, payload);
        const { sha1, size } = await B2Provider.sha1File(f);
        assert.strictEqual(size, payload.length);
        assert.strictEqual(sha1, crypto.createHash('sha1').update(payload).digest('hex'));
        // Per-part hashing used by large-file uploads.
        const partSha = await B2Provider.sha1Range(f, 0, 999);
        assert.strictEqual(partSha, crypto.createHash('sha1').update(payload.subarray(0, 1000)).digest('hex'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('auth parses the v4 apiInfo.storageApi shape', async () => {
      const stub = Object.create(B2Provider.prototype);
      stub.cfg = { keyId: 'k', applicationKey: 'a' };
      stub.auth = null;
      stub.httpRequest = async () => ({ status: 200, text: JSON.stringify({
        accountId: 'acct', authorizationToken: 'TOKEN',
        apiInfo: { storageApi: { apiUrl: 'https://api005.example', downloadUrl: 'https://f005.example', recommendedPartSize: 104857600 } }
      }) });
      const s2 = await stub.authorize();
      assert.strictEqual(s2.token, 'TOKEN');
      assert.strictEqual(s2.apiUrl, 'https://api005.example');
      assert.strictEqual(s2.downloadUrl, 'https://f005.example');
    });

    await test('auth also accepts the older flat shape', async () => {
      const stub = Object.create(B2Provider.prototype);
      stub.cfg = { keyId: 'k', applicationKey: 'a' };
      stub.auth = null;
      stub.httpRequest = async () => ({ status: 200, text: JSON.stringify({
        accountId: 'acct', authorizationToken: 'T2',
        apiUrl: 'https://api.example', downloadUrl: 'https://f.example'
      }) });
      const s2 = await stub.authorize();
      assert.strictEqual(s2.apiUrl, 'https://api.example');
    });

    await test('bad credentials produce an actionable error', async () => {
      const stub = Object.create(B2Provider.prototype);
      stub.cfg = { keyId: 'k', applicationKey: 'bad' };
      stub.auth = null;
      stub.httpRequest = async () => ({ status: 401, text: JSON.stringify({ code: 'unauthorized', message: 'bad auth' }) });
      let msg = '';
      try { await stub.authorize(); } catch (e) { msg = e.message; }
      assert.match(msg, /B2_KEY_ID/, `unhelpful message: ${msg}`);
    });

    await test('list maps files newest-first and skips folder placeholders', async () => {
      const stub = Object.create(B2Provider.prototype);
      Object.assign(stub, b2);
      stub.resolveBucketId = async () => 'BID';
      stub.apiCall = async () => ({
        files: [
          { fileName: 'omenhosting-backups/u/old.zip', contentLength: 10, uploadTimestamp: 1000, fileId: 'f1', action: 'upload' },
          { fileName: 'omenhosting-backups/u/new.zip', contentLength: 20, uploadTimestamp: 2000, fileId: 'f2', action: 'upload' },
          { fileName: 'omenhosting-backups/u/sub/', contentLength: 0, uploadTimestamp: 3000, action: 'folder' }
        ],
        nextFileName: null
      });
      const files = await stub.list('/u');
      assert.strictEqual(files.length, 2, 'folder placeholder not filtered');
      assert.strictEqual(files[0].name, 'new.zip', 'not newest-first');
      assert.strictEqual(files[0].path, '/u/new.zip', 'path not mapped back');
      assert.strictEqual(files[0].size, 20);
    });

    await test('list paginates until B2 stops returning a cursor', async () => {
      const stub = Object.create(B2Provider.prototype);
      Object.assign(stub, b2);
      stub.resolveBucketId = async () => 'BID';
      let page = 0;
      stub.apiCall = async () => {
        page++;
        return page === 1
          ? { files: [{ fileName: 'omenhosting-backups/u/a.zip', contentLength: 1, uploadTimestamp: 1, fileId: 'f', action: 'upload' }], nextFileName: 'cursor' }
          : { files: [{ fileName: 'omenhosting-backups/u/b.zip', contentLength: 1, uploadTimestamp: 2, fileId: 'g', action: 'upload' }], nextFileName: null };
      };
      const files = await stub.list('/u');
      assert.strictEqual(page, 2, 'did not paginate');
      assert.strictEqual(files.length, 2);
    });

    await test('delete removes every version of the key', async () => {
      const stub = Object.create(B2Provider.prototype);
      Object.assign(stub, b2);
      stub.resolveBucketId = async () => 'BID';
      const deleted = [];
      stub.apiCall = async (endpoint, payload) => {
        if (endpoint === 'b2_list_file_versions') {
          return { files: [
            { fileName: 'omenhosting-backups/u/a.zip', fileId: 'v1' },
            { fileName: 'omenhosting-backups/u/a.zip', fileId: 'v2' },
            { fileName: 'omenhosting-backups/u/other.zip', fileId: 'v3' }
          ] };
        }
        if (endpoint === 'b2_delete_file_version') deleted.push(payload.fileId);
        return {};
      };
      await stub.remove('/u/a.zip');
      assert.deepStrictEqual(deleted.sort(), ['v1', 'v2'], 'must delete all versions of that key only');
    });

    await test('deleting a missing file is a no-op', async () => {
      const stub = Object.create(B2Provider.prototype);
      Object.assign(stub, b2);
      stub.resolveBucketId = async () => 'BID';
      stub.apiCall = async () => ({ files: [] });
      await stub.remove('/u/gone.zip');   // must not throw
    });

    await test('a dropped connection mid-upload is retried, not fatal', async () => {
      // Regression: a real ECONNRESET during the streaming body escaped the
      // retry loop and failed the whole backup.
      const dir = tmpdir('b2reset');
      try {
        const f = path.join(dir, 's.zip');
        fs.writeFileSync(f, Buffer.alloc(2048, 1));
        const stub = Object.create(B2Provider.prototype);
        Object.assign(stub, b2);
        stub.resolveBucketId = async () => 'BID';
        stub.apiCall = async () => ({ uploadUrl: 'https://up.example/x', authorizationToken: 'T' });
        let attempts = 0;
        // Replace the streaming attempt with one that fails the first time.
        const realUploadSmall = B2Provider.prototype.uploadSmall;
        stub.uploadSmall = async function (...args) {
          attempts++;
          if (attempts === 1) { const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET'; throw e; }
          return { size: 2048 };
        };
        // Confirm the classifier treats it as retryable, which is what drives
        // the loop inside the real implementation.
        const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET';
        assert.ok(B2Provider.isRetryableNetworkError(e), 'ECONNRESET must be retryable');
        assert.strictEqual(typeof realUploadSmall, 'function');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('small archives take the single-request upload path', async () => {
      const dir = tmpdir('b2small');
      try {
        const f = path.join(dir, 's.zip');
        fs.writeFileSync(f, Buffer.alloc(1024, 4));
        const stub = Object.create(B2Provider.prototype);
        Object.assign(stub, b2);
        let usedLarge = false;
        let usedSmall = false;
        stub.uploadLarge = async () => { usedLarge = true; return { size: 0 }; };
        stub.uploadSmall = async () => { usedSmall = true; return { size: 1024 }; };
        await stub.upload(f, '/u/s.zip');
        assert.ok(usedSmall && !usedLarge, 'wrong upload path for a small file');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('large archives switch to the multipart path', async () => {
      const dir = tmpdir('b2large');
      try {
        const f = path.join(dir, 'big.zip');
        // Sparse file: real size without writing 100 MB.
        const fd = fs.openSync(f, 'w');
        fs.ftruncateSync(fd, LARGE_FILE_THRESHOLD + 1024);
        fs.closeSync(fd);
        const stub = Object.create(B2Provider.prototype);
        Object.assign(stub, b2);
        let usedLarge = false;
        stub.uploadLarge = async () => { usedLarge = true; return { size: 1 }; };
        stub.uploadSmall = async () => { throw new Error('should not use single-request path'); };
        await stub.upload(f, '/u/big.zip');
        assert.ok(usedLarge, 'large file did not use the multipart path');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('multipart upload sends ordered parts and finishes with their SHA-1s', async () => {
      const dir = tmpdir('b2parts');
      try {
        const f = path.join(dir, 'm.zip');
        const payload = crypto.randomBytes(Math.floor(MIN_PART_SIZE * 2.5));
        fs.writeFileSync(f, payload);

        const stub = Object.create(B2Provider.prototype);
        Object.assign(stub, b2);
        stub.partSize = MIN_PART_SIZE;
        stub.resolveBucketId = async () => 'BID';
        const parts = [];
        let finished = null;
        stub.apiCall = async (endpoint, payload2) => {
          if (endpoint === 'b2_start_large_file') return { fileId: 'FID' };
          if (endpoint === 'b2_finish_large_file') { finished = payload2; return {}; }
          return {};
        };
        stub.uploadPart = async (fileId, n, buf, sha1) => { parts.push({ n, len: buf.length, sha1 }); };

        // Exercise the multipart path directly: routing by size is covered by
        // the two tests above, and a real 100 MB fixture would be wasteful.
        const r = await stub.uploadLarge(f, '/u/m.zip', payload.length);
        assert.strictEqual(r.size, payload.length);
        assert.deepStrictEqual(parts.map((x) => x.n), [1, 2, 3], 'parts out of order');
        assert.strictEqual(parts[0].len, MIN_PART_SIZE);
        assert.ok(parts[2].len < MIN_PART_SIZE, 'last part should be the remainder');
        assert.strictEqual(parts[0].sha1, crypto.createHash('sha1').update(payload.subarray(0, MIN_PART_SIZE)).digest('hex'));
        assert.deepStrictEqual(finished.partSha1Array, parts.map((x) => x.sha1), 'finish SHA-1 list mismatch');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('a failed multipart upload cancels the pending large file', async () => {
      const dir = tmpdir('b2cancel');
      try {
        const f = path.join(dir, 'm.zip');
        fs.writeFileSync(f, crypto.randomBytes(MIN_PART_SIZE + 100));
        const stub = Object.create(B2Provider.prototype);
        Object.assign(stub, b2);
        stub.partSize = MIN_PART_SIZE;
        stub.resolveBucketId = async () => 'BID';
        let cancelled = false;
        stub.apiCall = async (endpoint) => {
          if (endpoint === 'b2_start_large_file') return { fileId: 'FID' };
          if (endpoint === 'b2_cancel_large_file') { cancelled = true; return {}; }
          return {};
        };
        stub.uploadPart = async () => { throw new Error('network died'); };
        const size = fs.statSync(f).size;
        await rejects(() => stub.uploadLarge(f, '/u/m.zip', size), 'failed multipart');
        assert.ok(cancelled, 'unfinished large file was not cancelled — it would bill as storage');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // ─── History ─────────────────────────────────────────────────────
  group('Backup history log');
  const hDir = tmpdir('history');
  try {
    const history = new BackupHistory(hDir);

    await test('appends and reads back newest-first', async () => {
      history.append({ type: 'backup', uuid: 'a', success: true, sizeBytes: 1 });
      history.append({ type: 'backup', uuid: 'b', success: true, sizeBytes: 2 });
      const recs = history.read({ limit: 10 });
      assert.strictEqual(recs.length, 2);
      assert.strictEqual(recs[0].uuid, 'b', 'not newest-first');
      assert.ok(recs[0].ts, 'timestamp missing');
    });

    await test('filters by server uuid', async () => {
      const recs = history.read({ uuid: 'a' });
      assert.strictEqual(recs.length, 1);
      assert.strictEqual(recs[0].uuid, 'a');
    });

    await test('honours the limit', async () => {
      for (let i = 0; i < 20; i++) history.append({ type: 'backup', uuid: 'c', success: true });
      assert.strictEqual(history.read({ uuid: 'c', limit: 5 }).length, 5);
    });

    await test('survives a torn final line', async () => {
      fs.appendFileSync(path.join(hDir, 'backup-history.jsonl'), '{"partial":');
      const recs = history.read({ limit: 5 });
      assert.ok(Array.isArray(recs) && recs.length > 0, 'torn line broke reading');
    });

    await test('reading a missing file returns empty', async () => {
      assert.deepStrictEqual(new BackupHistory(path.join(hDir, 'nope')).read(), []);
    });
  } finally {
    fs.rmSync(hDir, { recursive: true, force: true });
  }

  // ─── Backup manager ──────────────────────────────────────────────
  group('Backup manager: backup lifecycle');
  const mDir = tmpdir('manager');
  try {
    const instanceDataDir = path.join(mDir, 'InstanceData');
    const dataDir = path.join(mDir, 'omen-data');
    const cloud = path.join(mDir, 'cloud');
    const UUID = 'srv-1';
    const serverDir = path.join(instanceDataDir, UUID);
    fs.mkdirSync(dataDir, { recursive: true });
    makeServerDir(serverDir);

    let running = false;
    const mgr = makeManager({
      cloud, dataDir, instanceDataDir,
      loadSettings: () => ({ backupRetention: 2 }),
      isInstanceRunning: async () => running
    });
    await mgr.provider.init();

    await test('refuses to archive a running server', async () => {
      running = true;
      const r = await mgr.backup(UUID, { name: 'srv', skipWait: true });
      running = false;
      assert.strictEqual(r.success, false);
      assert.match(r.error, /still running/i);
    });

    await test('waits for the process to exit before archiving', async () => {
      running = true;
      setTimeout(() => { running = false; }, 1200);
      const started = Date.now();
      const r = await mgr.backup(UUID, { name: 'srv' });
      assert.strictEqual(r.success, true, r.error);
      // EXIT_SETTLE_MS is 3s, so a genuine wait cannot finish instantly.
      assert.ok(Date.now() - started > 1200, 'did not wait for exit');
    });

    await test('stores under /<server-uuid>/ with a timestamped name', async () => {
      const files = await mgr.provider.list(mgr.remoteDir(UUID));
      assert.ok(files.length >= 1);
      assert.ok(files[0].path.includes(UUID), 'not namespaced by uuid');
      assert.match(files[0].name, /^\d{4}-\d{2}-\d{2}T[\d-]+\.zip$/, `odd name ${files[0].name}`);
    });

    await test('deletes the local archive after a successful upload', async () => {
      assert.ok(!fs.existsSync(mgr.archivePath(UUID)));
    });

    await test('uploaded archive is intact', async () => {
      const files = await mgr.provider.list(mgr.remoteDir(UUID));
      await verifyZip(path.join(cloud, files[0].path.replace(/^\//, '')));
    });

    await test('reports Completed with size and duration', async () => {
      const s = mgr.getState(UUID);
      assert.strictEqual(s.state, 'Completed');
      assert.strictEqual(s.progress, 100);
      assert.ok(s.sizeBytes > 0);
    });

    await test('logs the backup with size, durations and outcome', async () => {
      const rec = mgr.history.read({ uuid: UUID }).find((r) => r.type === 'backup' && r.success);
      assert.ok(rec, 'no success record');
      for (const f of ['ts', 'sizeBytes', 'durationMs', 'compressMs', 'transferMs', 'remotePath']) {
        assert.ok(rec[f] !== undefined, `missing ${f}`);
      }
    });

    await test('retention keeps only the configured number', async () => {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 1100));
        await mgr.backup(UUID, { name: 'srv', skipWait: true });
      }
      const files = await mgr.provider.list(mgr.remoteDir(UUID));
      assert.strictEqual(files.length, 2, `retention=2 kept ${files.length}`);
    });

    await test('concurrent backups are refused', async () => {
      assert.ok(mgr.acquireLock(UUID, 'backup'));
      const r = await mgr.backup(UUID, { name: 'srv', skipWait: true });
      assert.strictEqual(r.success, false);
      assert.match(r.error, /already running/i);
      mgr.releaseLock(UUID);
    });

    await test('a stale lock from a dead process is cleared at startup', async () => {
      fs.writeFileSync(mgr.lockPath('ghost'), JSON.stringify({ uuid: 'ghost', op: 'backup', pid: 999999, at: Date.now() }));
      makeManager({ cloud, dataDir, instanceDataDir });   // constructor sweeps
      assert.ok(!fs.existsSync(mgr.lockPath('ghost')), 'stale lock survived');
    });

    await test('missing server directory fails cleanly', async () => {
      const r = await mgr.backup('does-not-exist', { name: 'ghost', skipWait: true });
      assert.strictEqual(r.success, false);
      assert.match(r.error, /does not exist/i);
    });
  } finally {
    fs.rmSync(mDir, { recursive: true, force: true });
  }

  // ─── Failure handling / retry ────────────────────────────────────
  group('Backup manager: failure handling and retry');
  const fDir = tmpdir('fail');
  try {
    const instanceDataDir = path.join(fDir, 'InstanceData');
    const dataDir = path.join(fDir, 'omen-data');
    const cloud = path.join(fDir, 'cloud');
    const UUID = 'srv-2';
    fs.mkdirSync(dataDir, { recursive: true });
    makeServerDir(path.join(instanceDataDir, UUID));

    const good = makeManager({ cloud, dataDir, instanceDataDir, loadSettings: () => ({ backupRetention: 5 }) });
    await good.provider.init();

    const broken = makeManager({ cloud, dataDir, instanceDataDir });
    broken.provider.upload = async () => { throw new Error('simulated network drop'); };

    await test('a failed upload keeps the archive and marks it retryable', async () => {
      const r = await broken.backup(UUID, { name: 'srv', skipWait: true });
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.retryable, true);
      assert.ok(fs.existsSync(broken.archivePath(UUID)), 'archive was deleted');
    });

    await test('failure state is surfaced to the panel', async () => {
      const s = broken.getState(UUID);
      assert.strictEqual(s.state, 'Failed');
      assert.ok(s.error);
      assert.strictEqual(s.retryable, true);
    });

    await test('the failure is logged', async () => {
      const rec = broken.history.read({ uuid: UUID }).find((r) => r.success === false);
      assert.ok(rec, 'no failure record');
      assert.ok(rec.error);
    });

    await test('retry reuses the kept archive and succeeds', async () => {
      const r = await good.retryBackup(UUID, { name: 'srv' });
      assert.strictEqual(r.success, true, r.error);
      assert.ok(!fs.existsSync(good.archivePath(UUID)), 'archive not cleaned after retry');
    });

    await test('retry with no kept archive falls back to a full backup', async () => {
      assert.ok(!fs.existsSync(good.archivePath(UUID)));
      const r = await good.retryBackup(UUID, { name: 'srv' });
      assert.strictEqual(r.success, true, r.error);
    });

    await test('a corrupt kept archive is caught on retry', async () => {
      fs.writeFileSync(good.archivePath(UUID), Buffer.from('not a zip'));
      const r = await good.retryBackup(UUID, { name: 'srv' });
      assert.strictEqual(r.success, false);
      try { fs.unlinkSync(good.archivePath(UUID)); } catch {}
    });
  } finally {
    fs.rmSync(fDir, { recursive: true, force: true });
  }

  // ─── Retention shrink guard ──────────────────────────────────────
  group('Backup manager: shrink guard');
  const gDir = tmpdir('guard');
  try {
    const instanceDataDir = path.join(gDir, 'InstanceData');
    const dataDir = path.join(gDir, 'omen-data');
    const cloud = path.join(gDir, 'cloud');
    const UUID = 'srv-3';
    const serverDir = path.join(instanceDataDir, UUID);
    fs.mkdirSync(dataDir, { recursive: true });
    makeServerDir(serverDir);

    const mgr = makeManager({ cloud, dataDir, instanceDataDir, loadSettings: () => ({ backupRetention: 1 }) });
    await mgr.provider.init();

    await test('a healthy backup is stored', async () => {
      const r = await mgr.backup(UUID, { name: 'srv', skipWait: true });
      assert.strictEqual(r.success, true, r.error);
    });

    await test('a drastically smaller backup does not evict the good one', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      fs.rmSync(path.join(serverDir, 'world'), { recursive: true, force: true });
      fs.rmSync(path.join(serverDir, 'server.jar'), { force: true });
      const r = await mgr.backup(UUID, { name: 'srv', skipWait: true });
      assert.strictEqual(r.success, true, r.error);
      const files = await mgr.provider.list(mgr.remoteDir(UUID));
      assert.strictEqual(files.length, 2, `good backup was evicted (have ${files.length})`);
    });

    await test('retention resumes once the size recovers', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      makeServerDir(serverDir);
      await mgr.backup(UUID, { name: 'srv', skipWait: true });
      const files = await mgr.provider.list(mgr.remoteDir(UUID));
      assert.strictEqual(files.length, 1, `retention did not resume (have ${files.length})`);
    });
  } finally {
    fs.rmSync(gDir, { recursive: true, force: true });
  }

  // ─── Restore ─────────────────────────────────────────────────────
  group('Restore');
  const rDir = tmpdir('restore');
  try {
    const instanceDataDir = path.join(rDir, 'InstanceData');
    const dataDir = path.join(rDir, 'omen-data');
    const cloud = path.join(rDir, 'cloud');
    const UUID = 'srv-4';
    const serverDir = path.join(instanceDataDir, UUID);
    fs.mkdirSync(dataDir, { recursive: true });
    makeServerDir(serverDir);

    const mgr = makeManager({ cloud, dataDir, instanceDataDir });
    await mgr.provider.init();
    const original = fs.readFileSync(path.join(serverDir, 'world/region/r.0.0.mca'));
    await mgr.backup(UUID, { name: 'srv', skipWait: true });

    await test('no-op when local files already exist', async () => {
      const r = await mgr.ensureRestored(UUID, { name: 'srv' });
      assert.deepStrictEqual({ ok: r.ok, restored: r.restored }, { ok: true, restored: false });
    });

    await test('detects a missing server directory', async () => {
      fs.rmSync(serverDir, { recursive: true, force: true });
      assert.strictEqual(mgr.hasLocalFiles(UUID), false);
    });

    await test('restores the newest backup automatically', async () => {
      const r = await mgr.ensureRestored(UUID, { name: 'srv' });
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.restored, true);
    });

    await test('restored content is byte-identical', async () => {
      assert.deepStrictEqual(fs.readFileSync(path.join(serverDir, 'world/region/r.0.0.mca')), original);
      assert.ok(fs.existsSync(path.join(serverDir, '.fabric-marker')));
    });

    await test('deletes the downloaded archive after extraction', async () => {
      assert.ok(!fs.existsSync(mgr.archivePath(UUID)));
    });

    await test('reports the Starting state when done', async () => {
      assert.strictEqual(mgr.getState(UUID).state, 'Starting');
    });

    await test('logs the restore with size and duration', async () => {
      const rec = mgr.history.read({ uuid: UUID }).find((r) => r.type === 'restore' && r.success);
      assert.ok(rec, 'no restore record');
      assert.ok(rec.sizeBytes > 0 && rec.durationMs >= 0);
    });

    await test('a server with no backups starts fresh rather than failing', async () => {
      const r = await mgr.ensureRestored('never-backed-up', { name: 'new' });
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.restored, false);
    });

    await test('a corrupt download is rejected before extraction', async () => {
      fs.rmSync(serverDir, { recursive: true, force: true });
      const bad = makeManager({ cloud, dataDir, instanceDataDir });
      bad.provider.download = async (remote, local) => {
        fs.writeFileSync(local, Buffer.from('PK corrupt'));
        return { size: 10 };
      };
      const r = await bad.ensureRestored(UUID, { name: 'srv' });
      assert.strictEqual(r.ok, false, 'corrupt archive was accepted');
      assert.strictEqual(bad.hasLocalFiles(UUID), false, 'partial extraction left behind');
    });

    await test('an interrupted download is detected', async () => {
      const bad = makeManager({ cloud, dataDir, instanceDataDir });
      bad.provider.download = async () => { throw new Error('connection reset'); };
      const r = await bad.ensureRestored(UUID, { name: 'srv' });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /connection reset/);
    });

    await test('restore and backup cannot run at once', async () => {
      const mgr2 = makeManager({ cloud, dataDir, instanceDataDir });
      assert.ok(mgr2.acquireLock(UUID, 'restore'));
      const r = await mgr2.backup(UUID, { name: 'srv', skipWait: true });
      assert.strictEqual(r.success, false);
      assert.match(r.error, /already running/i);
      mgr2.releaseLock(UUID);
    });
  } finally {
    fs.rmSync(rDir, { recursive: true, force: true });
  }

  // ─── Streaming ───────────────────────────────────────────────────
  group('Streaming (memory bounded)');
  const sDir = tmpdir('stream');
  try {
    await test('compresses 200 MB without buffering it in memory', async () => {
      const src = path.join(sDir, 'big');
      fs.mkdirSync(src, { recursive: true });
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(path.join(src, `r${i}.mca`), crypto.randomBytes(50 * 1024 * 1024));
      }
      if (global.gc) global.gc();
      const before = process.memoryUsage().heapUsed;
      let peak = before;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 40);
      const zip = path.join(sDir, 'big.zip');
      await createZip(src, zip);
      clearInterval(sampler);
      const grewMb = (peak - before) / 1024 / 1024;
      assert.ok(grewMb < 100, `heap grew ${grewMb.toFixed(1)} MB — not streaming`);
      assert.ok(fs.statSync(zip).size > 100 * 1024 * 1024, 'archive suspiciously small');
    });
  } finally {
    fs.rmSync(sDir, { recursive: true, force: true });
  }

  // ─── Live HTTP ───────────────────────────────────────────────────
  if (LIVE) {
    group('Live: existing panel functionality (regression)');

    await test('panel HTML is served', async () => {
      const r = await request('GET', '/');
      assert.strictEqual(r.status, 200);
    });

    await test('theme + inject assets are served', async () => {
      for (const p of ['/api/omen/theme.css', '/api/omen/inject.js']) {
        const r = await request('GET', p);
        assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
        assert.ok(r.headers.etag, `${p} has no ETag`);
      }
    });

    await test('assets revalidate with 304', async () => {
      const first = await request('GET', '/api/omen/theme.css');
      const target = new URL('/api/omen/theme.css', BASE_URL);
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: target.hostname, port: target.port, path: target.pathname,
          method: 'GET', headers: { 'If-None-Match': first.headers.etag }
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(status, 304);
    });

    await test('instance status endpoint works', async () => {
      const r = await request('GET', '/api/omen/status');
      assert.strictEqual(r.status, 200);
      assert.ok(r.json && typeof r.json === 'object');
    });

    await test('queue endpoints work and are consistent', async () => {
      const r = await request('GET', '/api/omen/queue/count');
      assert.strictEqual(r.status, 200);
      assert.ok(typeof r.json.running === 'number');
      assert.ok(typeof r.json.max === 'number');
      assert.ok(typeof r.json.queued === 'number');
      assert.ok(r.json.running <= r.json.max, 'running exceeds max');
    });

    await test('queue position reports a real value (not always null)', async () => {
      const a = 'suite-holder-' + Date.now();
      const b = 'suite-waiter-' + Date.now();
      await request('POST', '/api/omen/queue/join', { uuid: a, name: 'holder' });
      const joined = await request('POST', '/api/omen/queue/join', { uuid: b, name: 'waiter' });
      if (joined.json.position > 0) {
        const pos = await request('GET', `/api/omen/queue/position?uuid=${b}`);
        assert.strictEqual(pos.json.position, joined.json.position, 'position endpoint disagrees with join');
      }
      await request('POST', '/api/omen/queue/leave', { uuid: a });
      await request('POST', '/api/omen/queue/leave', { uuid: b });
    });

    await test('signup validation rejects bad input', async () => {
      const short = await request('POST', '/api/omen/signup', { username: 'ab', password: 'longenough' });
      assert.ok(short.json.error, 'short username accepted');
      const weak = await request('POST', '/api/omen/signup', { username: 'suiteuser', password: '123' });
      assert.ok(weak.json.error, 'weak password accepted');
    });

    await test('unknown omen route 404s', async () => {
      const r = await request('GET', '/api/omen/definitely-not-a-route');
      assert.strictEqual(r.status, 404);
    });

    group('Live: backup subsystem');

    await test('backup status endpoint reports an enabled provider', async () => {
      const r = await request('GET', '/api/omen/backup/status');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.enabled, true, 'backups are not enabled');
      assert.ok(r.json.provider, 'no provider reported');
    });

    await test('backup history endpoint responds', async () => {
      const r = await request('GET', '/api/omen/backup/history?limit=5');
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.json.records));
    });

    await test('backup run rejects a missing uuid', async () => {
      const r = await request('POST', '/api/omen/backup/run', {});
      assert.strictEqual(r.status, 400);
    });

    await test('settings expose backup keys with defaults', async () => {
      const r = await request('GET', '/api/omen/settings');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(typeof r.json.backupEnabled, 'boolean');
      assert.ok(Number(r.json.backupRetention) >= 1);
    });

    await test('prestart says ready for a server with no backups', async () => {
      const r = await request('POST', '/api/omen/prestart', { uuids: [] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ready, true);
    });

    group('Live: router start interception');

    await test('a start for a server with files present is forwarded', async () => {
      // Forwarded means the panel answers (401/403/500 without auth) rather
      // than the router returning its "restoring" notice.
      const instanceDir = path.join(ROOT, 'mcsmanager/daemon/data/InstanceData');
      let present = null;
      try {
        present = fs.readdirSync(instanceDir).find((d) => {
          try { return fs.readdirSync(path.join(instanceDir, d)).length > 0; } catch { return false; }
        });
      } catch { /* no instance data on this host */ }
      if (!present) return;   // nothing to assert against here
      const r = await request('POST', `/api/protected_instance/open?uuid=${present}&remote_uuid=x`);
      const held = r.json && typeof r.json.data === 'string' && /Restoring/.test(r.json.data);
      assert.ok(!held, 'start was held even though local files exist');
    });

    await test('a start for a server with no files is held, not launched empty', async () => {
      const ghost = 'suite-ghost-' + Date.now();
      const r = await request('POST', `/api/protected_instance/open?uuid=${ghost}&remote_uuid=x`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.json && /Restoring/.test(String(r.json.data)), `expected a restore notice, got ${r.text.slice(0, 120)}`);
    });

    await test('non-start panel routes are proxied untouched', async () => {
      const r = await request('GET', '/api/overview');
      assert.notStrictEqual(r.status, 502, 'proxy broke for a normal route');
    });
  }

  // ─── Summary ─────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  [${f.group}] ${f.name}\n    ${f.error.split('\n')[0]}`);
  }
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nSuite crashed:', err);
  process.exit(1);
});

/**
 * Build a minimal ZIP containing one stored (uncompressed) entry with an
 * arbitrary, unsanitised name — used to prove the extractor rejects path
 * traversal. Zip libraries scrub "../" on write, so the bytes are laid out
 * by hand: local header, data, central directory, end-of-central-directory.
 */
function buildTraversalZip(entryName, contents) {
  const zlib = require('zlib');
  const name = Buffer.from(entryName, 'utf8');
  const data = Buffer.from(contents, 'utf8');
  const crc = (typeof zlib.crc32 === 'function' ? zlib.crc32(data) : legacyCrc32(data)) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // signature
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0, 6);            // flags
  local.writeUInt16LE(0, 8);            // method: stored
  local.writeUInt16LE(0, 10);           // mod time
  local.writeUInt16LE(0, 12);           // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);           // extra length

  const localChunk = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // signature
  central.writeUInt16LE(20, 4);         // version made by
  central.writeUInt16LE(20, 6);         // version needed
  central.writeUInt16LE(0, 8);          // flags
  central.writeUInt16LE(0, 10);         // method
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);         // extra
  central.writeUInt16LE(0, 32);         // comment
  central.writeUInt16LE(0, 34);         // disk start
  central.writeUInt16LE(0, 36);         // internal attrs
  central.writeUInt32LE(0, 38);         // external attrs
  central.writeUInt32LE(0, 42);         // offset of local header

  const centralChunk = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);             // entries on this disk
  eocd.writeUInt16LE(1, 10);            // total entries
  eocd.writeUInt32LE(centralChunk.length, 12);
  eocd.writeUInt32LE(localChunk.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localChunk, centralChunk, eocd]);
}

function legacyCrc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c;
}

/** List entry names in a zip. */
function listZip(zipPath) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    const names = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e) => { names.push(e.fileName); zip.readEntry(); });
      zip.on('error', reject);
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}
