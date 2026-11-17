'use strict';
// Ho Ho Hold'em: HTTP server. No dependencies, runs on any Node 18+ host.
const http = require('http');
const fs = require('fs');
const path = require('path');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || 'santa2026'; // change this, or set HOST_KEY as an environment variable
const SNAP = path.join(__dirname, 'data', 'state.json');

// Restore a running game after a restart, then snapshot every few seconds.
try { if (fs.existsSync(SNAP)) { G.load(fs.readFileSync(SNAP, 'utf8')); console.log('Restored game from snapshot'); } } catch (e) { console.log('No snapshot restored:', e.message); }
setInterval(() => { try { G.tick(); } catch (e) { console.error('tick error', e); } }, 200);
setInterval(() => { try { fs.mkdirSync(path.dirname(SNAP), { recursive: true }); fs.writeFileSync(SNAP + '.tmp', G.save()); fs.renameSync(SNAP + '.tmp', SNAP); } catch (e) { /* read-only disk: play on without snapshots */ } }, 3000);

const INDEX = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'index.html');
const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

function api(route, b) {
  if (route === 'join') {
    let p = b.token && G.byToken(b.token);
    if (!p) {
      const name = cleanName(b.name);
      if (!name) return { error: 'Please enter your name' };
      const same = Object.values(G.state().players).find((x) => x.name.toLowerCase() === name.toLowerCase() && !x.kicked);
      if (same) {
        if (same.bot || Date.now() - same.lastSeen < 8000) return { error: 'That name is already playing. Pick another one.' };
        p = same; // same name, and that player is offline: take the seat back
      } else p = G.addPlayer(name);
    }
    if (b.hostKey && b.hostKey === HOST_KEY) p.isHost = true;
    return { token: p.token };
  }
  const p = G.byToken(b.token);
  if (!p || p.kicked) return { error: 'unknown' };
  if (route === 'state') return G.view(p.id, b.view);
  if (route === 'act') { const err = G.act(p.id, b.type, b.amount); return err ? { error: err } : { ok: true }; }
  if (route === 'host') {
    if (!p.isHost) return { error: 'Host only' };
    const err = G.host(b.cmd, b); return err ? { error: err } : { ok: true };
  }
  return { error: 'Not found' };
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const m = url.match(/\/api\/(\w+)$/);
  if (req.method === 'POST' && m) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = api(m[1], JSON.parse(body || '{}')); } catch (e) { console.error(e); out = { error: 'Server error' }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && !url.includes('.')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(INDEX));
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Ho Ho Hold'em running on port ${PORT}. Host link: /?host=${HOST_KEY}`));
