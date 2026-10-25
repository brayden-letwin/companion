import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDeadline,createDeadlineContext,taskDeadline,matchesDeadline,compareTaskDeadlines,resolveLocalDeadline} from '../src/core/productivity-deadlines.mjs';

const at='2026-10-25T12:00:00.000Z';
const context=(timezone='America/Vancouver',asOf=at)=>createDeadlineContext({timezone,asOf});
const task=fields=>({status:'todo',...fields});

test('calendar deadlines preserve their exact civil date across Vancouver and UTC+14',()=>{
  for(const dueDate of ['0001-01-01','0099-12-31','2000-02-29','2026-10-25','9999-12-31']){assert.deepEqual(normalizeDeadline({dueDate}),{dueDate,dueAt:null});for(const zone of ['America/Vancouver','Pacific/Kiritimati','UTC']){const result=taskDeadline(task({dueDate}),context(zone));assert.equal(result.kind,'date');assert.equal(result.date,dueDate);assert.equal(result.instant,null);assert.equal(result.time,null);}}
});

test('deadline omission preserves state and normalization is idempotent for active and cleared shapes',()=>{
  assert.equal(normalizeDeadline({title:'Unrelated update'}),undefined);assert.equal(normalizeDeadline({dueDate:undefined,dueAt:undefined}),undefined);assert.equal(normalizeDeadline(Object.create({dueDate:'2026-10-25'})),undefined);
  for(const fields of [{dueDate:''},{dueAt:null},{dueDate:null,dueAt:''},{dueDate:'',dueAt:null}]){const normalized=normalizeDeadline(fields);assert.deepEqual(normalized,{dueDate:null,dueAt:null});assert.deepEqual(normalizeDeadline(normalized),normalized);}
  for(const fields of [{dueDate:null,dueAt:'2026-10-25T12:00:00Z'},{dueDate:'2026-10-25',dueAt:''},{dueDate:'2026-10-25',dueAt:null}]){const normalized=normalizeDeadline(fields);assert.deepEqual(normalizeDeadline(normalized),normalized);assert.equal(fields.dueDate?'date':'instant',normalized.dueDate?'date':'instant');}
  assert.throws(()=>normalizeDeadline({dueDate:'invalid',dueAt:null}),{code:'invalid_deadline'});
  assert.throws(()=>normalizeDeadline({dueDate:'2026-10-25',dueAt:at}),{code:'invalid_deadline',statusCode:400});
});

test('exact timestamps require explicit offsets and preserve millisecond precision in canonical UTC',()=>{
  for(const[input,expected]of [['2026-10-25T09:30:00-07:00','2026-10-25T16:30:00.000Z'],['2026-10-25T09:30:00.1+14:00','2026-10-24T19:30:00.100Z'],['2026-10-25T09:30:00.012+05:45','2026-10-25T03:45:00.012Z'],['0099-12-31T23:59:59.999Z','0099-12-31T23:59:59.999Z']])assert.deepEqual(normalizeDeadline({dueAt:input}),{dueDate:null,dueAt:expected});
});

test('supported extreme instants roundtrip while offset conversion cannot write an unreadable canonical year',()=>{
  for(const dueAt of ['0001-01-01T00:00:00.000Z','9999-12-31T23:59:59.999Z']){const normalized=normalizeDeadline({dueAt});assert.deepEqual(normalizeDeadline(normalized),normalized);const selected=normalizeDeadline({dueAt:normalized.dueAt}),classified=taskDeadline(task(selected),context('UTC',dueAt));assert.equal(classified.kind,'instant');assert.equal(classified.instant,dueAt);assert.equal(classified.today,true);}
  assert.throws(()=>resolveLocalDeadline({localDateTime:'0001-01-01T00:00',timezone:'Etc/GMT-14'}),{code:'invalid_local_datetime'});assert.throws(()=>resolveLocalDeadline({localDateTime:'9999-12-31T23:59:59',timezone:'Etc/GMT+12'}),{code:'invalid_local_datetime'});
});

