const http = require('http');
const url = require('url');

const PORT = process.env.PROXY_PORT || 3000;
const WEB = { host: '127.0.0.1', port: 23333 };
const DAEMON = { host: '127.0.0.1', port: 24444 };
const MIDDLEWARE = { host: '127.0.0.1', port: 29999 };

// Stylesheet first so the skin paints without waiting on script execution;
// the script is deferred because none of it needs to run before parse.
const THEME_LINK = `<link rel="stylesheet" href="/api/omen/theme.css">`;
const INJECT_SCRIPT = THEME_LINK + `<script defer src="/api/omen/inject.js"></script>`;
const LOADING_PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loading...</title><style>body{background:#0b0e14;color:#2ecc71;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-size:20px}</style></head><body>Loading panel...</body></html>`;

/**
 * The real client IP, for the X-Real-IP header the web panel reads to apply
 * its per-IP login-failure ban. Without this every visitor looks like
 * 127.0.0.1 (this router) and one visitor's failed logins ban everyone.
 *
 * The rightmost X-Forwarded-For entry is the one appended by the closest
 * trusted proxy (the platform edge); entries to its left can be forged by
 * the client, so they are deliberately not used.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
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
function proxyRequest(req, res, target, body) {
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

  const opts = {
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers,
    timeout: 10000
  };

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

  proxy.on('error', () => {
    if (!res.headersSent) { res.writeHead(502); res.end('Service starting...'); }
  });

  proxy.on('timeout', () => { proxy.destroy(); });

  if (body !== undefined) {
    // Stream already drained by the start-request inspection.
    if (body.length) proxy.write(body);
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

  // Panel root — proxies to the real web panel with theme/script injection.
  if (parsed.path === '/' && req.method === 'GET') {
    // Proxy real page from web panel with inject script
    const proxyReq = http.request({ hostname: WEB.host, port: WEB.port, path: '/', method: 'GET', timeout: 10000 }, (upstream) => {
      const ct = upstream.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        const chunks = [];
        upstream.on('data', (c) => chunks.push(c));
        upstream.on('end', () => {
          try {
            let body = Buffer.concat(chunks).toString('utf8');
            if (body.includes('</head>')) body = body.replace('</head>', INJECT_SCRIPT + '</head>');
            else if (body.includes('</body>')) body = body.replace('</body>', INJECT_SCRIPT + '</body>');
            else body += INJECT_SCRIPT;
            const headers = { ...upstream.headers };
            headers['content-length'] = Buffer.byteLength(body);
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];
            res.writeHead(upstream.statusCode, headers);
            res.end(body);
          } catch(e) {
            if (!res.headersSent) { res.writeHead(500); res.end('Error'); }
          }
        });
        upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); } });
      } else {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res, { end: true });
      }
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(LOADING_PAGE);
      }
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(LOADING_PAGE);
      }
    });
    proxyReq.end();
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
