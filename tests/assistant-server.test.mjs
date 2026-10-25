import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedServer } from '../server/shared-server.mjs';

const READY = { provider: 'local', model: 'synthetic-local-math', aiConfigured: true, reasoningReady: true, transcriptionReady: true, unavailableReason: null, transcriptionUnavailableReason: null };
const question = id => ({ id, question: 'Why is this sequence Cauchy?', context: { paper: 'Synthetic test passage', page: 2, text: 'The tail is bounded by a geometric series.' }, familiarity: { 'Cauchy sequence': 'new' }, history: [{ role: 'user', text: 'Explain the bound.' }] });

function fakeProvider({ deferred = false, ignoreCancel = false } = {}) {
  const calls = [], cancelled = [], scopes = [], pending = new Map(), waiters = [];
  function notify() { for (const waiter of waiters.splice(0)) waiter(); }
  function call(kind, scope, input) {
    calls.push({ kind, scope, input });
    if (!deferred) { notify(); return Promise.resolve({ text: kind === 'ask' ? 'Synthetic local explanation.' : 'Synthetic transcript.' }); }
    const result = new Promise((resolve, reject) => pending.set(`${scope}:${input.id}`, { resolve, reject }));
    notify(); return result;
  }
  return {
    calls, cancelled, scopes, pending,
    getStatus: async () => READY,
    ask: (scope, input) => call('ask', scope, input),
    transcribe: (scope, input) => call('transcribe', scope, input),
    cancel(scope, id) {
      cancelled.push({ scope, id });
      if (!ignoreCancel) { const error = new Error('Request stopped.'); error.name = 'AbortError'; pending.get(`${scope}:${id}`)?.reject(error); pending.delete(`${scope}:${id}`); }
      notify();
    },
    cancelScope(scope) { scopes.push(scope); for (const call of calls) if (call.scope === scope) this.cancel(scope, call.input.id); },
    async waitFor(predicate) {
      while (!predicate()) await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fake provider event timed out.')), 3000); timer.unref(); })]);
    },
    finish(id, text = 'A late synthetic response.') {
      const call = calls.findLast(call => call.input.id === id);
      pending.get(`${call.scope}:${id}`)?.resolve({ text }); pending.delete(`${call.scope}:${id}`);
    },
  };
}

async function fixture(options = {}) {
  const provider = options.assistantProvider || fakeProvider();
  const app = await createSharedServer({ dbPath: ':memory:', port: 0, ...options, assistantProvider: provider });
  const { url, port } = await app.listen(); const origin = new URL(url).origin;
  async function request(method, route, body, session, headers = {}, raw = false) {
    const response = await fetch(origin + route, { method, headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...headers }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), redirect: 'error' });
    return { status: response.status, value: await response.json(), headers: response.headers };
  }
  async function session(previous) {
    const response = await request('GET', '/api/assistant/session', undefined, previous);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return { csrfToken: response.value.csrfToken, cookie: response.headers.get('set-cookie')?.split(';')[0] || previous?.cookie, response };
  }
  return { app, provider, origin, port, request, session };
}