test('invalid calendars, unqualified instants, rollovers and sub-millisecond loss are rejected',()=>{
  for(const dueDate of ['0000-01-01','10000-01-01','1900-02-29','2026-02-30','2026-13-01','2026-10-00','2026-1-01',' 2026-10-25',false,42])assert.throws(()=>normalizeDeadline({dueDate}),{code:'invalid_deadline'});
  for(const dueAt of ['2026-10-25','2026-10-25T09:00:00','2026-10-25T09:00Z','2026-02-30T09:00:00Z','2026-10-25T24:00:00Z','2026-10-25T12:60:00Z','2026-10-25T12:00:60Z','2026-10-25T12:00:00+24:00','2026-10-25T12:00:00+00:60','2026-10-25T12:00:00.0001Z','0001-01-01T00:00:00+14:00','9999-12-31T23:59:59-14:00',0])assert.throws(()=>normalizeDeadline({dueAt}),{code:'invalid_deadline'});
  for(const value of [null,[],1,'2026-10-25'])assert.throws(()=>normalizeDeadline(value),{code:'invalid_deadline'});
});

test('captured context is JSON-safe, uses its named zone and accepts an internal epoch clock',()=>{
  const vancouver=context('America/Vancouver','2026-10-25T00:30:00Z'),kiritimati=context('Pacific/Kiritimati','2026-10-25T00:30:00Z');assert.equal(vancouver.today,'2026-10-24');assert.equal(kiritimati.today,'2026-10-25');assert.equal(vancouver.asOf,'2026-10-25T00:30:00.000Z');assert.equal(vancouver.now,Date.parse(vancouver.asOf));assert.deepEqual(Object.keys(vancouver),['timezone','asOf','today','now']);assert.deepEqual(JSON.parse(JSON.stringify(vancouver)),{...vancouver});assert.equal(Object.isFrozen(vancouver),true);assert.equal(context('UTC',0).today,'1970-01-01');
  for(const timezone of ['Not/A_Zone','+14:00',' UTC ',null])assert.throws(()=>createDeadlineContext({timezone,asOf:at}),{code:'invalid_timezone'});
  for(const asOf of ['2026-10-25','2026-02-30T12:00:00Z',NaN,Infinity,0.5,{},new Date(at)])assert.throws(()=>createDeadlineContext({timezone:'UTC',asOf}),{code:'invalid_deadline_context'});assert.throws(()=>createDeadlineContext(null),{code:'invalid_deadline_context'});
});

test('Today, Overdue and Upcoming use one captured civil day and exact instants without inventing a time',()=>{
  const clock=context(),today=task({dueDate:'2026-10-25'}),yesterday=task({dueDate:'2026-10-24'}),tomorrow=task({dueDate:'2026-10-26'}),earlier=task({dueAt:'2026-10-25T11:59:59.999Z'}),equal=task({dueAt:at}),laterToday=task({dueAt:'2026-10-26T01:00:00Z'}),nextDay=task({dueAt:'2026-10-26T12:00:00Z'});
  assert.equal(taskDeadline(today,clock).overdue,false);assert.equal(taskDeadline(yesterday,clock).overdue,true);assert.equal(taskDeadline(tomorrow,clock).upcoming,true);assert.equal(taskDeadline(earlier,clock).overdue,true);assert.equal(taskDeadline(equal,clock).overdue,false);assert.equal(taskDeadline(laterToday,clock).today,true);assert.equal(taskDeadline(laterToday,clock).upcoming,false);assert.equal(taskDeadline(nextDay,clock).upcoming,true);assert.equal(taskDeadline({...earlier,status:'done'},clock).overdue,false);assert.equal(taskDeadline({...yesterday,status:'done'},clock).overdue,false);
  assert.equal(matchesDeadline(today,'today',clock),true);assert.equal(matchesDeadline(today,'overdue',clock),false);assert.equal(matchesDeadline(laterToday,'upcoming',clock),false);assert.equal(matchesDeadline(nextDay,'upcoming',clock),true);assert.equal(matchesDeadline(task({}),'none',clock),true);assert.equal(matchesDeadline(task({dueDate:null,dueAt:null}),'none',clock),true);assert.throws(()=>matchesDeadline(today,'tomorrow',clock),{code:'invalid_deadline_filter'});
});

