import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import { createProductivityStore } from '../server/productivity-store.mjs';
import { createProductivityTools } from '../server/productivity-tools.mjs';

const owner = 'synthetic-build-inspection';
async function fixture(t, { code, builder: supplied } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'companion-build-inspection-'));
  const root = path.join(directory, 'repo'); await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'src', 'value.mjs'), 'export const value = 1;\n');
  const store = await createProductivityStore({ dataDirectory: path.join(directory, 'workspace') });
  const builder = supplied || await createFeatureBuilder({ root, dataDirectory: path.join(directory, 'builds'), complete: async () => ({ summary: 'Update the synthetic value.', files: [{ path: 'src/value.mjs', content: code }], tests: [] }) });
  t.after(async () => { await builder.close?.(); store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  return { root, builder, store, tools: createProductivityTools({ store, builder, owner }) };
}
async function settled(builder, id) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { const job = await builder.get(id, owner); if (['failed','ready','review_required','applied'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic build did not settle.');
}

test('inspection explains an actual failed candidate verification without exposing source, diffs or private paths', async t => {
  const f = await fixture(t, { code: 'export const = ;\n' });
  const request = 'Change the value while preserving existing behavior and report any failed checks.';
  const queued = await f.builder.request({ prompt: request, providerId: 'synthetic', autoApply: false }, owner);
  const failed = await settled(f.builder, queued.id); assert.equal(failed.status, 'failed');
  const before = f.store.snapshot();
  const report = await f.tools.execute('inspect_feature_build', { jobId: queued.id });
  const job = report.featureBuild, encoded = JSON.stringify(report);
  assert.equal(job.status, 'failed'); assert.equal(job.request, request); assert.equal(job.verification.passed, false);
  assert.equal(job.files[0].path, 'src/value.mjs'); assert.equal(job.files[0].protected, false);
  assert.ok(job.verification.checks.some(check => check.passed === false && /SyntaxError/u.test(check.diagnostics)));
  assert.match(job.error, /verification/u); assert.match(job.diagnosticsTrust, /untrusted/u);
  assert.ok(!encoded.includes(f.root)); assert.ok(!encoded.includes('file:///')); assert.ok(!encoded.includes('"diff":')); assert.ok(!encoded.includes('"content":'));
  assert.equal(job.activation.sourceWasApplied, false); assert.equal(job.activation.currentSourceVerified, false); assert.ok(Buffer.byteLength(encoded) < 32000);
  assert.deepEqual(f.store.snapshot(), before); assert.equal(await readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('inspection distinguishes verified-ready from historical activation and never applies the candidate itself', async t => {
  const f = await fixture(t, { code: 'export const value = 2;\n' });
  const queued = await f.builder.request({ prompt: 'Prepare a synthetic value change for review.', providerId: 'synthetic', autoApply: false }, owner);
  assert.equal((await settled(f.builder, queued.id)).status, 'ready');
  const ready = (await f.tools.execute('inspect_feature_build', { jobId: queued.id })).featureBuild;
  assert.equal(ready.activation.requiresActivation, true); assert.equal(ready.activation.sourceWasApplied, false); assert.match(ready.activation.message, /has not been applied/u);
  assert.equal(await readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  await f.builder.apply(queued.id, owner);
  // A later source edit means the historical applied record cannot establish current runtime/source state.
  await writeFile(path.join(f.root, 'src/value.mjs'), 'export const value = 3;\n');
  const applied = (await f.tools.execute('inspect_feature_build', { jobId: queued.id })).featureBuild;
  assert.equal(applied.status, 'applied'); assert.equal(applied.activation.sourceWasApplied, true); assert.equal(applied.activation.requiresActivation, false);
  assert.equal(applied.activation.currentSourceVerified, false); assert.equal(applied.activation.runtimeVerified, false); assert.match(applied.activation.message, /history records activation/u);
  assert.equal(await readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), 'export const value = 3;\n');
});

test('worst-case inspection is hard bounded, prioritizes actual failures, redacts private paths and flags omissions', async t => {
  const id = randomUUID(), large = ('\u0001😀"\\\n').repeat(20000), checks = Array.from({ length: 128 }, (_, index) => ({ name: 'Check ' + index + '😀'.repeat(100), passed: index !== 127, output: index === 127 ? 'ACTUAL_FAILURE: incorrect result\n' + large + '\nACTUAL_FAILURE_END' : large }));
  const fake = { async get(jobId, actualOwner) { assert.equal(jobId, id); assert.equal(actualOwner, owner); return { id, status: 'review_required', prompt: ('Original criterion\nC:\\Users\\private\\request.txt\n' + large).slice(0,12000), summary: large, plan: 'Preserve original behavior\n/home/private/plan.json\n' + large, reviewRequired: true, error: 'Known failed assertion\nfile:///C:/Users/private/candidate.mjs:22\n' + large, files: [{ path: 'C:\\Users\\private\\secret.txt', protected: false }, ...Array.from({ length: 80 }, (_, index) => ({ path: 'server/' + '数'.repeat(175) + index + '.mjs', protected: true, diff: 'FULL_DIFF_MUST_NOT_LEAVE', content: 'FULL_SOURCE_MUST_NOT_LEAVE' }))], verification: { passed: false, checks }, transaction: { privatePath: 'PRIVATE_TRANSACTION_MUST_NOT_LEAVE' } }; } };
  const f = await fixture(t, { builder: fake });
  const report = await f.tools.execute('inspect_feature_build', { jobId: id }), encoded = JSON.stringify(report), result = report.featureBuild;
  assert.ok(Buffer.byteLength(encoded) <= 48 * 1024); assert.equal(result.verification.checks[0].passed, false); assert.match(result.verification.checks[0].diagnostics, /ACTUAL_FAILURE/u);
  assert.equal(result.truncation.files, true); assert.equal(result.truncation.checks, true); assert.equal(result.truncation.privatePathsOrControlsRedacted, true); assert.ok(Object.keys(result.truncation).some(key => key.startsWith('check:')));
  for (const hidden of ['C:\\Users', '/home/private', 'file:///', 'FULL_DIFF_MUST_NOT_LEAVE', 'FULL_SOURCE_MUST_NOT_LEAVE', 'PRIVATE_TRANSACTION_MUST_NOT_LEAVE']) assert.ok(!encoded.includes(hidden), hidden);
  assert.equal(result.activation.sourceWasApplied, false); assert.equal(result.reviewRequired, true);
});

test('inspection preserves builder ownership/not-found errors and rejects malformed or unsupported calls before reading', async t => {
  const id = randomUUID(), notFound = Object.assign(new Error('That feature request was not found.'), { code: 'feature_not_found', statusCode: 404 }); let reads = 0;
  const f = await fixture(t, { builder: { async get(jobId, actualOwner) { reads++; assert.equal(actualOwner, owner); assert.equal(jobId, id); throw notFound; } } });
  await assert.rejects(f.tools.execute('inspect_feature_build', { jobId: id }), error => error === notFound);
  assert.equal(reads, 1);
  await assert.rejects(f.tools.execute('inspect_feature_build', { jobId: 'z'.repeat(36) }), { code: 'invalid_tool' });
  await assert.rejects(f.tools.execute('inspect_feature_build', { jobId: id, owner: 'another-workspace' }), { code: 'invalid_tool' }); assert.equal(reads, 1);
  const definition = f.tools.catalog().find(tool => tool.name === 'inspect_feature_build'); assert.equal(definition.workflowAllowed, false); assert.equal(definition.effectPolicy, 'pure'); assert.equal(f.tools.definitions.length, 22);
  const unavailable = createProductivityTools({ store: f.store }); await assert.rejects(unavailable.execute('inspect_feature_build', { jobId: id }), { code: 'builder_unavailable' });
});

test('failed-check diagnostics retain the actual trailing failure after long progress stdout', async t => {
  const id = randomUUID(), output = 'Verification began\n' + 'A synthetic progress line with no failure yet.\n'.repeat(4000) + '\nAssertionError: empty input expected 0 but received undefined\nEND_OF_FAILURE';
  const f = await fixture(t, { builder: { async get() { return { id, status: 'failed', prompt: 'Empty input must show zero.', verification: { passed: false, checks: [{ name: 'Behavior check', passed: false, output }] } }; } } });
  const report = await f.tools.execute('inspect_feature_build', { jobId: id }), check = report.featureBuild.verification.checks[0];
  assert.match(check.diagnostics, /Verification began/u); assert.match(check.diagnostics, /AssertionError: empty input expected 0 but received undefined/u); assert.match(check.diagnostics, /END_OF_FAILURE/u);
  assert.equal(check.diagnosticsTruncated, true); assert.match(check.diagnostics, /Middle omitted/u); assert.ok(Buffer.byteLength(JSON.stringify(check.diagnostics)) - 2 <= 1800); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 48 * 1024);
});

test('request pagination recovers every stored criterion without gaps, repeats or silent clipping', async t => {
  const id=randomUUID(),prompt='Original request\n'+('Preserve this acceptance criterion and existing behavior.\n'.repeat(190))+'FINAL CRITERION: empty input must show zero, never undefined.';
  assert.ok(prompt.length>8000&&prompt.length<=12000);
  let reads=0;const f=await fixture(t,{builder:{async get(){reads++;return{id,status:'failed',prompt};}}});
  let offset=0,recovered='';const seen=[];
  for(;;){const report=await f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:offset}),page=report.featureBuild;seen.push(page.requestOffset);assert.equal(page.requestOffset,offset);assert.equal(page.requestLength,prompt.length);assert.ok(page.request.length<=4000);assert.equal(page.requestRedacted,false);assert.equal(page.truncation.request,undefined);assert.ok(Buffer.byteLength(JSON.stringify(report))<=48*1024);recovered+=page.request;if(!page.requestHasMore){assert.equal(page.nextRequestOffset,null);break;}assert.ok(page.nextRequestOffset>offset);offset=page.nextRequestOffset;}
  assert.deepEqual(seen,[0,4000,8000]);assert.equal(recovered,prompt);assert.match(recovered,/FINAL CRITERION/u);assert.equal(reads,3);
  const end=(await f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:prompt.length})).featureBuild;assert.equal(end.request,'');assert.equal(end.requestHasMore,false);assert.equal(end.nextRequestOffset,null);
  await assert.rejects(f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:prompt.length+1}),{code:'invalid_request_offset'});await assert.rejects(f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:12001}),{code:'invalid_tool'});await assert.rejects(f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:-1}),{code:'invalid_tool'});
  assert.equal(f.store.snapshot().revision,0);
});

