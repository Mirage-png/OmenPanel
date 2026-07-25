/**
 * OmenHosting — Backblaze B2 storage provider
 *
 * Implements the B2 native API (https://www.backblaze.com/apidocs).
 *
 * Auth:
 *   b2_authorize_account with HTTP Basic (keyId:applicationKey) returns a
 *   24-hour authorizationToken plus the apiUrl/downloadUrl to use for
 *   everything else. The token is refreshed automatically on expiry, and once
 *   more if a call comes back 401 (the token can be revoked early).
 *
 * Uploads:
 *   Files below LARGE_FILE_THRESHOLD go through b2_upload_file in one request.
 *   Larger ones use the large-file API (start → per-part upload → finish),
 *   which is mandatory above 5 GB and gives resumable, bounded-memory uploads
 *   for big worlds.
 *
 *   B2 requires the SHA-1 of every payload up front, so the archive is hashed
 *   in one streaming pass and then streamed again to upload. Nothing is ever
 *   held in memory in full.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { StorageProvider } = require('./provider');

const AUTH_URL = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';
const API_VERSION = 'v4';
const REQUEST_TIMEOUT = 300000;
/** Per-address connect budget; see the note in httpRequest(). */
const CONNECT_ATTEMPT_TIMEOUT = 30000;

/** Above this, switch to the large-file (multipart) API. */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;   // 100 MB
/** B2 rejects parts below 5 MB except the final one. */
const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 100 * 1024 * 1024;
/** Transient failures are retried; B2 explicitly asks clients to back off. */
const MAX_ATTEMPTS = 4;

