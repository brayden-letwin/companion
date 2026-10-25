import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProviderSettings } from '../server/provider-settings.mjs';

async function directory(t) { const folder = await mkdtemp(path.join(tmpdir(), 'companion-provider-settings-')); t.after(async () => { const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); }); return folder; }
const entry = (id, apiKey = 'synthetic-key-never-real') => ({ id, type: 'openai', label: 'Synthetic API', apiKey });

test('provider metadata persists atomically while non-Windows keys remain memory only and redacted', async t => {
  const dataDirectory = await directory(t); const settings = await createProviderSettings({ dataDirectory, platform: 'linux' });
  assert.equal(settings.list()[0].type, 'codex'); assert.equal(settings.list()[0].model, '');
  const configured = await settings.configure(entry('api')); assert.equal(configured.hasKey, true); assert.equal(configured.secretStorage, 'memory'); assert.equal(configured.model, 'gpt-6.1-sol'); assert.equal(configured.apiKey, undefined);
  await settings.select('api'); assert.equal((await settings.get('api')).apiKey, entry('api').apiKey);
  const disk = await readFile(path.join(dataDirectory, 'providers.json'), 'utf8'); assert.ok(!disk.includes(entry('api').apiKey)); assert.ok(!JSON.stringify(settings.list()).includes(entry('api').apiKey));
  const restarted = await createProviderSettings({ dataDirectory, platform: 'linux' }); assert.equal(restarted.defaultProviderId(), 'api'); assert.equal(restarted.list().find(entry => entry.id === 'api').hasKey, false);
  await settings.remove('api'); assert.equal(settings.defaultProviderId(), null); await assert.rejects(settings.get('api'), { code: 'provider_not_found' });
});

test('endpoint changes cannot silently reuse an API key and malformed endpoints never persist', async t => {
  const dataDirectory = await directory(t); const settings = await createProviderSettings({ dataDirectory, platform: 'linux' }); await settings.configure(entry('api'));
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=private', 'file:///tmp/socket', 'https://example.com/v1#token']) await assert.rejects(settings.configure({ ...entry('bad'), baseUrl }), { code: 'validation_error' });
  await assert.rejects(settings.configure({ id: 'api', type: 'openai', baseUrl: 'https://another.example/v1' }), /Re-enter the key/);
  assert.equal((await settings.get('api')).baseUrl, 'https://api.openai.com/v1');
  await settings.configure({ ...entry('api', 'replacement-synthetic-key'), baseUrl: 'https://another.example/v1/' });
  assert.equal((await settings.get('api')).apiKey, 'replacement-synthetic-key');
  assert.equal((await settings.get('api')).baseUrl, 'https://another.example/v1');
  await settings.configure({ id: 'local-proxy', type: 'compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'chosen-model' });
  await assert.rejects(settings.configure({ id: 'codex', type: 'codex', apiKey: 'synthetic' }), /existing CLI sign-in/);
});

test('serialized settings mutations retain concurrent additions and bind encrypted secrets to their endpoint', async t => {
  const dataDirectory = await directory(t); const bindings = [];
  const vault = { async protect(key, binding) { bindings.push(binding); return Buffer.from(`${binding}:${key}`).toString('base64'); }, async unprotect(cipher, binding) { const value = Buffer.from(cipher, 'base64').toString(); assert.ok(value.startsWith(binding + ':')); return value.slice(binding.length + 1); } };
  const settings = await createProviderSettings({ dataDirectory, vault });
  await Promise.all([settings.configure(entry('first')), settings.configure(entry('second'))]);
  assert.ok(settings.list().some(entry => entry.id === 'first')); assert.ok(settings.list().some(entry => entry.id === 'second'));
  assert.ok(bindings.includes('first|openai|https://api.openai.com/v1'));
  const disk = await readFile(path.join(dataDirectory, 'providers.json'), 'utf8'); assert.ok(!disk.includes(entry('first').apiKey));
  const restarted = await createProviderSettings({ dataDirectory, vault }); assert.equal((await restarted.get('first')).apiKey, entry('first').apiKey);
});

test('Windows DPAPI roundtrip protects a synthetic credential across settings restart', { skip: process.platform !== 'win32' }, async t => {
  const dataDirectory = await directory(t); const settings = await createProviderSettings({ dataDirectory }); const synthetic = 'DPAPI-synthetic-test-credential';
  await settings.configure(entry('protected', synthetic)); const disk = await readFile(path.join(dataDirectory, 'providers.json'), 'utf8'); assert.ok(!disk.includes(synthetic));
  const restarted = await createProviderSettings({ dataDirectory }); assert.equal((await restarted.get('protected')).apiKey, synthetic); assert.equal(restarted.list().find(entry => entry.id === 'protected').hasKey, true);
});
