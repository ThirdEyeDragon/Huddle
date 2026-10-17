// LAN chat server: HTTPS + WebSocket (chat & WebRTC signaling) + file uploads.
// Model: no default server. People start with DMs, create their own servers (guilds), and invite others by code.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000, MAX_USERS = 10, PASSWORD = process.env.PASSWORD || '';
const MAX_BANNER = 8 * 1024 * 1024, MAX_FILE = 100 * 1024 * 1024;
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) ICE.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
const DIR = process.pkg ? path.dirname(process.execPath) : __dirname, UP = path.join(DIR, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const clients = new Map(); // id -> { ws, name, oid, status, voice (channel id or false), muted, video }
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return d; } };
const saver = (f, get) => { let t; return () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(path.join(DIR, f), JSON.stringify(get()), { mode: 0o600 }, () => {}), 1000); }; };
const guilds = load('guilds.json', {}); // id -> { id, name, owner, code, members:[oid], channels:[{id,name,type:'text'|'voice'}] }
const history = {}; // channel id (guild channel or 'dm:<oidA>:<oidB>') -> messages
const profiles = load('profiles.json', {});
const rel = load('friends.json', {}); // oid -> { f: friends, i: incoming requests, o: outgoing requests }
const saveRel = saver('friends.json', () => rel);
const accounts = load('accounts.json', {}); // email -> { oid, salt, hash } : scrypt-hashed, written 0600, never sent to any client or served over HTTP
const sessions = load('sessions.json', {}); // sha256(remember-me token) -> { oid, exp }: only the hash is stored, written 0600
const TOK_TTL = 30 * 86400e3, sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const saveSessions = saver('sessions.json', () => sessions);
{ const t = Date.now(); let ch = false; for (const k in sessions) if (!sessions[k] || sessions[k].exp < t) { delete sessions[k]; ch = true; } if (ch) saveSessions(); }
const saveAccounts = saver('accounts.json', () => accounts), tries = new Map(); // tries: failed-login counter per email
const saveGuilds = saver('guilds.json', () => guilds);
const CHP = { text: ['view', 'send', 'files', 'react'], voice: ['view', 'connect', 'speak', 'video', 'screen'] }; // per-channel permissions
const ROLE_PERMS = ['channels', 'kick', 'nicks', 'mute', 'deafen', 'timeout', 'ban', 'vkick', 'roles', 'server', 'msgs']; // server-wide role permissions
{ let ch = false; // migrate the old "restrict joining / restrict files" switches (and the 'vc' / 'files' role perms) into per-channel permissions
  for (const g of Object.values(guilds)) {
    for (const x of g.channels) for (const [flag, perm, role] of [['vcr', 'connect', 'vc'], ['fr', 'files', 'files']]) if (x[flag]) {
      x.ov = x.ov || {}; const e = x.ov.e = x.ov.e || { allow: [], deny: [] }; if (!e.deny.includes(perm)) e.deny.push(perm);
      for (const r of g.roles || []) if (r.perms.includes(role)) { const o = x.ov[r.id] = x.ov[r.id] || { allow: [], deny: [] }; if (!o.allow.includes(perm)) o.allow.push(perm); }
      delete x[flag]; ch = true;
    }
    for (const r of g.roles || []) { const n = r.perms.filter(p => p !== 'vc' && p !== 'files'); if (n.length !== r.perms.length) { r.perms = n; ch = true; } }
  }
  if (ch) saveGuilds();
}
const emojis = load('emojis.json', {}); // name -> { name, url, o (creator), ts }: custom emojis anyone can use as :name:
const saveEmojis = saver('emojis.json', () => emojis);
const MAX_EMOJI = 256 * 1024, EMNAME = /^[a-z0-9_]{2,24}$/;
const emojiMagic = b => b.length > 11 && ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'));
const saveHistory = saver('history.json', () => history);
const saveProfiles = saver('profiles.json', () => Object.fromEntries(Object.entries(profiles).filter(([k]) => k[0] !== 'u')));
const norm = n => String(n).trim().toLowerCase();
const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const freeNum = (name, skip) => { // a 4-digit number nobody else with this same name has: name#0427
  const used = new Set(Object.entries(profiles).filter(([o, p]) => o !== skip && p.name && norm(p.name) === norm(name)).map(([, p]) => p.num));
  for (let i = 0; i < 300; i++) { const n = String(1 + crypto.randomInt(9999)).padStart(4, '0'); if (!used.has(n)) return n; }
  return '0000';
};
let nb = false; for (const o in profiles) if (!profiles[o].num && profiles[o].name) { profiles[o].num = freeNum(profiles[o].name, o); nb = true; } if (nb) saveProfiles(); // give existing people a number

const chGuild = ch => Object.values(guilds).find(g => g.channels.some(x => x.id === ch));
const can = (o, ch) => { // is this person allowed in this channel / DM?
  if (typeof ch !== 'string') return false;
  if (ch.startsWith('dm:')) { const p = ch.split(':'); return p.length === 3 && p[1] < p[2] && p.includes(o) && !!profiles[p[1]] && !!profiles[p[2]]; }
  const g = chGuild(ch); return !!g && g.members.includes(o) && chPerm(o, ch, 'view');
};
const audience = ch => ch.startsWith('dm:') ? ch.split(':').slice(1) : (chGuild(ch) || { members: [] }).members.filter(m => chPerm(m, ch, 'view'));
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const all = o => clients.forEach(c => send(c.ws, o));
const toCh = (ch, o) => { const a = audience(ch); clients.forEach(c => a.includes(c.oid) && send(c.ws, o)); };
const toG = (g, o) => clients.forEach(c => g.members.includes(c.oid) && send(c.ws, o));
const view = o => { // everything one person is allowed to see
  const gs = Object.values(guilds).filter(g => g.members.includes(o)), h = {};
  gs.forEach(g => g.channels.forEach(c => { if (chPerm(o, c.id, 'view')) h[c.id] = history[c.id] || []; }));
  Object.keys(history).forEach(k => k.startsWith('dm:') && k.split(':').includes(o) && (h[k] = history[k]));
  return { guilds: gs.map(g => gOut(g, o)), history: h };
};
const rid = () => crypto.randomBytes(4).toString('hex');
const relOf = o => rel[o] || { f: [], i: [], o: [] }, R = o => rel[o] = rel[o] || { f: [], i: [], o: [] };
const rm = (a, x) => { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); };
const pushRel = (...os) => os.forEach(o => clients.forEach(c => c.oid === o && send(c.ws, { t: 'rel', r: relOf(o) })));

