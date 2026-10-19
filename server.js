import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

// ---------- rooms ----------
const rooms = new Map();
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join(''); } while (rooms.has(c));
  return c;
}
function freshWorld(r) {
  r.tiles = new Set();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) r.tiles.add(i + ',' + j);
  r.debris = new Map(); r.nextDebris = 1; r.spawnT = 0;
}
const cleanName = (n) => (String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14)) || 'Player';
const members = (r) => [...r.players.values()];
const roomMsg = (r) => ({ t: 'room', code: r.code, state: r.state, host: r.host, players: members(r).map((p) => ({ id: p.id, name: p.name })) });
const toRoom = (r, o) => members(r).forEach((p) => send(p.ws, o.t === 'room' ? { ...o, you: p.id } : o));
const sendInit = (r, p) => send(p.ws, { t: 'init', id: p.id, tiles: [...r.tiles].map((k) => k.split(',').map(Number)) });

function leave(ws) {
  const r = ws.room; if (!r) return;
  r.players.delete(ws.pid); ws.room = null;
  if (r.players.size === 0) { rooms.delete(r.code); return; }
  if (r.host === ws.pid) r.host = members(r)[0].id;
  toRoom(r, roomMsg(r));
}
function join(ws, r, name) {
  const taken = new Set(members(r).map((p) => p.name));
  let n = name, k = 2; while (taken.has(n)) n = name + ' ' + k++;
  const id = r.players.has(1) ? 2 : 1;
  const p = { id, name: n, x: 0, z: 0, yaw: 0, ws };
  r.players.set(id, p); ws.room = r; ws.pid = id;
  toRoom(r, roomMsg(r));
  if (r.state === 'playing') sendInit(r, p);
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = ws.room;
    switch (m.t) {
      case 'list':
        send(ws, { t: 'rooms', rooms: [...rooms.values()].filter((x) => x.public && x.players.size < MAX_PLAYERS)
          .map((x) => ({ code: x.code, host: x.players.get(x.host).name, state: x.state, count: x.players.size })) });
        break;
      case 'create': {
        if (r) return;
        const room = { code: newCode(), public: !!m.pub, state: 'lobby', host: 1, players: new Map() };
        freshWorld(room); rooms.set(room.code, room); join(ws, room, cleanName(m.name));
        break;
      }
      case 'join': {
        if (r) return;
        const room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) return send(ws, { t: 'err', msg: 'Room not found' });
        if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Room is full (max 2 players)' });
        join(ws, room, cleanName(m.name));
        break;
      }
      case 'leave': leave(ws); break;
      case 'start':
        if (r && r.state === 'lobby' && r.host === ws.pid && r.players.size === MAX_PLAYERS) {
          r.state = 'playing'; freshWorld(r);
          toRoom(r, roomMsg(r)); members(r).forEach((p) => { p.x = p.z = 0; sendInit(r, p); });
        } else send(ws, { t: 'err', msg: 'Need 2 players and you must be the host' });
        break;
      case 'pos': {
        if (!r || r.state !== 'playing') return;
        const p = r.players.get(ws.pid);
        if ([m.x, m.z, m.yaw].every(Number.isFinite)) { p.x = m.x; p.z = m.z; p.yaw = m.yaw; }
        break;
      }
      case 'collect': {
        if (!r || r.state !== 'playing') return;
        const p = r.players.get(ws.pid), d = r.debris.get(m.id);
        if (d && Math.hypot(d.x - p.x, d.z - p.z) < 9) { r.debris.delete(m.id); send(ws, { t: 'got', type: d.type }); }
        break;
      }
      case 'place': {
        if (!r || r.state !== 'playing' || !Number.isInteger(m.i) || !Number.isInteger(m.j)) return;
        const k = m.i + ',' + m.j;
        const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => r.tiles.has((m.i + a) + ',' + (m.j + b)));
        if (!r.tiles.has(k) && adj && r.tiles.size < 200) { r.tiles.add(k); toRoom(r, { t: 'tile', i: m.i, j: m.j }); }
        break;
      }
    }
  });
  ws.on('close', () => leave(ws));
});

// ---------- game tick ----------
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - last) / 1000; last = now;
  for (const r of rooms.values()) {
    if (r.state !== 'playing') continue;
    r.spawnT += dt;
    if (r.spawnT >= 1) {
      r.spawnT -= 1;
      if (r.debris.size < 25 && Math.random() < 0.5) {
        const q = Math.random();
        r.debris.set(r.nextDebris++, { type: q < 0.5 ? 'wood' : q < 0.8 ? 'plastic' : 'barrel', x: -70, z: (Math.random() - 0.5) * 40 });
      }
    }
    for (const [id, d] of r.debris) { d.x += 1.5 * dt; if (d.x > 70) r.debris.delete(id); }
    toRoom(r, {
      t: 'state',
      players: members(r).map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(2)]),
      debris: [...r.debris].map(([id, d]) => [id, d.type, +d.x.toFixed(2), +d.z.toFixed(2)]),
    });
  }
}, 66);

server.listen(PORT, '0.0.0.0', () => console.log('Raft game on port ' + PORT));
