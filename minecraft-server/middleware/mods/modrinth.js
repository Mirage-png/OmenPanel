/**
 * OmenHosting — Modpack installer & plugin manager (Modrinth-backed)
 *
 * Modrinth's public API (https://docs.modrinth.com) needs no credentials and
 * covers both project types we care about:
 *   project_type:plugin  -> Bukkit/Spigot/Paper/Purpur plugins  -> plugins/
 *   project_type:mod     -> Fabric/Forge/NeoForge mods          -> mods/
 *   project_type:modpack -> .mrpack bundles                     -> whole server
 *
 * Security notes, because everything here is driven by remote data:
 *   - Downloads are restricted to Modrinth's own hosts. A version file URL is
 *     attacker-influenced data, so an unrestricted fetch would be an SSRF.
 *   - A .mrpack index lists destination paths chosen by the pack author. Every
 *     one is resolved and checked to stay inside the instance directory, so a
 *     malicious pack cannot write to ../../ anywhere on the host.
 *   - Downloads stream to disk; packs are hundreds of MB.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const API = 'api.modrinth.com';
const USER_AGENT = 'OmenHosting-Panel/1.0 (minecraft server panel)';
const REQUEST_TIMEOUT = 60000;

/** Only these hosts may be fetched from. */
const ALLOWED_HOSTS = new Set(['api.modrinth.com', 'cdn.modrinth.com', 'cdn-raw.modrinth.com']);

function assertAllowedHost(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Refusing to fetch a malformed URL: ${urlString}`);
  }
  if (parsed.protocol !== 'https:') throw new Error('Refusing a non-HTTPS download');
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to download from an unexpected host: ${parsed.hostname}`);
  }
  return parsed;
}

/** GET JSON from the Modrinth API. */
function apiGet(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API,
      path: pathWithQuery,
      method: 'GET',
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`Modrinth API ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('Modrinth returned malformed JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Modrinth request timed out')));
    req.end();
  });
}

/**
 * Stream a file to disk, following redirects, verifying the host each hop and
 * the SHA-1 at the end when the index supplies one.
 */
function download(urlString, destPath, expectedSha1, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects while downloading'));
    const parsed = assertAllowedHost(urlString);

    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, urlString).toString(), destPath, expectedSha1, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const hash = crypto.createHash('sha1');
      const out = fs.createWriteStream(destPath);
      let bytes = 0;

      res.on('data', (c) => { bytes += c.length; hash.update(c); });
      res.pipe(out);
      res.on('error', (err) => { out.destroy(); reject(err); });
      out.on('error', (err) => { res.destroy(); reject(err); });
      out.on('finish', () => {
        if (expectedSha1) {
          const actual = hash.digest('hex');
          if (actual !== expectedSha1) {
            // A mismatch means corruption or tampering; never leave it behind.
            fs.promises.unlink(destPath).catch(() => {});
            return reject(new Error(`Checksum mismatch for ${path.basename(destPath)}`));
          }
        }
        resolve({ bytes });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
  });
}

// ─── Search / versions ─────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} opts.type   'plugin' | 'mod' | 'modpack'
 * @param {string} [opts.query]
 * @param {string} [opts.gameVersion]
 * @param {number} [opts.limit]
 */
async function search(opts) {
  const facets = [[`project_type:${opts.type}`]];
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);

  const params = new URLSearchParams({
    query: opts.query || '',
    facets: JSON.stringify(facets),
    limit: String(Math.min(50, opts.limit || 20)),
    index: opts.query ? 'relevance' : 'downloads'
  });

  const data = await apiGet(`/v2/search?${params.toString()}`);
  return (data.hits || []).map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    icon: h.icon_url,
    categories: h.categories,
    versions: h.versions
  }));
}

/** Versions for a project, newest first. */
async function versions(projectId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
  if (opts.gameVersion) params.set('game_versions', JSON.stringify([opts.gameVersion]));
  const qs = params.toString();

  const data = await apiGet(`/v2/project/${encodeURIComponent(projectId)}/version${qs ? '?' + qs : ''}`);
  return (data || []).map((v) => {
    const primary = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    return {
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      datePublished: v.date_published,
      file: primary && {
        url: primary.url,
        filename: primary.filename,
        size: primary.size,
        sha1: primary.hashes && primary.hashes.sha1
      }
    };
  }).filter((v) => v.file);
}

async function versionById(versionId) {
  const v = await apiGet(`/v2/version/${encodeURIComponent(versionId)}`);
  const primary = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!primary) throw new Error('That version has no downloadable file');
  return {
    id: v.id,
    name: v.name,
    projectId: v.project_id,
    versionNumber: v.version_number,
    loaders: v.loaders,
    gameVersions: v.game_versions,
    file: {
      url: primary.url,
      filename: primary.filename,
      size: primary.size,
      sha1: primary.hashes && primary.hashes.sha1
    }
  };
}

// ─── Installation ──────────────────────────────────────────────────

/** Resolve a path from remote data, refusing anything outside the instance. */
function safeJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to write outside the server directory: ${relative}`);
  }
  return target;
}

/**
 * Install a single plugin or mod jar.
 *
 * @param {Object} opts
 * @param {string} opts.serverDir
 * @param {string} opts.versionId
 * @param {'plugin'|'mod'} opts.type
 */