const h0 = load('history.json', {});
for (const c in h0) if (Array.isArray(h0[c])) history[c] = h0[c].slice(-300);
for (const k in history) if (!k.startsWith('dm:') && !chGuild(k)) delete history[k]; // drop the old built-in channels

const roster = () => [...clients].map(([id, c]) => { // sm / sd = muted / deafened by a moderator (per server, only while in that server's voice channel)
  const g = c.voice && chGuild(c.voice), sm = !!(g && (g.smuted || {})[c.oid]), sd = !!(g && (g.sdeaf || {})[c.oid]);
  const ns = !!g && !chPerm(c.oid, c.voice, 'speak'), nv = !!g && !chPerm(c.oid, c.voice, c.scr ? 'screen' : 'video'); // ns: may not speak here, nv: may not send video here
  return { id, oid: c.oid, status: c.status, name: c.name, voice: c.voice, muted: c.muted || sm || ns, video: !!c.video && !nv, sm, sd, ns };
});
const mayO = (g, o, p) => g.owner === o || (g.roles || []).some(r => r.perms.includes(p) && ((g.mroles || {})[o] || []).includes(r.id)); // owner, or a role that grants p
const left = ms => { const s = Math.ceil(ms / 1000); return s >= 86400 ? Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h' : s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm ' + s % 60 + 's' : s + 's'; };
const chAllows = (g, o, x, p) => { // can this member do p in channel x? Everyone may by default; overrides: @everyone ('e') first, then the member's roles (an allow beats a deny). The owner can always.
  if (g.owner === o) return true;
  const ov = x.ov || {}, rs = ((g.mroles || {})[o] || []).map(r => ov[r]).filter(Boolean); let v = true;
  if (ov.e) { if (ov.e.deny.includes(p)) v = false; if (ov.e.allow.includes(p)) v = true; }
  if (rs.some(r => r.allow.includes(p))) v = true; else if (rs.some(r => r.deny.includes(p))) v = false;
  return v;
};
const chPerm = (o, ch, p) => { if (typeof ch !== 'string' || ch.startsWith('dm:')) return true; const g = chGuild(ch), x = g && g.channels.find(k => k.id === ch); return !x || chAllows(g, o, x, p); };
const gOut = (g, o) => { // what this person is allowed to see of a server: hidden channels are left out unless they manage channels / roles
  if (mayO(g, o, 'channels') || mayO(g, o, 'roles')) return g;
  const ch = g.channels.filter(x => chAllows(g, o, x, 'view')); return ch.length === g.channels.length ? g : { ...g, channels: ch };
};
const pushG = g => clients.forEach(c => g.members.includes(c.oid) && send(c.ws, { t: 'guild', g: gOut(g, c.oid) }));
const gate = (o, ch, file) => { // why can't this person post here right now? ('' = they can)
  if (ch.startsWith('dm:')) return ''; const g = chGuild(ch); if (!g) return '';
  const t = (g.timeouts || {})[o];
  if (t) { if (t > Date.now()) return 'You are timed out for another ' + left(t - Date.now()) + '.'; delete g.timeouts[o]; saveGuilds(); }
  const x = g.channels.find(k => k.id === ch);
  if (x && !chAllows(g, o, x, 'send')) return 'You do not have permission to send messages in this channel.';
  if (file && x && !chAllows(g, o, x, 'files')) return 'You do not have permission to send files in this channel.';
  return '';
};
const vcOK = (o, ch) => chPerm(o, ch, 'connect') && chPerm(o, ch, 'view');
const enforceVc = g => { // kick people out of restricted voice channels they may no longer join
  clients.forEach(o => { if (o.voice && g.channels.some(x => x.id === o.voice) && !vcOK(o.oid, o.voice)) { o.voice = false; o.muted = o.video = false; send(o.ws, { t: 'vdeny' }); send(o.ws, { t: 'perr', msg: 'You no longer have access to that voice channel.' }); } });
  clients.forEach(o => { if (g.members.includes(o.oid)) send(o.ws, { t: 'hist', history: Object.fromEntries(g.channels.filter(x => chPerm(o.oid, x.id, 'view')).map(x => [x.id, history[x.id] || []])) }); }); // anyone who just gained a channel gets its history
  all({ t: 'users', users: roster() });
};
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };

function postMessage(ch, uid, text, file, replyId) {
  const c = clients.get(uid); if (!c || !can(c.oid, ch)) return;
  const list = history[ch] = history[ch] || [];
  let r; // snapshot of the message being replied to (built here so clients can't fake it)
  if (replyId) { const o = list.find(x => x.id === replyId); if (o) r = { id: o.id, from: o.from, text: (o.text || (o.file ? '📎 ' + o.file.name : '')).slice(0, 140) }; }
  const m = { id: crypto.randomUUID(), ch, uid, o: c.oid, from: c.name, text: String(text || '').slice(0, 1000), file, r, ts: Date.now() };
  list.push(m); if (list.length > 300) list.shift();
  saveHistory(); toCh(ch, { t: 'msg', m });
}

