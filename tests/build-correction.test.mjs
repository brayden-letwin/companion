import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import { correctionContract, assertCorrectionContract, correctionContext, GENERATION_BUDGETS } from '../server/build-correction.mjs';
const OWNER = 'synthetic-correction-owner';
const PROMPT = 'Add a tested answer panel. Preserve this complete original request: A, C, D, 60 minutes.';
const TEST_TEXT = 'import test from "node:test";import assert from "node:assert/strict";import {value} from "./answer.mjs";test("actual answer is 42",()=>assert.equal(value,42));';
function panel(value = 42) { return { summary: 'Adds the requested answer panel', files: [
  { path: 'src/features/manifest.json', content: JSON.stringify({ version: 1, features: [{ id: 'answer', title: 'Answer', module: './features/answer.mjs' }] }) },
  { path: 'src/features/answer.mjs', content: `export const value=${value};export function mount({container}){container.textContent=String(value);}` },
  { path: 'src/features/answer.test.mjs', content: TEST_TEXT },
], tests: ['An actual answer must be 42.'] }; }
async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-correction-')), root = path.join(temporary, 'source'), dataDirectory = path.join(temporary, 'private');
  await mkdir(path.join(root, 'src'), {recursive:true}); await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'src/original.mjs'), 'export const value=42;');
  await writeFile(path.join(root, 'tests/math.test.mjs'), 'import test from "node:test";import assert from "node:assert/strict";import {value} from "../src/original.mjs";test("original behavior",()=>assert.equal(value,42));');
  const calls=[]; const complete=async input=>{calls.push(input);return options.complete ? options.complete(input,calls.length) : panel(calls.length===1?41:42);};
  const builder=await createFeatureBuilder({root,dataDirectory,...options,complete});
  t.after(async()=>{await builder.close();assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep+'companion-correction-'));await rm(temporary,{recursive:true,force:true});});
  return {builder,root,dataDirectory,calls,complete};
}
async function settled(builder,id) { for(let i=0;i<2000;i++){const job=await builder.get(id,OWNER);if(['applied','ready','review_required','failed','conflict','cancelled','interrupted'].includes(job.status)&&!(job.status==='ready'&&job.autoApply&&!job.reviewRequired))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Build did not settle'); }
async function request(f,extra={}){return f.builder.request({prompt:PROMPT,providerId:'synthetic',...extra},OWNER);}

test('one failed candidate is corrected against the original request and has two immutable, owner-bound reports',async t=>{
  const f=await fixture(t),queued=await request(f),job=await settled(f.builder,queued.id);
  assert.equal(job.status,'applied',job.error);assert.equal(job.id,queued.id);assert.equal(job.prompt,PROMPT);assert.equal(job.providerId,'synthetic');assert.equal(job.generationAttempt,2);assert.equal(job.generationAttemptLimit,2);assert.equal(f.calls.length,2);
  assert.deepEqual(job.attempts.map(x=>[x.number,x.status]),[[1,'failed'],[2,'passed']]);assert.ok(job.attempts.every(x=>!('files'in x)&&!('checks'in x.verification)));
  const first=await f.builder.getAttempt(job.id,1,OWNER),second=await f.builder.getAttempt(job.id,2,OWNER);
  assert.equal(first.buildId,job.id);assert.equal(first.verification.passed,false);assert.match(first.files.find(x=>x.path==='src/features/answer.mjs').diff,/value=41/);
  assert.equal(second.verification.passed,true);assert.match(second.files.find(x=>x.path==='src/features/answer.mjs').diff,/value=42/);
  assert.match(await readFile(path.join(f.dataDirectory,job.id,'candidate-attempt-1/src/features/answer.mjs'),'utf8'),/value=41/);
  assert.match(await readFile(path.join(f.root,'src/features/answer.mjs'),'utf8'),/value=42/);
  assert.ok(!JSON.stringify(job).includes('attemptRecords'));assert.ok(!JSON.stringify(job.attempts).includes('actual answer is 42'));
  await assert.rejects(f.builder.getAttempt(job.id,1,'different-owner'),{code:'feature_not_found'});await assert.rejects(f.builder.getAttempt(job.id,3,OWNER),{code:'invalid_build_attempt'});
  const correction=f.calls[1].messages.map(x=>JSON.parse(x.content));assert.equal(correction.find(x=>x.correction).correction.originalRequest,PROMPT);assert.ok(correction.some(x=>x.failed_candidate_file==='src/features/answer.mjs'&&x.content.includes('value=41')));
  await writeFile(path.join(f.dataDirectory,job.id,'attempt-1.json'),'{}');await assert.rejects(f.builder.getAttempt(job.id,1,OWNER),{code:'attempt_evidence_changed'});
});

test('a second actual check failure is terminal and never starts a third model request',async t=>{
  const f=await fixture(t,{complete:()=>panel(41)}),job=await settled(f.builder,(await request(f)).id);
  assert.equal(job.status,'failed');assert.equal(f.calls.length,2);assert.deepEqual(job.attempts.map(x=>x.status),['failed','failed']);assert.equal((await f.builder.getAttempt(job.id,2,OWNER)).verification.passed,false);await assert.rejects(access(path.join(f.root,'src/features/answer.mjs')),{code:'ENOENT'});
});

test('external patch failure retains one attempt and never asks a model to change supplied source',async t=>{
  const f=await fixture(t),patch=panel(41),baseHashes=Object.fromEntries(patch.files.map(file=>[file.path,null]));
  const job=await settled(f.builder,(await f.builder.submitPatch({...patch,baseHashes},OWNER)).id);
  assert.equal(job.status,'failed');assert.equal(job.generationAttemptLimit,1);assert.equal(job.generationAttempt,1);assert.equal(f.calls.length,0);assert.equal((await f.builder.getAttempt(job.id,1,OWNER)).status,'failed');
});

test('the correction cannot weaken an initial feature test or discard its registered behavior',async t=>{
  for(const attack of ['weaken-test','drop-test','drop-registration','retarget-registration']){
    const f=await fixture(t,{complete:(_input,count)=>{const patch=panel(count===1?41:42);if(count===1)return patch;if(attack==='weaken-test')patch.files.find(x=>x.path.endsWith('.test.mjs')).content=TEST_TEXT.replace('value,42','value,41');if(attack==='drop-test')patch.files=patch.files.filter(x=>!x.path.endsWith('.test.mjs'));if(attack==='drop-registration')patch.files[0].content='{"version":1,"features":[]}';if(attack==='retarget-registration')patch.files[0].content=patch.files[0].content.replace('answer.mjs','other.mjs');return patch;}});
    const job=await settled(f.builder,(await request(f)).id);assert.equal(job.status,'failed',attack);assert.match(job.error,/cannot (?:remove|discard)/);assert.equal(job.attempts.length,1);assert.equal(job.verification,null);assert.deepEqual(job.files,[]);assert.equal((await f.builder.getAttempt(job.id,1,OWNER)).status,'failed');
  }
});

test('capability correction preserves exact initial acceptance cases and protected review',async t=>{
  const entry={id:'double',title:'Double',module:'./double.mjs',version:1,tool:{name:'cap_double',description:'Double an integer',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}},workflowAllowed:true,effectPolicy:'pure',acceptance:[{name:'Exact first criterion',arguments:{value:3},expected:{total:6}}]};
  function capabilityPatch(count,attack){const cap=structuredClone(entry);if(count===2&&attack)cap.acceptance[0].expected.total=4;return {summary:'Adds tested doubling',files:[{path:'server/capabilities/manifest.json',content:JSON.stringify({version:1,capabilities:[cap]})},{path:'server/capabilities/double.mjs',content:`export function execute(args){return {total:args.value${count===1||attack?'+1':'*2'}};}`}],tests:[]};}
  for(const attack of [false,true]){
    const f=await fixture(t,{complete:(_input,count)=>capabilityPatch(count,attack)}),job=await settled(f.builder,(await request(f)).id);
    assert.equal(job.status,attack?'failed':'review_required');assert.equal(f.calls.length,2);if(attack)assert.match(job.error,/cannot remove or change/);else{assert.equal(job.reviewRequired,true);assert.equal(job.attempts[1].reviewRequired,true);assert.equal(job.attempts[1].verification.passed,true);}await assert.rejects(access(path.join(f.root,'server/capabilities/double.mjs')),{code:'ENOENT'});
  }
});

test('pending generation two clears current candidate evidence while preserving the failed report',async t=>{
  let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{complete:(_input,count)=>count===1?panel(41):(entered(),new Promise(resolve=>{release=resolve;}))}),queued=await request(f);
  await enteredPromise;const pending=await f.builder.get(queued.id,OWNER);assert.equal(pending.generationAttempt,2);assert.equal(pending.status,'generating');assert.deepEqual(pending.files,[]);assert.equal(pending.verification,null);assert.equal((await f.builder.getAttempt(queued.id,1,OWNER)).status,'failed');release(panel());assert.equal((await settled(f.builder,queued.id)).status,'applied');
});

