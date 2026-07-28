const http = require('http');
const url = require('url');

// PORT is the platform-standard var (Render, and most other PaaS hosts, pick
// this up automatically and route external traffic to it); PROXY_PORT is
// this app's own older/local-only override. Neither is set on Replit, which
// instead maps a fixed external port to this app's own hardcoded default.
const PORT = process.env.PORT || process.env.PROXY_PORT || 3000;
const WEB = { host: '127.0.0.1', port: 23333 };
const DAEMON = { host: '127.0.0.1', port: 24444 };
const MIDDLEWARE = { host: '127.0.0.1', port: 29999 };

// Stylesheet first so the skin paints without waiting on script execution;
// the script is deferred because none of it needs to run before parse.
const THEME_LINK = `<link rel="stylesheet" href="/api/omen/theme.css">`;
const INJECT_SCRIPT = THEME_LINK + `<script defer src="/api/omen/inject.js"></script>`;

/**
 * Cold-start handling has gone through two versions before this one, in the
 * same direction each time — less visible machinery, not more:
 *   1. A `<meta http-equiv="refresh" content="2">` — a blind full-page reload
 *      every 2 seconds regardless of whether the backend was actually up.
 *   2. A branded "Loading panel..." page whose own client-side script polled
 *      /_omen/ready and reloaded once the backend answered — no more blind
 *      reloading, but still a visible custom page in between.
 * This version shows nothing at all: proxyRequest() below silently retries
 * the connection to the web panel server-side, for a GET/HEAD request, before
 * ever sending a response back to the browser. The visitor's browser just
 * shows its own native "waiting for omenpanel.onrender.com..." state — the
 * same thing it always shows for a slow page load — right up until the real
 * page is ready, then gets that real page directly. No separate screen, no
 * client-side polling loop, nothing to dislike the look of.
 */
// 100s (the original value here) turned out to be too short: a cold Render
// boot has to install the daemon and web panel's own dependencies (~150-300
// packages each) on a single shared vCPU before the web panel is even
// spawnable, and that alone was measured taking longer than 100s, surfacing
// as the plain-text fallback below instead of the retry actually working.
const WEB_RETRY_MAX_MS = 280000;
const WEB_RETRY_INTERVAL_MS = 2000;

/**
 * Number of proxies the hosting platform puts between the visitor and this
 * router, each of which appends one X-Forwarded-For entry.
 *
 * Measured on the live deployment rather than assumed:
 *   plain request   -> 35.144.47.23, 34.117.33.233, 35.191.147.240, 34.67.115.235
 *   forged XFF sent -> 1.2.3.4, 35.144.47.23, 34.117.33.233, 35.191.102.185, 136.115.212.231
 * where 35.144.47.23 was the caller's real public address. In both cases the
 * true client sits 3 entries from the end, and a forged value is *prepended*,
 * so counting from the right both lands on the right entry and cannot be
 * shifted by anything the client sends. Overridable in case the platform's
 * topology changes.
 */
const TRUSTED_PROXY_HOPS = Number(process.env.OMEN_TRUSTED_PROXY_HOPS || 3);

/**
 * The real client IP, for the X-Real-IP header the web panel reads to apply
 * its per-IP login-failure ban. Without this every visitor resolves to the
 * same address and a single visitor's failed logins lock out everyone.
 *
 * Taking the last entry is wrong here: those are the platform's own load
 * balancers, shared by every visitor *and* rotating between requests.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const idx = parts.length - 1 - TRUSTED_PROXY_HOPS;
      // Short chain means fewer proxies than expected (direct/internal call),
      // where the leftmost entry is the closest thing to an origin address.
      return idx >= 0 ? parts[idx] : parts[0];
    }
  }
  return req.socket.remoteAddress || '';
}

function getBackend(path) {
  if (path.startsWith('/socket.io')) return DAEMON;
  if (path.startsWith('/upload-new')) return DAEMON;
  if (path.startsWith('/upload-piece')) return DAEMON;
  if (path.startsWith('/upload/')) return DAEMON;
  if (path.startsWith('/download/')) return DAEMON;
  if (path.startsWith('/api/omen/inject.js')) return MIDDLEWARE;
  if (path.startsWith('/api/omen/')) return MIDDLEWARE;
  if (path === '/create') return MIDDLEWARE;
  return WEB;
}

/**
 * @param {Buffer} [body] Pre-read request body. Start requests are buffered so
 *   their instance UUIDs can be inspected, which consumes the stream — those
 *   bytes are replayed here instead of piping.
 */
