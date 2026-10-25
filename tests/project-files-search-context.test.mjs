import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSearchReference} from '../server/project-files-context.mjs';
const projectId='11111111-1111-4111-8111-111111111111',searchId='22222222-2222-4222-8222-222222222222';
const page=()=>({projectId,grantEpoch:2,searchId,path:'research',query:'PRIVATE_QUERY_MARKER',caseSensitive:false,startedAt:'2026-10-25T12:00:00Z',observedAt:'2026-10-25T12:00:01Z',complete:false,scanHasMore:true,stopReason:null,returned:1,scanned:{directories:2,entries:8,files:4,bytes:50},skipped:{protected:1,unavailable:0,binary:1,oversized:0},sourceTrust:'untrusted_project_search',snapshot:false,matches:[{path:'research/note.txt',hash:'a'.repeat(64),readAt:'2026-10-25T12:00:00.500Z',line:3,column:5,snippet:'PRIVATE_SNIPPET_MARKER',matchOffset:12,matchLength:10}]});

test('search history retains exact observed file references and completeness without query or snippet text',()=>{
  const result=projectSearchReference(page());assert.equal(result.projectId,projectId);assert.equal(result.searchId,searchId);assert.equal(result.sourceOmitted,true);assert.equal(result.snapshot,false);assert.equal(result.complete,false);assert.equal(result.scanHasMore,true);assert.deepEqual(result.scanned,{directories:2,entries:8,files:4,bytes:50});assert.deepEqual(result.files,[{path:'research/note.txt',hash:'a'.repeat(64),readAt:'2026-10-25T12:00:00.500Z',line:3}]);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(projectSearchReference(result),result,'A second bounded projection preserves observed file references.');
});

test('unknown search identities and mismatched source types cannot become retained search evidence',()=>{
  for(const change of [{searchId:'not-an-id'},{projectId:'not-a-project'},{grantEpoch:0},{sourceTrust:'model_text'}])assert.equal(projectSearchReference({...page(),...change}),null);
  const value=page();value.matches=[{...value.matches[0],hash:'invalid'}];assert.deepEqual(projectSearchReference(value).files,[]);
  value.matches=[{...page().matches[0],hash:null,fileExists:false}];assert.deepEqual(projectSearchReference(value).files,[]);
});

test('retained search references bound metadata and omit invalid or extra result fields',()=>{
  const value=page();value.matches=Array.from({length:80},()=>({...value.matches[0],projectId:'33333333-3333-4333-8333-333333333333'}));value.scanned.extra='PRIVATE_METADATA_MARKER';value.scanned.bytes=-1;value.skipped.binary=NaN;value.returned=900;value.stopReason='x'.repeat(101);const result=projectSearchReference(value);assert.equal(result.files.length,20);assert.ok(!('returned'in result));assert.ok(!('stopReason'in result));assert.ok(!('bytes'in result.scanned));assert.ok(!('extra'in result.scanned));assert.ok(!('binary'in result.skipped));assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.projectId,projectId);
});
