import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../server/mcp-server.mjs';

const TOKEN = 'S'.repeat(43), CSRF = 'C'.repeat(43), ORIGIN = 'http://127.0.0.1:4174';
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-test-client', version: '1.0' } };
const tool = (name, args = {}) => ({ name, arguments: args });
async function fixture(t, handler = async () => response({ revision: 0, tasks: [] }), options = {}) {
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough(), messages = [], calls = [], waiters = [];
  let outputText = '', errorText = '', buffer = '', nextId = 1;
  output.on('data', chunk => { const value = chunk.toString('utf8'); outputText += value; buffer += value; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); const message = JSON.parse(line); messages.push(message); for (const waiter of [...waiters]) if (waiter.check(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } } });
  errorOutput.on('data', chunk => { errorText += chunk.toString(); });
  const fetchImpl = async (url, request) => {
    calls.push({ url, ...request });
    if (url.endsWith('/api/assistant/session')) return response({ csrfToken: CSRF }, 200, { 'Set-Cookie': `companion_assistant_session_v1_4174=${TOKEN}; Path=/api/assistant; HttpOnly; SameSite=Strict` });
    return handler(url, request);
  };
  const server = createMcpServer({ input, output, errorOutput, fetchImpl, ...options }); server.start();
  t.after(() => server.close());
  function waitFor(check) { return new Promise((resolve, reject) => { const waiter = { check, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Synthetic MCP response timeout.')); }, 3000) }; waiter.timer.unref(); waiters.push(waiter); }); }
  function request(method, params, id = nextId++) { const pending = waitFor(message => message.id === id); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'); return pending; }
  function notify(method, params) { input.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'); }
  async function initialize() { const result = await request('initialize', init); assert.equal(result.result.protocolVersion, '2025-11-25'); notify('notifications/initialized'); return result; }
  return { server, input, messages, calls, request, notify, initialize, waitFor, outputText: () => outputText, errorText: () => errorText };
}

test('MCP lifecycle negotiates tools, requires initialized, and keeps stdout protocol only', async t => {
  const f = await fixture(t); assert.equal((await f.request('ping')).result.constructor, Object);
  assert.equal((await f.request('tools/list')).error.code, -32002);
  const initialized = await f.request('initialize', { ...init, protocolVersion: '2024-11-05' }); assert.equal(initialized.result.protocolVersion, '2025-11-25'); assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await f.request('tools/list')).error.code, -32002); f.notify('notifications/initialized');
  const listed = await f.request('tools/list'); assert.equal(listed.result.tools.length, 12); assert.equal(listed.result.tools.find(item => item.name === 'companion_workspace').annotations.readOnlyHint, true); assert.equal(listed.result.tools.find(item => item.name === 'companion_apply_build').annotations.destructiveHint, true);
  assert.equal(f.calls.length, 0); assert.equal(f.errorText(), ''); for (const line of f.outputText().trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal((await f.request('initialize', init)).error.code, -32600);
});

test('MCP workspace and chat use fixed local endpoints with a private reusable session and exact POST Origin', async t => {
  const f = await fixture(t, async (url, request) => response(url.endsWith('/workspace') ? { revision: 2, tasks: [{ title: 'Synthetic task' }] } : { id: JSON.parse(request.body).id, text: 'Synthetic reply.', actions: [] })); await f.initialize();
  const workspace = await f.request('tools/call', tool('companion_workspace')); assert.equal(workspace.result.structuredContent.tasks[0].title, 'Synthetic task');
  const chat = await f.request('tools/call', tool('companion_chat', { id: 'synthetic-chat', message: 'Help with a task.' })); assert.equal(chat.result.structuredContent.text, 'Synthetic reply.');
  assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 1);
  const post = f.calls.find(call => call.url.endsWith('/chat')); assert.equal(post.headers.Origin, ORIGIN); assert.equal(post.headers['X-CSRF-Token'], CSRF); assert.equal(post.headers.Cookie, `companion_assistant_session_v1_4174=${TOKEN}`); assert.equal(post.redirect, 'error');
  assert.ok(f.calls.every(call => call.url.startsWith(ORIGIN + '/api/assistant/'))); assert.ok(!f.outputText().includes(TOKEN)); assert.ok(!f.outputText().includes(CSRF));
});

test('MCP source, build, activation and patch tools map actual backend envelopes without arbitrary paths', async t => {
  const buildId = randomUUID(), payloads = [];
  const f = await fixture(t, async (url, request) => { payloads.push({ url, request, body: request.body ? JSON.parse(request.body) : undefined }); if (url.includes('/source')) return response({ revision: 'synthetic-hash', files: [{ path: 'src/features/example.mjs', hash: 'a'.repeat(64) }] }); if (request.method === 'GET') return response({ jobs: [] }); return response({ id: buildId, status: url.endsWith('/apply') ? 'applied' : 'queued' }, 202); }); await f.initialize();
  await f.request('tools/call', tool('companion_source', { includeContent: true })); assert.ok(payloads[0].url.endsWith('/features/source?content=1'));
  const build = await f.request('tools/call', tool('companion_build_feature', { prompt: 'Add a synthetic feature.', autoApply: false })); assert.equal(build.result.structuredContent.status, 'queued'); assert.deepEqual(payloads[1].body, { prompt: 'Add a synthetic feature.', autoApply: false });
  await f.request('tools/call', tool('companion_get_build', { id: buildId }));
  const applied = await f.request('tools/call', tool('companion_apply_build', { id: buildId })); assert.equal(applied.result.structuredContent.status, 'applied'); assert.deepEqual(payloads.at(-1).body, {});
  await f.request('tools/call', tool('companion_rollback_build', { id: buildId })); assert.ok(payloads.at(-1).url.endsWith('/rollback'));
  const patch = { summary: 'Original synthetic patch', files: [{ path: 'src/features/example.mjs', content: 'export const example = true;' }], baseHashes: { 'src/features/example.mjs': null }, autoApply: false };
  await f.request('tools/call', tool('companion_submit_patch', patch)); assert.ok(payloads.at(-1).url.endsWith('/features/patch')); assert.deepEqual(payloads.at(-1).body, patch);
  const count = payloads.length;
  for (const bad of [{ ...patch, files: [{ path: '../private.txt', content: 'x' }] }, { ...patch, files: [{ path: 'server/.env', content: 'x' }] }, { ...patch, files: [{ path: 'C:/outside.txt', content: 'x' }] }, { ...patch, baseHashes: {} }, { ...patch, providerId: 'not-an-external-patch-field' }]) assert.equal((await f.request('tools/call', tool('companion_submit_patch', bad))).error.code, -32602);
  assert.equal(payloads.length, count); assert.equal((await f.request('tools/call', tool('companion_workspace', { url: 'https://external.example' }))).error.code, -32602);
});

test('MCP errors preserve failed-action evidence while redacting credentials and rejecting key configuration', async t => {
  const f = await fixture(t, async url => url.endsWith('/providers') ? response({ providers: [{ id: 'fake', hasKey: true, apiKey: 'synthetic-api-key', protectedKey: 'synthetic-cipher' }], csrfToken: CSRF, diagnostic: `session=${TOKEN}` }) : response({ error: { code: 'revision_conflict', message: 'Review the latest workspace.' }, actions: [{ tool: 'create_task', status: 'completed' }] }, 409)); await f.initialize();
  const providers = await f.request('tools/call', tool('companion_connections')); assert.equal(providers.result.structuredContent.providers[0].hasKey, true); assert.equal(providers.result.structuredContent.providers[0].apiKey, '[redacted]');
  for (const secret of [TOKEN, CSRF, 'synthetic-api-key', 'synthetic-cipher']) assert.ok(!f.outputText().includes(secret));
  const failed = await f.request('tools/call', tool('companion_run_tool', { tool: 'create_task', arguments: { title: 'Synthetic task' }, operationId: randomUUID() })); assert.equal(failed.result.isError, true); assert.equal(failed.result.structuredContent.actions[0].status, 'completed');
  assert.equal((await f.request('tools/call', tool('companion_configure_provider', { apiKey: 'must-not-forward' }))).error.code, -32602);
});

test('MCP refreshes expired assistant sessions once, but never retries rejected provider credentials', async t => {
  let workspaceCalls = 0;
  const f = await fixture(t, async url => {
    if (url.endsWith('/workspace')) return ++workspaceCalls === 1 ? response({ error: { code: 'assistant_session_required', message: 'Refresh session.' } }, 401) : response({ revision: 1, tasks: [] });
    return response({ error: { code: 'provider_credentials_rejected', message: 'Update this provider key.' } }, 401);
  });
  await f.initialize(); assert.equal((await f.request('tools/call', tool('companion_workspace'))).result.isError, false); assert.equal(workspaceCalls, 2); assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 2);
  const chat = await f.request('tools/call', tool('companion_chat', { id: 'credential-failure', message: 'A synthetic request.' })); assert.equal(chat.result.isError, true); assert.equal(chat.result.structuredContent.error.code, 'provider_credentials_rejected'); assert.equal(f.calls.filter(call => call.url.endsWith('/chat')).length, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/session')).length, 2);
});

test('MCP cancellation aborts pending HTTP, frees admission and suppresses even a late reply', async t => {
  let began, resolveFetch, requestSignal; const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, (_url, request) => { requestSignal = request.signal; began(); return new Promise(resolve => { resolveFetch = resolve; }); }, { maxInFlight: 1 }); await f.initialize();
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: tool('companion_workspace') }) + '\n'); await started;
  assert.equal((await f.request('ping')).error.code, -32000); f.notify('notifications/cancelled', { requestId: 'cancel-me', reason: 'Synthetic user cancellation' }); assert.equal(requestSignal.aborted, true);
  assert.deepEqual((await f.request('ping')).result, {}); resolveFetch(response({ text: 'Late reply must be ignored.' })); await turn(); assert.ok(!f.messages.some(message => message.id === 'cancel-me'));
  const before = f.messages.length; f.notify('notifications/cancelled', { requestId: 'unknown' }); f.notify('notifications/unknown'); await turn(); assert.equal(f.messages.length, before);
});

