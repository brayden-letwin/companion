import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelRouter } from '../server/model-router.mjs';

const ok = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const messages = [{ role: 'user', content: 'Create a synthetic test task.' }];
const tools = [{ name: 'create_task', description: 'Create a local task.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }];
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
function codexSpawn({ ready = true, answer = 'A generic productivity answer.', delayMs = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kill = () => { clearTimeout(child.delayTimer); child.exitCode = 137; child.emit('close', 137); };
    child.stdin = new Writable({ write(_, __, callback) { callback(); } });
    const finish = () => { if (args[0] === 'login') child.stderr.write(ready ? 'Logged in using ChatGPT' : 'Not logged in'); else { child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n'); child.stdout.write('{"type":"turn.completed"}\n'); } child.exitCode = ready || args[0] !== 'login' ? 0 : 1; child.emit('close', child.exitCode); };
    if (args[0] === 'login') queueMicrotask(finish); else child.stdin.on('finish', () => { if (delayMs) child.delayTimer = setTimeout(finish, delayMs); else finish(); }); return child;
  };
  return { calls, spawnImpl };
}
async function fixture(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'companion-router-test-'));
  t.after(async () => { assert.ok(path.resolve(dataDirectory).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(dataDirectory, { recursive: true, force: true }); });
  const codex = codexSpawn(); const router = await createModelRouter({ dataDirectory, spawnImpl: codex.spawnImpl, fetchImpl: async () => ok({ models: [{ name: 'qwen3.5:4b' }] }), settingsOptions: { platform: 'linux' }, ...options });
  return { router, codex, dataDirectory };
}
const config = type => ({ id: `synthetic-${type}`, type, label: `Synthetic ${type}`, apiKey: 'synthetic-private-api-key', ...(type === 'compatible' ? { baseUrl: 'https://compatible.example/v1', model: 'user-model' } : {}) });

test('router defaults to signed-in Codex without overriding its configured model and persists explicit selection', async t => {
  const { router, codex } = await fixture(t); const status = await router.getStatus(); assert.equal(status.defaultProviderId, 'codex'); assert.equal(status.codexAvailable, true); assert.equal(status.reasoningReady, true);
  assert.equal((await router.complete({ messages })).text, 'A generic productivity answer.'); assert.ok(!codex.calls.find(call => call.args[0] === 'exec').args.includes('--model'));
  await router.select('ollama'); assert.equal((await router.getStatus()).defaultProviderId, 'ollama');
  await router.configure(config('openai')); const listed = await router.listProviders(); const entry = listed.find(item => item.id === 'synthetic-openai'); assert.equal(entry.hasKey, true); assert.equal(entry.ready, true); assert.equal(entry.verified, false); assert.ok(!JSON.stringify(listed).includes('synthetic-private-api-key'));
  await router.remove('synthetic-openai'); assert.ok(!(await router.listProviders()).some(item => item.id === 'synthetic-openai'));
});

test('router falls back to Ollama only for the initial default when Codex is not signed in', async t => {
  const offline = codexSpawn({ ready: false }); const { router } = await fixture(t, { spawnImpl: offline.spawnImpl }); assert.equal((await router.getStatus()).defaultProviderId, 'ollama');
  await router.select('codex'); assert.equal((await router.getStatus()).defaultProviderId, 'codex', 'An explicit choice does not silently switch providers.');
});

test('OpenAI Responses maps tools and preserves encrypted reasoning for a stateless tool-result continuation', async t => {
  const calls = [], reasoning = { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'synthetic-encrypted-reasoning', summary: [] };
  const { router } = await fixture(t, { fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return ok(calls.length === 1 ? { status: 'completed', output: [reasoning, { type: 'function_call', call_id: 'call_1', name: 'create_task', arguments: '{"title":"Review changes"}' }] } : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Task created.' }] }] }); } });
  await router.configure(config('openai')); const first = await router.complete({ providerId: 'synthetic-openai', messages, system: 'Help with work.', tools });
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'create_task', arguments: { title: 'Review changes' } }]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-private-api-key'); assert.equal(calls[0].body.store, false); assert.equal(calls[0].body.tools[0].name, 'create_task');
  const second = await router.complete({ providerId: 'synthetic-openai', tools, messages: [...messages, { role: 'assistant', content: first.text, toolCalls: first.toolCalls, rawContinuation: first.rawContinuation }, { role: 'tool', toolCallId: 'call_1', content: '{"created":true}' }] });
  assert.equal(second.text, 'Task created.'); assert.deepEqual(calls[1].body.input[1], reasoning); assert.deepEqual(calls[1].body.input.at(-1), { type: 'function_call_output', call_id: 'call_1', output: '{"created":true}' });
});

test('Anthropic Messages maps tool use and tool results with current authentication and structured output', async t => {
  const calls = []; const { router } = await fixture(t, { fetchImpl: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, init, body }); return ok(calls.length === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'create_task', input: { title: 'Draft plan' } }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"done"}' }] }); } });
  await router.configure(config('anthropic')); const first = await router.complete({ providerId: 'synthetic-anthropic', messages, tools });
  const result = await router.complete({ providerId: 'synthetic-anthropic', messages: [...messages, { role: 'assistant', content: '', toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'toolu_1', content: 'Created.' }], schema });
  assert.equal(result.text, '{"answer":"done"}'); assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages'); assert.equal(calls[0].init.headers['anthropic-version'], '2026-10-21'); assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-private-api-key');
  assert.deepEqual(calls[1].body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Created.' }] }); assert.deepEqual(calls[1].body.output_config.format, { type: 'json_schema', schema });
});

test('compatible APIs and Ollama use generic chat, normalized tool arguments and structured formats', async t => {
  const calls = []; const { router } = await fixture(t, { fetchImpl: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, init, body }); return ok(url.endsWith('/api/chat') ? { done: true, message: { role: 'assistant', content: '{"answer":"local"}' } } : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'proxy_1', function: { name: 'create_task', arguments: '{"title":"A proxy task"}' } }] } }] }); } });
  await router.configure(config('compatible')); const proxy = await router.complete({ providerId: 'synthetic-compatible', messages, tools, system: 'A generic personal assistant.' }); assert.equal(proxy.toolCalls[0].arguments.title, 'A proxy task');
  const local = await router.complete({ providerId: 'ollama', messages, schema, system: 'Help organize work.' }); assert.equal(local.text, '{"answer":"local"}'); assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/chat'); assert.deepEqual(calls[1].body.format, schema); assert.equal(calls[1].body.messages[0].content, 'Help organize work.'); assert.equal(calls[1].init.headers.Authorization, undefined); assert.ok(!JSON.stringify(calls[1].body).includes('math tutor'));
});

