import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { verifyCapabilityBehavior, verifyPanelCapabilityLinks } from '../server/capability-verification.mjs';

async function fixture(t, code, checks, effectPolicy = 'pure') {
  const root = await mkdtemp(path.join(tmpdir(),'companion-capability-verification-'));
  t.after(async()=>{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep+'companion-capability-verification-'));await rm(target,{recursive:true,force:true});});
  const directory=path.join(root,'server','capabilities');await mkdir(directory,{recursive:true});
  const entry={id:'double-value',title:'Double value',module:'./double-value.mjs',version:1,tool:{name:'cap_double_value',description:'Return twice a number.',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}},workflowAllowed:true,effectPolicy,acceptance:checks};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,capabilities:[entry]}));
  await writeFile(path.join(directory,'double-value.mjs'),code);
  return root;
}
test('candidate capability verification executes real source and compares declared behavior',async t=>{
  const root=await fixture(t,'export function execute(args){return {total:args.value*2};}',[{name:'Known output',arguments:{value:3},expected:{total:6}}]);
  const result=await verifyCapabilityBehavior({root});assert.equal(result.passed,true,result.output);assert.match(result.output,/1 capability behavior check/);
});
test('an exported function with wrong or empty behavior cannot pass registration alone',async t=>{
  for(const source of ['export function execute(args){return {total:args.value+1};}','export function execute(){}']){
    const root=await fixture(t,source,[{name:'Known output',arguments:{value:3},expected:{total:6}}]);
    assert.equal((await verifyCapabilityBehavior({root})).passed,false);
  }
});
test('workspace behavior uses fixture-only tool results and rejects unexpected or unused host effects',async t=>{
  const code='export async function execute(args,ctx){const value=await ctx.runTool("create_task",{title:"Fixture task"});return {taskId:value.task.id};}';
  const expected={name:'Fixture action',arguments:{value:1},expected:{taskId:'fixture-only'},tools:[{name:'create_task',arguments:{title:'Fixture task'},result:{task:{id:'fixture-only'}}}]};
  const root=await fixture(t,code,[expected],'workspace');const passed=await verifyCapabilityBehavior({root});assert.equal(passed.passed,true,passed.output);assert.match(passed.output,/fixtures only/);
  const unexpected=await fixture(t,code,[{...expected,tools:[]}],'workspace');assert.equal((await verifyCapabilityBehavior({root:unexpected})).passed,false);
  const unused=await fixture(t,'export function execute(){return {taskId:"fixture-only"};}',[expected],'workspace');assert.equal((await verifyCapabilityBehavior({root:unused})).passed,false);
});
test('a panel cannot claim an absent capability or malformed voice aliases',async t=>{
  const root=await fixture(t,'export function execute(args){return {total:args.value*2};}',[{name:'Known output',arguments:{value:3},expected:{total:6}}]);await mkdir(path.join(root,'src','features'),{recursive:true});
  const manifestPath=path.join(root,'src','features','manifest.json'),panel={id:'double-panel',title:'Double',module:'./features/double-panel.mjs',capabilityId:'double-value',aliases:['Double tool']};
  await writeFile(manifestPath,JSON.stringify({version:1,features:[panel]}));assert.equal((await verifyPanelCapabilityLinks({root})).passed,true);
  await writeFile(manifestPath,JSON.stringify({version:1,features:[{...panel,capabilityId:'missing'}]}));assert.equal((await verifyPanelCapabilityLinks({root})).passed,false);
  await writeFile(manifestPath,JSON.stringify({version:1,features:[{...panel,aliases:[{}]}]}));assert.equal((await verifyPanelCapabilityLinks({root})).passed,false);
});