test('MCP HTTP timeouts and response limits return bounded tool errors without raw network diagnostics', async t => {
  const timed = await fixture(t, () => new Promise(() => {}), { requestTimeoutMs: 15 }); await timed.initialize(); const timeout = await timed.request('tools/call', tool('companion_workspace')); assert.equal(timeout.result.isError, true); assert.equal(timeout.result.structuredContent.error.code, 'companion_timeout');
  const large = await fixture(t, async () => response({ text: 'x'.repeat(1000) }), { maxResponseBytes: 100 }); await large.initialize(); const limit = await large.request('tools/call', tool('companion_workspace')); assert.equal(limit.result.structuredContent.error.code, 'response_limit');
  const offline = await fixture(t, async () => { throw new Error('synthetic-private-network-detail'); }); await offline.initialize(); const failed = await offline.request('tools/call', tool('companion_workspace')); assert.equal(failed.result.structuredContent.error.code, 'companion_unavailable'); assert.ok(!offline.outputText().includes('synthetic-private-network-detail'));
});

test('MCP framing rejects malformed UTF-8, batches and oversized messages, then recovers on the next newline', async t => {
  const f = await fixture(t, undefined, { maxFrameBytes: 512 });
  let pending = f.waitFor(message => message.error?.code === -32700); f.input.write(Buffer.from([0xc3, 0x28, 10])); await pending;
  pending = f.waitFor(message => message.error?.code === -32600); f.input.write('[]\n'); await pending;
  pending = f.waitFor(message => message.error?.message.includes('input limit')); f.input.write('x'.repeat(600) + '\n'); await pending;
  assert.deepEqual((await f.request('ping')).result, {}); await f.initialize(); assert.equal((await f.request('missing/method')).error.code, -32601);
  assert.equal((await f.request('ping', [])).error.code, -32602);
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'unicode', method: 'tools/call', params: tool('companion_chat', { id: 'unicode-chat', message: 'Plan café work → done.' }) }) + '\n'); const index = bytes.indexOf(Buffer.from('é')); pending = f.waitFor(message => message.id === 'unicode'); f.input.write(bytes.subarray(0, index + 1)); f.input.write(bytes.subarray(index + 1)); assert.equal((await pending).result.isError, false);
  assert.equal(JSON.parse(f.calls.find(call => call.url.endsWith('/chat')).body).message, 'Plan café work → done.');
});

