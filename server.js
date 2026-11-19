'use strict';
// Pingr: accounts, 1:1 + group chats, voice/video call signaling.
// Zero dependencies (Node 18+). Data is saved to DATA_DIR/db.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_CALL = 6;

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, sessions: {}, chats: {}, messages: {}, reads: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}

// ---------- persistence ----------
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300);
}
function saveNow() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('save failed', e.message); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });

// ---------- helpers ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomBytes(8).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(pw, u.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
}

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

// login/register throttling
const attempts = new Map();
function throttled(key, max = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || a.reset < now) { a = { n: 0, reset: now + windowMs }; attempts.set(key, a); }
  a.n++;
  return a.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k); }, 60000).unref();

// ---------- live connections ----------
const clients = new Map(); // username -> Set(res)
const isOnline = (u) => clients.has(u);
function sendTo(u, obj) {
  const s = clients.get(u);
  if (!s) return;
  const d = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of s) r.write(d);
}

function contactsOf(user) {
  const set = new Set();
  for (const c of Object.values(db.chats)) if (c.members.includes(user)) c.members.forEach((m) => m !== user && set.add(m));
  return set;
}

// ---------- chats ----------
function chatView(c, me) {
  const msgs = db.messages[c.id] || [];
  const last = msgs[msgs.length - 1] || null;
  const readN = (db.reads[me] || {})[c.id] || 0;
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].n > readN; i--) {
    if (msgs[i].from !== me && msgs[i].type !== 'sys') unread++;
  }
  return {
    id: c.id, type: c.type, name: c.name, created: c.created, last, unread,
    members: c.members.map((u) => ({ username: u, display: (db.users[u] && db.users[u].display) || u, online: isOnline(u) })),
  };
}
function pushChat(c) { for (const u of c.members) sendTo(u, { type: 'chat', chat: chatView(c, u) }); }

function addMessage(c, from, text, type) {
  const arr = db.messages[c.id] || (db.messages[c.id] = []);
  const m = { n: (arr.length ? arr[arr.length - 1].n : 0) + 1, id: uid(), from, text, ts: Date.now() };
  if (type) m.type = type;
  arr.push(m);
  if (!type) { (db.reads[from] || (db.reads[from] = {}))[c.id] = m.n; }
  save();
  for (const u of c.members) sendTo(u, { type: 'message', chatId: c.id, message: m });
  return m;
}

const dispName = (u) => (db.users[u] && db.users[u].display) || u;

// ---------- calls ----------
const calls = new Map(); // chatId -> { participants:Set, video }
function callView(id) {
  const c = calls.get(id);
  return { type: 'call-state', chatId: id, participants: c ? [...c.participants] : [], video: c ? c.video : false };
}
function broadcastCall(chat) { const v = callView(chat.id); for (const u of chat.members) sendTo(u, v); }
function leaveCall(user, onlyExcept) {
  for (const [id, c] of calls) {
    if (id === onlyExcept) continue;
    if (c.participants.delete(user)) {
      if (!c.participants.size) calls.delete(id);
      const chat = db.chats[id];
      if (chat) broadcastCall(chat);
    }
  }
}

