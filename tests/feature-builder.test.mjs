import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import http from 'node:http';

const OWNER = 'synthetic-local-workspace';
const feature = {
  summary: 'Adds a real focus timer panel.',
  files: [
    { path: 'src/features/manifest.json', content: JSON.stringify({ version: 1, features: [{ id: 'focus-timer', title: 'Focus timer', description: 'A simple focus panel.', module: './features/focus-timer.mjs' }] }) },
    { path: 'src/features/focus-timer.mjs', content: 'export function mount({container}) { container.textContent = "Focus timer ready"; return () => { container.textContent = ""; }; }\n' },
    { path: 'src/features/focus-timer.test.mjs', content: 'import test from "node:test"; import assert from "node:assert/strict"; import {mount} from "./focus-timer.mjs"; test("panel mounts and cleans up",()=>{const container={textContent:""};const cleanup=mount({container});assert.equal(container.textContent,"Focus timer ready");cleanup();assert.equal(container.textContent,"");});\n' },
  ],
  tests: ['Panel mounts and cleans up.'],
};

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-builder-'));
  const root = path.join(temporary, 'repo'), dataDirectory = path.join(temporary, 'private-builder');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests')); await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'src/runtime.mjs'), 'export const answer = 42;\n');
  await writeFile(path.join(root, 'tests/math.test.mjs'), 'import test from "node:test";import assert from "node:assert/strict";import{answer}from"../src/runtime.mjs";test("existing behavior is preserved",()=>assert.equal(answer,42));');
  await writeFile(path.join(root, 'server/security.mjs'), 'export const authenticationRequired = true;\n');
  const completions = [];
  const complete = options.complete || (async input => { completions.push(input); return { text: JSON.stringify(feature), toolCalls: [] }; });
  const builder = await createFeatureBuilder({ root, dataDirectory, ...options, complete });
  t.after(async () => {
    await builder.close(); const target = path.resolve(temporary);
    assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep + 'companion-builder-'));
    await rm(target, { recursive: true, force: true });
  });
  return { root, dataDirectory, temporary, builder, completions, complete };
}
async function finished(builder, id, statuses = ['applied', 'ready', 'review_required', 'failed', 'conflict', 'cancelled']) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const job = await builder.get(id, OWNER);
    if (statuses.includes(job.status) && !(job.status === 'ready' && job.autoApply && !job.reviewRequired)) return job;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Synthetic builder request did not settle.');
}
async function absent(file) { await assert.rejects(access(file), { code: 'ENOENT' }); }

test('a requested feature becomes real verified source, registered runtime behavior and retained rollback', async t => {
  const f = await fixture(t);
  const queued = await f.builder.request({ prompt: 'Add a focus timer panel', providerId: 'synthetic-codex' }, OWNER);
  assert.equal(queued.status, 'queued');
  const job = await finished(f.builder, queued.id);
  assert.equal(job.status, 'applied', JSON.stringify(job.verification));
  assert.equal(job.reviewRequired, false); assert.equal(job.verification.passed, true);
  assert.deepEqual(job.providedFeatures,[{id:'focus-timer',title:'Focus timer'}]);
  assert.ok(job.verification.checks.some(check => check.name === 'Existing trusted regression tests'));
  assert.ok(job.verification.checks.some(check => check.name === 'Feature registration and module exports'));
  assert.ok(job.verification.checks.some(check => check.name === 'Feature-specific tests'));
  assert.match(job.files.find(file => file.path.endsWith('focus-timer.mjs')).diff, /export function mount/);
  const module = await import(pathToFileURL(path.join(f.root, 'src/features/focus-timer.mjs')));
  const container = {}; module.mount({ container }); assert.equal(container.textContent, 'Focus timer ready');
  assert.equal(f.completions[0].providerId, 'synthetic-codex'); assert.equal(f.completions[0].schema.type, 'object');
  const rolledBack = await f.builder.rollback(job.id, OWNER);
  assert.equal(rolledBack.status, 'rolled_back'); await absent(path.join(f.root, 'src/features/focus-timer.mjs'));
  assert.deepEqual(rolledBack.providedFeatures,[]);
  assert.match(await readFile(path.join(f.root, 'src/runtime.mjs'), 'utf8'), /42/);
});