test('Codex uses schema output for action proposals without running the proposed tool', async t => {
  const codex = codexSpawn({ answer: JSON.stringify({ text: 'I can create that task.', toolCalls: [{ id: 'codex_call_1', name: 'create_task', argumentsJson: '{"title":"Review"}' }] }) }); const { router } = await fixture(t, { spawnImpl: codex.spawnImpl });
  const result = await router.complete({ providerId: 'codex', messages, tools }); assert.deepEqual(result.toolCalls, [{ id: 'codex_call_1', name: 'create_task', arguments: { title: 'Review' } }]); assert.ok(codex.calls[0].args.includes('--output-schema'));
});

test('provider failures, incomplete output, unknown tools and malformed arguments stay credential safe', async t => {
  let response = new Response('synthetic-private-api-key diagnostic', { status: 401 }); const { router } = await fixture(t, { fetchImpl: async () => response }); await router.configure(config('openai'));
  await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages }), error => error.code === 'provider_credentials_rejected' && !error.message.includes('synthetic-private'));
  response = ok({ status: 'incomplete', output: [] }); await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages }), { code: 'incomplete_provider_response' });
  response = ok({ status: 'completed', output: [{ type: 'function_call', call_id: 'unknown_1', name: 'delete_everything', arguments: '{}' }] }); await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages, tools }), { code: 'invalid_provider_response' });
  response = ok({ status: 'completed', output: [{ type: 'function_call', call_id: 'bad_1', name: 'create_task', arguments: 'invalid JSON' }] }); await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages, tools }), { code: 'invalid_provider_response' });
  response = new Response('x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages }), { code: 'provider_output_limit' });
});