// Community: live "looking to play" posts, shown to everyone outside any server. In memory; each post expires after 3 hours.
const LFG_TTL = 3 * 3600e3, lfg = [];
const lfgLive = () => { const t = Date.now(); for (let i = lfg.length - 1; i >= 0; i--) if (lfg[i].exp <= t) lfg.splice(i, 1); return lfg; };
const lfgOut = () => ({ t: 'lfg', posts: lfgLive().slice().reverse() }); // newest first
setInterval(() => { const n = lfg.length; lfgLive(); if (lfg.length !== n) all(lfgOut()); }, 30000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-token, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Huddle server is running. Open the Huddle app and enter this address.'); }
  if (req.method === 'GET' && u.pathname.startsWith('/files/')) {
    const f = path.join(UP, path.basename(decodeURIComponent(u.pathname.slice(7))));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(f).toLowerCase(), orig = path.basename(f).slice(9);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    if (!MIME[ext] || u.searchParams.has('dl')) h['Content-Disposition'] = `attachment; filename="${encodeURIComponent(orig)}"`;
    res.writeHead(200, h); return fs.createReadStream(f).pipe(res);
  }
  if (req.method === 'POST' && u.pathname === '/banner') {
    const ext = { gif: '.gif', png: '.png', jpg: '.jpg', webp: '.webp' }[u.searchParams.get('ext')];
    if (!clients.has(req.headers['x-token'])) { res.writeHead(401); return res.end(); }
    if (!ext) { res.writeHead(415); return res.end(); }
    const stored = rid() + '_banner' + ext, fp = path.join(UP, stored), out = fs.createWriteStream(fp); let size = 0, dead = false;
    req.on('data', d => { size += d.length; if (size > MAX_BANNER && !dead) { dead = true; req.destroy(); out.destroy(); fs.unlink(fp, () => {}); } });
    req.on('error', () => out.destroy()); out.on('error', () => {}); req.pipe(out);
    out.on('finish', () => { if (dead) return; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: '/files/' + stored })); });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/emoji') {
    const c = clients.get(req.headers['x-token']), ext = { gif: '.gif', png: '.png', jpg: '.jpg', webp: '.webp' }[u.searchParams.get('ext')], name = String(u.searchParams.get('name') || '').toLowerCase();
    const bad = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); req.resume(); };
    if (!c) return bad(401, 'Not signed in.'); if (c.oid[0] === 'u') return bad(403, 'Guests cannot add emojis.');
    if (!ext) return bad(415, 'Use a PNG, JPG, GIF or WebP image.');
    if (!EMNAME.test(name)) return bad(400, 'Names use 2-24 letters, numbers or underscores.');
    if (emojis[name]) return bad(409, 'An emoji called :' + name + ': already exists.');
    if (Object.values(emojis).filter(e => e.o === c.oid).length >= 50) return bad(403, 'You can have up to 50 emojis. Delete one first.');
    if (Object.keys(emojis).length >= 300) return bad(403, 'This server has reached its emoji limit.');
    const stored = rid() + '_emoji' + ext, fp = path.join(UP, stored), out = fs.createWriteStream(fp); let size = 0, dead = false;
    req.on('data', d => { size += d.length; if (size > MAX_EMOJI && !dead) { dead = true; req.destroy(); out.destroy(); fs.unlink(fp, () => {}); } });
    req.on('error', () => out.destroy()); out.on('error', () => {}); req.pipe(out);
    out.on('finish', () => {
      if (dead) return;
      const drop = (code, msg) => { fs.unlink(fp, () => {}); res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
      let head; try { const fd = fs.openSync(fp, 'r'); head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd); } catch { return drop(500, 'Could not save that.'); }
      if (!emojiMagic(head)) return drop(415, 'That file is not a valid image.');
      if (emojis[name]) return drop(409, 'An emoji called :' + name + ': already exists.');
      emojis[name] = { name, url: '/files/' + stored, o: c.oid, ts: Date.now() }; saveEmojis(); all({ t: 'emojis', e: emojis });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(emojis[name]));
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/upload') {
    const uid = req.headers['x-token'], c = clients.get(uid), ch = u.searchParams.get('ch');
    if (!c) { res.writeHead(401); return res.end(); }
    if (!can(c.oid, ch)) { res.writeHead(403); return res.end(); }
    { const why = gate(c.oid, ch, true); if (why) { res.writeHead(403); return res.end(why); } }
    const name = path.basename(u.searchParams.get('name') || 'file').replace(/[^\w.\- ]/g, '_').slice(-80);
    const stored = rid() + '_' + name; // 9-char prefix
    const out = fs.createWriteStream(path.join(UP, stored)); let size = 0, dead = false;
    req.on('data', d => { size += d.length; if (size > MAX_FILE && !dead) { dead = true; req.destroy(); out.destroy(); fs.unlink(path.join(UP, stored), () => {}); } });
    req.on('error', () => out.destroy()); out.on('error', () => {}); req.pipe(out);
    out.on('finish', () => {
      if (dead) return;
      postMessage(ch, uid, u.searchParams.get('text'), { url: '/files/' + encodeURIComponent(stored), name, size, type: MIME[path.extname(name).toLowerCase()] || '' }, u.searchParams.get('reply'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
wss.on('connection', ws => {
  let id = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); ws.on('error', () => {});
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (!id) {
      if (d.t !== 'join') return;
      if (PASSWORD && d.pass !== PASSWORD) return send(ws, { t: 'err', msg: 'Wrong server password.' });
      const nid = crypto.randomUUID(), email = String(d.email || '').trim().toLowerCase().slice(0, 120), pw = String(d.password || '').slice(0, 200);
      if (d.mode !== 'token' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(ws, { t: 'err', msg: 'Enter a valid email address.' });
      const tr = tries.get(email) || { n: 0, t: 0 }; if (tr.n >= 5 && Date.now() - tr.t < 60000) return send(ws, { t: 'err', msg: 'Too many attempts. Wait a minute and try again.' });
      let oid, newAcc = null, viaTok = false;
      if (d.mode === 'token') { // remember-me: sign back in with a saved token instead of a password
        const th = sha(String(d.token || '').slice(0, 100)), ss = sessions[th];
        if (!ss || ss.exp < Date.now() || !profiles[ss.oid]) { if (ss) { delete sessions[th]; saveSessions(); } return send(ws, { t: 'err', msg: 'Your saved sign-in expired. Please sign in again.', tok: 1 }); }
        oid = ss.oid; viaTok = true; ss.exp = Date.now() + TOK_TTL; saveSessions();
      } else if (d.mode === 'register') {
        if (accounts[email]) return send(ws, { t: 'err', msg: 'An account with that email already exists. Sign in instead.' });
        if (pw.length < 8) return send(ws, { t: 'err', msg: 'Use at least 8 characters for your password.' });
        const old = crypto.createHash('sha256').update(String(d.key || '').slice(0, 64)).digest('hex').slice(0, 16); // lets existing people keep their profile & servers
        oid = d.key && profiles[old] && !Object.values(accounts).some(a => a.oid === old) ? old : crypto.randomBytes(8).toString('hex');
        const salt = crypto.randomBytes(16).toString('hex'); newAcc = { oid, salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
      } else {
        const a = accounts[email], h = crypto.scryptSync(pw, a ? a.salt : '0'.repeat(32), 64); // same work whether or not the email exists
        if (!a || !crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'))) { tr.n++; tr.t = Date.now(); tries.set(email, tr); return send(ws, { t: 'err', msg: 'Wrong email or password.' }); }
        oid = a.oid;
      }
      tries.delete(email); const key = oid;
      const name = String((profiles[oid] && profiles[oid].name) || d.name || '').trim().slice(0, 24);
      if (!name) return send(ws, { t: 'err', msg: 'Enter a name.' });
      const dup = [...clients].find(([, c]) => c.oid === oid); // signing in again replaces your older session
      if (dup) { clients.delete(dup[0]); try { dup[1].ws.terminate(); } catch {} }
      if (clients.size >= MAX_USERS) return send(ws, { t: 'err', msg: `Server is full (${MAX_USERS} people max).` });
      id = nid; if (newAcc) { accounts[email] = newAcc; saveAccounts(); } if (!profiles[oid]) { profiles[oid] = { name, num: freeNum(name, oid), color: '', bio: '', avatar: '' }; saveProfiles(); }
      clients.set(id, { ws, name, key, oid, status: 'online', voice: false, muted: false, video: false });
      let tok = '';
      if (!viaTok && d.remember === true) { // fresh token, keep at most 10 per person
        tok = crypto.randomBytes(32).toString('hex'); sessions[sha(tok)] = { oid, exp: Date.now() + TOK_TTL };
        const mine = Object.entries(sessions).filter(([, v]) => v.oid === oid).sort((a, b) => a[1].exp - b[1].exp);
        mine.slice(0, Math.max(0, mine.length - 10)).forEach(([k]) => delete sessions[k]); saveSessions();
      }
      send(ws, { t: 'init', id, oid, tok, ice: ICE, ...view(oid), rel: relOf(oid), emojis, profiles, users: roster(), lfg: lfgOut().posts, max: MAX_USERS });
      return all({ t: 'users', users: roster() });
    }
    if (d.t === 'ping') return send(ws, { t: 'pong' });
    const c = clients.get(id); if (!c) return;
    const err = msg => send(ws, { t: 'perr', msg });
    const mineG = () => { const g = guilds[d.g]; return g && g.members.includes(c.oid) ? g : null; };
    const may = (g, p) => g.owner === c.oid || (g.roles || []).some(r => r.perms.includes(p) && ((g.mroles || {})[c.oid] || []).includes(r.id)); // owner, or a role that grants p
    if (d.t === 'msg' && can(c.oid, d.ch) && String(d.text || '').trim()) { const why = gate(c.oid, d.ch, false); if (why) return err(why); postMessage(d.ch, id, d.text, undefined, d.reply); }
    else if ((d.t === 'edit' || d.t === 'del') && can(c.oid, d.ch) && history[d.ch]) { // people can only change their own messages
      const i = history[d.ch].findIndex(x => x.id === d.id), m = history[d.ch][i];
      const gg = !d.ch.startsWith('dm:') && chGuild(d.ch); // people change their own messages; 'Manage messages' can also delete other people's
      if (!m || !((m.o && m.o === c.oid) || (d.t === 'del' && gg && may(gg, 'msgs')))) return;
      if (d.t === 'del') {
        history[d.ch].splice(i, 1);
        if (m.file && m.file.url) fs.unlink(path.join(UP, path.basename(decodeURIComponent(m.file.url.slice(7)))), () => {});
        saveHistory(); toCh(d.ch, { t: 'del', ch: d.ch, id: m.id });
      } else {
        const text = String(d.text || '').slice(0, 1000);
        if (!text.trim() && !m.file) return;
        m.text = text; m.edited = true; saveHistory(); toCh(d.ch, { t: 'edit', ch: d.ch, id: m.id, text });
      }
    }
    else if (d.t === 'react' && can(c.oid, d.ch) && history[d.ch]) { // emoji reactions: click again to remove yours
      const m = history[d.ch].find(x => x.id === d.id), e = String(d.e || ''), cust = /^:[a-z0-9_]{2,24}:$/.test(e) && !!emojis[e.slice(1, -1)];
      if (!m || !e || (e.length > 8 && !cust)) return;
      if (!chPerm(c.oid, d.ch, 'react')) return err('You do not have permission to add reactions in this channel.');
      m.rx = m.rx || {}; const a = m.rx[e] = m.rx[e] || [], i = a.indexOf(c.oid);
      i < 0 ? a.push(c.oid) : a.splice(i, 1); if (!a.length) delete m.rx[e];
      if (Object.keys(m.rx).length > 20) return;
      saveHistory(); toCh(d.ch, { t: 'rx', ch: d.ch, id: m.id, rx: m.rx });
    }
    else if (d.t === 'gcreate') { // make your own server
      const name = String(d.name || '').trim().slice(0, 32); if (!name) return err('Name your server.');
      if (Object.values(guilds).filter(g => g.owner === c.oid).length >= 10) return err('You can own up to 10 servers.');
      const gid = rid(), g = guilds[gid] = { id: gid, name, owner: c.oid, code: rid(), members: [c.oid], icon: '', color: '', desc: '',
        channels: [{ id: gid + '-general', name: 'general', type: 'text' }, { id: gid + '-lounge', name: 'Lounge', type: 'voice' }] };
      saveGuilds(); pushG(g); send(ws, { t: 'go', g: gid });
    }
    else if (d.t === 'gjoin') {
      const g = Object.values(guilds).find(x => x.code === String(d.code || '').trim().toLowerCase());
      if (!g) return err('That invite code is not valid.');
      if ((g.bans || []).includes(c.oid)) return err('You are banned from this server.');
      if (!g.members.includes(c.oid)) { g.members.push(c.oid); saveGuilds(); }
      send(ws, { t: 'hist', history: view(c.oid).history }); pushG(g); send(ws, { t: 'go', g: g.id });
    }
    else if (d.t === 'gleave') {
      const g = mineG(); if (!g || g.owner === c.oid) return;
      g.members = g.members.filter(o => o !== c.oid); if (g.mroles) delete g.mroles[c.oid]; if (g.nicks) delete g.nicks[c.oid]; saveGuilds(); send(ws, { t: 'gone', g: g.id }); pushG(g);
    }
    else if (d.t === 'gdel') {
      const g = mineG(); if (!g || g.owner !== c.oid) return;
      toG(g, { t: 'gone', g: g.id }); g.channels.forEach(x => delete history[x.id]); delete guilds[g.id]; saveGuilds(); saveHistory();
    }
    else if (d.t === 'chadd' || d.t === 'chdel') { // channel management: owner or 'channels' role
      const g = mineG(); if (!g || !may(g, 'channels')) return;
      if (d.t === 'chadd') {
        const type = d.type === 'voice' ? 'voice' : 'text', raw = String(d.name || '').trim();
        const name = (type === 'text' ? raw.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') : raw).slice(0, 24);
        if (!name) return err('Enter a channel name.'); if (g.channels.length >= 30) return err('Too many channels.');
        g.channels.push(Object.assign({ id: g.id + '-' + rid(), name, type }, (g.categories || []).some(k => k.id === d.cat) ? { cat: d.cat } : {}));
      } else {
        const x = g.channels.find(k => k.id === d.id); if (!x) return;
        if (x.type === 'text' && g.channels.filter(k => k.type === 'text').length < 2) return err('A server needs at least one text channel.');
        g.channels = g.channels.filter(k => k !== x); delete history[x.id]; saveHistory();
        clients.forEach(o => { if (o.voice === x.id) { o.voice = false; o.muted = o.video = false; } }); all({ t: 'users', users: roster() });
      }
      saveGuilds(); pushG(g);
    }
    else if (d.t === 'chmove') { // drag to reorder: any channel (text or voice) can go anywhere, into any category; owner or 'channels' role
      const g = mineG(); if (!g || !may(g, 'channels')) return; const before = String(d.before || '');
      const x = g.channels.find(c => c.id === d.id); if (!x || before === x.id) return;
      const tgt = before ? g.channels.find(c => c.id === before) : null; if (before && !tgt) return;
      const cat = d.cat !== undefined ? String(d.cat || '') : tgt ? (tgt.cat || '') : (x.cat || '');
      if (cat && !(g.categories || []).some(k => k.id === cat)) return;
      if (cat) x.cat = cat; else delete x.cat;
      const rest = g.channels.filter(c => c !== x); let i = -1;
      if (before) i = rest.findIndex(c => c.id === before); else { rest.forEach((c, k) => { if ((c.cat || '') === cat) i = k + 1; }); if (i < 0) i = rest.length; }
      rest.splice(i, 0, x); g.channels = rest; saveGuilds(); pushG(g);
    }
    else if (d.t === 'catadd' || d.t === 'catedit' || d.t === 'catdel') { // categories: owner or 'channels' role
      const g = mineG(); if (!g || !may(g, 'channels')) return; g.categories = g.categories || [];
      const name = String(d.name || '').trim().slice(0, 24);
      if (d.t === 'catadd') {
        if (!name) return err('Enter a category name.'); if (g.categories.length >= 12) return err('Too many categories.');
        g.categories.push({ id: 'k' + rid(), name });
      } else {
        const k = g.categories.find(x => x.id === d.id); if (!k) return;
        if (d.t === 'catedit') { if (!name) return err('Enter a category name.'); k.name = name; }
        else { g.categories = g.categories.filter(x => x !== k); g.channels.forEach(ch => { if (ch.cat === k.id) delete ch.cat; }); }
      }
      saveGuilds(); pushG(g);
    }
    else if (d.t === 'gset') { // server settings: name, description, colour, icon
      const g = mineG(); if (!g || !may(g, 'server')) return;
      const name = String(d.name || '').trim().slice(0, 32); if (!name) return err('Name your server.');
      g.name = name; g.desc = String(d.desc || '').slice(0, 200);
      g.color = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color.toLowerCase() : '';
      g.icon = typeof d.icon === 'string' && d.icon.length <= 60000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(d.icon) ? d.icon : '';
      saveGuilds(); pushG(g);
    }
    else if (d.t === 'nickset') { // server-only nicknames: owner, or a role with the 'nicks' permission
      const g = mineG(); if (!g || !may(g, 'nicks') || !g.members.includes(d.o)) return;
      if (d.o === g.owner && c.oid !== g.owner) return err('Only the owner can change the owner\u2019s nickname.');
      const nick = String(d.nick || '').trim().slice(0, 32); g.nicks = g.nicks || {};
      if (nick) g.nicks[d.o] = nick; else delete g.nicks[d.o];
      saveGuilds(); pushG(g);
    }
    else if (d.t === 'rolesave' || d.t === 'roledel' || d.t === 'roleset') { // roles: the owner, or anyone with 'roles' (who can only hand out permissions they hold themselves)
      const g = mineG(); if (!g || !may(g, 'roles')) return; g.roles = g.roles || []; g.mroles = g.mroles || {};
      const held = new Set(g.owner === c.oid ? ROLE_PERMS : g.roles.filter(r => (g.mroles[c.oid] || []).includes(r.id)).flatMap(r => r.perms));
      const touch = r => g.owner === c.oid || r.perms.every(p => held.has(p));
      const deny = () => { err('You can only change roles whose permissions you have yourself.'); send(ws, { t: 'guild', g: gOut(g, c.oid) }); };
      if (d.t === 'roleset') {
        if (!g.members.includes(d.o)) return;
        const ids = [...new Set(Array.isArray(d.roles) ? d.roles : [])].filter(i => g.roles.some(r => r.id === i));
        if (d.o === g.owner && c.oid !== g.owner) { err('Only the owner can change the owner\u2019s roles.'); return send(ws, { t: 'guild', g: gOut(g, c.oid) }); }
        const was = g.mroles[d.o] || [];
        if ([...new Set([...was, ...ids])].filter(i => was.includes(i) !== ids.includes(i)).some(i => { const r = g.roles.find(x => x.id === i); return r && !touch(r); })) return deny();
        if (ids.length) g.mroles[d.o] = ids; else delete g.mroles[d.o];
      } else if (d.t === 'roledel') {
        const dr = g.roles.find(r => r.id === d.id); if (dr && !touch(dr)) return deny();
        g.roles = g.roles.filter(r => r.id !== d.id); g.channels.forEach(x => { if (x.ov) { delete x.ov[d.id]; if (!Object.keys(x.ov).length) delete x.ov; } });
        for (const o in g.mroles) { g.mroles[o] = g.mroles[o].filter(i => i !== d.id); if (!g.mroles[o].length) delete g.mroles[o]; }
      } else {
        const name = String(d.name || '').trim().slice(0, 24); if (!name) return err('Name the role.');
        const color = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color.toLowerCase() : '#8e8d98';
        const perms = ROLE_PERMS.filter(p => Array.isArray(d.perms) && d.perms.includes(p) && held.has(p)), r = g.roles.find(x => x.id === d.id);
        if (r && !touch(r)) return deny();
        const glow = ['soft', 'strong', 'pulse', 'neon', 'rainbow', 'shimmer', 'aurora', 'ember'].includes(d.glow) ? d.glow : ''; // optional role glow
        const icon = [...clean(d.icon, 16)].slice(0, 8).join(''), color2 = /^#[0-9a-f]{6}$/i.test(d.color2) ? d.color2.toLowerCase() : '', style = ['bold', 'italic'].includes(d.style) ? d.style : '', badge = !!d.badge, rnfx = ['flow', 'shimmer', 'neon', 'rainbow'].includes(d.nfx) ? d.nfx : ''; // role icon, gradient end, name style, chat badge
        if (r) Object.assign(r, { name, color, perms, glow, icon, color2, style, badge, nfx: rnfx });
        else { if (g.roles.length >= 20) return err('You can have up to 20 roles.'); g.roles.push({ id: 'r' + rid(), name, color, perms, glow, icon, color2, style, badge, nfx: rnfx }); }
      }
      saveGuilds(); pushG(g); enforceVc(g);
    }
    else if (d.t === 'gcode') { const g = mineG(); if (!g || !may(g, 'server')) return; g.code = rid(); saveGuilds(); pushG(g); }
    else if (d.t === 'lfgpost') { // community board: anyone can post, up to 3 live posts each
      const game = String(d.game || '').trim().slice(0, 40), note = String(d.note || '').trim().slice(0, 200);
      const mode = ['Any', 'Casual', 'Ranked'].includes(d.mode) ? d.mode : 'Any', need = Math.min(9, Math.max(1, Math.floor(+d.need) || 1));
      if (!game) return err('Say which game you want to play.');
      if (Date.now() - (c.lfgT || 0) < 5000) return err('Slow down a little before posting again.');
      lfgLive(); if (lfg.filter(p => p.o === c.oid).length >= 3) return err('You can have up to 3 live posts. Close one first.');
      c.lfgT = Date.now(); lfg.push({ id: rid(), o: c.oid, game, note, mode, need, ts: Date.now(), exp: Date.now() + LFG_TTL }); all(lfgOut());
    }
    else if (d.t === 'lfgdel') { const i = lfg.findIndex(p => p.id === d.id && p.o === c.oid); if (i < 0) return; lfg.splice(i, 1); all(lfgOut()); }
    else if (d.t === 'gmod') { // moderation: mute / deafen / timeout / ban (and their undo), each behind its own role permission
      const g = mineG(), o = String(d.o || ''), a = String(d.a || '');
      const need = { mute: 'mute', unmute: 'mute', deafen: 'deafen', undeafen: 'deafen', timeout: 'timeout', untimeout: 'timeout', ban: 'ban', unban: 'ban', vkick: 'vkick' }[a];
      if (!g || !need || !may(g, need)) return;
      if (o === g.owner) return err('You cannot do that to the server owner.'); if (o === c.oid) return err('You cannot do that to yourself.');
      if (a === 'unban') { g.bans = (g.bans || []).filter(x => x !== o); saveGuilds(); return pushG(g); }
      if (!g.members.includes(o)) return;
      const flag = (k, on) => { g[k] = g[k] || {}; if (on) g[k][o] = 1; else delete g[k][o]; };
      if (a === 'mute' || a === 'unmute') flag('smuted', a === 'mute');
      else if (a === 'deafen' || a === 'undeafen') flag('sdeaf', a === 'deafen');
      else if (a === 'timeout') {
        const secs = Math.floor(+d.secs); if (!(secs >= 10)) return err('Pick a timeout of at least 10 seconds.');
        g.timeouts = g.timeouts || {}; g.timeouts[o] = Date.now() + Math.min(secs, 28 * 86400) * 1000;
      } else if (a === 'untimeout') { if (g.timeouts) delete g.timeouts[o]; }
      else if (a === 'vkick') { // disconnect from voice (they can rejoin)
        let n = 0; clients.forEach(x => { if (x.oid === o && g.channels.some(k => k.id === x.voice)) { x.voice = false; x.muted = x.video = false; send(x.ws, { t: 'vdeny' }); n++; } });
        if (!n) return err('They are not in one of this server\u2019s voice channels.');
      }
      else if (a === 'ban') {
        if ((g.bans || []).length >= 200) return err('Too many banned members. Unban someone first.');
        g.members = g.members.filter(x => x !== o); g.bans = [...new Set([...(g.bans || []), o])];
        for (const k of ['mroles', 'nicks', 'smuted', 'sdeaf', 'timeouts']) if (g[k]) delete g[k][o];
        clients.forEach(x => { if (x.oid === o) { send(x.ws, { t: 'gone', g: g.id }); if (g.channels.some(k => k.id === x.voice)) { x.voice = false; x.muted = x.video = false; } } });
      }
      saveGuilds(); pushG(g); all({ t: 'users', users: roster() });
    }
    else if (d.t === 'gkick') {
      const g = mineG(); if (!g || !may(g, 'kick') || d.o === c.oid || d.o === g.owner || !g.members.includes(d.o)) return;
      g.members = g.members.filter(o => o !== d.o); if (g.mroles) delete g.mroles[d.o]; if (g.nicks) delete g.nicks[d.o]; saveGuilds();
      clients.forEach(o => { if (o.oid === d.o) { send(o.ws, { t: 'gone', g: g.id }); if (g.channels.some(x => x.id === o.voice)) o.voice = false; } });
      pushG(g); all({ t: 'users', users: roster() });
    }
    else if (d.t === 'chedit') { // rename a channel / set its topic
      const g = mineG(), x = g && g.channels.find(k => k.id === d.id); if (!x || !may(g, 'channels')) return;
      const raw = String(d.name || '').trim(), name = (x.type === 'text' ? raw.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') : raw).slice(0, 24);
      if (!name) return err('Enter a channel name.');
      x.icon = typeof d.icon === 'string' && d.icon.length <= 40000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(d.icon) ? d.icon : '';
      if (d.cat !== undefined) { if ((g.categories || []).some(k => k.id === d.cat)) x.cat = d.cat; else delete x.cat; }
      x.name = name; if (x.type === 'text') x.topic = String(d.topic || '').trim().slice(0, 100);
      saveGuilds(); pushG(g); enforceVc(g);
    }
    else if (d.t === 'chperm') { // channel permissions: per role (and @everyone = 'e'), each perm is allow / deny / inherit. Needs 'roles'.
      const g = mineG(), x = g && g.channels.find(k => k.id === d.id); if (!x || !may(g, 'roles')) return;
      const src = d.ov && typeof d.ov === 'object' ? d.ov : {}, ok = CHP[x.type], ov = {};
      for (const k of ['e', ...(g.roles || []).map(r => r.id)]) {
        const s = src[k]; if (!s || typeof s !== 'object') continue;
        const allow = ok.filter(p => Array.isArray(s.allow) && s.allow.includes(p)), deny = ok.filter(p => Array.isArray(s.deny) && s.deny.includes(p) && !allow.includes(p));
        if (allow.length || deny.length) ov[k] = { allow, deny };
      }
      if (Object.keys(ov).length) x.ov = ov; else delete x.ov;
      saveGuilds(); pushG(g); enforceVc(g);
    }
    else if (d.t === 'profile') {
      const want = String(d.name || '').trim().slice(0, 24) || c.name, old = profiles[c.oid] || {}, name = want; // names can change; the number stays unless name#number would clash
      let num = old.num; if (!num || Object.entries(profiles).some(([o, p]) => o !== c.oid && p.num === num && p.name && norm(p.name) === norm(want))) num = freeNum(want, c.oid);
      const color = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color.toLowerCase() : '';
      const avatar = typeof d.avatar === 'string' && d.avatar.length <= 60000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(d.avatar) ? d.avatar : '';
      const banner = typeof d.banner === 'string' && /^\/files\/[0-9a-f]{8}_banner\.(gif|png|jpg|webp)$/.test(d.banner) && fs.existsSync(path.join(UP, path.basename(d.banner))) ? d.banner : '';
      const oldB = (profiles[c.oid] || {}).banner; if (oldB && oldB !== banner) fs.unlink(path.join(UP, path.basename(oldB)), () => {});
      const hx = v => /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '';
      let gl = hx(d.gl), gr = hx(d.gr); if (gl || gr) { gl = gl || gr; gr = gr || gl; } // left/right gradient colours
      const fx = ['ring', 'glow', 'neon', 'pulse', 'breathe', 'flicker', 'heartbeat', 'dash', 'comet', 'sparkle', 'orbit', 'rainbow', 'aurora', 'ripple', 'fire', 'electric', 'halo', 'glitch'].includes(d.fx) ? d.fx : '', rc = hx(d.rc); // avatar effect + its colour
      const cg = ['steady', 'breathe', 'flicker', 'heartbeat', 'aurora', 'sweep', 'rainbow'].includes(d.cg) ? d.cg : '', cc = hx(d.cc), cc2 = hx(d.cc2), ci = [1, 2, 3].includes(+d.ci) ? +d.ci : 2; // profile-card glow: style, two colours, intensity
      const nfx = ['gradient', 'flow', 'shimmer', 'neon', 'rainbow', 'fire', 'ice', 'pulse'].includes(d.nfx) ? d.nfx : '', nc = hx(d.nc), nc2 = hx(d.nc2); // name style
      const bfx = ['shine', 'aurora', 'scan', 'sparkle'].includes(d.bfx) ? d.bfx : '', bc = hx(d.bc); // banner effect
      profiles[c.oid] = { ...(old.disc === false ? { disc: false } : {}), name, num, color, bio: String(d.bio || '').slice(0, 140), avatar, banner, gl, gr, fx, rc, cg, cc, cc2, ci, nfx, nc, nc2, bfx, bc, pn: clean(d.pn, 24), cs: clean(d.cs, 60), ce: [...clean(d.ce, 16)].slice(0, 8).join(''), pl: clean(d.pl, 40) }; c.name = name; saveProfiles();
      all({ t: 'profiles', p: { [c.oid]: profiles[c.oid] } }); all({ t: 'users', users: roster() });
    }
    else if (d.t === 'priv') { // account discoverable: off hides you from name#number lookups and New message search (friends & people in shared servers can still find you)
      const p = profiles[c.oid]; if (!p || c.oid[0] === 'u') return;
      if (d.disc === false) p.disc = false; else delete p.disc;
      saveProfiles(); all({ t: 'profiles', p: { [c.oid]: p } });
    }
    else if (d.t === 'forget') { if (sessions[sha(String(d.token || '').slice(0, 100))]?.oid === c.oid) { delete sessions[sha(String(d.token || '').slice(0, 100))]; saveSessions(); } }
    else if (d.t === 'emdel') { // only whoever added an emoji can delete it
      const n = String(d.name || ''), e = emojis[n]; if (!e || e.o !== c.oid) return;
      delete emojis[n]; fs.unlink(path.join(UP, path.basename(e.url)), () => {}); saveEmojis(); all({ t: 'emojis', e: emojis });
    }
    else if (d.t === 'status') { c.status = ['online', 'dnd', 'sleep', 'offline'].includes(d.s) ? d.s : 'online'; all({ t: 'users', users: roster() }); }
    else if (d.t === 'fadd' || d.t === 'facc' || d.t === 'fdec' || d.t === 'frem') { // friends: request, accept, decline/cancel, remove
      let o = String(d.o || '');
      if (d.t === 'fadd' && d.tag) { const m = /^(.{1,24})#(\d{4})$/.exec(String(d.tag).trim()), f = m && Object.entries(profiles).find(([, p]) => p.num === m[2] && p.name && norm(p.name) === norm(m[1])); if (!f) return err('No one found with that name and number.'); o = f[0]; }
      if (!o || o === c.oid || o[0] === 'u' || c.oid[0] === 'u' || !profiles[o]) return; // guests (no saved identity) can't have friends
      if (d.t === 'fadd' && profiles[o].disc === false && !relOf(c.oid).f.includes(o) && !relOf(c.oid).i.includes(o) && !Object.values(guilds).some(g => g.members.includes(c.oid) && g.members.includes(o))) return err('No one found with that name and number.'); // not discoverable
      const a = R(c.oid), b = R(o), drop = (x, y) => { rm(x.i, y); rm(x.o, y); };
      const befriend = () => { drop(a, o); drop(b, c.oid); if (!a.f.includes(o)) a.f.push(o); if (!b.f.includes(c.oid)) b.f.push(c.oid); };
      if (d.t === 'fadd') {
        if (a.f.includes(o) || a.o.includes(o)) return;
        if (a.i.includes(o)) befriend(); // they already asked you: that makes you friends
        else { if (a.o.length >= 50) return err('Too many pending requests.'); a.o.push(o); b.i.push(c.oid); }
      } else if (d.t === 'facc') { if (!a.i.includes(o)) return; befriend(); }
      else if (d.t === 'fdec') { drop(a, o); drop(b, c.oid); }
      else { rm(a.f, o); rm(b.f, c.oid); }
      saveRel(); pushRel(c.oid, o);
    }
    else if (d.t === 'typing' && can(c.oid, d.ch)) { const a = audience(d.ch); clients.forEach((o, i) => i !== id && a.includes(o.oid) && send(o.ws, { t: 'typing', ch: d.ch, uid: id })); }
    else if (d.t === 'voice') {
      if (d.on && can(c.oid, d.ch) && !vcOK(c.oid, d.ch)) { send(ws, { t: 'vdeny' }); return err('You do not have permission to join this voice channel.'); }
      c.voice = d.on && can(c.oid, d.ch) ? d.ch : false; if (!c.voice) c.muted = c.video = false; all({ t: 'users', users: roster() }); }
    else if (d.t === 'state') { c.muted = !!d.muted; c.video = !!d.video; c.scr = !!d.scr; all({ t: 'users', users: roster() }); }
    else if (d.t === 'sig') { const o = clients.get(d.to); if (o && o.voice && o.voice === c.voice) send(o.ws, { t: 'sig', from: id, d: d.d }); }
  });
  ws.on('close', () => { if (id) { const o = clients.get(id) && clients.get(id).oid; clients.delete(id); if (o && o[0] === 'u') delete profiles[o]; all({ t: 'users', users: roster() }); } });
});

setInterval(() => wss.clients.forEach(w => { if (!w.isAlive) return w.terminate(); w.isAlive = false; w.ping(); }), 30000);

server.listen(PORT, () => {
  if (process.env.HUDDLE_HOST) return;
  console.log(`\nHuddle server running on http://localhost:${PORT} (max ${MAX_USERS} users)`);
  if (!PASSWORD) console.log('WARNING: no password set. Anyone with your tunnel link can join. Set PASSWORD=... before exposing it.');
  console.log('\nNext, in a second terminal, start the tunnel:');
  console.log(`  cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('Send the https://....trycloudflare.com address it prints to your friends.\n');
});