async function installJar(opts) {
  const version = await versionById(opts.versionId);
  const folder = opts.type === 'mod' ? 'mods' : 'plugins';
  // filename comes from Modrinth; basename it so it cannot carry a path.
  const filename = path.basename(version.file.filename);
  if (!/\.jar$/i.test(filename)) throw new Error('That version is not a .jar file');

  const dest = safeJoin(opts.serverDir, path.join(folder, filename));
  await download(version.file.url, dest, version.file.sha1);

  return {
    installed: filename,
    folder,
    bytes: version.file.size,
    versionNumber: version.versionNumber
  };
}

/**
 * Install a modpack from its .mrpack bundle.
 *
 * The format is a zip containing `modrinth.index.json` (a manifest of files to
 * fetch) plus an `overrides/` tree copied verbatim into the server directory.
 *
 * @param {Object} opts
 * @param {string} opts.serverDir
 * @param {string} opts.versionId
 * @param {string} opts.workDir       scratch space for the .mrpack
 * @param {(stage: string, done: number, total: number) => void} [opts.onProgress]
 */
async function installModpack(opts) {
  const { extractZip } = require('../backup/archive');

  const version = await versionById(opts.versionId);
  if (!/\.mrpack$/i.test(version.file.filename)) {
    throw new Error('That version is not a .mrpack modpack file');
  }

  fs.mkdirSync(opts.workDir, { recursive: true });
  const packPath = path.join(opts.workDir, `modpack-${crypto.randomBytes(6).toString('hex')}.mrpack`);
  const unpacked = packPath + '-extracted';

  try {
    if (opts.onProgress) opts.onProgress('Downloading modpack', 0, 1);
    await download(version.file.url, packPath, version.file.sha1);

    // A .mrpack is a zip; the existing extractor already refuses traversal.
    if (opts.onProgress) opts.onProgress('Unpacking modpack', 0, 1);
    fs.mkdirSync(unpacked, { recursive: true });
    await extractZip(packPath, unpacked);

    const indexPath = path.join(unpacked, 'modrinth.index.json');
    if (!fs.existsSync(indexPath)) throw new Error('Modpack is missing modrinth.index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    // Fetch every file the manifest asks for, into a checked destination.
    const files = Array.isArray(index.files) ? index.files : [];
    let done = 0;
    for (const entry of files) {
      const url = (entry.downloads || [])[0];
      if (!url || !entry.path) { done++; continue; }

      // Server-side packs mark client-only files as unsupported; skip those.
      const env = entry.env || {};
      if (env.server === 'unsupported') { done++; continue; }

      const dest = safeJoin(opts.serverDir, entry.path);
      await download(url, dest, entry.hashes && entry.hashes.sha1);
      done++;
      if (opts.onProgress) opts.onProgress('Downloading mods', done, files.length);
    }

    // overrides/ (and server-overrides/) are copied over the server directory.
    for (const dirName of ['overrides', 'server-overrides']) {
      const dir = path.join(unpacked, dirName);
      if (!fs.existsSync(dir)) continue;
      if (opts.onProgress) opts.onProgress(`Applying ${dirName}`, 0, 1);
      copyTree(dir, opts.serverDir, dir);
    }

    return {
      name: index.name || version.name,
      packVersion: index.versionId || version.versionNumber,
      files: files.length,
      dependencies: index.dependencies || {}
    };
  } finally {
    fs.promises.unlink(packPath).catch(() => {});
    fs.promises.rm(unpacked, { recursive: true, force: true }).catch(() => {});
  }
}

/** Recursive copy, re-checking every destination against the server root. */
function copyTree(from, serverDir, overridesRoot) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const relative = path.relative(overridesRoot, src);
    const dest = safeJoin(serverDir, relative);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, serverDir, overridesRoot);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

// ─── Installed inventory ───────────────────────────────────────────

/** List the jars currently present in plugins/ and mods/. */
function listInstalled(serverDir) {
  const out = { plugins: [], mods: [] };
  for (const folder of ['plugins', 'mods']) {
    const dir = path.join(serverDir, folder);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.jar(\.disabled)?$/i.test(e.name)) continue;
      let size = 0;
      let modified = 0;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        size = st.size;
        modified = st.mtimeMs;
      } catch { continue; }
      out[folder].push({
        name: e.name,
        size,
        modified,
        disabled: /\.disabled$/i.test(e.name)
      });
    }
    out[folder].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

/** Delete a jar. `filename` is treated as a bare name, never a path. */
function removeJar(serverDir, folder, filename) {
  if (folder !== 'plugins' && folder !== 'mods') throw new Error('Unknown folder');
  const name = path.basename(filename);
  if (!/\.jar(\.disabled)?$/i.test(name)) throw new Error('Only .jar files can be removed here');
  const target = safeJoin(serverDir, path.join(folder, name));
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { removed: name };
}

/** Enable/disable a jar by toggling a `.disabled` suffix. */
function toggleJar(serverDir, folder, filename) {
  if (folder !== 'plugins' && folder !== 'mods') throw new Error('Unknown folder');
  const name = path.basename(filename);
  const from = safeJoin(serverDir, path.join(folder, name));
  const to = /\.disabled$/i.test(name)
    ? from.replace(/\.disabled$/i, '')
    : from + '.disabled';
  fs.renameSync(from, to);
  return { name: path.basename(to), disabled: /\.disabled$/i.test(to) };
}

module.exports = {
  search, versions, versionById,
  installJar, installModpack,
  listInstalled, removeJar, toggleJar,
  safeJoin, ALLOWED_HOSTS
};