test('source snapshots exclude environment, Git, dependencies, databases, user notes and logs', async t => {
  const f = await fixture(t);
  for (const [file, content] of Object.entries({ '.env': 'SYNTHETIC_SECRET_SHOULD_NOT_LEAVE', '.git/config': 'PRIVATE_GIT_MARKER', 'node_modules/private/index.js': 'DEPENDENCY_MARKER', 'data/room.sqlite': 'DATABASE_MARKER', 'personal-note.txt': 'PERSONAL_MARKER', 'server.log': 'LOG_MARKER' })) {
    await mkdir(path.dirname(path.join(f.root, file)), { recursive: true }); await writeFile(path.join(f.root, file), content);
  }
  const source = await f.builder.source(OWNER, { includeContent: true });
  const serialized = JSON.stringify(source);
  for (const marker of ['SYNTHETIC_SECRET_SHOULD_NOT_LEAVE', 'PRIVATE_GIT_MARKER', 'DEPENDENCY_MARKER', 'DATABASE_MARKER', 'PERSONAL_MARKER', 'LOG_MARKER']) assert.ok(!serialized.includes(marker));
  assert.ok(source.files.some(file => file.path === 'src/runtime.mjs' && file.content.includes('42')));
  assert.ok((await f.builder.source(OWNER)).files.every(file => !Object.hasOwn(file, 'content')));
});

test('protected source changes present a concrete review and only explicit activation changes them', async t => {
  const patch = { summary: 'Changes protected server behavior for review.', files: [{ path: 'server/security.mjs', content: 'export const authenticationRequired = "reviewed";\n' }] };
  const f = await fixture(t, { complete: async () => ({ text: JSON.stringify(patch) }) });
  const job = await finished(f.builder, (await f.builder.request({ prompt: 'Change server behavior', providerId: 'synthetic' }, OWNER)).id);
  assert.equal(job.status, 'review_required'); assert.equal(job.reviewRequired, true);
  assert.match(job.files[0].diff, /authenticationRequired/);
  assert.match(await readFile(path.join(f.root, 'server/security.mjs'), 'utf8'), /true/);
  assert.equal((await f.builder.apply(job.id, OWNER)).status, 'applied');
  assert.match(await readFile(path.join(f.root, 'server/security.mjs'), 'utf8'), /reviewed/);
  await f.builder.rollback(job.id, OWNER);
  assert.match(await readFile(path.join(f.root, 'server/security.mjs'), 'utf8'), /true/);
});

test('microphone-session source changes require review before they can affect capture', async t => {
  const f = await fixture(t, {complete:async()=>({summary:'Prepare a reviewed microphone implementation.',files:[{path:'src/voice-session.mjs',content:'export const microphonePolicy = "review required";\n'}],tests:[]})});
  const job=await finished(f.builder,(await f.builder.request({prompt:'Prepare the microphone policy change.',providerId:'synthetic',autoApply:true},OWNER)).id);
  assert.equal(job.status,'review_required'); assert.equal(job.files[0].protected,true); await absent(path.join(f.root,'src/voice-session.mjs'));
});

function executablePatch(code='export function execute(args){return {total:args.value*2};}') {
  const capability={id:'double-value',title:'Double value',module:'./double-value.mjs',version:1,tool:{name:'cap_double_value',description:'Double one number.',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}},workflowAllowed:true,effectPolicy:'pure',acceptance:[{name:'Known result',arguments:{value:3},expected:{total:6}}]};
  return {summary:'Add one executable registered capability.',files:[{path:'server/capabilities/manifest.json',content:JSON.stringify({version:1,capabilities:[capability]})},{path:'server/capabilities/double-value.mjs',content:code}],tests:[]};
}
test('executable capabilities require real behavior verification and protected activation',async t=>{
  const f=await fixture(t,{complete:async()=>executablePatch()});
  const job=await finished(f.builder,(await f.builder.request({prompt:'Add a tested callable action.',providerId:'synthetic',autoApply:true},OWNER)).id);
  assert.equal(job.status,'review_required',JSON.stringify(job.verification));assert.equal(job.reviewRequired,true);assert.ok(job.verification.checks.find(check=>check.name==='Registered capability behavior')?.passed);
  await absent(path.join(f.root,'server/capabilities/double-value.mjs'));await f.builder.apply(job.id,OWNER);
  assert.match(await readFile(path.join(f.root,'server/capabilities/double-value.mjs'),'utf8'),/args.value\*2/);
  await f.builder.rollback(job.id,OWNER);await absent(path.join(f.root,'server/capabilities/manifest.json'));
});
test('registered empty or incorrect capability behavior cannot be activated',async t=>{
  for(const code of ['export function execute(){}','export function execute(args){return {total:args.value+1};}']){
    const f=await fixture(t,{complete:async()=>executablePatch(code)});
    const job=await finished(f.builder,(await f.builder.request({prompt:'Validate the actual capability behavior.',providerId:'synthetic'},OWNER)).id);
    assert.equal(job.status,'failed');assert.equal(job.verification.checks.find(check=>check.name==='Registered capability behavior')?.passed,false);await absent(path.join(f.root,'server/capabilities/double-value.mjs'));
  }
});

