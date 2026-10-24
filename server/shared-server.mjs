import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { PAPER, PASSAGES } from '../src/core/discussion.mjs';
import { createSharedState, applySharedOperation } from '../src/core/shared-discussion.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE_PREFIX = 'companion_shared_session_v1_';
const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 32 * 1024;
const derive = promisify(scrypt);
const PASSWORD_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const SHARED_PAPER = Object.freeze({ id: 'fixed-points-v1', title: PAPER, version: 'original-v1', passages: PASSAGES.map(p => ({ ...p, page: 1 })) });
const ASSETS = new Map([
  ['/', ['room.html', 'text/html; charset=utf-8']],
  ['/room.html', ['room.html', 'text/html; charset=utf-8']],
  ['/src/room.mjs', ['src/room.mjs', 'text/javascript; charset=utf-8']],
  ['/src/room.css', ['src/room.css', 'text/css; charset=utf-8']],
  ['/src/group.css', ['src/group.css', 'text/css; charset=utf-8']],
]);

function failure(statusCode, code, message) { return Object.assign(new Error(message), { statusCode, code }); }
const hash = text => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!ownObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure(400, 'validation_error', 'The request contains unsupported fields.');
}
function name(value, max, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw failure(400, 'validation_error', `${label} must contain 2–${max} readable characters.`);
  const normalized = value.trim().normalize('NFKC');
  if (normalized.length < 2 || normalized.length > max) throw failure(400, 'validation_error', `${label} must contain 2–${max} readable characters.`);
  return normalized;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 512) throw failure(400, 'validation_error', 'Choose a password with 12–128 characters.');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (ownObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** One local group, authenticated members, and atomic versioned discussion state. */
export async function createSharedServer({ dbPath, port = 4174, root = REPO_ROOT, now = Date.now, authLimit = 20 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('An explicit SQLite database path is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid shared-room port.');
  const rootReal = await realpath(root);
  if (dbPath !== ':memory:') await mkdir(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT UNIQUE NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','member')),salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS room(id INTEGER PRIMARY KEY CHECK(id=1),group_id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,created_by TEXT NOT NULL REFERENCES members(id),expires_at INTEGER NOT NULL,used_at INTEGER);
    CREATE TABLE IF NOT EXISTS receipts(member_id TEXT NOT NULL REFERENCES members(id),operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(member_id,operation_id));`);
  const dummySalt = randomBytes(16).toString('hex'), dummyHash = randomBytes(64);
  let passwordJobs = 0;
  const authWindows = new Map();
  let closed = false;

  function transact(callback) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function roomRow() { return db.prepare('SELECT * FROM room WHERE id=1').get(); }
  function members() { return db.prepare('SELECT id,name,role FROM members ORDER BY created_at,id').all().map(row => ({ ...row })); }
  function snapshot() {
    const saved = roomRow();
    if (!saved) throw failure(409, 'setup_required', 'Create the reading group first.');
    const state = JSON.parse(saved.state_json);
    return { revision: saved.revision, group: { id: saved.group_id, name: saved.name }, paper: SHARED_PAPER, members: members(), threads: state.threads };
  }
  function currentOrigin(req) {
    const actualPort = server.address()?.port || port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) throw failure(403, 'invalid_host', 'Only this local reading-room address is allowed.');
    return `http://${req.headers.host}`;
  }
  function requestSession(req) {
    const cookieName = `${COOKIE_PREFIX}${server.address()?.port || port}`;
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return null;
    const raw = cookies[0].slice(cookieName.length + 1);
    if (!validToken(raw)) return null;
    const saved = db.prepare('SELECT sessions.*,members.name,members.role FROM sessions JOIN members ON members.id=sessions.member_id WHERE token_hash=?').get(hash(raw));
    if (!saved || saved.expires_at <= now()) {
      if (saved) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(raw));
      return null;
    }
    return { tokenHash: saved.token_hash, csrf: saved.csrf, user: { id: saved.member_id, name: saved.name, role: saved.role } };
  }
  function requireSession(req) { const result = requestSession(req); if (!result) throw failure(401, 'authentication_required', 'Sign in to the reading group.'); return result; }
  function setCookie(res, raw, age = SESSION_MS / 1000) {
    // Only API requests need the cookie; static documents/assets receive none.
    const cookieName = `${COOKIE_PREFIX}${server.address()?.port || port}`;
    res.setHeader('Set-Cookie', `${cookieName}=${raw}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}`);
  }
  function newSession(memberId, res) {
    const raw = token(), csrfToken = token(), at = now();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(at);
    const previous = db.prepare('SELECT token_hash FROM sessions WHERE member_id=? ORDER BY created_at DESC').all(memberId);
    for (const old of previous.slice(4)) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(raw), memberId, csrfToken, at + SESSION_MS, at);
    setCookie(res, raw); return csrfToken;
  }
  function rateAuth(req, displayName = '') {
    const safeName = typeof displayName === 'string' ? displayName.normalize('NFKC').toLowerCase().slice(0, 60) : '';
    const at = now(), keys = [`ip:${req.socket.remoteAddress}`, `name:${safeName}`];
    for (const [key, record] of authWindows) if (record.until <= at) authWindows.delete(key);
    for (const key of keys) {
      const record = authWindows.get(key) || { count: 0, until: at + 15 * 60 * 1000 };
      if (record.count >= authLimit) throw failure(429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
      record.count += 1; authWindows.set(key, record);
    }
  }
  async function passwordKey(value, salt) {
    if (passwordJobs >= 2) throw failure(429, 'busy', 'Sign-in is busy. Try again shortly.');
    passwordJobs += 1;
    try { return await derive(value, salt, 64, PASSWORD_OPTIONS); }
    finally { passwordJobs -= 1; }
  }
  function userCount() { return db.prepare('SELECT count(*) AS count FROM members').get().count; }
  function register(displayName, salt, passwordHash, role) {
    if (userCount() >= 50) throw failure(409, 'member_limit', 'This pilot supports up to 50 group members.');
    const key = displayName.toLowerCase();
    if (db.prepare('SELECT id FROM members WHERE name_key=?').get(key)) throw failure(409, 'name_taken', 'That member name is already in use.');
    const user = { id: randomUUID(), name: displayName, role };
    db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?)').run(user.id, user.name, key, role, salt, passwordHash.toString('hex'), now());
    return user;
  }
  function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    res.end(body);
  }
  async function readBody(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure(415, 'json_required', 'Send this request as JSON.');
    const declared = req.headers['content-length'];
    if (declared && (!/^\d{1,8}$/.test(declared) || Number(declared) > MAX_BODY)) throw failure(413, 'body_too_large', 'The request is too large.');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) throw failure(413, 'body_too_large', 'The request is too large.');
      chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!ownObject(value)) throw new Error(); return value; }
    catch { throw failure(400, 'invalid_json', 'The request must contain a JSON object.'); }
  }
  async function assets(req, res, route) {
    const asset = ASSETS.get(route);
    if (!asset) throw failure(404, 'not_found', 'That resource was not found.');
    const file = await realpath(path.join(rootReal, asset[0])).catch(() => { throw failure(404, 'not_found', 'That resource was not found.'); });
    if (!file.startsWith(rootReal + path.sep)) throw failure(403, 'invalid_path', 'That resource is outside the reading room.');
    const info = await stat(file);
    if (!info.isFile()) throw failure(404, 'not_found', 'That resource was not found.');
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const origin = currentOrigin(req);
      let route;
      try { route = decodeURIComponent((req.url || '').split('?')[0]); }
      catch { throw failure(400, 'invalid_path', 'Invalid request path.'); }
      if (!route.startsWith('/') || /[\\\0:]/.test(route) || route.split('/').some(part => part.startsWith('.'))) throw failure(403, 'invalid_path', 'That path is not allowed.');
      if (req.method === 'OPTIONS') throw failure(403, 'cross_origin_denied', 'Cross-origin requests are not allowed.');
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'method_not_allowed', 'This resource is read-only.');
        await assets(req, res, route); return;
      }
      if (req.method === 'GET') {
        if (route === '/api/health') { json(res, 200, { service: 'companion-shared', version: '0.4.0', setupRequired: !roomRow() }); return; }
        if (route === '/api/session') {
          const session = requestSession(req);
          json(res, 200, { setupRequired: !roomRow(), user: session?.user || null, ...(session ? { csrfToken: session.csrf } : {}) }); return;
        }
        if (route === '/api/room') { requireSession(req); json(res, 200, snapshot()); return; }
        throw failure(404, 'not_found', 'That API endpoint was not found.');
      }
      if (req.method !== 'POST') throw failure(405, 'method_not_allowed', 'Use GET or POST for this endpoint.');
      if (req.headers.origin !== origin) throw failure(403, 'invalid_origin', 'Submit changes from this reading-room page.');
      const body = await readBody(req);

      if (route === '/api/setup') {
        fields(body, ['groupName', 'displayName', 'password']);
        rateAuth(req, body.displayName);
        if (roomRow()) throw failure(409, 'setup_complete', 'This reading group has already been created.');
        const groupName = name(body.groupName, 80, 'Group name'), displayName = name(body.displayName, 60, 'Member name');
        const salt = randomBytes(16).toString('hex'), key = await passwordKey(password(body.password), salt);
        const result = transact(() => {
          if (roomRow()) throw failure(409, 'setup_complete', 'This reading group has already been created.');
          const user = register(displayName, salt, key, 'admin');
          db.prepare('INSERT INTO room VALUES(1,?,?,0,?)').run(randomUUID(), groupName, JSON.stringify(createSharedState()));
          const csrfToken = newSession(user.id, res); return { user, csrfToken, room: snapshot() };
        });
        json(res, 201, result); return;
      }
      if (route === '/api/login') {
        fields(body, ['displayName', 'password']); rateAuth(req, body.displayName);
        const displayName = name(body.displayName, 60, 'Member name'), supplied = password(body.password);
        const saved = db.prepare('SELECT * FROM members WHERE name_key=?').get(displayName.toLowerCase());
        const key = await passwordKey(supplied, saved?.salt || dummySalt);
        const expected = saved ? Buffer.from(saved.password_hash, 'hex') : dummyHash;
        if (!timingSafeEqual(key, expected) || !saved) throw failure(401, 'invalid_credentials', 'The member name or password is incorrect.');
        const user = { id: saved.id, name: saved.name, role: saved.role };
        const csrfToken = transact(() => newSession(user.id, res));
        json(res, 200, { user, csrfToken, room: snapshot() }); return;
      }
      if (route === '/api/join') {
        fields(body, ['inviteToken', 'displayName', 'password']); rateAuth(req, body.displayName);
        if (!validToken(body.inviteToken)) throw failure(400, 'invalid_invite', 'This invite is invalid, expired, or already used.');
        const inviteHash = hash(body.inviteToken);
        const invite = db.prepare('SELECT * FROM invites WHERE token_hash=?').get(inviteHash);
        if (!invite || invite.used_at !== null || invite.expires_at <= now()) throw failure(400, 'invalid_invite', 'This invite is invalid, expired, or already used.');
        const displayName = name(body.displayName, 60, 'Member name'), salt = randomBytes(16).toString('hex');
        const key = await passwordKey(password(body.password), salt);
        const result = transact(() => {
          const current = db.prepare('SELECT * FROM invites WHERE token_hash=?').get(inviteHash);
          if (!current || current.used_at !== null || current.expires_at <= now()) throw failure(400, 'invalid_invite', 'This invite is invalid, expired, or already used.');
          const user = register(displayName, salt, key, 'member');
          db.prepare('UPDATE invites SET used_at=? WHERE token_hash=?').run(now(), inviteHash);
          db.prepare('UPDATE room SET revision=revision+1 WHERE id=1').run();
          const csrfToken = newSession(user.id, res); return { user, csrfToken, room: snapshot() };
        });
        json(res, 201, result); return;
      }

      const session = requireSession(req);
      if (typeof req.headers['x-csrf-token'] !== 'string' || req.headers['x-csrf-token'] !== session.csrf) throw failure(403, 'invalid_csrf', 'Refresh this page before submitting changes.');
      if (route === '/api/logout') {
        fields(body, []); db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.tokenHash); setCookie(res, '', 0); json(res, 200, { ok: true }); return;
      }
      if (route === '/api/invites') {
        fields(body, []);
        if (session.user.role !== 'admin') throw failure(403, 'forbidden', 'Only the group administrator can create invite links.');
        const at = now();
        const active = db.prepare('SELECT count(*) AS count FROM invites WHERE used_at IS NULL AND expires_at>?').get(at).count;
        if (active >= 20) throw failure(429, 'invite_limit', 'This pilot has 20 active invite links. Wait for them to be used or expire.');
        const raw = token(), expiresAt = at + INVITE_MS;
        db.prepare('INSERT INTO invites VALUES(?,?,?,NULL)').run(hash(raw), session.user.id, expiresAt);
        json(res, 201, { inviteToken: raw, inviteUrl: `${origin}/room.html#invite=${raw}`, expiresAt: new Date(expiresAt).toISOString() }); return;
      }
      if (route === '/api/operations') {
        if (Object.values(body).some(value => value !== null && typeof value === 'object')) throw failure(400, 'validation_error', 'Operation fields must be text or numbers.');
        if (typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId)
            || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw failure(400, 'validation_error', 'Use a unique operation ID and the current room revision.');
        const payloadHash = hash(JSON.stringify(canonical(body)));
        const result = transact(() => {
          const receipt = db.prepare('SELECT payload_hash FROM receipts WHERE member_id=? AND operation_id=?').get(session.user.id, body.operationId);
          if (receipt) {
            if (receipt.payload_hash !== payloadHash) throw failure(409, 'operation_conflict', 'That operation ID was already used for a different request.');
            return { operationId: body.operationId, room: snapshot(), replayed: true };
          }
          const saved = roomRow();
          if (saved.revision !== body.expectedRevision) throw failure(409, 'revision_conflict', 'The discussion changed. Your draft can be kept while you review the latest version.');
          const state = JSON.parse(saved.state_json);
          const next = applySharedOperation(state, session.user, members(), SHARED_PAPER, body);
          if (db.prepare('SELECT count(*) AS count FROM receipts').get().count >= 50000) throw failure(409, 'history_limit', 'This pilot has reached its operation history limit.');
          db.prepare('UPDATE room SET state_json=?,revision=revision+1 WHERE id=1').run(JSON.stringify(next));
          db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(session.user.id, body.operationId, payloadHash, now());
          return { operationId: body.operationId, room: snapshot(), replayed: false };
        });
        json(res, 200, result); return;
      }
      throw failure(404, 'not_found', 'That API endpoint was not found.');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      const value = { error: { code: status === 500 ? 'internal_error' : error.code || 'request_failed', message: status === 500 ? 'The reading room could not complete this request.' : error.message } };
      if (status === 409 && ['revision_conflict', 'contribution_conflict', 'operation_conflict'].includes(error.code)) {
        try { value.room = snapshot(); } catch { /* Missing setup must not mask the original error. */ }
      }
      if (status === 429) res.setHeader('Retry-After', '60');
      json(res, status, value);
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 64;
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}/room.html` };
    },
    async close() {
      if (closed) return; closed = true;
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node server/shared-server.mjs [--db <SQLite path>] [--port <port>]\nThe server binds only to 127.0.0.1.'); }
  else {
    let dbPath = process.env.COMPANION_SHARED_DB || path.join(process.env.COMPANION_SHARED_DATA_DIR || path.resolve(REPO_ROOT, '..', '..', 'work', 'companion-shared'), 'room.sqlite');
    let port = Number(process.env.COMPANION_SHARED_PORT || 4174);
    for (let index = 0; index < args.length; index += 2) {
      if (!['--db', '--port'].includes(args[index]) || !args[index + 1]) throw new Error('Use --db <path> or --port <port>.');
      if (args[index] === '--db') dbPath = path.resolve(args[index + 1]); else port = Number(args[index + 1]);
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.');
    const app = await createSharedServer({ dbPath, port });
    const address = await app.listen();
    console.log(`Companion shared room: ${address.url}\nLocal pilot only. Create the first administrator in the browser; no account is pre-created.`);
    const stop = () => { app.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