test('provider descriptors are sanitized and frozen across planning, initial generation and correction',async t=>{
  let provider={id:'synthetic',type:'codex',model:'first',baseUrl:'https://example.test',ready:true,apiKey:'SYNTHETIC_PRIVATE_MARKER'};
  const f=await fixture(t,{getProvider:async()=>provider,complete:(_input,count)=>{if(count===1)provider={...provider,model:'changed'};return panel(41);}}),job=await settled(f.builder,(await request(f)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/AI connection changed/);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].expectedProvider,{id:'synthetic',type:'codex',model:'first',baseUrl:'https://example.test'});assert.ok(!JSON.stringify(job).includes('SYNTHETIC_PRIVATE_MARKER'));assert.ok(!JSON.stringify(f.calls).includes('SYNTHETIC_PRIVATE_MARKER'));
});

test('all three planned model phases receive the same safe provider pin and unread baseline files remain forbidden during correction',async t=>{
  for(const unread of [false,true]){
    let generated=0;
    const provider={id:'synthetic',type:'codex',model:'frozen'};
    const f=await fixture(t,{getProvider:async()=>provider,complete:(input)=>{
      if(input.schema.properties.paths)return {paths:[],reason:'Required contracts and new isolated feature files suffice.'};
      const patch=panel(++generated===1?41:42);if(generated===2&&unread)patch.files.push({path:'src/original.mjs',content:'export const value=43;'});return patch;
    }});
    await mkdir(path.join(f.root,'docs'));await writeFile(path.join(f.root,'docs/reference.md'),'reference\n'.repeat(19000));
    const job=await settled(f.builder,(await request(f)).id);assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>JSON.stringify(call.expectedProvider)===JSON.stringify(provider)));
    assert.equal(job.status,unread?'failed':'applied');if(unread)assert.match(job.error,/existing file it had not read/);assert.equal(await readFile(path.join(f.root,'src/original.mjs'),'utf8'),'export const value=42;');
  }
});