function proxyRequest(req, res, target, body, retryState) {
  // Only a GET/HEAD to the web panel is safe to silently retry — there's no
  // request body to worry about re-sending, and it's the actual scenario
  // that matters (a visitor's browser loading the page while the backend is
  // still cold). Anything else (a POST while cold, or the daemon/middleware
  // not answering) falls back to an immediate plain response, same as before.
  const canRetry = target === WEB && (req.method === 'GET' || req.method === 'HEAD') && body === undefined;
  if (canRetry && !retryState) retryState = { startedAt: Date.now() };

  // X-Real-IP is always overwritten, never forwarded from the client, so a
  // visitor cannot forge it to dodge (or poison) the panel's per-IP ban.
  const headers = {
    ...req.headers,
    host: `${target.host}:${target.port}`,
    'x-real-ip': clientIp(req)
  };

  // HTML gets rewritten below, which only works on uncompressed bytes. Ask the
  // panel for identity encoding on document requests; every other response is
  // piped through untouched and keeps its compression.
  const wantsHtml = (req.headers['accept'] || '').includes('text/html');
  if (target === WEB && wantsHtml) headers['accept-encoding'] = 'identity';

  // Uploads/downloads to the daemon are large, slow file transfers on
  // whatever connection the visitor has — a longer *inactivity* timeout is
  // fine for ordinary API calls, but a momentary stall on a slow upload
  // (mobile network hiccup, a browser pause between chunks) kills the daemon
  // connection mid-transfer, leaving a truncated file on disk. That silent
  // truncation is what surfaces later as "invalid or corrupt jarfile" when
  // the server tries to start a server.jar that never finished uploading.
  //
  // The non-daemon default used to be 10s, which turned out to be too tight
  // for MIDDLEWARE routes that make their own sequential internal calls
  // (e.g. signup: admin login, then create-user, each a separate hop to the
  // web panel) — under Render's CPU-constrained free tier those two hops
  // alone could exceed 10s, timing this out before either one even had a
  // chance to fail on its own terms.
  const isDaemonTransfer = target === DAEMON;
  const opts = {
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers,
    timeout: isDaemonTransfer ? 600000 : 45000
  };

  function handleFailure() {
    if (res.headersSent) return;
    if (canRetry && Date.now() - retryState.startedAt < WEB_RETRY_MAX_MS) {
      setTimeout(() => proxyRequest(req, res, target, body, retryState), WEB_RETRY_INTERVAL_MS);
      return;
    }
    if (target === WEB) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('The panel is taking longer than usual to start. Please try again shortly.');
    } else {
      // MIDDLEWARE/DAEMON API routes are called by inject.js's own fetch()
      // calls (signup, network config, backups, ...), all of which parse the
      // response as JSON — a plain-text body here used to fail that parse
      // and surface as a generic, unhelpful "Connection error" regardless of
      // what actually went wrong.
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service starting, please try again shortly.' }));
    }
  }

  const proxy = http.request(opts, (upstream) => {
    // Inject script into HTML responses. Compressed bodies are passed straight
    // through — decoding them here would cost more than the injection is worth,
    // and rewriting the raw bytes would corrupt the page.
    const ct = upstream.headers['content-type'] || '';
    const encoded = !!upstream.headers['content-encoding'];
    if (target === WEB && ct.includes('text/html') && !encoded) {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');

        // The panel's index.html already ships its own inject.js tag, so only
        // the stylesheet is needed there; a second script tag is a wasted request.
        const snippet = body.includes('api/omen/inject.js') ? THEME_LINK : INJECT_SCRIPT;

        if (body.includes('</head>')) {
          body = body.replace('</head>', snippet + '</head>');
        } else if (body.includes('</body>')) {
          body = body.replace('</body>', snippet + '</body>');
        } else {
          body += snippet;
        }
        const headers = { ...upstream.headers };
        headers['content-length'] = Buffer.byteLength(body);
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        res.writeHead(upstream.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res, { end: true });
    }
  });

  proxy.on('error', handleFailure);
  proxy.on('timeout', () => { proxy.destroy(); handleFailure(); });

  if (body !== undefined) {
    // Stream already drained by the start-request inspection.
    if (body.length) proxy.write(body);
    proxy.end();
  } else if (canRetry) {
    // A GET/HEAD has no body to send — end immediately rather than piping
    // req, so a retry never has to worry about req's stream already having
    // been consumed by an earlier attempt.
    proxy.end();
  } else {
    req.pipe(proxy, { end: true });
  }
}

