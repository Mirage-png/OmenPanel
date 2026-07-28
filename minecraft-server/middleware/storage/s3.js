/**
 * OmenHosting — S3-compatible storage provider
 *
 * Works against any service that speaks the S3 REST API with SigV4 auth:
 * Filebase, AWS S3, Cloudflare R2, MinIO, etc. No AWS SDK dependency — just
 * the request signing, implemented directly against the published algorithm
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html),
 * matching this project's existing pattern of talking to storage APIs over
 * raw HTTPS (see b2.js).
 *
 * Uploads are single-PUT, streamed from disk. That caps a single object at
 * 5 GB (S3's hard limit for a non-multipart PUT) — fine for panel state and
 * most world archives; a very large modpack world could exceed it, in which
 * case split the backup or use the B2 provider, which does implement
 * multipart for exactly that case.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { StorageProvider } = require('./provider');

const REQUEST_TIMEOUT = 300000;
// list() is metadata-only (used by init()'s own connectivity check, and the
// comment there already promises "fails fast") -- it has no business sharing
// REQUEST_TIMEOUT with actual file transfers. Before this fix it did: a
// misconfigured/unreachable endpoint (not a hard refusal, just no response)
// meant init() could sit for the full 5 minutes before restoreState() ever
// gave up, and restore-state.js runs before the daemon even starts -- long
// enough alone to make deploy-start.sh look permanently hung from outside.
const LIST_TIMEOUT = 15000;
const CONNECT_ATTEMPT_TIMEOUT = 30000;
const MAX_ATTEMPTS = 4;
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

class S3Provider extends StorageProvider {
  /**
   * @param {Object} cfg
   * @param {string} cfg.endpoint    Full endpoint URL, e.g. https://s3.filebase.io
   * @param {string} cfg.accessKeyId
   * @param {string} cfg.secretAccessKey
   * @param {string} cfg.bucket
   * @param {string} [cfg.region]      Defaults to 'auto' (Filebase's documented value)
   * @param {string} [cfg.remoteRoot]  Key prefix for all objects
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.region = cfg.region || 'auto';
    this.endpoint = new URL(cfg.endpoint);
  }

  get name() {
    return 's3';
  }

  async init() {
    if (!this.cfg.accessKeyId || !this.cfg.secretAccessKey) {
      throw new Error('S3 access key / secret key must be set');
    }
    if (!this.cfg.bucket) throw new Error('S3 bucket must be set');
    // A cheap, harmless call that fails fast on bad credentials/bucket/endpoint.
    await this.list('/');
    console.log(`[storage:s3] Ready (endpoint=${this.endpoint.host} bucket=${this.cfg.bucket} prefix=${this.cfg.remoteRoot || '/'})`);
  }

  // ─── Key mapping ────────────────────────────────────────────────

  toKey(remotePath) {
    const root = (this.cfg.remoteRoot || '').replace(/^\/+|\/+$/g, '');
    const rel = path.posix.normalize(remotePath).replace(/^\/+/, '');
    return root ? `${root}/${rel}` : rel;
  }

  fromKey(key) {
    const root = (this.cfg.remoteRoot || '').replace(/^\/+|\/+$/g, '');
    let rel = key;
    if (root && key.startsWith(root + '/')) rel = key.slice(root.length + 1);
    return '/' + rel;
  }

  // ─── SigV4 signing ──────────────────────────────────────────────

  static hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  }

  static sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Streaming SHA-256 of a whole file. Filebase (unlike AWS S3 proper)
   * rejects UNSIGNED-PAYLOAD on PUT with a bare 403, so the payload hash has
   * to be the real content hash — same two-pass-read tradeoff the B2
   * provider already makes for its required SHA-1.
   */
  static sha256File(localPath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(localPath, { highWaterMark: 1024 * 1024 })
        .on('data', (c) => hash.update(c))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  signingKey(dateStamp) {
    const kDate = S3Provider.hmac('AWS4' + this.cfg.secretAccessKey, dateStamp);
    const kRegion = S3Provider.hmac(kDate, this.region);
    const kService = S3Provider.hmac(kRegion, 's3');
    return S3Provider.hmac(kService, 'aws4_request');
  }

  /**
   * Builds signed request options for path+bucket-style access
   * (https://endpoint/bucket/key), which every S3-compatible provider
   * supports even when it also offers virtual-hosted-style.
   */
  sign({ method, key, query = {}, headers = {}, payloadHash = UNSIGNED_PAYLOAD }) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const keySegments = key ? key.split('/').map(encodeURIComponent) : [];
    const canonicalUri = '/' + [this.cfg.bucket, ...keySegments].join('/');
    const sortedQueryKeys = Object.keys(query).sort();
    const canonicalQuery = sortedQueryKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');

    // AWS SigV4 requires lowercase header names in the canonical request;
    // caller-supplied headers (e.g. "Content-Length") must be normalized
    // here or the required alphabetical sort — and the signature — breaks.
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;

    const allHeaders = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...lowerHeaders
    };
    const sortedHeaderKeys = Object.keys(allHeaders).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${String(allHeaders[k]).trim()}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      S3Provider.sha256Hex(canonicalRequest)
    ].join('\n');

    const signature = crypto.createHmac('sha256', this.signingKey(dateStamp)).update(stringToSign, 'utf8').digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      hostname: this.endpoint.hostname,
      port: this.endpoint.port || undefined,
      protocol: this.endpoint.protocol,
      path: canonicalUri + (canonicalQuery ? `?${canonicalQuery}` : ''),
      method,
      headers: {
        ...lowerHeaders,
        host: this.endpoint.host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization
      }
    };
  }

  // ─── HTTP plumbing ──────────────────────────────────────────────

  httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const transport = options.protocol === 'http:' ? http : https;
      const req = transport.request({
        timeout: REQUEST_TIMEOUT,
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
      req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
      if (body) req.write(body);
      req.end();
    });
  }

  static isRetryableNetworkError(err) {
    return !!err && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']
      .includes(err.code || (err.errors && err.errors[0] && err.errors[0].code));
  }

  static isRetryable(status) {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503;
  }

  async withRetry(fn, label) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!S3Provider.isRetryableNetworkError(err) || attempt === MAX_ATTEMPTS) throw err;
        console.warn(`[storage:s3] ${label}: ${err.code || err.message}, retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(500 * Math.pow(2, attempt - 1));
      }
    }
    throw lastError;
  }

  static describeError(text) {
    const m = /<Message>([^<]*)<\/Message>/.exec(text || '');
    return m ? m[1] : (text || '').slice(0, 200) || 'no response body';
  }

  // ─── Upload ─────────────────────────────────────────────────────

  async upload(localPath, remotePath, onProgress) {
    const { size } = fs.statSync(localPath);
    const key = this.toKey(remotePath);
    const payloadHash = await S3Provider.sha256File(localPath);

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const opts = this.sign({
        method: 'PUT',
        key,
        payloadHash,
        headers: { 'Content-Length': String(size) }
      });

      try {
        const res = await this.withRetry(() => new Promise((resolve, reject) => {
          const transport = opts.protocol === 'http:' ? http : https;
          const req = transport.request({ ...opts, timeout: REQUEST_TIMEOUT, autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('S3 upload timed out')));

          let sent = 0;
          const stream = fs.createReadStream(localPath);
          stream.on('data', (c) => { sent += c.length; if (onProgress) onProgress(sent, size); });
          stream.on('error', (err) => { req.destroy(err); reject(err); });
          stream.pipe(req);
        }), `PUT ${key}`);

        if (res.status >= 200 && res.status < 300) {
          if (onProgress) onProgress(size, size);
          return { size };
        }
        if (process.env.OMEN_S3_DEBUG) console.error('[storage:s3] DEBUG upload response:', res.status, res.text);
        lastError = new Error(`S3 upload failed (HTTP ${res.status}): ${S3Provider.describeError(res.text)}`);
      } catch (err) {
        lastError = err;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[storage:s3] upload ${key}: ${lastError.message}, retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  // ─── Download ───────────────────────────────────────────────────

  async download(remotePath, localPath, onProgress) {
    const key = this.toKey(remotePath);
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const opts = this.sign({ method: 'GET', key, payloadHash: S3Provider.sha256Hex('') });

      try {
        const size = await new Promise((resolve, reject) => {
          const transport = opts.protocol === 'http:' ? http : https;
          const req = transport.request({ ...opts, timeout: REQUEST_TIMEOUT, autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT }, (res) => {
            if (res.statusCode !== 200) {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => reject(new Error(`S3 download failed (HTTP ${res.statusCode}): ${S3Provider.describeError(Buffer.concat(chunks).toString('utf8'))}`)));
              return;
            }
            const total = Number(res.headers['content-length']) || 0;
            let received = 0;
            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            const out = fs.createWriteStream(localPath);
            res.on('data', (c) => { received += c.length; if (onProgress) onProgress(received, total); });
            res.pipe(out);
            out.on('error', (err) => { res.destroy(); reject(err); });
            res.on('error', (err) => { out.destroy(); reject(err); });
            out.on('finish', () => {
              if (total && received !== total) return reject(new Error(`Download truncated: got ${received} of ${total} bytes`));
              resolve(received);
            });
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('S3 download timed out')));
          req.end();
        });
        return { size };
      } catch (err) {
        lastError = err;
        if (S3Provider.isRetryableNetworkError(err) && attempt < MAX_ATTEMPTS) {
          console.warn(`[storage:s3] download ${key}: ${err.code || err.message}, retrying (${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  // ─── Listing ────────────────────────────────────────────────────

  async list(remoteDir) {
    const prefix = this.toKey(remoteDir).replace(/\/+$/, '');
    const normalizedPrefix = prefix ? prefix + '/' : '';

    const files = [];
    let continuationToken;

    do {
      const query = {
        'list-type': '2',
        prefix: normalizedPrefix,
        delimiter: '/',
        'max-keys': '1000'
      };
      if (continuationToken) query['continuation-token'] = continuationToken;

      const opts = { ...this.sign({ method: 'GET', key: '', query, payloadHash: S3Provider.sha256Hex('') }), timeout: LIST_TIMEOUT };
      const res = await this.withRetry(() => this.httpRequest(opts), 'ListObjectsV2');

      if (res.status === 404) return [];
      if (res.status !== 200) throw new Error(`S3 list failed (HTTP ${res.status}): ${S3Provider.describeError(res.text)}`);

      for (const m of res.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = m[1];
        const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
        if (!key || key === normalizedPrefix) continue;
        const size = Number(/<Size>([^<]*)<\/Size>/.exec(block)?.[1] || 0);
        const modified = /<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1];
        files.push({
          path: this.fromKey(key),
          name: path.posix.basename(key),
          size,
          modified: modified ? new Date(modified).getTime() : 0
        });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(res.text);
      continuationToken = truncated ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(res.text)?.[1] : null;
    } while (continuationToken);

    return files.sort((a, b) => b.modified - a.modified);
  }

  // ─── Delete ─────────────────────────────────────────────────────

  async remove(remotePath) {
    const key = this.toKey(remotePath);
    const opts = this.sign({ method: 'DELETE', key, payloadHash: S3Provider.sha256Hex('') });
    const res = await this.withRetry(() => this.httpRequest(opts), `DELETE ${key}`);
    // 404/204 both mean "gone" — deleting a missing object must not throw.
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`S3 delete failed (HTTP ${res.status}): ${S3Provider.describeError(res.text)}`);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { S3Provider };
