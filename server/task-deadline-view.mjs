import {createDeadlineContext,taskDeadline,normalizeDeadline} from '../src/core/productivity-deadlines.mjs';

const MAX_BYTES=1024*1024;
const fail=(code,message,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const pad=value=>String(value).padStart(2,'0');
function offsetLabel(minutes){const seconds=Math.round(Math.abs(minutes)*60),hours=Math.floor(seconds/3600),rest=seconds%3600;return'UTC'+(minutes<0?'-':'+')+pad(hours)+':'+pad(Math.floor(rest/60))+(rest%60?':'+pad(rest%60):'');}

/** Civil display comes from the server's zone database, including millisecond precision. */
export function projectTaskDeadline(task,context){
 const value=taskDeadline(task,context),instant=value.kind==='instant'?value.instant:null;
 let localDateTime=null,offsetMinutes=null;
 if(instant){localDateTime=value.date+'T'+value.time+instant.slice(19,23);offsetMinutes=(Date.parse(localDateTime+'Z')-Date.parse(instant))/60000;}
 return{taskId:typeof task.id==='string'?task.id:null,...value,localDateTime,dueDate:value.kind==='date'?value.date:null,dueAt:instant,offsetMinutes,offsetLabel:offsetMinutes===null?null:offsetLabel(offsetMinutes)};
}

/** One bounded, revision-bound view for all local tasks; task text never enters it. */
export function taskDeadlineView(state,options={},now=Date.now()){
 if(!state||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.tasks)||state.tasks.length>2000)throw fail('invalid_task_state','The task deadline snapshot is invalid.',500);
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['timezone','expectedRevision'].includes(key)))throw fail('invalid_deadline_query','Use the deadline timezone and current workspace revision.');
 if(options.expectedRevision!==undefined){if(!Number.isSafeInteger(options.expectedRevision)||options.expectedRevision<0)throw fail('invalid_revision','Use the current workspace revision.');if(options.expectedRevision!==state.revision)throw fail('revision_conflict','Tasks changed. Refresh their deadlines with the new workspace revision.',409);}
 const context=createDeadlineContext({timezone:options.timezone,asOf:now}),ids=new Set();
 const deadlines=state.tasks.map(task=>{if(!task||typeof task!=='object'||Array.isArray(task)||typeof task.id!=='string'||!task.id||task.id.length>80||ids.has(task.id))throw fail('invalid_task_state','A saved task has invalid or duplicated identity.',500);ids.add(task.id);return projectTaskDeadline(task,context);});
 const result={revision:state.revision,...context,deadlines};
 if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)throw fail('deadline_view_limit','The complete deadline view exceeds its bound.',500);
 return result;
}

export function formatDeadlineInstant(dueAt,timezone,now=Date.now()){
 if(typeof dueAt!=='string'||!dueAt)throw fail('invalid_deadline','Choose an exact qualified deadline timestamp.');
 const normalized=normalizeDeadline({dueAt}),context=createDeadlineContext({timezone,asOf:now});
 return{timezone:context.timezone,...projectTaskDeadline({dueAt:normalized.dueAt},context)};
}
