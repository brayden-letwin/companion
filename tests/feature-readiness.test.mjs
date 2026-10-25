import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import { createFeatureReadiness } from '../server/feature-readiness.mjs';
import { loadCapabilities } from '../server/capability-registry.mjs';

const OWNER = 'synthetic-readiness-owner';
const sha = text => createHash('sha256').update(text).digest('hex');
const cap = {
  id: 'double-value', title: 'Double value', module: './double-value.mjs', version: 1,
  tool: { name: 'cap_double_value', description: 'Double one value.', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } },
  workflowAllowed: true, effectPolicy: 'pure', acceptance: [{ name: 'Known result', arguments: { value: 3 }, expected: { total: 6 } }],
};
const code = 'export function execute(args){return {total:args.value*2};}\n';
const patch = files => ({ summary: 'Implement the requested callable double action.', files, tests: [] });
const newCapability = () => patch([
  { path: 'server/capabilities/manifest.json', content: JSON.stringify({ version: 1, capabilities: [cap] }) },
  { path: 'server/capabilities/double-value.mjs', content: code },
]);
const runtime = () => ({ managed: true, restarting: false, hostRestartAvailable: true,
  hostPid: 100, workerPid: 101, supervisorPid: 99, hostInstanceId: randomUUID(), workerInstanceId: randomUUID(), supervisorInstanceId: randomUUID() });