test('router cancellation and combined concurrency admission cannot publish stale provider text', async t => {
  const pending = []; const { router } = await fixture(t, { fetchImpl: async (_url, init) => new Promise((resolve, reject) => { pending.push({ resolve, reject }); init.signal.addEventListener('abort', () => reject(new Error('synthetic private transport detail'))); }) }); await router.configure(config('openai'));
  const firstController = new AbortController(), secondController = new AbortController();
  const first = router.complete({ providerId: 'synthetic-openai', messages, signal: firstController.signal }); const second = router.complete({ providerId: 'synthetic-openai', messages, signal: secondController.signal });
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages }), { code: 'provider_busy' }); firstController.abort(); secondController.abort(); await assert.rejects(first, { name: 'AbortError' }); await assert.rejects(second, { name: 'AbortError' });
  const next = router.complete({ providerId: 'synthetic-openai', messages }); while (pending.length < 3) await new Promise(resolve => setImmediate(resolve)); pending[2].resolve(ok({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh answer.' }] }] })); assert.equal((await next).text, 'Fresh answer.');
});

test('structured generation has its own longer HTTP budget while normal chat and tools keep the shorter timeout', async t => {
  const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(ok({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":"structured"}' }] }] })), 60);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Synthetic timeout transport.')); }, { once: true });
  });
  const { router } = await fixture(t, { timeoutMs: 20, buildTimeoutMs: 300, fetchImpl }); await router.configure(config('openai'));
  await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages }), { code: 'provider_timeout' });
  assert.equal((await router.complete({ providerId: 'synthetic-openai', messages, schema })).text, '{"answer":"structured"}');
  await assert.rejects(router.complete({ providerId: 'synthetic-openai', messages, tools }), { code: 'provider_timeout' });
});

test('Codex receives the longer schema budget without extending its ordinary tool-call envelope', async t => {
  const codex = codexSpawn({ answer: '{"answer":"structured"}', delayMs: 80 });
  const { router } = await fixture(t, { spawnImpl: codex.spawnImpl, timeoutMs: 25, buildTimeoutMs: 500 });
  assert.equal((await router.complete({ providerId: 'codex', messages, schema })).text, '{"answer":"structured"}');
  const generated = codex.calls.find(call => call.args[0] === 'exec'); assert.ok(generated.args.includes('--output-schema')); assert.ok(!generated.args.includes('--model')); assert.equal(generated.args[generated.args.indexOf('--sandbox') + 1], 'read-only');
  await assert.rejects(router.complete({ providerId: 'codex', messages, tools }), { code: 'provider_timeout' });
});

test('a structured request still expires at its configured bound and can be cancelled immediately', async t => {
  let started, observedSignal; let waiting = new Promise(resolve => { started = resolve; });
  const fetchImpl = (_url, init) => new Promise((_, reject) => { observedSignal = init.signal; started(); init.signal.addEventListener('abort', () => reject(new Error('Synthetic aborted transport.')), { once: true }); });
  const { router } = await fixture(t, { timeoutMs: 10, buildTimeoutMs: 50, fetchImpl }); await router.configure(config('openai'));
  const expiry = router.complete({ providerId: 'synthetic-openai', messages, schema }); await waiting; await assert.rejects(expiry, { code: 'provider_timeout', statusCode: 504 }); assert.equal(observedSignal.aborted, true);
  waiting = new Promise(resolve => { started = resolve; }); const controller = new AbortController(); const cancelled = router.complete({ providerId: 'synthetic-openai', messages, schema, signal: controller.signal }); await waiting; controller.abort(); await assert.rejects(cancelled, { name: 'AbortError', code: 'request_cancelled' });
});

test('router timeout configuration remains finite and capped at ten minutes', async () => {
  for (const options of [{ timeoutMs: 0 }, { buildTimeoutMs: 0 }, { buildTimeoutMs: Infinity }, { buildTimeoutMs: 600001 }, { buildTimeoutMs: 1.5 }]) await assert.rejects(createModelRouter(options), { code: 'validation_error' });
});