test('legacy conflicts and malformed saved values remain invalid without being rewritten or treated as unscheduled',()=>{
  const clock=context();for(const source of [task({dueAt:'2026-10-25'}),task({dueDate:'2026-02-30'}),task({dueDate:'2026-10-25',dueAt:at}),task({dueAt:'2026-10-25T12:00:00'}),task({dueAt:false}),null]){const before=structuredClone(source),result=taskDeadline(source,clock);assert.deepEqual(result,{kind:'invalid',date:null,instant:null,time:null,overdue:false,today:false,upcoming:false});assert.equal(matchesDeadline(source,'none',clock),false);assert.equal(matchesDeadline(source,'all',clock),true);assert.deepEqual(source,before);}
  assert.equal(taskDeadline(task({dueDate:null,dueAt:at}),clock).kind,'instant');assert.equal(taskDeadline(task({dueDate:'2026-10-25',dueAt:null}),clock).kind,'date');
});

test('deadline sort orders civil days, exact times then date-only, leaving undated and invalid stable at the end',()=>{
  const clock=context(),items=[task({id:'none'}),task({id:'date',dueDate:'2026-10-25'}),task({id:'late',dueAt:'2026-10-26T01:00:00Z'}),task({id:'invalid',dueAt:'bad'}),task({id:'next',dueDate:'2026-10-26'}),task({id:'early',dueAt:'2026-10-25T08:00:00Z'}),task({id:'prior',dueDate:'2026-10-24'})];assert.deepEqual([...items].sort((a,b)=>compareTaskDeadlines(a,b,clock)).map(item=>item.id),['prior','early','late','date','next','none','invalid']);assert.equal(compareTaskDeadlines(task({dueDate:'2026-10-25'}),task({dueDate:'2026-10-25'}),clock),0);assert.equal(taskDeadline(items[1],clock).instant,null);
});

test('a serialized server context is respected and only its actual zone/instant control classification',()=>{
  const wire=JSON.parse(JSON.stringify(context('UTC','2026-10-25T23:00:00Z'))),source=task({dueDate:'2026-10-25'});assert.equal(taskDeadline(source,wire).today,true);wire.today='1900-01-01';wire.now=0;assert.equal(taskDeadline(source,wire).today,true);wire.asOf='2026-10-26T01:00:00Z';assert.equal(taskDeadline(source,wire).overdue,true);wire.timezone='Pacific/Honolulu';assert.equal(taskDeadline(source,wire).today,true);
});

test('ordinary named-zone local times resolve uniquely with fractional precision and UTC+14',()=>{
  for(const[input,zone,dueAt,offset]of [['2026-10-25T09:30','America/Vancouver','2026-10-25T16:30:00.000Z',-420],['2026-10-25T00:15:00.012','Pacific/Kiritimati','2026-10-24T10:15:00.012Z',840],['2026-10-25T09:30:12.5','Asia/Kathmandu','2026-10-25T03:45:12.500Z',345],['0001-01-01T00:00','UTC','0001-01-01T00:00:00.000Z',0]]){const result=resolveLocalDeadline({localDateTime:input,timezone:zone});assert.equal(result.localDateTime,input);assert.equal(result.status,'unique');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].dueAt,dueAt);assert.equal(result.candidates[0].offsetMinutes,offset);assert.match(result.candidates[0].offsetLabel,/^UTC[+-]\d{2}:\d{2}(?::\d{2})?$/);}
});

