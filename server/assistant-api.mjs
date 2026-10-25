import { randomBytes, createHash } from 'node:crypto';
import localProviderModule from '../electron/local-provider.cjs';
import providerModule from '../electron/provider.cjs';
import { createProductivityApi } from './productivity-api.mjs';

const { createLocalProvider, DEFAULT_LOCAL_MODEL } = localProviderModule;
const { validateAsk, validateAudio, requestId } = providerModule;
const SESSION_MS = 8 * 60 * 60 * 1000;
const JSON_LIMIT = 128 * 1024;
const AUDIO_LIMIT = 10 * 1024 * 1024;
const FORMATS = new Set(['audio/webm', 'video/webm', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg', 'audio/m4a']);
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const stopped = () => fail(499, 'request_cancelled', 'Request stopped.');

function json(res, statusCode, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(body);
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, 'validation_error', 'The request contains unsupported fields.');
}
function validate(check) {
  try { return check(); }
  catch (error) { throw fail(400, 'validation_error', error.message); }
}
async function readBytes(req, limit) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fail(415, 'unsupported_encoding', 'Send uncompressed request data.');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d{1,9}$/.test(declared) || Number(declared) > limit)) throw fail(413, 'body_too_large', 'The request is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'body_too_large', 'The request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'json_required', 'Send this request as JSON.');
  const bytes = await readBytes(req, JSON_LIMIT);
  try { const value = JSON.parse(bytes.toString('utf8')); fields(value, Object.keys(value || {})); return value; }
  catch { throw fail(400, 'invalid_json', 'The request must contain a JSON object.'); }
}

