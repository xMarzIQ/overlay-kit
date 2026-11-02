// Overlay server: no npm install needed (Node 18+).
//   node server.js
// Overlay (add to OBS as a Browser Source): http://localhost:3000/overlay
// Control panel (open in any browser):      http://localhost:3000/control

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.CONTROL_TOKEN || crypto.randomBytes(6).toString('hex');

// What the overlay is currently showing.
const state = {
  lowerThird: { visible: false, name: 'Your Name', title: 'What you do' },
  ticker: { visible: false, text: 'Welcome to the stream' },
  timer: { visible: false, label: 'Starting soon', endsAt: null },
};

// Which fields the control panel may change on each module, and their types.
const schema = {
  lowerThird: { visible: 'boolean', name: 'string', title: 'string' },
  ticker: { visible: 'boolean', text: 'string' },
  timer: { visible: 'boolean', label: 'string' },
};

const clients = new Set();

const snapshot = () => ({ type: 'state', state, serverTime: Date.now() });
const push = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
const broadcast = (data) => clients.forEach((res) => push(res, data));

function authorized(req) {
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const real = Buffer.from(TOKEN);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendFile(res, name) {
  fs.readFile(path.join(__dirname, 'public', name), (err, buf) => {
    if (err) return reply(res, 500, { error: 'Missing file: ' + name });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Pages
  if (req.method === 'GET' && url.pathname === '/overlay') return sendFile(res, 'overlay.html');
  if (req.method === 'GET' && (url.pathname === '/control' || url.pathname === '/')) {
    return sendFile(res, 'control.html');
  }

  // Live updates (Server-Sent Events). EventSource reconnects on its own.
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    push(res, snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Commands (token required)
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return reply(res, 401, { error: 'Wrong token' });

    let body;
    try { body = await readJson(req); } catch (e) { return reply(res, 400, { error: e.message }); }

    if (url.pathname === '/api/set') {
      const fields = schema[body.key];
      const value = body.value;
      if (!fields || typeof value !== 'object' || value === null) {
        return reply(res, 400, { error: 'Unknown module or bad value' });
      }
      for (const [field, type] of Object.entries(fields)) {
        if (typeof value[field] === type) {
          state[body.key][field] = type === 'string' ? value[field].slice(0, 200) : value[field];
        }
      }
      // Timer: the browser sends a duration; the server turns it into an end time
      // so the overlay stays correct even if clocks differ.
      if (body.key === 'timer' && Number.isFinite(value.seconds)) {
        const seconds = Math.min(Math.max(value.seconds, 0), 86_400);
        state.timer.endsAt = Date.now() + seconds * 1000;
      }
      broadcast(snapshot());
      return reply(res, 200, { ok: true });
    }

    if (url.pathname === '/api/alert') {
      const text = String(body.text || '').slice(0, 200);
      if (!text) return reply(res, 400, { error: 'Alert text is empty' });
      const ms = Math.min(Math.max(Number(body.ms) || 5000, 1000), 30_000);
      broadcast({ type: 'alert', text, ms });
      return reply(res, 200, { ok: true });
    }
  }

  reply(res, 404, { error: 'Not found' });
});

// Keep idle connections alive through proxies.
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 25_000);

server.listen(PORT, () => {
  console.log(`Overlay:  http://localhost:${PORT}/overlay   (OBS Browser Source, 1920x1080)`);
  console.log(`Control:  http://localhost:${PORT}/control`);
  console.log(`Token:    ${TOKEN}`);
  if (!process.env.CONTROL_TOKEN) {
    console.log('(Random token. Set CONTROL_TOKEN=yourpassword to keep the same one between runs.)');
  }
});