test('MCP endpoint configuration cannot target external hosts, credentials, paths or non-HTTP schemes', () => {
  for (const companionUrl of ['https://example.com', 'http://example.com:4174', 'http://127.0.0.1:4174/arbitrary', 'http://user:synthetic-secret@localhost:4174', 'file:///private', 'http://localhost:4174/?token=secret', 'http://localhost:4174/#fragment']) assert.throws(() => createMcpServer({ companionUrl }), /COMPANION_URL/);
});

test('real stdio subprocess bridges a disposable loopback API without protocol pollution', { timeout: 10000 }, async t => {
  let port, writes = [];
  const api = http.createServer((request, result) => {
    const send = (value, headers = {}) => { result.writeHead(200, { 'Content-Type': 'application/json', ...headers }); result.end(JSON.stringify(value)); };
    if (request.url === '/api/assistant/session') return send({ csrfToken: CSRF }, { 'Set-Cookie': `companion_assistant_session_v1_${port}=${TOKEN}; Path=/api/assistant; HttpOnly; SameSite=Strict` });
    assert.equal(request.headers.cookie, `companion_assistant_session_v1_${port}=${TOKEN}`);
    if (request.url === '/api/assistant/workspace') return send({ revision: 7, tasks: [{ title: 'Disposable stdio test' }] });
    if (request.url === '/api/assistant/features') { assert.equal(request.headers.origin, `http://127.0.0.1:${port}`); assert.equal(request.headers['x-csrf-token'], CSRF); const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { writes.push(JSON.parse(Buffer.concat(chunks))); send({ id: randomUUID(), status: 'queued' }); }); return; }
    result.writeHead(404); result.end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); port = api.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/mcp-server.mjs', import.meta.url))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { COMPANION_URL: `http://127.0.0.1:${port}`, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  let buffer = '', stdout = '', stderr = ''; const received = [], waiters = new Map();
  child.stdout.on('data', chunk => { stdout += chunk.toString(); buffer += chunk.toString(); let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); received.push(message); waiters.get(message.id)?.(message); waiters.delete(message.id); } }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise(resolve => child.on('close', resolve));
  t.after(async () => { child.kill(); await exited; await new Promise(resolve => api.close(resolve)); });
  const call = (id, method, params) => new Promise(resolve => { waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await call(1, 'initialize', init)).result.protocolVersion, '2025-11-25'); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await call(2, 'tools/call', tool('companion_workspace'))).result.structuredContent.revision, 7);
  assert.equal((await call(3, 'tools/call', tool('companion_build_feature', { prompt: 'A disposable feature request.', autoApply: false }))).result.structuredContent.status, 'queued'); assert.equal(writes[0].autoApply, false);
  child.stdin.end(); assert.equal(await exited, 0); assert.equal(received.length, 3); assert.equal(stderr, ''); assert.ok(!stdout.includes(TOKEN)); assert.ok(!stdout.includes(CSRF));
});