class B2Provider extends StorageProvider {
  /**
   * @param {Object} cfg
   * @param {string} cfg.keyId            B2 applicationKeyId
   * @param {string} cfg.applicationKey   B2 applicationKey
   * @param {string} cfg.bucket           Bucket name
   * @param {string} [cfg.bucketId]       Skips a lookup when supplied
   * @param {string} [cfg.remoteRoot]     Key prefix for all backups
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.auth = null;          // { token, apiUrl, downloadUrl, accountId, expiresAt }
    this.bucketId = cfg.bucketId || '';
    this.partSize = DEFAULT_PART_SIZE;
  }

  get name() {
    return 'b2';
  }

  // ─── HTTP plumbing ──────────────────────────────────────────────

  /** Raw request; resolves with status/headers/text and never throws on 4xx/5xx. */
  httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const transport = options.protocol === 'http:' ? http : https;
      const req = transport.request({
        timeout: REQUEST_TIMEOUT,
        // Node 20+ races IPv6/IPv4 with a 250 ms per-attempt budget. On a slow
        // or high-latency link every attempt blows that budget and the connect
        // fails with an ETIMEDOUT AggregateError even though the host is
        // perfectly reachable, so the window is widened here.
        autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT,
        ...options
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8')
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('B2 request timed out')));
      if (body) req.write(body);
      req.end();
    });
  }

  /** True for statuses B2 documents as worth retrying. */
  static isRetryable(status) {
    return status === 408 || status === 429 || status === 500 || status === 503;
  }

  /**
   * Connection-level failures (DNS blips, resets, timeouts) are as common as
   * HTTP errors on long unattended uploads, and are equally worth retrying.
   */
  static isRetryableNetworkError(err) {
    return !!err && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']
      .includes(err.code || (err.errors && err.errors[0] && err.errors[0].code));
  }

  /** Run `fn`, retrying transient network failures with backoff. */
  static async withNetworkRetry(fn, label) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!B2Provider.isRetryableNetworkError(err) || attempt === MAX_ATTEMPTS) throw err;
        console.warn(`[storage:b2] ${label}: ${err.code || err.message}, retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(500 * Math.pow(2, attempt - 1));
      }
    }
    throw lastError;
  }

  /**
   * JSON call against the storage API, with auth refresh on 401 and bounded
   * retries with backoff on transient failures.
   */
  async apiCall(endpoint, payload, { auth = true } = {}) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const session = auth ? await this.authorize() : null;
      const url = new URL(`${session.apiUrl}/b2api/${API_VERSION}/${endpoint}`);
      const body = JSON.stringify(payload || {});

      const res = await B2Provider.withNetworkRetry(() => this.httpRequest({
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: session.token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, body), endpoint);

      if (res.status === 200) {
        try {
          return JSON.parse(res.text);
        } catch {
          throw new Error(`${endpoint}: malformed JSON response`);
        }
      }

      // An expired or revoked token: drop it and try once more.
      if (res.status === 401) {
        this.auth = null;
        lastError = new Error(`${endpoint}: unauthorized (${describeB2Error(res.text)})`);
        if (attempt < MAX_ATTEMPTS) continue;
        throw lastError;
      }

      lastError = new Error(`${endpoint}: HTTP ${res.status} — ${describeB2Error(res.text)}`);
      if (B2Provider.isRetryable(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }

    throw lastError;
  }

  // ─── Auth ───────────────────────────────────────────────────────

  /** Authorize, caching the token until shortly before it expires. */
  async authorize() {
    if (this.auth && Date.now() < this.auth.expiresAt) return this.auth;

    const basic = Buffer.from(`${this.cfg.keyId}:${this.cfg.applicationKey}`).toString('base64');
    const url = new URL(AUTH_URL);

    const res = await B2Provider.withNetworkRetry(() => this.httpRequest({
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: { Authorization: `Basic ${basic}` }
    }), 'b2_authorize_account');

    if (res.status !== 200) {
      throw new Error(
        `b2_authorize_account failed (HTTP ${res.status}): ${describeB2Error(res.text)}. ` +
        'Check B2_KEY_ID and B2_APPLICATION_KEY.'
      );
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error('b2_authorize_account returned malformed JSON');
    }

    // v4 nests these under apiInfo.storageApi; older versions had them at the
    // top level. Accept both so a version bump does not break auth.
    const storage = (data.apiInfo && data.apiInfo.storageApi) || data;
    if (!storage.apiUrl || !data.authorizationToken) {
      throw new Error('b2_authorize_account response missing apiUrl or authorizationToken');
    }

    if (storage.recommendedPartSize) {
      this.partSize = Math.max(MIN_PART_SIZE, storage.recommendedPartSize);
    }

    this.auth = {
      token: data.authorizationToken,
      apiUrl: storage.apiUrl.replace(/\/$/, ''),
      downloadUrl: (storage.downloadUrl || '').replace(/\/$/, ''),
      accountId: data.accountId,
      allowed: storage.allowed || data.allowed || {},
      // Tokens last 24h; refresh well before that.
      expiresAt: Date.now() + 23 * 60 * 60 * 1000
    };
    return this.auth;
  }

  /** Resolve the bucket name to its id (cached). */
  async resolveBucketId() {
    if (this.bucketId) return this.bucketId;
    const session = await this.authorize();

    // A bucket-scoped key already tells us the bucket without a lookup.
    const allowedBuckets = session.allowed && session.allowed.buckets;
    if (Array.isArray(allowedBuckets)) {
      const match = allowedBuckets.find((b) => b.name === this.cfg.bucket);
      if (match && match.id) {
        this.bucketId = match.id;
        return this.bucketId;
      }
    }

    const res = await this.apiCall('b2_list_buckets', {
      accountId: session.accountId,
      bucketName: this.cfg.bucket
    });

    const bucket = (res.buckets || []).find((b) => b.bucketName === this.cfg.bucket);
    if (!bucket) {
      const names = (res.buckets || []).map((b) => b.bucketName).join(', ') || '(none visible)';
      throw new Error(`B2 bucket "${this.cfg.bucket}" not found. Buckets available: ${names}`);
    }
    this.bucketId = bucket.bucketId;
    return this.bucketId;
  }

  async init() {
    if (!this.cfg.keyId || !this.cfg.applicationKey) {
      throw new Error('B2_KEY_ID and B2_APPLICATION_KEY must be set');
    }
    if (!this.cfg.bucket) throw new Error('B2_BUCKET must be set');

    await this.authorize();
    await this.resolveBucketId();
    console.log(`[storage:b2] Ready (bucket=${this.cfg.bucket} prefix=${this.cfg.remoteRoot || '/'})`);
  }

  // ─── Key mapping ────────────────────────────────────────────────

  /**
   * Remote paths are POSIX and absolute ("/uuid/file.zip"); B2 keys have no
   * leading slash. The configured root is applied as a prefix.
   */
  toKey(remotePath) {
    const root = (this.cfg.remoteRoot || '').replace(/^\/+|\/+$/g, '');
    const rel = path.posix.normalize(remotePath).replace(/^\/+/, '');
    return root ? `${root}/${rel}` : rel;
  }

  /** Inverse of toKey, so callers keep seeing the paths they passed in. */
  fromKey(key) {
    const root = (this.cfg.remoteRoot || '').replace(/^\/+|\/+$/g, '');
    let rel = key;
    if (root && key.startsWith(root + '/')) rel = key.slice(root.length + 1);
    return '/' + rel;
  }

  // ─── Hashing ────────────────────────────────────────────────────

  /** Streaming SHA-1 of a whole file — B2 requires it before the upload. */
  static sha1File(localPath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      let size = 0;
      fs.createReadStream(localPath, { highWaterMark: 1024 * 1024 })
        .on('data', (c) => { hash.update(c); size += c.length; })
        .on('error', reject)
        .on('end', () => resolve({ sha1: hash.digest('hex'), size }));
    });
  }

  /** SHA-1 of one part, read as a bounded slice. */
  static sha1Range(localPath, start, end) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      fs.createReadStream(localPath, { start, end })
        .on('data', (c) => hash.update(c))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  static readRange(localPath, start, end) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      fs.createReadStream(localPath, { start, end })
        .on('data', (c) => chunks.push(c))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  // ─── Upload ─────────────────────────────────────────────────────

  async upload(localPath, remotePath, onProgress) {
    const { size } = fs.statSync(localPath);
    return size >= LARGE_FILE_THRESHOLD
      ? this.uploadLarge(localPath, remotePath, size, onProgress)
      : this.uploadSmall(localPath, remotePath, size, onProgress);
  }

  /** Single-request upload for ordinary archives. */
  async uploadSmall(localPath, remotePath, size, onProgress) {
    const bucketId = await this.resolveBucketId();
    const { sha1 } = await B2Provider.sha1File(localPath);
    const key = this.toKey(remotePath);

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Upload URLs are single-use-ish and can go stale, so one is fetched per
      // attempt rather than cached.
      const { uploadUrl, authorizationToken } = await this.apiCall('b2_get_upload_url', { bucketId });
      const url = new URL(uploadUrl);

      // A reset or timeout mid-body must be retried like any other transient
      // failure — an unattended nightly backup cannot fail on one dropped
      // connection. The upload is restarted from the beginning because the
      // request body is a stream that cannot be rewound.
      let res;
      try {
        res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: 'POST',
          timeout: REQUEST_TIMEOUT,
          autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT,
          headers: {
            Authorization: authorizationToken,
            'X-Bz-File-Name': encodeURIComponent(key),
            'Content-Type': 'application/zip',
            'Content-Length': size,
            'X-Bz-Content-Sha1': sha1
          }
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('B2 upload timed out')));

        let sent = 0;
        const stream = fs.createReadStream(localPath);
        stream.on('data', (c) => {
          sent += c.length;
          if (onProgress) onProgress(sent, size);
        });
        stream.on('error', (err) => { req.destroy(err); reject(err); });
        stream.pipe(req);
        });
      } catch (err) {
        lastError = err;
        if (B2Provider.isRetryableNetworkError(err) && attempt < MAX_ATTEMPTS) {
          console.warn(`[storage:b2] upload ${key}: ${err.code || err.message}, retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        throw err;
      }

      if (res.status === 200) {
        if (onProgress) onProgress(size, size);
        return { size };
      }

      lastError = new Error(`b2_upload_file: HTTP ${res.status} — ${describeB2Error(res.text)}`);
      // 401/503 here mean "get a fresh upload URL and retry", per B2's docs.
      if ((res.status === 401 || B2Provider.isRetryable(res.status)) && attempt < MAX_ATTEMPTS) {
        if (res.status === 401) this.auth = null;
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  /** Large-file upload: start → parts → finish. Required above 5 GB. */
  async uploadLarge(localPath, remotePath, size, onProgress) {
    const bucketId = await this.resolveBucketId();
    const key = this.toKey(remotePath);

    const start = await this.apiCall('b2_start_large_file', {
      bucketId,
      fileName: key,
      contentType: 'application/zip'
    });
    const fileId = start.fileId;

    try {
      const partSize = Math.max(MIN_PART_SIZE, this.partSize);
      const partCount = Math.ceil(size / partSize);
      const sha1Array = [];
      let uploaded = 0;

      for (let i = 0; i < partCount; i++) {
        const from = i * partSize;
        const to = Math.min(from + partSize, size) - 1;
        const partSha1 = await B2Provider.sha1Range(localPath, from, to);
        const buffer = await B2Provider.readRange(localPath, from, to);

        await this.uploadPart(fileId, i + 1, buffer, partSha1);
        sha1Array.push(partSha1);
        uploaded += buffer.length;
        if (onProgress) onProgress(uploaded, size);
      }

      await this.apiCall('b2_finish_large_file', { fileId, partSha1Array: sha1Array });
      if (onProgress) onProgress(size, size);
      return { size };
    } catch (err) {
      // Leaving an unfinished large file behind would silently consume storage.
      try { await this.apiCall('b2_cancel_large_file', { fileId }); } catch { /* best effort */ }
      throw err;
    }
  }

  async uploadPart(fileId, partNumber, buffer, sha1) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { uploadUrl, authorizationToken } = await this.apiCall('b2_get_upload_part_url', { fileId });
      const url = new URL(uploadUrl);

      const res = await B2Provider.withNetworkRetry(() => this.httpRequest({
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: authorizationToken,
          'X-Bz-Part-Number': partNumber,
          'Content-Length': buffer.length,
          'X-Bz-Content-Sha1': sha1
        }
      }, buffer), `b2_upload_part ${partNumber}`);

      if (res.status === 200) return;

      lastError = new Error(`b2_upload_part ${partNumber}: HTTP ${res.status} — ${describeB2Error(res.text)}`);
      if ((res.status === 401 || B2Provider.isRetryable(res.status)) && attempt < MAX_ATTEMPTS) {
        if (res.status === 401) this.auth = null;
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  // ─── Listing ────────────────────────────────────────────────────

  async list(remoteDir) {
    const bucketId = await this.resolveBucketId();
    const prefix = this.toKey(remoteDir).replace(/\/+$/, '') + '/';

    const files = [];
    let startFileName = null;

    // Paginate so a server with many retained backups is fully enumerated.
    do {
      const res = await this.apiCall('b2_list_file_names', {
        bucketId,
        prefix,
        delimiter: '/',       // this level only, no recursion
        maxFileCount: 1000,
        startFileName
      });

      for (const f of res.files || []) {
        // Directory placeholders come back as "folder" actions.
        if (f.action && f.action !== 'upload') continue;
        files.push({
          path: this.fromKey(f.fileName),
          name: path.posix.basename(f.fileName),
          size: Number(f.contentLength) || 0,
          modified: Number(f.uploadTimestamp) || 0,
          fileId: f.fileId
        });
      }
      startFileName = res.nextFileName || null;
    } while (startFileName);

    return files.sort((a, b) => b.modified - a.modified);
  }

  // ─── Download ───────────────────────────────────────────────────

  async download(remotePath, localPath, onProgress) {
    const session = await this.authorize();
    const key = this.toKey(remotePath);
    const url = `${session.downloadUrl}/file/${encodeURIComponent(this.cfg.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const size = await this.streamToFile(url, localPath, onProgress);
    return { size };
  }

  /** Streams straight to disk, following redirects, verifying completeness. */
  streamToFile(url, localPath, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects downloading from B2'));

      this.authorize().then((session) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'http:' ? http : https;

        const req = transport.get({
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          timeout: REQUEST_TIMEOUT,
          autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT,
          headers: { Authorization: session.token }
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return resolve(this.streamToFile(new URL(res.headers.location, url).toString(), localPath, onProgress, redirects + 1));
          }
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => reject(new Error(
              `B2 download failed (HTTP ${res.statusCode}): ${describeB2Error(Buffer.concat(chunks).toString('utf8'))}`
            )));
            return;
          }

          const total = Number(res.headers['content-length']) || 0;
          let received = 0;
          const out = fs.createWriteStream(localPath);

          res.on('data', (c) => {
            received += c.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(out);

          out.on('error', (err) => { res.destroy(); reject(err); });
          res.on('error', (err) => { out.destroy(); reject(err); });
          out.on('finish', () => {
            // A truncated transfer that still closed cleanly would otherwise
            // look like success and yield a corrupt archive.
            if (total && received !== total) {
              return reject(new Error(`Download truncated: got ${received} of ${total} bytes`));
            }
            resolve(received);
          });
        });

        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('B2 download timed out')));
      }).catch(reject);
    });
  }

  // ─── Delete ─────────────────────────────────────────────────────

  /**
   * B2 keeps versions, so every version of the key is removed — otherwise
   * retention would appear to work while storage kept growing.
   */
  async remove(remotePath) {
    const bucketId = await this.resolveBucketId();
    const key = this.toKey(remotePath);

    const res = await this.apiCall('b2_list_file_versions', {
      bucketId,
      startFileName: key,
      prefix: key,
      maxFileCount: 1000
    });

    const versions = (res.files || []).filter((f) => f.fileName === key);
    if (!versions.length) return;   // already gone

    for (const v of versions) {
      try {
        await this.apiCall('b2_delete_file_version', { fileName: v.fileName, fileId: v.fileId });
      } catch (err) {
        if (/not_present|no such file/i.test(err.message)) continue;
        throw err;
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Pull B2's structured error out of a response body for readable logs. */
function describeB2Error(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed.code || parsed.message) return `${parsed.code || 'error'}: ${parsed.message || ''}`.trim();
  } catch { /* not json */ }
  return (text || '').slice(0, 200) || 'no response body';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { B2Provider, LARGE_FILE_THRESHOLD, MIN_PART_SIZE };