async function fixture(t, { initial = {}, generated = newCapability() } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-readiness-')), root = path.join(temporary, 'repo'), dataDirectory = path.join(temporary, 'private-builder');
  for (const [file, content] of Object.entries({ 'package.json': '{"type":"module"}', 'src/runtime.mjs': 'export const healthy=true;', ...initial })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content);
  }
  let completions = 0, catalog = [], current = runtime(); const origin = structuredClone(current);
  const builder = await createFeatureBuilder({ root, dataDirectory, complete: async () => { completions++; return generated; } });
  const tools = { catalog: () => catalog, execute: () => { throw new Error('Readiness must never execute a tool.'); } };
  const proveReady = createFeatureReadiness({ root, builder, tools, getRuntimeStatus: () => ({ ...current, nonce: 'PRIVATE_NONCE_MUST_NOT_LEAVE', sourceRoot: root }), owner: OWNER });
  t.after(async () => { await builder.close(); assert.ok(temporary.startsWith(path.join(tmpdir(), 'companion-readiness-'))); await rm(temporary, { recursive: true, force: true }); });
  async function settle() {
    const queued = await builder.requestLinked({ prompt: 'Build and use the double-value action.', providerId: 'synthetic', autoApply: false }, OWNER, { id: randomUUID(), key: randomUUID() });
    const until = Date.now() + 15000;
    while (Date.now() < until) { const job = await builder.get(queued.id, OWNER); if (['ready', 'review_required', 'failed'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Synthetic readiness build did not settle.');
  }
  async function reloadCatalog() { catalog = (await loadCapabilities({ root })).map(item => ({ kind: 'capability', name: item.tool.name, capabilityId: item.id, version: item.version, hash: item.hash })); }
  function restarted({ supervisor = false } = {}) { current = { ...current, hostPid: current.hostPid + 10, workerPid: current.workerPid + 10, hostInstanceId: randomUUID(), workerInstanceId: randomUUID(), ...(supervisor ? { supervisorPid: current.supervisorPid + 10, supervisorInstanceId: randomUUID() } : {}) }; }
  return { root, dataDirectory, builder, proveReady, settle, reloadCatalog, restarted, origin, current: () => current, changeRuntime: update => { current = { ...current, ...update }; }, setCatalog: value => { catalog = value; }, completions: () => completions };
}

test('actual applied source, exact loaded capability and new host plus worker lifetimes are all required', async t => {
  const f = await fixture(t), job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  assert.equal(job.status, 'review_required'); assert.equal((await f.proveReady(record)).reason, 'build_not_applied');
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog();
  assert.equal((await f.proveReady(record)).reason, 'runtime_restart_required');
  f.changeRuntime({ workerPid: 201, workerInstanceId: randomUUID() });
  assert.equal((await f.proveReady(record)).reason, 'runtime_restart_required');
  f.changeRuntime({ hostPid: 200 }); // A PID alone cannot prove replacement.
  assert.equal((await f.proveReady(record)).reason, 'runtime_restart_required');
  f.restarted(); const ready = await f.proveReady(record);
  assert.equal(ready.ready, true); assert.equal(ready.reason, 'ready');
  assert.deepEqual(Object.keys(ready).sort(), ['ready', 'reason', 'requiredCapabilities', 'runtime', 'sourceRevision'].sort());
  assert.equal(ready.requiredCapabilities.length, 1); assert.equal(ready.requiredCapabilities[0].name, 'cap_double_value');
  assert.match(ready.sourceRevision, /^[a-f\d]{64}$/); assert.equal(JSON.stringify(ready).includes('PRIVATE_NONCE'), false); assert.equal(JSON.stringify(ready).includes(f.root), false);
  assert.equal(f.completions(), 1);
});

test('later source changes and rollback invalidate historical applied claims', async t => {
  const f = await fixture(t), job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  assert.equal((await f.proveReady(record)).ready, true);
  const file = path.join(f.root, 'server/capabilities/double-value.mjs'); await writeFile(file, code + '// Later human edit.\n');
  assert.equal((await f.proveReady(record)).reason, 'source_changed');
  await writeFile(file, code); assert.equal((await f.proveReady(record)).ready, true);
  await f.builder.rollback(job.id, OWNER); assert.equal((await f.proveReady(record)).reason, 'build_not_applied');
});

test('new source cannot be used through an old or fabricated loaded catalog pin', async t => {
  const f = await fixture(t), job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); f.restarted();
  assert.equal((await f.proveReady(record)).reason, 'capability_unavailable');
  const evidence = await f.builder.readinessEvidence(job.id, OWNER), pin = evidence.requiredCapabilities[0];
  for (const changed of [{ kind: 'builtin' }, { version: 2 }, { hash: '0'.repeat(64) }, { capabilityId: 'another-action' }]) {
    f.setCatalog([{ kind: 'capability', name: pin.name, capabilityId: pin.id, version: pin.version, hash: pin.hash, ...changed }]);
    assert.equal((await f.proveReady(record)).reason, 'capability_unavailable');
  }
  await f.reloadCatalog(); assert.equal((await f.proveReady(record)).ready, true);
  f.changeRuntime({ restarting: true }); assert.equal((await f.proveReady(record)).reason, 'runtime_restarting');
});

test('module-only edits identify their callable result and reject independently changed registry metadata', async t => {
  const manifest = JSON.stringify({ version: 1, capabilities: [cap] });
  const f = await fixture(t, { initial: { 'server/capabilities/manifest.json': manifest, 'server/capabilities/double-value.mjs': code }, generated: patch([{ path: 'server/capabilities/double-value.mjs', content: 'export function execute(args){return {total:args.value+args.value};}\n' }]) });
  const job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  const ready = await f.proveReady(record); assert.equal(ready.ready, true); assert.equal(ready.requiredCapabilities[0].id, cap.id);
  await writeFile(path.join(f.root, 'server/capabilities/manifest.json'), JSON.stringify({ version: 1, capabilities: [{ ...cap, title: 'Changed after activation' }] }));
  assert.equal((await f.proveReady(record)).reason, 'capability_source_changed');
});

test('manifest-only edits identify changed entries rather than unrelated registered functions', async t => {
  const other = { ...cap, id: 'other-value', title: 'Other value', module: './other-value.mjs', tool: { ...cap.tool, name: 'cap_other_value' } };
  const f = await fixture(t, { initial: { 'server/capabilities/manifest.json': JSON.stringify({ version: 1, capabilities: [cap, other] }), 'server/capabilities/double-value.mjs': code, 'server/capabilities/other-value.mjs': code }, generated: patch([{ path: 'server/capabilities/manifest.json', content: JSON.stringify({ version: 1, capabilities: [{ ...cap, title: 'Improved double action' }, other] }) }]) });
  const job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  assert.deepEqual((await f.proveReady(record)).requiredCapabilities.map(item => item.id), ['double-value']);
  assert.equal((await f.proveReady(record)).ready, true);
});

test('a verified applied panel does not count as a callable capability', async t => {
  const f = await fixture(t, { generated: patch([{ path: 'src/panel.mjs', content: 'export function mount(container){container.textContent="A panel";}' }]) });
  const job = await f.settle(); assert.equal(job.status, 'ready'); await f.builder.apply(job.id, OWNER);
  const proof = await f.proveReady({ buildId: job.id, origin: { runtime: f.origin } });
  assert.equal(proof.ready, false); assert.equal(proof.reason, 'no_callable_result'); assert.deepEqual(proof.requiredCapabilities, []);
});

test('control-kernel changes additionally require a new owning launcher lifetime and PID', async t => {
  const generated = newCapability(); generated.files.push({ path: 'server/runtime-host-entry.mjs', content: 'export const trustedBootstrapVersion=2;\n' });
  const f = await fixture(t, { generated }), job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  assert.equal((await f.proveReady(record)).reason, 'runtime_restart_required');
  f.changeRuntime({ supervisorPid: 299 }); assert.equal((await f.proveReady(record)).reason, 'runtime_restart_required');
  f.changeRuntime({ supervisorInstanceId: randomUUID() }); assert.equal((await f.proveReady(record)).ready, true);
});

test('retained candidate changes are rejected without executing source or leaking private paths', async t => {
  const f = await fixture(t), job = await f.settle(), record = { buildId: job.id, origin: { runtime: f.origin } };
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  const candidate = path.join(f.dataDirectory, job.id, 'candidate/server/capabilities/double-value.mjs');
  await writeFile(candidate, 'throw new Error("CANDIDATE_MUST_NOT_EXECUTE"); export function execute(){return {}; }');
  const proof = await f.proveReady(record); assert.equal(proof.ready, false); assert.equal(proof.reason, 'feature_evidence_changed');
  assert.equal(JSON.stringify(proof).includes('CANDIDATE_MUST_NOT_EXECUTE'), false);
  assert.equal(sha(await readFile(path.join(f.root, 'server/capabilities/double-value.mjs'))), sha(code));
  assert.equal(f.completions(), 1);
});

test('retained readiness evidence has a source byte cap before parsing', async t => {
  const f = await fixture(t), job = await f.settle();
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  await writeFile(path.join(f.dataDirectory, job.id, 'candidate/server/capabilities/manifest.json'), ' '.repeat(250001));
  const proof = await f.proveReady({ buildId: job.id, origin: { runtime: f.origin } });
  assert.equal(proof.ready, false); assert.equal(proof.reason, 'feature_evidence_limit');
});

test('retained candidate directory links are refused even when they resolve inside the same private job', async t => {
  const f = await fixture(t), job = await f.settle();
  await f.builder.apply(job.id, OWNER); await f.reloadCatalog(); f.restarted();
  const candidate = path.join(f.dataDirectory, job.id, 'candidate'), moved = path.join(f.dataDirectory, job.id, 'candidate-original');
  await rename(candidate, moved);
  try { await symlink(moved, candidate, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ERR_ACCESS_DENIED'].includes(error.code)) { t.skip('Synthetic junction creation is not permitted in this execution context.'); return; } throw error; }
  const proof = await f.proveReady({ buildId: job.id, origin: { runtime: f.origin } });
  assert.equal(proof.ready, false); assert.equal(proof.reason, 'build_evidence_unavailable');
  assert.equal(sha(await readFile(path.join(f.root, 'server/capabilities/double-value.mjs'))), sha(code));
});