test('personal assistant works without a reading-group account and reuses its own scoped session', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  assert.equal((await f.request('GET', '/api/assistant/status')).status, 401);
  const user = await f.session();
  assert.match(user.cookie, new RegExp(`^companion_assistant_session_v1_${f.port}=`));
  assert.match(user.response.headers.get('set-cookie'), /Path=\/api\/assistant; HttpOnly; SameSite=Strict; Max-Age=28800/);
  const reused = await f.session(user);
  assert.equal(reused.csrfToken, user.csrfToken); assert.equal(reused.response.headers.get('set-cookie'), null);
  assert.deepEqual((await f.request('GET', '/api/session', undefined, user)).value, { setupRequired: true, user: null });
  assert.equal((await f.request('GET', '/api/room', undefined, user)).status, 401);
  assert.equal((await f.request('GET', '/api/health')).value.version, '0.5.0');
  assert.deepEqual((await f.request('GET', '/api/assistant/status', undefined, user)).value, READY);
  const answer = await f.request('POST', '/api/assistant/ask', question('first'), user);
  assert.deepEqual(answer.value, { id: 'first', text: 'Synthetic local explanation.' }); assert.equal(answer.status, 200);
  assert.deepEqual(f.provider.calls[0].input.history, [{ role: 'user', text: 'Explain the bound.' }]);
  assert.match(f.provider.calls[0].scope, /^personal-/);
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
  const transcript = await f.request('POST', '/api/assistant/transcribe', audio, user, { 'Content-Type': 'audio/webm;codecs=opus', 'X-Request-Id': 'voice1' }, true);
  assert.deepEqual(transcript.value, { id: 'voice1', text: 'Synthetic transcript.' });
  assert.deepEqual(Buffer.from(f.provider.calls[1].input.bytes), audio);
  assert.equal(f.provider.calls[1].input.mimeType, 'audio/webm');
  assert.equal(f.provider.calls[1].scope, f.provider.calls[0].scope);
});