test('historical Vancouver gaps and folds enumerate all candidates and never choose a fold occurrence',()=>{
  const gap=resolveLocalDeadline({localDateTime:'2025-03-09T02:30',timezone:'America/Vancouver'});assert.equal(gap.status,'nonexistent');assert.deepEqual(gap.candidates,[]);const fold=resolveLocalDeadline({localDateTime:'2025-11-02T01:30',timezone:'America/Vancouver'});assert.equal(fold.status,'ambiguous');assert.deepEqual(fold.candidates,[{dueAt:'2025-11-02T08:30:00.000Z',offsetMinutes:-420,offsetLabel:'UTC-07:00'},{dueAt:'2025-11-02T09:30:00.000Z',offsetMinutes:-480,offsetLabel:'UTC-08:00'}]);assert.equal(Object.hasOwn(fold,'dueAt'),false);for(const candidate of fold.candidates){const local=taskDeadline(task({dueAt:candidate.dueAt}),context('America/Vancouver'));assert.equal(local.date,'2025-11-02');assert.equal(local.time,'01:30:00');}
});

test('current runtime IANA data distinguishes permanent-DST Vancouver from Los Angeles in November 2026',()=>{
  const vancouver=resolveLocalDeadline({localDateTime:'2026-11-01T01:30',timezone:'America/Vancouver'}),losAngeles=resolveLocalDeadline({localDateTime:'2026-11-01T01:30',timezone:'America/Los_Angeles'});assert.equal(vancouver.status,'unique','The runtime timezone database must include British Columbia’s 2026 permanent-DST rule.');assert.deepEqual(vancouver.candidates.map(item=>item.offsetMinutes),[-420]);assert.equal(losAngeles.status,'ambiguous');assert.deepEqual(losAngeles.candidates.map(item=>item.offsetMinutes),[-420,-480]);
});

test('Lord Howe half-hour transitions and Apia skipped civil day are resolved without one-hour assumptions',()=>{
  const fold=resolveLocalDeadline({localDateTime:'2026-04-05T01:45',timezone:'Australia/Lord_Howe'});assert.equal(fold.status,'ambiguous');assert.deepEqual(fold.candidates.map(item=>item.offsetMinutes),[660,630]);assert.equal(Date.parse(fold.candidates[1].dueAt)-Date.parse(fold.candidates[0].dueAt),30*60000);assert.equal(resolveLocalDeadline({localDateTime:'2026-10-04T02:15',timezone:'Australia/Lord_Howe'}).status,'nonexistent');
  for(const time of ['00:00','12:00','23:59'])assert.equal(resolveLocalDeadline({localDateTime:'2011-12-30T'+time,timezone:'Pacific/Apia'}).status,'nonexistent');assert.deepEqual(resolveLocalDeadline({localDateTime:'2011-12-29T12:00',timezone:'Pacific/Apia'}).candidates.map(item=>item.offsetMinutes),[-600]);assert.deepEqual(resolveLocalDeadline({localDateTime:'2011-12-31T12:00',timezone:'Pacific/Apia'}).candidates.map(item=>item.offsetMinutes),[840]);
});

test('invalid local inputs and unnamed offsets fail rather than receiving implicit host timezone guesses',()=>{
  for(const localDateTime of ['2026-02-30T09:30','2026-10-25','2026-10-25T24:00','2026-10-25T09:60','2026-10-25T09:00:60','2026-10-25T09:00:00.0001','2026-10-25T09:00Z','0000-01-01T00:00',null])assert.throws(()=>resolveLocalDeadline({localDateTime,timezone:'UTC'}),{code:'invalid_local_datetime'});assert.throws(()=>resolveLocalDeadline({localDateTime:'2026-10-25T09:00',timezone:'+14:00'}),{code:'invalid_timezone'});assert.throws(()=>resolveLocalDeadline(null),{code:'invalid_local_datetime'});
});
