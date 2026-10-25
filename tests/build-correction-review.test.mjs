import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createFeatureBuilder} from '../server/feature-builder.mjs';
import {correctionContract,assertCorrectionContract} from '../server/build-correction.mjs';

const OWNER='independent-synthetic-review';
const baselineSecurity='export const authenticationRequired = true;\n';
const patch=(summary,files)=>({text:JSON.stringify({summary,files,tests:[]}),toolCalls:[]});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,{complete,verify}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'companion-correction-review-')),root=path.join(directory,'source'),dataDirectory=path.join(directory,'private');
  for(const folder of ['src/features','server','tests'])await mkdir(path.join(root,folder),{recursive:true});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');await writeFile(path.join(root,'src/runtime.mjs'),'export const answer=42;\n');await writeFile(path.join(root,'server/security.mjs'),baselineSecurity);
  await writeFile(path.join(root,'tests/math.test.mjs'),'import test from"node:test";import assert from"node:assert/strict";import{answer}from"../src/runtime.mjs";test("the original behavior remains",()=>assert.equal(answer,42));');
  const calls=[],builder=await createFeatureBuilder({root,dataDirectory,complete:async input=>{calls.push(input);return complete(input,calls.length,{root,dataDirectory});},...(verify?{verify:input=>verify(input,{root,dataDirectory})}:{})});
  t.after(async()=>{await builder.close();assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'companion-correction-review-'));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:25});});
  return{root,dataDirectory,builder,calls};
}
async function settled(builder,id){const until=Date.now()+20000;while(Date.now()<until){const job=await builder.get(id,OWNER);if(['applied','review_required','failed','conflict','cancelled','interrupted'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('The synthetic correction did not settle.');}
const absent=file=>assert.rejects(access(file),{code:'ENOENT'});

test('semantically identical capability acceptance criteria tolerate reordered JSON object keys',()=>{
  const entry={id:'example',module:'./example.mjs',acceptance:[{name:'actual result',arguments:{value:2,mode:'default'},expected:{doubled:4,valid:true},calls:[]}]};
  const base={files:[]},initial={files:[{path:'server/capabilities/manifest.json',content:JSON.stringify({version:1,capabilities:[entry]})}]};
  const corrected={files:[{path:'server/capabilities/manifest.json',content:JSON.stringify({capabilities:[{module:'./example.mjs',id:'example',acceptance:[{calls:[],expected:{valid:true,doubled:4},arguments:{mode:'default',value:2},name:'actual result'}]}],version:1})}]};
  assert.doesNotThrow(()=>assertCorrectionContract(base,corrected,correctionContract(base,initial)));
  const changed=structuredClone(corrected);const manifest=JSON.parse(changed.files[0].content);manifest.capabilities[0].acceptance[0].expected.doubled=5;changed.files[0].content=JSON.stringify(manifest);assert.throws(()=>assertCorrectionContract(base,changed,correctionContract(base,initial)),{code:'correction_checks_changed'});
});

test('cumulative correction omissions restore original protected bytes and remove failed new files without erasing attempt evidence',async t=>{
  const broken='export function mount( {\n',f=await fixture(t,{complete:async(_input,number)=>number===1?patch('First private failed candidate',[{path:'server/security.mjs',content:'export const authenticationRequired = "reviewed";\n'},{path:'src/features/retired.mjs',content:broken}]):patch('Focused complete replacement',[{path:'src/features/final.mjs',content:'export function mount({container}){container.textContent="Actual final feature";}\n'}])});
  const queued=await f.builder.request({prompt:'Add one focused final feature without changing the existing server control.',providerId:'synthetic',autoApply:true},OWNER),job=await settled(f.builder,queued.id);
  assert.equal(job.status,'applied',JSON.stringify(job.verification));assert.equal(f.calls.length,2);assert.equal(job.reviewRequired,false);assert.deepEqual(job.files.map(file=>file.path),['src/features/final.mjs']);assert.equal(await readFile(path.join(f.root,'server/security.mjs'),'utf8'),baselineSecurity);await absent(path.join(f.root,'src/features/retired.mjs'));assert.match(await readFile(path.join(f.root,'src/features/final.mjs'),'utf8'),/Actual final feature/);
  const candidate=path.join(f.dataDirectory,job.id,'candidate');assert.equal(await readFile(path.join(candidate,'server/security.mjs'),'utf8'),baselineSecurity);await absent(path.join(candidate,'src/features/retired.mjs'));
  const first=await f.builder.getAttempt(job.id,1,OWNER);assert.equal(first.buildId,job.id);assert.equal(first.number,1);assert.equal(first.status,'failed');assert.equal(first.verification.passed,false);assert.equal(first.reviewRequired,true);assert.ok(first.files.some(file=>file.path==='server/security.mjs'&&file.protected));assert.ok(first.files.some(file=>file.path==='src/features/retired.mjs'));
  const archive=path.join(f.dataDirectory,job.id,'candidate-attempt-1');assert.equal(await readFile(path.join(archive,'src/features/retired.mjs'),'utf8'),broken);assert.match(await readFile(path.join(archive,'server/security.mjs'),'utf8'),/"reviewed"/);
  first.files.length=0;assert.equal((await f.builder.getAttempt(job.id,1,OWNER)).files.length,2);assert.equal((await f.builder.getAttempt(job.id,2,OWNER)).verification.passed,true);
});

test('live source changing after a failed check stops correction before a second provider request and preserves the human edit',async t=>{
  let modified=false;const replacement='export const answer=99; // synthetic human edit\n';
  const f=await fixture(t,{complete:async()=>patch('A candidate requiring a fixed verification result',[{path:'src/features/new.mjs',content:'export const requestedFeature=true;\n'}]),verify:async(_input,{root})=>{if(!modified){modified=true;await writeFile(path.join(root,'src/runtime.mjs'),replacement);}return{passed:false,output:'Synthetic held-out behavior check failed.'};}});
  const job=await settled(f.builder,(await f.builder.request({prompt:'Add the requested feature while preserving current source.',providerId:'synthetic'},OWNER)).id);
  assert.equal(job.status,'conflict');assert.equal(f.calls.length,1);assert.equal(await readFile(path.join(f.root,'src/runtime.mjs'),'utf8'),replacement);await absent(path.join(f.root,'src/features/new.mjs'));const first=await f.builder.getAttempt(job.id,1,OWNER);assert.equal(first.verification.passed,false);assert.ok(first.verification.checks.some(check=>check.name==='Additional trusted verification'&&!check.passed));
});

test('cancelling a correction whose model ignores abort cannot activate its late answer or erase the original failed report',async t=>{
  const entered=deferred(),late=deferred(),f=await fixture(t,{complete:async(_input,number)=>{if(number===1)return patch('Syntax failure to correct',[{path:'src/features/cancelled.mjs',content:'export function broken( {\n'}]);entered.resolve();return late.promise;}});
  const queued=await f.builder.request({prompt:'Add a bounded feature.',providerId:'synthetic'},OWNER);await entered.promise;const first=await f.builder.getAttempt(queued.id,1,OWNER);assert.equal(first.status,'failed');await f.builder.cancel(queued.id,OWNER);
  late.resolve(patch('Late answer must be ignored',[{path:'src/features/cancelled.mjs',content:'export const lateFeature=true;\n'}]));await f.builder.close();const job=await f.builder.get(queued.id,OWNER);assert.equal(job.status,'cancelled');assert.equal(f.calls.length,2);await absent(path.join(f.root,'src/features/cancelled.mjs'));assert.deepEqual(await f.builder.getAttempt(queued.id,1,OWNER),first);
});

test('escaped source diffs larger than six megabytes retain a readable complete attempt report within original source limits',async t=>{
  const f=await fixture(t,{complete:async()=>{throw new Error('An external patch must not ask a model to correct it.');}}),content='\u0001'.repeat(180000);
  await mkdir(path.join(f.root,'docs'));const paths=[];for(let index=0;index<6;index++){const relative='docs/escaped-'+index+'.md';paths.push(relative);await writeFile(path.join(f.root,relative),content);}
  const inventory=await f.builder.source(OWNER),files=[...paths.map(relative=>({path:relative,content:'Short replacement.\n'})),{path:'src/features/broken.mjs',content:'export function broken( {\n'}],baseHashes=Object.fromEntries(files.map(file=>[file.path,inventory.files.find(entry=>entry.path===file.path)?.hash??null]));
  const queued=await f.builder.submitPatch({summary:'Synthetic external patch with bounded raw but escaped diff evidence.',files,baseHashes,autoApply:false},OWNER),job=await settled(f.builder,queued.id);assert.equal(job.status,'failed');assert.equal(f.calls.length,0);assert.equal(job.generationAttemptLimit,1);
  const report=await f.builder.getAttempt(job.id,1,OWNER);assert.equal(report.verification.passed,false);assert.equal(report.files.length,7);assert.ok(Buffer.byteLength(JSON.stringify(report))>6000000);for(const relative of paths){const diff=report.files.find(file=>file.path===relative).diff;assert.ok(diff.includes(content));assert.equal(await readFile(path.join(f.root,relative),'utf8'),content);}
  assert.deepEqual(await f.builder.getAttempt(job.id,1,OWNER),report);
});