// Panel endpoints that launch an instance. A server whose local files are gone
// (wiped volume, fresh container) must be restored from cloud backup first, and
// intercepting here covers every route into a start — the console page, the
// instance list, and restarts — not just the ones the middleware initiates.
const START_PATHS = [
  '/api/protected_instance/open',
  '/api/protected_instance/restart',
  '/api/instance/multi_open',
  '/api/instance/multi_restart'
];

function isStartRequest(pathname, method) {
  return method === 'POST' && START_PATHS.some((p) => pathname.startsWith(p));
}

/**
 * Pull instance UUIDs out of a start request. Single-instance calls carry the
 * uuid in the query string; multi_* calls carry an array in the JSON body.
 */
function extractInstanceUuids(parsed, body) {
  const uuids = new Set();

  const q = new URLSearchParams(parsed.query || '');
  const single = q.get('uuid');
  if (single) uuids.add(single);

  if (body && body.length) {
    try {
      const parsedBody = JSON.parse(body.toString('utf8'));
      const list = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      for (const item of list) {
        if (item && item.instanceUuid) uuids.add(item.instanceUuid);
      }
    } catch { /* not JSON; fall back to the query string alone */ }
  }

  return [...uuids];
}

/** Ask the middleware whether these servers' files are present. */
function checkPrestart(uuids) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ uuids });
    const proxyReq = http.request({
      hostname: MIDDLEWARE.host,
      port: MIDDLEWARE.port,
      path: '/api/omen/prestart',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000
    }, (upstream) => {
      let data = '';
      upstream.on('data', (c) => data += c);
      upstream.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ready: true }); }
      });
    });
    // Fail open on any middleware problem: a backup subsystem that is down
    // must never block someone from starting their server.
    proxyReq.on('error', () => resolve({ ready: true }));
    proxyReq.on('timeout', () => { proxyReq.destroy(); resolve({ ready: true }); });
    proxyReq.write(payload);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const target = getBackend(parsed.path);

  // Gate starts on the server's files actually being present.
  if (target === WEB && isStartRequest(parsed.pathname, req.method)) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const uuids = extractInstanceUuids(parsed, body);

      if (!uuids.length) return proxyRequest(req, res, target, body);

      const verdict = await checkPrestart(uuids);
      if (verdict.ready) return proxyRequest(req, res, target, body);

      // A restore is running; it starts the server itself once finished, so
      // the start request is answered rather than forwarded. MCSManager renders
      // `data` as a toast, and the panel's backup box shows live progress.
      console.log(`[router] Holding start for ${uuids.join(', ')} — restoring from backup`);
      const message = 'Restoring this server from cloud backup. It will start automatically when the restore finishes.';
      const payload = JSON.stringify({ status: 500, data: message, time: Date.now() });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
    return;
  }

  // Healthcheck endpoint — always returns OK so the platform never confuses it
  // with the actual panel response. Probers (Cloud Run, Replit) send no Accept
  // header, but some synthetic monitors do, so match on path alone.
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  proxyRequest(req, res, target);
});

server.on('upgrade', (req, socket, head) => {
  const { host, port } = getBackend(url.parse(req.url).path);
  const proxy = http.request({
    hostname: host,
    port,
    path: req.url,
    method: 'GET',
    headers: { ...req.headers, 'x-real-ip': clientIp(req) }
  });
  proxy.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
    const hdrs = upstream.rawHeaders;
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < hdrs.length; i += 2) raw += `${hdrs[i]}: ${hdrs[i + 1]}\r\n`;
    raw += '\r\n';
    socket.write(raw);
    if (head?.length) socket.write(head);
    if (upstreamHead?.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[router] 127.0.0.1:${PORT} -> web:${WEB.port} / daemon:${DAEMON.port} / middleware:${MIDDLEWARE.port}`);
});