// ---------- http ----------
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => json(res, code, { error: msg });

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function authUser(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (!token) return null;
  const s = db.sessions[sha(token)];
  return s && db.users[s.username] ? s.username : null;
}
function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { username, ts: Date.now() };
  save();
  return token;
}
const userView = (u) => ({ username: u.username, display: u.display });
const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const indexHtml = () => fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(indexHtml());
    }
    if (req.method === 'GET' && p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, { iceServers: iceServers() });

    // ----- auth -----
    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      const b = await readBody(req);
      const username = clean(b.username, 20).toLowerCase();
      const password = String(b.password || '').slice(0, 200);
      if (throttled(ip(req) + ':' + p, 20) || throttled('u:' + username, 10)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
      if (p === '/api/register') {
        if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Username: 3-20 letters, numbers or _');
        if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters');
        if (db.users[username]) return fail(res, 409, 'That username is taken');
        const { salt, hash } = hashPw(password);
        db.users[username] = { username, display: clean(b.display, 30) || username, salt, hash, created: Date.now() };
        save();
        return json(res, 200, { token: newSession(username), user: userView(db.users[username]) });
      }
      const u = db.users[username];
      if (!u || !checkPw(password, u)) return fail(res, 401, 'Wrong username or password');
      return json(res, 200, { token: newSession(username), user: userView(u) });
    }

    // ----- SSE -----
    if (req.method === 'GET' && p === '/events') {
      const me = authUser(req, url);
      if (!me) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const first = !clients.has(me);
      if (first) clients.set(me, new Set());
      clients.get(me).add(res);
      if (first) for (const c of contactsOf(me)) sendTo(c, { type: 'presence', username: me, online: true });
      for (const chat of Object.values(db.chats)) if (chat.members.includes(me) && calls.has(chat.id)) res.write(`data: ${JSON.stringify(callView(chat.id))}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        const s = clients.get(me);
        if (!s) return;
        s.delete(res);
        if (!s.size) {
          clients.delete(me);
          leaveCall(me);
          for (const c of contactsOf(me)) sendTo(c, { type: 'presence', username: me, online: false });
        }
      });
      return;
    }

    // ----- authenticated API -----
    if (p.startsWith('/api/')) {
      const me = authUser(req, url);
      if (!me) return fail(res, 401, 'Please log in');

      if (req.method === 'POST' && p === '/api/logout') {
        const h = req.headers.authorization || '';
        delete db.sessions[sha(h.slice(7))]; save();
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/me') {
        const chats = Object.values(db.chats).filter((c) => c.members.includes(me)).map((c) => chatView(c, me));
        return json(res, 200, { user: userView(db.users[me]), chats });
      }

      if (req.method === 'GET' && p === '/api/users/search') {
        const q = clean(url.searchParams.get('q'), 30).toLowerCase();
        if (!q) return json(res, 200, { users: [] });
        const users = Object.values(db.users)
          .filter((u) => u.username !== me && (u.username.includes(q) || u.display.toLowerCase().includes(q)))
          .slice(0, 20).map(userView);
        return json(res, 200, { users });
      }

      if (req.method === 'POST' && p === '/api/chats/dm') {
        const b = await readBody(req);
        const other = clean(b.username, 20).toLowerCase();
        if (!db.users[other] || other === me) return fail(res, 400, 'User not found');
        let chat = Object.values(db.chats).find((c) => c.type === 'dm' && c.members.includes(me) && c.members.includes(other));
        if (!chat) {
          chat = { id: uid(), type: 'dm', name: '', members: [me, other], created: Date.now(), createdBy: me };
          db.chats[chat.id] = chat; save();
          pushChat(chat);
        }
        return json(res, 200, { chat: chatView(chat, me) });
      }

      if (req.method === 'POST' && p === '/api/chats/group') {
        const b = await readBody(req);
        const name = clean(b.name, 40);
        if (!name) return fail(res, 400, 'Give the group a name');
        const members = [...new Set([me, ...(Array.isArray(b.members) ? b.members : []).map((x) => clean(x, 20).toLowerCase())])]
          .filter((u) => db.users[u]).slice(0, 50);
        if (members.length < 2) return fail(res, 400, 'Add at least one other person');
        const chat = { id: uid(), type: 'group', name, members, created: Date.now(), createdBy: me };
        db.chats[chat.id] = chat; save();
        addMessage(chat, me, 'created the group "' + name + '"', 'sys');
        pushChat(chat);
        return json(res, 200, { chat: chatView(chat, me) });
      }

      let m;
      if ((m = p.match(/^\/api\/chats\/([a-f0-9]+)\/(messages|read|members|leave)$/))) {
        const chat = db.chats[m[1]];
        if (!chat || !chat.members.includes(me)) return fail(res, 404, 'Chat not found');
        const action = m[2];

        if (req.method === 'GET' && action === 'messages') {
          const arr = db.messages[chat.id] || [];
          return json(res, 200, { messages: arr.slice(-300) });
        }
        if (req.method === 'POST' && action === 'messages') {
          const b = await readBody(req);
          const text = clean(b.text, 4000);
          if (!text) return fail(res, 400, 'Empty message');
          return json(res, 200, { message: addMessage(chat, me, text) });
        }
        if (req.method === 'POST' && action === 'read') {
          const arr = db.messages[chat.id] || [];
          (db.reads[me] || (db.reads[me] = {}))[chat.id] = arr.length ? arr[arr.length - 1].n : 0;
          save();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'members') {
          if (chat.type !== 'group') return fail(res, 400, 'Not a group');
          const b = await readBody(req);
          const who = clean(b.username, 20).toLowerCase();
          if (!db.users[who]) return fail(res, 400, 'User not found');
          if (chat.members.includes(who)) return fail(res, 400, 'Already in the group');
          if (chat.members.length >= 50) return fail(res, 400, 'Group is full');
          chat.members.push(who); save();
          addMessage(chat, me, 'added ' + dispName(who), 'sys');
          pushChat(chat);
          return json(res, 200, { chat: chatView(chat, me) });
        }
        if (req.method === 'POST' && action === 'leave') {
          if (chat.type !== 'group') return fail(res, 400, 'You can only leave groups');
          addMessage(chat, me, 'left', 'sys');
          chat.members = chat.members.filter((u) => u !== me);
          leaveCall(me);
          sendTo(me, { type: 'chat-removed', chatId: chat.id });
          if (!chat.members.length) { delete db.chats[chat.id]; delete db.messages[chat.id]; } else pushChat(chat);
          save();
          return json(res, 200, { ok: true });
        }
      }

      // ----- call signaling -----
      if (req.method === 'POST' && p === '/api/signal') {
        const b = await readBody(req);
        const chat = db.chats[b.chatId];
        if (!chat || !chat.members.includes(me)) return fail(res, 404, 'Chat not found');
        const type = b.type;
        if (type === 'join') {
          let c = calls.get(chat.id);
          if (c && !c.participants.has(me) && c.participants.size >= MAX_CALL) return fail(res, 409, 'This call is full');
          leaveCall(me, chat.id);
          if (!c) {
            const video = !!(b.data && b.data.video);
            c = { participants: new Set(), video };
            calls.set(chat.id, c);
            addMessage(chat, me, 'started a ' + (video ? 'video' : 'voice') + ' call', 'sys');
          }
          c.participants.add(me);
          broadcastCall(chat);
        } else if (type === 'leave') {
          const c = calls.get(chat.id);
          if (c && c.participants.delete(me)) { if (!c.participants.size) calls.delete(chat.id); broadcastCall(chat); }
        } else if (type === 'decline') {
          const c = calls.get(chat.id);
          if (c) for (const u of c.participants) sendTo(u, { type: 'signal', chatId: chat.id, from: me, kind: 'decline' });
        } else if (type === 'description' || type === 'candidate') {
          const c = calls.get(chat.id);
          const to = clean(b.to, 20);
          if (c && c.participants.has(me) && c.participants.has(to)) sendTo(to, { type: 'signal', chatId: chat.id, from: me, kind: type, data: b.data });
        } else return fail(res, 400, 'Unknown signal');
        return json(res, 200, { ok: true });
      }
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) fail(res, 400, 'Bad request');
  }
});

server.listen(PORT, () => console.log(`Pingr running on http://localhost:${PORT}  (data: ${DB_FILE})`));