/** Personal, memory-only local inference. It never authenticates a group member. */
export function createAssistantApi({ provider = createLocalProvider({ model: process.env.COMPANION_LOCAL_MODEL || DEFAULT_LOCAL_MODEL }), now = Date.now, getPort, root, dataDirectory, createProductivityRuntime, sessionLimit = 64, sessionRateLimit = 30, requestRateLimit = 30, requestTimeoutMs = 125000 } = {}) {
  if (!provider || ['getStatus', 'ask', 'transcribe', 'cancel', 'cancelScope'].some(method => typeof provider[method] !== 'function')) throw new Error('Invalid local assistant provider.');
  const sessions = new Map(), creationWindows = new Map(), inFlight = new Set(), active = new Map();
  const productivity = createProductivityApi({ root, dataDirectory, createRuntime: createProductivityRuntime });
  let statusCache = null, statusPending = null, closed = false;
  const cookieName = () => `companion_assistant_session_v1_${getPort()}`;

  function rate(windows, key, limit, period, message) {
    const at = now();
    for (const [savedKey, window] of windows) if (window.until <= at) windows.delete(savedKey);
    const window = windows.get(key) || { count: 0, until: at + period };
    if (window.count >= limit) throw fail(429, 'rate_limited', message);
    window.count += 1; windows.set(key, window);
  }
  function stop(record) {
    if (record.stopped) return;
    record.stopped = true;
    if (record.id) {
      active.delete(`${record.session.scope}:${record.id}`);
      try { provider.cancel(record.session.scope, record.id); } catch { /* Cancellation must release admission even if a provider fails. */ }
    }
    record.release();
  }
  function cleanup() {
    const at = now();
    for (const [key, session] of sessions) if (session.expiresAt <= at) {
      for (const record of inFlight) if (record.session === session) stop(record);
      provider.cancelScope(session.scope); sessions.delete(key);
    }
  }
  function sessionFor(req) {
    cleanup();
    const name = cookieName();
    const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
    if (values.length !== 1) return null;
    const raw = values[0].slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return sessions.get(hash(raw)) || null;
  }
  function requireSession(req) {
    const session = sessionFor(req);
    if (!session) throw fail(401, 'assistant_session_required', 'Refresh the assistant page to reconnect.');
    return session;
  }
  function start(req, res, session) {
    if (inFlight.size >= 2) throw fail(429, 'assistant_busy', 'Companion is busy. Stop an active request before starting another.');
    rate(session.windows, 'work', requestRateLimit, 60000, 'Too many assistant requests. Try again in a minute.');
    const record = { session, res, id: null, stopped: false, release: null };
    const disconnected = () => { if (!res.writableEnded) stop(record); };
    const aborted = () => stop(record);
    const timer = setTimeout(() => {
      stop(record);
      json(res, 504, { error: { code: 'assistant_timeout', message: 'The local request timed out. Try a shorter question or recording.' } });
    }, requestTimeoutMs);
    timer.unref?.();
    record.release = () => {
      clearTimeout(timer); req.off('aborted', aborted); res.off('close', disconnected); inFlight.delete(record);
      if (record.id && active.get(`${session.scope}:${record.id}`) === record) active.delete(`${session.scope}:${record.id}`);
    };
    inFlight.add(record); req.once('aborted', aborted); res.once('close', disconnected);
    return record;
  }
  function identify(record, id) {
    if (record.stopped) throw stopped();
    const key = `${record.session.scope}:${id}`;
    if (active.has(key)) throw fail(409, 'request_active', 'That request is already running. Stop it before reusing its ID.');
    record.id = id; active.set(key, record);
  }
  async function work(req, res, session, kind) {
    const record = start(req, res, session);
    try {
      let input;
      if (kind === 'ask') {
        const body = await readJson(req); fields(body, ['id', 'question', 'context', 'familiarity', 'history']);
        const checked = validate(() => validateAsk(body));
        input = { ...checked, history: checked.history.map(entry => ({ role: entry.role, text: entry.content })) };
      } else {
        const id = validate(() => requestId(req.headers['x-request-id']));
        const mimeType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (!FORMATS.has(mimeType)) throw fail(415, 'audio_required', 'Record audio as WebM, WAV, MP4, M4A, or MP3.');
        const bytes = await readBytes(req, AUDIO_LIMIT);
        input = validate(() => validateAudio({ id, mimeType, bytes }));
      }
      identify(record, input.id);
      let result;
      try { result = await provider[kind](session.scope, input); }
      catch (error) {
        if (record.stopped || error.name === 'AbortError') throw stopped();
        throw fail(502, 'local_provider_unavailable', typeof error.message === 'string' ? error.message.slice(0, 500) : 'The local service could not complete this request.');
      }
      if (record.stopped) throw stopped();
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > (kind === 'ask' ? 30000 : 4000)) throw fail(502, 'invalid_local_response', 'The local service returned an invalid answer. Try again.');
      json(res, 200, { id: input.id, text: result.text.trim() });
    } finally { record.release(); }
  }
  return {
    async handle(req, res, route, origin) {
      if (route !== '/api/assistant' && !route.startsWith('/api/assistant/')) return false;
      try {
        if (closed) throw fail(503, 'assistant_closed', 'The assistant is shutting down.');
        if (req.method === 'GET' && route === '/api/assistant/session') {
          let session = sessionFor(req);
          if (!session) {
            rate(creationWindows, req.socket.remoteAddress, sessionRateLimit, 15 * 60000, 'Too many assistant sessions. Try again later.');
            if (sessions.size >= sessionLimit) throw fail(429, 'assistant_session_limit', 'This local assistant has too many open sessions. Try again later.');
            const raw = token(); session = { csrfToken: token(), scope: `personal-${token()}`, expiresAt: now() + SESSION_MS, windows: new Map() };
            sessions.set(hash(raw), session);
            res.setHeader('Set-Cookie', `${cookieName()}=${raw}; Path=/api/assistant; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
          }
          json(res, 200, { csrfToken: session.csrfToken }); return true;
        }
        const session = requireSession(req);
        if (req.method === 'GET' && route === '/api/assistant/status') {
          rate(session.windows, 'status', 30, 60000, 'Too many connection checks. Try again in a minute.');
          if (!statusCache || statusCache.until <= now()) {
            if (!statusPending) statusPending = Promise.resolve().then(() => provider.getStatus()).then(value => { statusCache = { value, until: now() + 2000 }; return value; }).finally(() => { statusPending = null; });
            await statusPending;
          }
          json(res, 200, statusCache.value); return true;
        }
        if (req.method === 'GET' && await productivity.handle(req, res, route, session)) return true;
        if (req.method !== 'POST') throw fail(405, 'method_not_allowed', 'Use the supported assistant GET or POST endpoint.');
        if (req.headers.origin !== origin) throw fail(403, 'invalid_origin', 'Submit requests from this assistant page.');
        if (typeof req.headers['x-csrf-token'] !== 'string' || req.headers['x-csrf-token'] !== session.csrfToken) throw fail(403, 'invalid_csrf', 'Refresh the assistant page before submitting.');
        if (await productivity.handle(req, res, route, session)) return true;
        if (route === '/api/assistant/ask' || route === '/api/assistant/transcribe') {
          await work(req, res, session, route.endsWith('/ask') ? 'ask' : 'transcribe'); return true;
        }
        if (route === '/api/assistant/cancel') {
          rate(session.windows, 'cancel', 60, 60000, 'Too many stop requests. Try again in a minute.');
          const body = await readJson(req); fields(body, ['id']); const id = validate(() => requestId(body.id));
          productivity.cancel(session.scope, id);
          const record = active.get(`${session.scope}:${id}`);
          if (record) { stop(record); json(record.res, 499, { error: { code: 'request_cancelled', message: 'Request stopped.' } }); }
          json(res, 200, { id, cancelled: true }); return true;
        }
        throw fail(404, 'not_found', 'That assistant endpoint was not found.');
      } catch (error) {
        const status = error.statusCode || 502;
        if (status === 429) res.setHeader('Retry-After', '60');
        json(res, status, { error: { code: error.code || 'local_provider_unavailable', message: error.statusCode ? error.message : 'The local service could not complete this request. Check its connection and try again.' } });
      }
      return true;
    },
    async close() {
      closed = true;
      for (const record of inFlight) { stop(record); json(record.res, 503, { error: { code: 'assistant_closed', message: 'The assistant is shutting down.' } }); }
      for (const session of sessions.values()) provider.cancelScope(session.scope);
      sessions.clear(); creationWindows.clear();
      await productivity.close();
    },
  };
}
