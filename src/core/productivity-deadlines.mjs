// Calendar deadlines remain civil dates. Only explicitly qualified timestamps
// become instants; Intl supplies the runtime's named-zone rules.
const DATE=/^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const FILTERS=new Set(['all','today','overdue','upcoming','none']);
const contexts=new WeakMap();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:400});
const pad=(value,length=2)=>String(value).padStart(length,'0');
const empty=value=>value===null||value===undefined||value==='';
function calendar(value,code='invalid_deadline'){
  const match=typeof value==='string'&&DATE.exec(value);
  if(!match||Number(match[1])<1)throw fail(code,'Choose an actual calendar date in YYYY-MM-DD form, from year 0001 to 9999.');
  const time=Date.parse(value+'T00:00:00.000Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)throw fail(code,'Choose an actual calendar date without a rolled-over day or month.');
  return value;
}
function instant(value,code='invalid_deadline'){
  const match=typeof value==='string'&&INSTANT.exec(value);
  if(!match)throw fail(code,'Use an exact ISO timestamp with seconds, up to three fractional digits and an explicit Z or numeric offset.');
  calendar(match[1],code);
  const offset=match[6];
  if(Number(match[2])>23||Number(match[3])>59||Number(match[4])>59||offset!=='Z'&&(Number(offset.slice(1,3))>23||Number(offset.slice(4,6))>59))throw fail(code,'Choose valid time and timezone-offset fields without rollover.');
  const now=Date.parse(value),canonical=Number.isFinite(now)?new Date(now).toISOString():'';
  if(!/^\d{4}-/.test(canonical)||canonical.startsWith('0000-'))throw fail(code,'The exact deadline must remain within years 0001 to 9999 after timezone conversion.');
  return{now,canonical};
}

/** Omitted fields preserve a deadline. One active value wins over its empty
 * opposite; two active values conflict. Explicitly empty fields clear both.
 */
export function normalizeDeadline(fields){
  if(!object(fields))throw fail('invalid_deadline','Provide deadline fields.');
  const hasDate=Object.hasOwn(fields,'dueDate')&&fields.dueDate!==undefined,hasInstant=Object.hasOwn(fields,'dueAt')&&fields.dueAt!==undefined;
  if(!hasDate&&!hasInstant)return undefined;
  const activeDate=hasDate&&!empty(fields.dueDate),activeInstant=hasInstant&&!empty(fields.dueAt);
  if(activeDate&&activeInstant)throw fail('invalid_deadline','Use a calendar date or an exact time, rather than two deadlines.');
  if(activeDate)return{dueDate:calendar(fields.dueDate),dueAt:null};
  if(activeInstant)return{dueDate:null,dueAt:instant(fields.dueAt).canonical};
  return{dueDate:null,dueAt:null};
}

function namedZone(value){
  const input=value===undefined?Intl.DateTimeFormat().resolvedOptions().timeZone:value;
  if(typeof input!=='string'||!input||input.length>100||input.trim()!==input||/^[+-]|[\u0000-\u001f\u007f]/u.test(input))throw fail('invalid_timezone','Choose a named IANA timezone.');
  try{return new Intl.DateTimeFormat('en-US',{timeZone:input}).resolvedOptions().timeZone;}
  catch{throw fail('invalid_timezone','Choose an available named IANA timezone.');}
}
function formatter(timezone){
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:timezone,calendar:'gregory',numberingSystem:'latn',era:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
}
function parts(time,format){
  const values=Object.fromEntries(format.formatToParts(new Date(time)).filter(item=>item.type!=='literal').map(item=>[item.type,item.value]));
  const year=values.era==='BC'?1-Number(values.year):Number(values.year),month=Number(values.month),day=Number(values.day),hour=Number(values.hour),minute=Number(values.minute),second=Number(values.second),millisecond=Number(values.fractionalSecond||0);
  return{year,month,day,hour,minute,second,millisecond,date:pad(year,4)+'-'+pad(month)+'-'+pad(day),time:pad(hour)+':'+pad(minute)+':'+pad(second)};
}
function utcValue(value){const date=new Date(0);date.setUTCFullYear(value.year,value.month-1,value.day);date.setUTCHours(value.hour,value.minute,value.second,value.millisecond);return date.getTime();}

/** A JSON-safe captured clock and named zone shared by queries and renderers. */
export function createDeadlineContext(options={}){
  if(!object(options))throw fail('invalid_deadline_context','Use deadline context options.');
  const{timezone,asOf}=options;
  const zone=namedZone(timezone);let time;
  if(asOf===undefined)time=Date.now();
  else if(typeof asOf==='number'&&Number.isSafeInteger(asOf)){try{time=instant(new Date(asOf).toISOString(),'invalid_deadline_context').now;}catch{throw fail('invalid_deadline_context','Use a finite, in-range millisecond clock or an explicit ISO timestamp.');}}
  else if(typeof asOf==='string')time=instant(asOf,'invalid_deadline_context').now;
  else throw fail('invalid_deadline_context','Use a finite millisecond clock or an explicit ISO timestamp.');
  const format=formatter(zone),local=parts(time,format);calendar(local.date,'invalid_deadline_context');
  const context=Object.freeze({timezone:zone,asOf:new Date(time).toISOString(),today:local.date,now:time});contexts.set(context,{context,format,sourceTimezone:context.timezone,sourceAsOf:context.asOf});return context;
}
function contextData(value){
  if(value===undefined)value=createDeadlineContext();
  if(!object(value))throw fail('invalid_deadline_context','Use a captured deadline context.');
  const cached=contexts.get(value);if(cached&&cached.sourceTimezone===value.timezone&&cached.sourceAsOf===value.asOf)return cached;
  const captured=createDeadlineContext({timezone:value.timezone,asOf:value.asOf}),data={...contexts.get(captured),sourceTimezone:value.timezone,sourceAsOf:value.asOf};contexts.set(value,data);return data;
}
const classification=kind=>({kind,date:null,instant:null,time:null,overdue:false,today:false,upcoming:false});

/** Invalid retained values stay invalid; this read never repairs old task data. */
export function taskDeadline(task,context){
  const data=contextData(context),clock=data.context;if(!object(task))return classification('invalid');
  const hasDate=!empty(task.dueDate),hasInstant=!empty(task.dueAt);
  if(!hasDate&&!hasInstant)return classification('none');
  if(hasDate&&hasInstant)return classification('invalid');
  try{
    if(hasDate){const date=calendar(task.dueDate);return{...classification('date'),date,overdue:task.status==='todo'&&date<clock.today,today:date===clock.today,upcoming:date>clock.today};}
    const value=instant(task.dueAt),local=parts(value.now,data.format);calendar(local.date);
    return{kind:'instant',date:local.date,instant:value.canonical,time:local.time,overdue:task.status==='todo'&&value.now<clock.now,today:local.date===clock.today,upcoming:local.date>clock.today};
  }catch{return classification('invalid');}
}
export function matchesDeadline(task,filter='all',context){
  if(!FILTERS.has(filter))throw fail('invalid_deadline_filter','Choose all, today, overdue, upcoming or none.');
  const deadline=taskDeadline(task,context);
  return filter==='all'||filter==='none'?filter==='all'||deadline.kind==='none':deadline[filter]===true;
}
/** Date-only sorts after exact times on that civil day, without inventing an instant. */
export function compareTaskDeadlines(left,right,context){
  const captured=contextData(context).context,a=taskDeadline(left,captured),b=taskDeadline(right,captured),validA=a.kind==='date'||a.kind==='instant',validB=b.kind==='date'||b.kind==='instant';
  if(!validA||!validB)return Number(validB)-Number(validA);
  if(a.date!==b.date)return a.date<b.date?-1:1;
  if(a.kind!==b.kind)return a.kind==='date'?1:-1;
  if(a.kind==='date'||a.instant===b.instant)return 0;
  return a.instant<b.instant?-1:1;
}
function offsetLabel(milliseconds){
  const seconds=Math.round(Math.abs(milliseconds)/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;
  return'UTC'+(milliseconds<0?'-':'+')+pad(hours)+':'+pad(minutes)+(remainder?':'+pad(remainder):'');
}

/** Enumerate nearby zone offsets, then verify every candidate by complete roundtrip.
 * The runtime's Intl/IANA database is authoritative; no Pacific/DST rules are embedded.
 */
export function resolveLocalDeadline(options={}){
  if(!object(options))throw fail('invalid_local_datetime','Use a local calendar time and named timezone.');
  const{localDateTime,timezone}=options;
  const zone=namedZone(timezone),match=typeof localDateTime==='string'&&LOCAL.exec(localDateTime);
  if(!match)throw fail('invalid_local_datetime','Use a local calendar date and HH:mm, with optional seconds and up to three fractional digits.');
  calendar(match[1],'invalid_local_datetime');
  const target={year:Number(match[1].slice(0,4)),month:Number(match[1].slice(5,7)),day:Number(match[1].slice(8,10)),hour:Number(match[2]),minute:Number(match[3]),second:Number(match[4]||0),millisecond:Number((match[5]||'').padEnd(3,'0'))};
  if(target.hour>23||target.minute>59||target.second>59)throw fail('invalid_local_datetime','Choose a valid local time without rollover.');
  const center=utcValue(target),format=formatter(zone),offsets=new Set();
  // A 72-hour window covers modern UTC offsets and full-day date-line changes.
  for(let delta=-36*60;delta<=36*60;delta+=30){const time=center+delta*60000;offsets.add(utcValue(parts(time,format))-time);}
  const candidates=[],seen=new Set();let outOfRange=false;
  for(const offset of offsets){
    const time=center-offset,roundtrip=parts(time,format);
    if(Object.keys(target).some(key=>target[key]!==roundtrip[key])||seen.has(time))continue;
    let dueAt;try{dueAt=instant(new Date(time).toISOString(),'invalid_local_datetime').canonical;}catch{outOfRange=true;continue;}
    seen.add(time);candidates.push({dueAt,offsetMinutes:offset/60000,offsetLabel:offsetLabel(offset)});
  }
  candidates.sort((a,b)=>a.dueAt.localeCompare(b.dueAt));
  if(!candidates.length&&outOfRange)throw fail('invalid_local_datetime','The resolved instant falls outside supported years 0001 to 9999.');
  return{timezone:zone,localDateTime,status:candidates.length===0?'nonexistent':candidates.length===1?'unique':'ambiguous',candidates};
}