test('Unicode and escaped request pages preserve whole characters and exact routes/operators under the wire bound',async t=>{
  const id=randomUUID(),prompt='A'.repeat(3999)+'😀'+('数"\\\n😀'.repeat(1000))+'\nFINAL: preserve the route "/b", quoted "/", and regex /b/.';
  assert.ok(prompt.length<=12000);const f=await fixture(t,{builder:{async get(){return{id,status:'ready',prompt};}}});let offset=0,recovered='';
  for(;;){const report=await f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:offset}),page=report.featureBuild;assert.ok(Buffer.byteLength(JSON.stringify(report))<=48*1024);assert.equal(page.requestRedacted,false);if(offset===0)assert.equal(page.nextRequestOffset,3999);recovered+=page.request;if(!page.requestHasMore)break;offset=page.nextRequestOffset;}
  assert.equal(recovered,prompt);await assert.rejects(f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:4000}),{code:'invalid_request_offset'});
});

test('explicit private-path redaction across a page boundary reports redaction and preserves raw request offsets',async t=>{
  const id=randomUUID(),prompt='A'.repeat(3996)+' C:\\Users\\synthetic\\private.txt, then Criterion after private path. Keep empty input as zero.';
  const f=await fixture(t,{builder:{async get(){return{id,status:'failed',prompt};}}});const first=(await f.tools.execute('inspect_feature_build',{jobId:id})).featureBuild,second=(await f.tools.execute('inspect_feature_build',{jobId:id,requestOffset:first.nextRequestOffset})).featureBuild;
  assert.equal(first.requestRedacted,true);assert.equal(second.requestRedacted,true);assert.equal(first.requestLength,prompt.length);assert.equal(first.request.length+second.request.length,prompt.length);assert.equal(first.nextRequestOffset,4000);assert.equal(second.requestOffset,4000);const recovered=first.request+second.request;assert.ok(!recovered.includes('Users'));assert.ok(!recovered.includes('synthetic'));assert.match(recovered,/Criterion after private path\. Keep empty input as zero\./u);assert.equal(second.requestHasMore,false);
});

