import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCodexCompletion, getCodexStatus } from '../server/codex-runner.mjs';

function fakeSpawn(handler) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.input = '';
    child.kill = () => { child.killed = true; child.exitCode = 137; queueMicrotask(() => child.emit('close', 137)); return true; };
    child.stdin = new Writable({ write(chunk, _, callback) { child.input += chunk.toString(); callback(); } });
    if (args[0] === 'login') queueMicrotask(() => handler(child, args, options, command));
    else child.stdin.on('finish', () => handler(child, args, options, command));
    return child;
  };
}
function finish(child, text = 'Synthetic answer.') { child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n'); child.stdout.write('{"type":"turn.completed"}\n'); child.exitCode = 0; child.emit('close', 0); }
async function directory(t) { const folder = await mkdtemp(path.join(tmpdir(), 'companion-codex-test-')); t.after(async () => { assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(folder, { recursive: true, force: true }); }); return folder; }

test('Codex completion uses stdin, a private empty job, strict read-only flags and the existing default model', async t => {
  const dataDirectory = await directory(t); const events = [];
  const spawnImpl = fakeSpawn(async (child, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.ok(options.cwd.startsWith(dataDirectory + path.sep)); assert.deepEqual(await readdir(options.cwd), []);
    for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag)); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.ok(args.includes('mcp_servers={}')); assert.ok(!args.includes('--model')); assert.ok(!args.includes('--ignore-user-config'));
    assert.ok(!args.some(arg => arg.includes('synthetic user request'))); assert.match(child.input, /synthetic user request/);
    child.stdout.write('{"type":"turn.started"}\n'); finish(child);
  });
  assert.deepEqual(await runCodexCompletion({ prompt: 'A synthetic user request with `shell characters` and $variables.', dataDirectory, spawnImpl, onEvent: event => events.push(event) }), { text: 'Synthetic answer.', toolCalls: [] });
  assert.deepEqual(await readdir(dataDirectory), []); assert.ok(events.length > 1);
});

test('Codex structured output passes a schema file and a user-selected model without shell expansion', async t => {
  const dataDirectory = await directory(t); const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const spawnImpl = fakeSpawn(async (child, args) => { assert.equal(args[args.indexOf('--model') + 1], 'user-chosen-model'); assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')), schema); finish(child, '{"answer":"structured"}'); });
  assert.equal((await runCodexCompletion({ prompt: 'Return structured data.', schema, model: 'user-chosen-model', dataDirectory, spawnImpl })).text, '{"answer":"structured"}');
});

test('Codex JSONL decoding preserves Unicode across split pipe chunks', async t => {
  const dataDirectory = await directory(t), expected = 'Plan café tasks → done';
  const spawnImpl = fakeSpawn(child => { const event = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: expected } }) + '\n'); const index = event.indexOf(Buffer.from('é')); child.stdout.write(event.subarray(0, index + 1)); child.stdout.write(event.subarray(index + 1)); child.stdout.write('{"type":"turn.completed"}\n'); child.exitCode = 0; child.emit('close', 0); });
  assert.equal((await runCodexCompletion({ prompt: 'Return Unicode.', dataDirectory, spawnImpl })).text, expected);
});

test('Codex login status returns only readiness and never diagnostic or credential text', async () => {
  const ready = fakeSpawn(child => { child.stderr.write('Logged in using ChatGPT\n'); child.emit('close', 0); }); assert.deepEqual(await getCodexStatus({ spawnImpl: ready }), { ready: true, unavailableReason: null });
  const failed = fakeSpawn(child => { child.stderr.write('synthetic-private-diagnostic'); child.emit('close', 1); }); const value = await getCodexStatus({ spawnImpl: failed }); assert.equal(value.ready, false); assert.ok(!JSON.stringify(value).includes('synthetic-private-diagnostic'));
});

test('Codex cancellation, timeout, malformed output and unexpected actions cannot publish late answers', async t => {
  const dataDirectory = await directory(t); let started;
  const ready = new Promise(resolve => { started = resolve; }); let child;
  const controller = new AbortController(); const pending = runCodexCompletion({ prompt: 'Synthetic pending task.', signal: controller.signal, dataDirectory, spawnImpl: fakeSpawn(value => { child = value; started(); }) });
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError', code: 'request_cancelled' }); assert.equal(child.killed, true);
  await assert.rejects(runCodexCompletion({ prompt: 'Synthetic timeout.', timeoutMs: 10, dataDirectory, spawnImpl: fakeSpawn(() => {}) }), { code: 'provider_timeout' });
  await assert.rejects(runCodexCompletion({ prompt: 'Bad events.', dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('not-json-synthetic-secret\n'); }) }), error => error.code === 'invalid_provider_response' && !error.message.includes('synthetic-secret'));
  await assert.rejects(runCodexCompletion({ prompt: 'No commands.', dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('{"type":"item.started","item":{"type":"command_execution"}}\n'); }) }), { code: 'unexpected_provider_action' });
  await assert.rejects(runCodexCompletion({ prompt: 'Bound output.', maxOutputBytes: 20, dataDirectory, spawnImpl: fakeSpawn(child => { child.stdout.write('x'.repeat(30)); }) }), { code: 'provider_output_limit' });
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('Codex admits at most two completions and releases both slots after cancellation', async t => {
  const dataDirectory = await directory(t), children = []; let notify;
  const started = new Promise(resolve => { notify = resolve; }); const spawnImpl = fakeSpawn(child => { children.push(child); if (children.length === 2) notify(); }); const firstController = new AbortController(), secondController = new AbortController();
  const first = runCodexCompletion({ prompt: 'First.', dataDirectory, spawnImpl, signal: firstController.signal }); const second = runCodexCompletion({ prompt: 'Second.', dataDirectory, spawnImpl, signal: secondController.signal });
  await started; await assert.rejects(runCodexCompletion({ prompt: 'Third.', dataDirectory, spawnImpl }), { code: 'provider_busy' });
  // Register both rejection observers before aborting either concurrent request.
  const rejections=[assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})];
  firstController.abort(); secondController.abort(); await Promise.all(rejections);
  assert.equal((await runCodexCompletion({ prompt: 'Next.', dataDirectory, spawnImpl: fakeSpawn(child => finish(child)) })).text, 'Synthetic answer.');
});