test('CAS prevents activation when source changed after the verified snapshot', async t => {
  const f = await fixture(t);
  const ready = await finished(f.builder, (await f.builder.request({ prompt: 'Add focus', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  assert.equal(ready.status, 'ready');
  await writeFile(path.join(f.root, 'src/runtime.mjs'), 'export const answer = 43;');
  await assert.rejects(f.builder.apply(ready.id, OWNER), { code: 'source_conflict' });
  assert.equal((await f.builder.get(ready.id, OWNER)).status, 'conflict');
  await absent(path.join(f.root, 'src/features/focus-timer.mjs'));
});

test('the desktop launcher and public MCP template remain editable protected source', async t => {
  const f = await fixture(t, { complete: async () => ({ summary: 'Prepare a desktop launcher and public client template.', files: [{ path:'Start Desktop Companion.cmd',content:'@echo off\r\necho Companion desktop\r\n' },{ path:'mcp.example.json',content:'{"mcpServers":{}}\n' }], tests:[] }) });
  const job = await finished(f.builder,(await f.builder.request({prompt:'Prepare the desktop integration source.',providerId:'synthetic',autoApply:true},OWNER)).id);
  assert.equal(job.status,'review_required'); assert.equal(job.files.length,2); assert.ok(job.files.every(file=>file.protected));
  await assert.rejects(readFile(path.join(f.root,'Start Desktop Companion.cmd')),{code:'ENOENT'});
  await f.builder.apply(job.id,OWNER);
  assert.match(await readFile(path.join(f.root,'Start Desktop Companion.cmd'),'utf8'),/Companion desktop/);
});

test('external tools submit actual patches with exact base hashes and cannot use outside paths', async t => {
  const f = await fixture(t); const source = await f.builder.source(OWNER);
  const current = source.files.find(file => file.path === 'src/runtime.mjs').hash;
  const job = await finished(f.builder, (await f.builder.submitPatch({ summary: 'Adds an external tool feature', files: feature.files, baseHashes: Object.fromEntries(feature.files.map(file => [file.path, null])) }, OWNER)).id);
  assert.equal(job.status, 'applied'); assert.equal(f.completions.length, 0);
  for (const file of ['../outside.mjs', 'src/../../outside.mjs', 'C:/private.mjs', 'src\\outside.mjs', '.env', 'node_modules/x.mjs', 'src/data/private.json']) {
    await assert.rejects(f.builder.submitPatch({ summary: 'Bad path', files: [{ path: file, content: 'bad' }], baseHashes: {} }, OWNER), { code: 'invalid_source_path' });
  }
  const stale = await f.builder.submitPatch({ summary: 'Stale external patch', files: [{ path: 'src/runtime.mjs', content: 'export const answer = 42; // changed' }], baseHashes: { 'src/runtime.mjs': '0'.repeat(64) } }, OWNER);
  assert.equal((await finished(f.builder, stale.id)).status, 'conflict');
  assert.match(current, /^[a-f0-9]{64}$/);
});

test('syntax and existing behavior failures leave live source unchanged', async t => {
  for (const content of ['export const broken = ;', 'export const answer = 7;']) {
    const f = await fixture(t, { complete: async () => ({ summary: 'A broken candidate', files: [{ path: 'src/runtime.mjs', content }], tests: ['echo should-never-run'] }) });
    const job = await finished(f.builder, (await f.builder.request({ prompt: 'Modify runtime', providerId: 'synthetic' }, OWNER)).id);
    assert.equal(job.status, 'failed'); assert.equal(job.verification.passed, false);
    assert.match(await readFile(path.join(f.root, 'src/runtime.mjs'), 'utf8'), /42/);
  }
});

test('candidate tests cannot read private files or inherited credentials', async t => {
  const secret = 'SYNTHETIC_BUILDER_SECRET';
  const f = await fixture(t);
  const privateFile = path.join(f.temporary, 'private-token.txt'); await writeFile(privateFile, secret);
  const malicious = `import {readFileSync} from 'node:fs';export const answer = Number(readFileSync(${JSON.stringify(privateFile)},'utf8'));`;
  const job = await finished(f.builder, (await f.builder.submitPatch({ summary: 'Invalid candidate attempts outside read', files: [{ path: 'src/runtime.mjs', content: malicious }], baseHashes: { 'src/runtime.mjs': (await f.builder.source(OWNER)).files.find(file => file.path === 'src/runtime.mjs').hash } }, OWNER)).id);
  assert.equal(job.status, 'failed'); assert.ok(!JSON.stringify(job).includes(secret));
  assert.match(job.verification.checks.at(-1).output, /permission|ACCESS_DENIED/i);
  const previous = process.env.SYNTHETIC_API_KEY; process.env.SYNTHETIC_API_KEY = secret;
  try {
    const safe = await f.builder.submitPatch({ summary: 'Checks credential-free verification environment', files: [{ path: 'src/runtime.mjs', content: 'if(process.env.SYNTHETIC_API_KEY)throw Error("credential leak");export const answer=42;' }], baseHashes: { 'src/runtime.mjs': (await f.builder.source(OWNER)).files.find(file => file.path === 'src/runtime.mjs').hash } }, OWNER);
    assert.equal((await finished(f.builder, safe.id)).status, 'applied');
  } finally { if (previous === undefined) delete process.env.SYNTHETIC_API_KEY; else process.env.SYNTHETIC_API_KEY = previous; }
});

test('cancellation settles even when a model ignores the abort and ownership is enforced', async t => {
  let started;
  const invoked = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { complete: async () => { started(); return new Promise(() => {}); } });
  const job = await f.builder.request({ prompt: 'A pending request', providerId: 'synthetic' }, OWNER);
  await invoked;
  await assert.rejects(f.builder.get(job.id, 'another-owner'), { code: 'feature_not_found' });
  await assert.rejects(f.builder.cancel(job.id, 'another-owner'), { code: 'feature_not_found' });
  await f.builder.cancel(job.id, OWNER);
  assert.equal((await finished(f.builder, job.id)).status, 'cancelled'); await f.builder.close();
});

test('persisted jobs are readable after restart and interrupted work is not silently restarted', async t => {
  const f = await fixture(t);
  const job = await finished(f.builder, (await f.builder.request({ prompt: 'Prepared feature', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  await f.builder.close();
  const metadata = path.join(f.dataDirectory, job.id, 'job.json'); const saved = JSON.parse(await readFile(metadata, 'utf8'));
  saved.status = 'generating'; await writeFile(metadata, JSON.stringify(saved));
  let called = false;
  const restarted = await createFeatureBuilder({ root: f.root, dataDirectory: f.dataDirectory, complete: async () => { called = true; } });
  t.after(() => restarted.close());
  assert.equal((await restarted.get(job.id, OWNER)).status, 'interrupted'); assert.equal(called, false);
});

test('rollback refuses to overwrite edits made after activation', async t => {
  const f = await fixture(t);
  const job = await finished(f.builder, (await f.builder.request({ prompt: 'Focus panel', providerId: 'synthetic' }, OWNER)).id);
  await writeFile(path.join(f.root, 'src/features/focus-timer.mjs'), 'export function mount(){} // human edit');
  await assert.rejects(f.builder.rollback(job.id, OWNER), { code: 'source_conflict' });
  assert.match(await readFile(path.join(f.root, 'src/features/focus-timer.mjs'), 'utf8'), /human edit/);
});

test('junctions in application source are refused without reading their target', async t => {
  const f = await fixture(t); const outside = path.join(f.temporary, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.mjs'), 'export const privateData = "must not snapshot";');
  try { await symlink(outside, path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('This host does not permit test junction creation.'); return; } throw error; }
  await assert.rejects(f.builder.source(OWNER, { includeContent: true }), { code: 'unsafe_source_path' });
});

test('candidate networking is blocked for loopback, external HTTPS, native sockets and DNS', async t => {
  let hits = 0;
  const canary = http.createServer((_request, response) => { hits += 1; response.end('synthetic canary'); });
  await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => canary.close(resolve)));
  const f = await fixture(t); const url = `http://127.0.0.1:${canary.address().port}/canary`;
  const content = `import assert from 'node:assert/strict';import http from 'node:http';import https,{request} from 'node:https';import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';import dns from 'node:dns';import promises from 'node:dns/promises';import http2 from 'node:http2';const code='ERR_COMPANION_VERIFY_NETWORK';for(const call of [()=>fetch(${JSON.stringify(url)}),()=>http.get(${JSON.stringify(url)}),()=>https.get('https://example.invalid/'),()=>request('https://example.invalid/'),()=>new http.ClientRequest(${JSON.stringify(url)}),()=>new net.Socket(),()=>net.createConnection(80,'127.0.0.1'),()=>tls.connect(443,'example.invalid'),()=>dgram.createSocket('udp4'),()=>dns.lookup('example.invalid',()=>{}),()=>promises.lookup('example.invalid'),()=>http2.connect('https://example.invalid'),()=>new WebSocket('ws://127.0.0.1:1')])assert.throws(call,{code});assert.throws(()=>{http.get=()=>{}},TypeError);assert.throws(()=>process.binding('tcp_wrap'));export const answer=42;`;
  const digest = (await f.builder.source(OWNER)).files.find(file => file.path === 'src/runtime.mjs').hash;
  const job = await finished(f.builder, (await f.builder.submitPatch({ summary: 'Proves candidate network restrictions', files: [{ path: 'src/runtime.mjs', content }], baseHashes: { 'src/runtime.mjs': digest }, autoApply: false }, OWNER)).id);
  assert.equal(job.status, 'ready', JSON.stringify(job.verification)); assert.equal(hits, 0);
});

test('large repositories use planning and bounded lossless source messages with strict schemas', async t => {
  const calls = [];
  const f = await fixture(t, { complete: async input => {
    calls.push(input);
    if (input.schema.properties.paths) return { text: JSON.stringify({ paths: ['src/runtime.mjs'], reason: 'Use isolated features and preserve runtime.' }) };
    return { text: JSON.stringify(feature) };
  } });
  await writeFile(path.join(f.root, 'src/large.mjs'), '// OMIT_LARGE_CONTEXT\n' + '// enough source to require planning\n'.repeat(6000));
  await mkdir(path.join(f.root,'server/capabilities'));await writeFile(path.join(f.root,'server/capabilities/manifest.json'),'{"version":1,"capabilities":[]}');
  await mkdir(path.join(f.root,'docs'));await writeFile(path.join(f.root,'docs/CAPABILITIES.md'),'CAPABILITY_CONTRACT_MUST_BE_SUPPLIED');
  const job = await finished(f.builder, (await f.builder.request({ prompt: 'Add focus', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  assert.equal(job.status, 'ready', job.error);
  assert.equal(calls.length, 2); assert.ok(calls[0].schema.required.includes('paths'));
  const planning=JSON.parse(calls[0].messages[0].content),inventoryPaths=planning.inventory.map(file=>file.path);
  assert.deepEqual(calls[0].schema.properties.paths.items.enum,inventoryPaths);
  assert.ok(planning.requiredContext.every(file=>inventoryPaths.includes(file)));
  assert.ok(planning.requiredContext.includes('server/capabilities/manifest.json'));
  assert.match(calls[0].system,/phase selects files to READ/);
  const generation = calls[1]; assert.ok(generation.schema.required.includes('tests'));
  const supplied=generation.messages.slice(1).map(message=>JSON.parse(message.content));assert.ok(supplied.some(file=>file.source_file==='server/capabilities/manifest.json'&&file.content==='{"version":1,"capabilities":[]}'));assert.ok(supplied.some(file=>file.source_file==='docs/CAPABILITIES.md'&&file.content.includes('CAPABILITY_CONTRACT_MUST_BE_SUPPLIED')));
  assert.ok(generation.messages.every(message => Buffer.byteLength(message.content) <= 90000));
  assert.ok(generation.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) <= 420000);
  assert.ok(!generation.messages.some(message => message.content.includes('OMIT_LARGE_CONTEXT')));
  assert.ok(generation.messages[0].content.includes('src/large.mjs'));
  const summaries = await f.builder.list(OWNER); assert.equal(summaries[0].fileCount, 3); assert.equal(summaries[0].files, undefined);
  assert.ok((await f.builder.get(job.id, OWNER)).files.some(file => file.diff.includes('mount')));
});

test('source selection only requires existing context and leaves missing manifests for generation',async t=>{
  const calls=[];
  const f=await fixture(t,{complete:async input=>{calls.push(input);return{text:JSON.stringify(input.schema.properties.paths?{paths:['src/runtime.mjs'],reason:'Read the existing runtime; create the new panel files next.'}:feature)};}});
  await writeFile(path.join(f.root,'src/large.mjs'),'// source that requires planning\n'.repeat(6000));
  const job=await finished(f.builder,(await f.builder.request({prompt:'Add the first new panel; its manifest does not exist yet.',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'ready',job.error);assert.equal(calls.length,2);
  const planning=JSON.parse(calls[0].messages[0].content);
  assert.deepEqual(planning.requiredContext,['package.json']);
  for(const missing of ['server/capabilities/manifest.json','src/features/manifest.json','docs/CAPABILITIES.md']){assert.equal(planning.requiredContext.includes(missing),false);assert.equal(calls[0].schema.properties.paths.items.enum.includes(missing),false);}
  const generation=JSON.parse(calls[1].messages[0].content);assert.equal(generation.selectedPaths.includes('src/features/manifest.json'),false);
  assert.ok(job.files.some(file=>file.path==='src/features/manifest.json'&&file.beforeHash===null));
});

test('source selection still rejects unknown planned files before generation',async t=>{
  let calls=0;
  const f=await fixture(t,{complete:async()=>{calls++;return{text:JSON.stringify({paths:['server/capabilities/manifest.json'],reason:'An absent file is not a valid existing source selection.'})};}});
  await writeFile(path.join(f.root,'src/large.mjs'),'// source that requires planning\n'.repeat(6000));
  const job=await finished(f.builder,(await f.builder.request({prompt:'Add a capability',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/source selection contains unknown paths/);assert.equal(calls,1);
  await absent(path.join(f.root,'server/capabilities/manifest.json'));
  assert.equal(await readFile(path.join(f.root,'src/runtime.mjs'),'utf8'),'export const answer = 42;\n');
});

test('source selection does not authorize replacing an existing file the model was not supplied',async t=>{
  let calls=0;
  const f=await fixture(t,{complete:async input=>{calls++;return{text:JSON.stringify(input.schema.properties.paths?{paths:[],reason:'Only the existing required context is selected.'}:{summary:'Attempted unread rewrite',files:[{path:'src/runtime.mjs',content:'export const answer=41;'}],tests:[]})};}});
  await writeFile(path.join(f.root,'src/large.mjs'),'// source that requires planning\n'.repeat(6000));
  const job=await finished(f.builder,(await f.builder.request({prompt:'A scoped change',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/replace an existing file it had not read/);assert.equal(calls,2);
  assert.equal(await readFile(path.join(f.root,'src/runtime.mjs'),'utf8'),'export const answer = 42;\n');
});

async function budgetReferences(root) {
  const paths=['src/bridge-reference.mjs','src/ui-reference.mjs','src/test-reference.mjs'];
  for(const file of paths)await writeFile(path.join(root,file),'// complete reference source line\n'.repeat(6500));
  return paths;
}

test('an oversized valid selection gets one measured re-selection and supplies complete focused source',async t=>{
  const calls=[];let references;
  const f=await fixture(t,{complete:async input=>{
    calls.push(input);
    if(input.schema.properties.paths){const payload=JSON.parse(input.messages[0].content);return{text:JSON.stringify(payload.selectionFeedback?{paths:['src/runtime.mjs'],reason:'Use supplied contracts and isolated new panel modules; preserve all requested behavior.'}:{paths:references,reason:'Initial broad existing-source reference selection.'})};}
    return{text:JSON.stringify(feature)};
  }});
  references=await budgetReferences(f.root);
  const prompt='Add the complete focus feature, preserve current behavior, and keep its requested controls.';
  const job=await finished(f.builder,(await f.builder.request({prompt,providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'ready',job.error);assert.equal(calls.length,3);
  const first=JSON.parse(calls[0].messages[0].content),second=JSON.parse(calls[1].messages[0].content),generation=calls[2];
  assert.deepEqual(first.budgets,{maxMessages:100,maxMessageBytes:90000,maxContentBytes:420000,maxSerializedBytes:470000});
  assert.ok(first.requiredContextUsage.contentBytes<first.budgets.maxContentBytes);
  for(const file of references){const entry=first.inventory.find(item=>item.path===file);assert.ok(entry.contextBytes>entry.bytes);assert.ok(entry.serializedBytes>entry.contextBytes);assert.ok(entry.parts>1);}
  assert.deepEqual(second.selectionFeedback.previousPaths,references);assert.ok(second.selectionFeedback.overruns.some(item=>item.kind==='contentBytes'&&item.actual-item.limit===item.overBy&&item.overBy>0));
  assert.deepEqual(second.inventory,first.inventory);assert.deepEqual(second.requiredContext,first.requiredContext);assert.equal(second.request,prompt);
  assert.equal(job.contextPlans.length,2);assert.ok(job.contextPlans[0].overruns.length);assert.deepEqual(job.contextPlans[1].overruns,[]);
  assert.equal(job.contextPlans[1].usage.contentBytes,generation.messages.reduce((sum,message)=>sum+Buffer.byteLength(message.content),0));
  assert.equal(job.contextPlans[1].usage.serializedBytes,Buffer.byteLength(JSON.stringify(generation.messages)));
  const supplied=generation.messages.slice(1).map(message=>JSON.parse(message.content));
  assert.equal(supplied.filter(file=>file.source_file==='src/runtime.mjs').map(file=>file.content).join(''),await readFile(path.join(f.root,'src/runtime.mjs'),'utf8'));
  assert.ok(!supplied.some(file=>references.includes(file.source_file)));
  assert.ok(job.events.some(item=>/Re-selecting source once/u.test(item.message)));assert.ok(job.events.some(item=>/full files.*content bytes.*serialized bytes/u.test(item.message)));
});

test('a second oversized selection fails truthfully before generation instead of changing scope or budgets',async t=>{
  let selections=0,generations=0,references;
  const f=await fixture(t,{complete:async input=>{if(!input.schema.properties.paths){generations++;return{text:JSON.stringify(feature)};}selections++;return{text:JSON.stringify({paths:references,reason:'Still selecting the same large references.'})};}});
  references=await budgetReferences(f.root);
  const job=await finished(f.builder,(await f.builder.request({prompt:'Implement the full requested feature.',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/after one measured re-selection/u);assert.match(job.error,/generation did not run/u);assert.equal(selections,2);assert.equal(generations,0);
  assert.equal(job.contextPlans.length,2);assert.ok(job.contextPlans.every(plan=>plan.overruns.length>0));
  await absent(path.join(f.root,'src/features/manifest.json'));assert.equal(await readFile(path.join(f.root,'src/runtime.mjs'),'utf8'),'export const answer = 42;\n');
});

test('a small repository with too many source messages uses focused selection before the router limit',async t=>{
  const calls=[];
  const f=await fixture(t,{complete:async input=>{calls.push(input);return{text:JSON.stringify(input.schema.properties.paths?{paths:['src/runtime.mjs'],reason:'Read only relevant existing source; preserve the requested new feature.'}:feature)};}});
  for(let index=0;index<105;index++)await writeFile(path.join(f.root,'src',`tiny-${index}.mjs`),'// tiny existing source\n');
  const job=await finished(f.builder,(await f.builder.request({prompt:'Add the complete focus feature.',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'ready',job.error);assert.equal(calls.length,2);assert.ok(calls[0].schema.properties.paths);
  const planning=JSON.parse(calls[0].messages[0].content);assert.equal(planning.budgets.maxMessages,100);assert.ok(planning.inventory.length>100);
  assert.ok(calls[1].messages.length<=100);assert.equal(job.contextPlans[0].usage.messages,calls[1].messages.length);
});

test('context re-selection still rejects an unknown path and never reaches generation',async t=>{
  let calls=0,references;
  const f=await fixture(t,{complete:async input=>{calls++;assert.ok(input.schema.properties.paths);return{text:JSON.stringify({paths:calls===1?references:['src/future-file.mjs'],reason:'An unknown path remains invalid on re-selection.'})};}});
  references=await budgetReferences(f.root);
  const job=await finished(f.builder,(await f.builder.request({prompt:'Add the complete feature.',providerId:'synthetic',autoApply:false},OWNER)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/unknown paths/u);assert.equal(calls,2);assert.equal(job.contextPlans.length,1);await absent(path.join(f.root,'src/future-file.mjs'));
});

test('cancelling a pending context re-selection prevents late generation and keeps its measured evidence',async t=>{
  let calls=0,references,began,release;const pending=new Promise(resolve=>{began=resolve;});
  const f=await fixture(t,{complete:async input=>{calls++;assert.ok(input.schema.properties.paths);if(calls===1)return{text:JSON.stringify({paths:references,reason:'Initial broad source selection.'})};began();return new Promise(resolve=>{release=resolve;});}});
  references=await budgetReferences(f.root);
  const queued=await f.builder.request({prompt:'Implement the feature without losing its scope.',providerId:'synthetic',autoApply:false},OWNER);await pending;
  await f.builder.cancel(queued.id,OWNER);release({text:JSON.stringify({paths:['src/runtime.mjs'],reason:'A late response must not restart work.'})});
  const job=await finished(f.builder,queued.id);assert.equal(job.status,'cancelled');assert.equal(calls,2);assert.equal(job.contextPlans.length,1);assert.ok(job.contextPlans[0].overruns.length);await absent(path.join(f.root,'src/features/manifest.json'));
});

test('closing stops queued and uncooperative generation before any later source activation', async t => {
  let started; const invoked = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { complete: async () => { started(); return new Promise(() => {}); } });
  const active = await f.builder.request({ prompt: 'Pending active feature', providerId: 'synthetic' }, OWNER); await invoked;
  const queued = await f.builder.request({ prompt: 'Pending queued feature', providerId: 'synthetic' }, OWNER);
  await f.builder.close();
  assert.equal((await f.builder.get(active.id, OWNER)).status, 'cancelled');
  assert.equal((await f.builder.get(queued.id, OWNER)).status, 'cancelled');
  await assert.rejects(f.builder.request({ prompt: 'Too late', providerId: 'synthetic' }, OWNER), { code: 'builder_closed' });
  await absent(path.join(f.root, 'src/features/manifest.json'));
});

test('path case aliases cannot overwrite an existing file while claiming it is new', async t => {
  const f = await fixture(t);
  const job = await finished(f.builder, (await f.builder.submitPatch({ summary: 'Alias attempt', files: [{ path: 'src/Runtime.mjs', content: 'export const answer=42;// alias' }], baseHashes: { 'src/Runtime.mjs': null } }, OWNER)).id);
  assert.equal(job.status, 'failed'); assert.match(job.error, /exact source path/);
  assert.equal(await readFile(path.join(f.root, 'src/runtime.mjs'), 'utf8'), 'export const answer = 42;\n');
  await assert.rejects(f.builder.submitPatch({ summary: 'Short name alias', files: [{ path: 'src/RUNTIM~1.mjs', content: '' }], baseHashes: {} }, OWNER), { code: 'invalid_source_path' });
});

test('startup restores a partial journaled promotion and preserves unrecognized later edits', async t => {
  for (const externalChange of [false, true]) {
    const content = 'export const authenticationRequired = "new";\n';
    const f = await fixture(t, { complete: async () => ({ summary: 'A protected change', files: [{ path: 'server/security.mjs', content }], tests: [] }) });
    const job = await finished(f.builder, (await f.builder.request({ prompt: 'Prepare protected change', providerId: 'synthetic' }, OWNER)).id); await f.builder.close();
    const metadata = path.join(f.dataDirectory, job.id, 'job.json'); const saved = JSON.parse(await readFile(metadata, 'utf8'));
    const backupDirectory = 'apply-backup-synthetic'; await mkdir(path.join(f.dataDirectory, job.id, backupDirectory, 'server'), { recursive: true });
    await writeFile(path.join(f.dataDirectory, job.id, backupDirectory, 'server/security.mjs'), 'export const authenticationRequired = true;\n');
    await writeFile(path.join(f.root, 'server/security.mjs'), externalChange ? 'export const humanEdit=true;' : content);
    saved.status = 'applying'; saved.transaction = { direction: 'apply', backupDirectory, files: saved.files.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })) }; await writeFile(metadata, JSON.stringify(saved));
    const restarted = await createFeatureBuilder({ root: f.root, dataDirectory: f.dataDirectory, complete: f.complete }); t.after(() => restarted.close());
    const recovered = await restarted.get(job.id, OWNER);
    assert.equal(recovered.status, externalChange ? 'recovery_required' : 'interrupted');
    assert.match(await readFile(path.join(f.root, 'server/security.mjs'), 'utf8'), externalChange ? /humanEdit/ : /authenticationRequired = true/);
  }
});

test('two builder instances on one source root serialize promotion and the second detects a conflict', async t => {
  const f = await fixture(t);
  const other = await createFeatureBuilder({ root: f.root, dataDirectory: path.join(f.temporary, 'other-builder'), complete: f.complete });
  t.after(() => other.close());
  const first = await finished(f.builder, (await f.builder.request({ prompt: 'First candidate', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  const second = await finished(other, (await other.request({ prompt: 'Second candidate', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  const results = await Promise.allSettled([f.builder.apply(first.id, OWNER), other.apply(second.id, OWNER)]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.status === 'applied').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'source_conflict').length, 1);
  await absent(path.join(f.root, '.companion-feature-writer.lock'));
  await absent(path.join(f.root, '.companion-feature-writer.lock.reclaim'));
});

test('a live writer lock is retained rather than guessed stale', async t => {
  const f = await fixture(t);
  const job = await finished(f.builder, (await f.builder.request({ prompt: 'Ready candidate', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  const lock = path.join(f.root, '.companion-feature-writer.lock');
  const saved = { pid: process.pid, nonce: 'synthetic-live-owner' }; await writeFile(lock, JSON.stringify(saved));
  await assert.rejects(f.builder.apply(job.id, OWNER), { code: 'feature_writer_busy' });
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), saved);
});

test('Stop cancels an automatic ready candidate waiting for the source writer and preserves manual reviews', async t => {
  const requests = [];
  const f = await fixture(t, { complete: async input => {
    const request = JSON.parse(input.messages[0].content).request;
    requests.push(request);
    return request.includes('Protected') ? { summary: 'Protected review candidate', files: [{ path: 'server/security.mjs', content: 'export const authenticationRequired = "review";' }], tests: [] } : feature;
  } });
  const manual = await finished(f.builder, (await f.builder.request({ prompt: 'Manual candidate', providerId: 'synthetic', autoApply: false }, OWNER)).id);
  const review = await finished(f.builder, (await f.builder.request({ prompt: 'Protected candidate', providerId: 'synthetic' }, OWNER)).id);
  assert.equal(manual.status, 'ready'); assert.equal(review.status, 'review_required');
  const lock = path.join(f.root, '.companion-feature-writer.lock'); await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'synthetic-held-writer' }));
  const queued = await f.builder.request({ prompt: 'Automatic candidate', providerId: 'synthetic' }, OWNER);
  const deadline = Date.now() + 10000;
  while ((await f.builder.get(queued.id, OWNER)).status !== 'ready') {
    if (Date.now() > deadline) throw new Error('Automatic candidate never reached its writer wait.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  const waiting = await f.builder.request({ prompt: 'Queued after writer wait', providerId: 'synthetic' }, OWNER);
  assert.deepEqual((await f.builder.stopPending('another-owner')).builds, []);
  const stopped = await f.builder.stopPending(OWNER);
  assert.deepEqual(new Set(stopped.builds.map(job => job.id)), new Set([queued.id, waiting.id]));
  assert.ok(stopped.builds.every(job => job.status === 'cancelled'));
  await unlink(lock); await f.builder.close();
  assert.equal((await f.builder.get(queued.id, OWNER)).status, 'cancelled');
  assert.equal((await f.builder.get(waiting.id, OWNER)).status, 'cancelled');
  assert.equal((await f.builder.get(manual.id, OWNER)).status, 'ready');
  assert.equal((await f.builder.get(review.id, OWNER)).status, 'review_required');
  assert.ok(!requests.includes('Queued after writer wait'));
  await absent(path.join(f.root, 'src/features/focus-timer.mjs'));
  await absent(path.join(f.root, 'src/features/manifest.json'));
});