test('quoted private paths with spaces do not erase the following same-line acceptance criterion',async t=>{
  const id=randomUUID(),prompt='Read "C:\\Users\\Synthetic User\\note.txt", then keep empty input as zero. Also preserve "/b".';
  const f=await fixture(t,{builder:{async get(){return{id,status:'failed',prompt};}}});const page=(await f.tools.execute('inspect_feature_build',{jobId:id})).featureBuild;
  assert.equal(page.requestRedacted,true);assert.equal(page.request.length,prompt.length);assert.ok(!page.request.includes('Synthetic User'));assert.match(page.request,/then keep empty input as zero/u);assert.match(page.request,/preserve "\/b"/u);
});

test('applying and recovery states never assert that source is untouched or currently active',async t=>{
  const id=randomUUID();let status='applying';const f=await fixture(t,{builder:{async get(){return{id,status,prompt:'Original intent.'};}}});
  for(const state of ['applying','recovery_required','unrecognized']){status=state;const job=(await f.tools.execute('inspect_feature_build',{jobId:id})).featureBuild;assert.equal(job.activation.sourceWasApplied,null);assert.equal(job.activation.currentSourceVerified,false);assert.equal(job.activation.runtimeVerified,false);assert.doesNotMatch(job.activation.message,/has not applied source/u);}
});