test('assistant Host, Origin, CSRF and session boundaries reject browser forgery', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const user = await f.session(), other = await f.session();
  assert.equal((await f.request('POST', '/api/assistant/ask', question('none'))).status, 401);
  for (const headers of [{ Origin: 'https://example.invalid' }, { Origin: '' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': other.csrfToken }]) {
    assert.equal((await f.request('POST', '/api/assistant/ask', question('forged'), user, headers)).status, 403, JSON.stringify(headers));
  }
  // Fetch owns the Host header; use the native HTTP client to actually spoof it.
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/api/assistant/status', { headers: { Host: `example.invalid:${f.port}`, Cookie: user.cookie } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await f.request('OPTIONS', '/api/assistant/ask', undefined, user)).status, 403);
  assert.equal((await f.request('POST', '/api/assistant/ask', { ...question('tools'), tools: [{ type: 'computer' }] }, user)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/ask', { ...question('system'), history: [{ role: 'system', text: 'Do something else.' }] }, user)).status, 400);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(user.response.headers.get('access-control-allow-origin'), null);
});

test('assistant validates and bounds JSON, audio and request identifiers before provider work', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const user = await f.session();
  assert.equal((await f.request('POST', '/api/assistant/ask', '{bad', user, {}, true)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/ask', 'plain', user, { 'Content-Type': 'text/plain' }, true)).status, 415);
  assert.equal((await f.request('POST', '/api/assistant/ask', { ...question('large'), question: 'x'.repeat(5000) }, user)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/ask', { ...question('huge'), question: 'x'.repeat(129 * 1024) }, user)).status, 413);
  assert.equal((await f.request('POST', '/api/assistant/ask', question('../path'), user)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/ask', { ...question('history'), history: [{ role: 'user', content: 'Wrong field.' }] }, user)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/transcribe', Buffer.alloc(1), user, { 'Content-Type': 'application/octet-stream', 'X-Request-Id': 'badmime' }, true)).status, 415);
  assert.equal((await f.request('POST', '/api/assistant/transcribe', Buffer.alloc(0), user, { 'Content-Type': 'audio/wav', 'X-Request-Id': 'empty' }, true)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/transcribe', Buffer.alloc(1), user, { 'Content-Type': 'audio/wav' }, true)).status, 400);
  assert.equal((await f.request('POST', '/api/assistant/transcribe', Buffer.alloc(10 * 1024 * 1024 + 1), user, { 'Content-Type': 'audio/wav', 'X-Request-Id': 'hugeaudio' }, true)).status, 413);
  assert.equal(f.provider.calls.length, 0);
});

test('cancellation is session scoped, rejects duplicate active IDs, and discards a late provider answer', async t => {
  const provider = fakeProvider({ deferred: true, ignoreCancel: true });
  const f = await fixture({ assistantProvider: provider }); t.after(() => f.app.close()); const user = await f.session(), other = await f.session();
  const answer = f.request('POST', '/api/assistant/ask', question('pending'), user);
  await provider.waitFor(() => provider.calls.length === 1);
  assert.equal((await f.request('POST', '/api/assistant/ask', question('pending'), user)).status, 409);
  assert.equal((await f.request('POST', '/api/assistant/cancel', { id: 'pending' }, other)).status, 200);
  assert.equal(provider.cancelled.length, 0, 'Another personal session cannot cancel this work.');
  const cancel = await f.request('POST', '/api/assistant/cancel', { id: 'pending' }, user);
  assert.deepEqual(cancel.value, { id: 'pending', cancelled: true });
  const response = await answer; assert.equal(response.status, 499); assert.equal(response.value.error.code, 'request_cancelled');
  assert.equal(provider.cancelled[0].scope, provider.calls[0].scope); assert.equal(provider.cancelled[0].id, 'pending');
  provider.finish('pending', 'This answer must never be published.');
  const next = f.request('POST', '/api/assistant/ask', question('next'), user);
  await provider.waitFor(() => provider.calls.some(call => call.input.id === 'next')); provider.finish('next', 'The next answer.');
  assert.deepEqual((await next).value, { id: 'next', text: 'The next answer.' });
});

test('two combined audio and inference slots are enforced and cancellation frees admission', async t => {
  const provider = fakeProvider({ deferred: true }); const f = await fixture({ assistantProvider: provider }); t.after(() => f.app.close()); const user = await f.session();
  const first = f.request('POST', '/api/assistant/ask', question('first'), user);
  const voice = f.request('POST', '/api/assistant/transcribe', Buffer.from([1, 2]), user, { 'Content-Type': 'audio/wav', 'X-Request-Id': 'voice' }, true);
  await provider.waitFor(() => provider.calls.length === 2);
  assert.equal((await f.request('POST', '/api/assistant/ask', question('third'), user)).status, 429);
  await f.request('POST', '/api/assistant/cancel', { id: 'first' }, user); assert.equal((await first).status, 499);
  const third = f.request('POST', '/api/assistant/ask', question('third'), user);
  await provider.waitFor(() => provider.calls.length === 3);
  provider.finish('voice', 'Voice text.'); provider.finish('third', 'A third answer.');
  assert.equal((await voice).status, 200); assert.equal((await third).status, 200);
});

test('disconnecting a browser cancels its exact local provider request', async t => {
  const provider = fakeProvider({ deferred: true, ignoreCancel: true }); const f = await fixture({ assistantProvider: provider }); t.after(() => f.app.close()); const user = await f.session();
  const body = JSON.stringify(question('disconnect'));
  const req = http.request(f.origin + '/api/assistant/ask', { method: 'POST', headers: { Origin: f.origin, Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.on('error', () => {}); req.end(body);
  await provider.waitFor(() => provider.calls.length === 1); req.destroy();
  await provider.waitFor(() => provider.cancelled.length === 1);
  assert.deepEqual(provider.cancelled[0], { scope: provider.calls[0].scope, id: 'disconnect' });
  provider.finish('disconnect');
});

test('memory-only sessions expire, remain port isolated, and have bounded creation and request rates', async t => {
  let clock = Date.now(); const f = await fixture({ now: () => clock, assistantOptions: { sessionLimit: 2, sessionRateLimit: 10, requestRateLimit: 2 } }); t.after(() => f.app.close());
  const user = await f.session(); await f.session();
  assert.equal((await f.request('GET', '/api/assistant/session')).status, 429);
  assert.equal((await f.request('POST', '/api/assistant/ask', question('one'), user)).status, 200);
  assert.equal((await f.request('POST', '/api/assistant/ask', question('two'), user)).status, 200);
  const rate = await f.request('POST', '/api/assistant/ask', question('three'), user);
  assert.equal(rate.status, 429); assert.equal(rate.headers.get('retry-after'), '60');
  clock += 60001; assert.equal((await f.request('POST', '/api/assistant/ask', question('later'), user)).status, 200);
  const other = await fixture(); t.after(() => other.app.close()); const otherUser = await other.session();
  assert.notEqual(user.cookie.split('=')[0], otherUser.cookie.split('=')[0]);
  assert.equal((await other.request('GET', '/api/assistant/status', undefined, user)).status, 401);
  clock += 8 * 60 * 60 * 1000;
  assert.equal((await f.request('GET', '/api/assistant/status', undefined, user)).status, 401);
  const renewed = await f.session(user); assert.notEqual(renewed.csrfToken, user.csrfToken);
  assert.ok(f.provider.scopes.length > 0, 'Expiry cancels requests in the expired scope.');
  const limited = await fixture({ assistantOptions: { sessionRateLimit: 1 } }); t.after(() => limited.app.close());
  await limited.session(); assert.equal((await limited.request('GET', '/api/assistant/session')).status, 429);
});

test('shutdown and timeouts cancel work without waiting for an uncooperative provider', async t => {
  const provider = fakeProvider({ deferred: true, ignoreCancel: true }); const f = await fixture({ assistantProvider: provider }); t.after(() => f.app.close()); const user = await f.session();
  const response = f.request('POST', '/api/assistant/ask', question('shutdown'), user);
  await provider.waitFor(() => provider.calls.length === 1); const closing = f.app.close();
  assert.equal((await response).status, 503); await closing; provider.finish('shutdown');
  const timeoutProvider = fakeProvider({ deferred: true, ignoreCancel: true }); const timed = await fixture({ assistantProvider: timeoutProvider, assistantOptions: { requestTimeoutMs: 30 } }); t.after(() => timed.app.close()); const timedUser = await timed.session();
  const timeout = await timed.request('POST', '/api/assistant/ask', question('timeout'), timedUser);
  assert.equal(timeout.status, 504); assert.equal(timeout.value.error.code, 'assistant_timeout');
  assert.equal(timeoutProvider.cancelled.length, 1); timeoutProvider.finish('timeout');
});

test('assistant static allowlist serves the interface and PDF assets without exposing server files', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'companion-assistant-assets-'));
  let app;
  t.after(async () => { await app?.close(); const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); });
  await mkdir(path.join(folder, 'src/core'), { recursive: true }); await mkdir(path.join(folder, 'node_modules/pdfjs-dist/cmaps'), { recursive: true });
  await writeFile(path.join(folder, 'assistant.html'), '<!doctype html><title>Synthetic assistant</title>');
  await writeFile(path.join(folder, 'room.html'), '<!doctype html><title>Synthetic room</title>');
  await writeFile(path.join(folder, 'src/core/assistant.mjs'), 'export const synthetic = true;');
  await writeFile(path.join(folder, 'node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap'), 'synthetic-font');
  await writeFile(path.join(folder, '.env'), 'SYNTHETIC_SECRET=must-not-serve');
  const f = await fixture({ root: folder }); app = f.app;
  const home = await fetch(f.origin + '/'); assert.equal(home.status, 200); assert.match(await home.text(), /Synthetic assistant/);
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/); assert.match(home.headers.get('content-security-policy'), /worker-src 'self' blob:/);
  assert.equal((await fetch(f.origin + '/room.html')).status, 200);
  assert.equal((await fetch(f.origin + '/src/core/assistant.mjs')).status, 200);
  assert.equal((await fetch(f.origin + '/node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap')).status, 200);
  for (const route of ['/.env', '/server/assistant-api.mjs', '/electron/provider.cjs', '/package.json', '/node_modules/pdfjs-dist/package.json', '/node_modules/pdfjs-dist/build/pdf.mjs.map']) assert.ok([403, 404].includes((await fetch(f.origin + route)).status), route);
  const head = await fetch(f.origin + '/assistant.html', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
