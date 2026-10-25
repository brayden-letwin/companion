import test from 'node:test';
import assert from 'node:assert/strict';
import {taskDeadlineView,formatDeadlineInstant} from '../server/task-deadline-view.mjs';

const at=Date.parse('2026-10-25T16:00:00Z'),task=(id,fields={})=>({id,status:'todo',dueAt:null,...fields});
test('one revision-bound server view distinguishes calendar dates, exact civil times and unknown legacy values without reading task text',()=>{
 const state={revision:7,tasks:[task('calendar',{dueDate:'2026-10-25'}),task('timed',{dueAt:'2026-10-25T16:00:00.123Z'}),task('none'),task('bad',{dueAt:'invalid'}),task('both',{dueAt:'2026-10-25T00:00:00Z',dueDate:'2026-10-25'})]};
 Object.defineProperty(state.tasks[0],'details',{get(){throw Error('Deadline projections must not read task text.');}});
 const result=taskDeadlineView(state,{timezone:'America/Vancouver',expectedRevision:7},at);assert.equal(result.revision,7);assert.equal(result.timezone,'America/Vancouver');assert.equal(result.asOf,'2026-10-25T16:00:00.000Z');assert.equal(result.today,'2026-10-25');assert.equal(result.now,at);
 assert.deepEqual(result.deadlines.map(x=>x.kind),['date','instant','none','invalid','invalid']);assert.equal(result.deadlines[0].dueDate,'2026-10-25');assert.equal(result.deadlines[0].dueAt,null);assert.equal(result.deadlines[0].today,true);assert.equal(result.deadlines[0].overdue,false);assert.equal(result.deadlines[1].localDateTime,'2026-10-25T09:00:00.123');assert.equal(result.deadlines[1].offsetLabel,'UTC-07:00');assert.equal(result.deadlines[1].offsetMinutes,-420);assert.equal(result.deadlines[2].localDateTime,null);assert.ok(!JSON.stringify(result).includes('details'));
 assert.throws(()=>taskDeadlineView(state,{timezone:'UTC',expectedRevision:6},at),{code:'revision_conflict',statusCode:409});
});
test('server instant formatting preserves exact milliseconds and identifies both occurrences of a repeated hour',()=>{
 const first=formatDeadlineInstant('2025-11-02T01:30:00.123-07:00','America/Vancouver',at),second=formatDeadlineInstant('2025-11-02T01:30:00.123-08:00','America/Vancouver',at);
 assert.equal(first.localDateTime,'2025-11-02T01:30:00.123');assert.equal(second.localDateTime,first.localDateTime);assert.equal(first.dueAt,'2025-11-02T08:30:00.123Z');assert.equal(second.dueAt,'2025-11-02T09:30:00.123Z');assert.equal(first.offsetLabel,'UTC-07:00');assert.equal(second.offsetLabel,'UTC-08:00');assert.equal(first.taskId,null);
 assert.throws(()=>formatDeadlineInstant('2026-10-25','UTC',at),{code:'invalid_deadline'});assert.throws(()=>formatDeadlineInstant('','UTC',at),{code:'invalid_deadline'});
});
test('all 2000 deadline records fit one complete bounded response with stable identities and no invented local instants',()=>{
 const state={revision:1,tasks:Array.from({length:2000},(_,id)=>task(String(id).padStart(80,'x'),{dueDate:id%2?'2026-10-26':null,dueAt:id%2?null:'2026-10-25T00:00:00.999Z',title:'Private title is not needed',details:'Private body is not needed'}))},before=structuredClone(state),value=taskDeadlineView(state,{timezone:'Pacific/Kiritimati'},at);
 assert.equal(value.deadlines.length,2000);assert.deepEqual(value.deadlines.map(x=>x.taskId),state.tasks.map(x=>x.id));assert.ok(Buffer.byteLength(JSON.stringify(value))<=1024*1024);assert.ok(!JSON.stringify(value).includes('Private'));assert.equal(value.deadlines[0].localDateTime,'2026-10-25T14:00:00.999');assert.equal(value.deadlines[0].offsetLabel,'UTC+14:00');assert.equal(value.deadlines[1].localDateTime,null);assert.deepEqual(state,before);
});
test('deadline display selectors and malformed task identities fail explicitly',()=>{
 const state={revision:0,tasks:[task('one')]};for(const options of [{expectedRevision:-1},{expectedRevision:'0'},{timezone:'not/a-zone'},{other:true}])assert.throws(()=>taskDeadlineView(state,options,at));
 for(const bad of [{revision:0,tasks:[task('one'),task('one')]},{revision:0,tasks:[task('')]},{revision:0,tasks:Array.from({length:2001},(_,i)=>task(String(i)))}])assert.throws(()=>taskDeadlineView(bad,{},at),{code:'invalid_task_state'});
});