test('a complete failed candidate that cannot fit correction context is retained without another model call',async t=>{
  const f=await fixture(t,{complete:()=>{const patch=panel(41);patch.files.push({path:'docs/long-source.md',content:'x'.repeat(249000)});return patch;}}),job=await settled(f.builder,(await request(f)).id);
  assert.equal(job.status,'failed');assert.match(job.error,/fixed complete-file context limit/);assert.equal(f.calls.length,1);assert.equal(job.generationAttempt,1);assert.equal(job.attempts.length,1);const report=await f.builder.getAttempt(job.id,1,OWNER);assert.ok(report.files.find(file=>file.path==='docs/long-source.md').diff.length>249000);
});

test('malformed initial output is not corrected and malformed correction never reuses the old verification',async t=>{
  for(const initialBad of [true,false]){
    const f=await fixture(t,{complete:(_input,count)=>initialBad||count===2?{text:'not JSON'}:panel(41)}),job=await settled(f.builder,(await request(f)).id);
    assert.equal(job.status,'failed');assert.equal(f.calls.length,initialBad?1:2);assert.equal(job.attempts.length,initialBad?0:1);assert.equal(job.verification,null);assert.deepEqual(job.files,[]);
  }
});

test('retained attempt reports survive restart without generation, migration or implicit correction',async t=>{
  const f=await fixture(t,{complete:()=>panel(41)}),job=await settled(f.builder,(await request(f)).id),before=await f.builder.getAttempt(job.id,1,OWNER);await f.builder.close();let calls=0;
  const reopened=await createFeatureBuilder({root:f.root,dataDirectory:f.dataDirectory,complete:async()=>{calls++;return panel();}});t.after(()=>reopened.close());assert.deepEqual(await reopened.getAttempt(job.id,1,OWNER),before);assert.equal((await reopened.get(job.id,OWNER)).status,'failed');assert.equal(calls,0);
});

test('correction context retains complete source, labels versions and explicitly bounds diagnostic excerpts',()=>{
  const base={files:[]},patch=panel(41),contract=correctionContract(base,patch),context={selectedPaths:new Set(),messages:[{role:'user',content:JSON.stringify({request:PROMPT})}]},verification={passed:false,checks:[{name:'Synthetic failed behavior',passed:false,output:'head\n'+('界'.repeat(8000))+'\nC:\\private-fixture\\candidate\\file.mjs\nFINAL_FAILURE_MARKER'}]};
  const result=correctionContext({context,prompt:PROMPT,patch,contract,verification});assert.equal(result.diagnosticsTruncated,true);assert.ok(result.usage.contentBytes<=GENERATION_BUDGETS.maxContentBytes);assert.ok(!JSON.stringify(result.messages).includes('private-fixture'));assert.match(result.messages.find(x=>x.content.includes('failedChecks')).content,/FINAL_FAILURE_MARKER/);
  for(const file of patch.files){const pages=result.messages.map(x=>JSON.parse(x.content)).filter(x=>x.failed_candidate_file===file.path);assert.equal(pages.map(x=>x.content).join(''),file.content);}
  const accepted=structuredClone(patch);assert.doesNotThrow(()=>assertCorrectionContract(base,accepted,contract));
  const huge={...context,messages:[{role:'user',content:'a'.repeat(419000)}]};assert.throws(()=>correctionContext({context:huge,prompt:PROMPT,patch,contract,verification}),{code:'correction_context_limit'});
  const longLine={...patch,files:[...patch.files,{path:'src/oversize.mjs',content:'a'.repeat(80000)}]};assert.throws(()=>correctionContext({context,prompt:PROMPT,patch:longLine,contract,verification}),{code:'correction_context_limit'});
});
