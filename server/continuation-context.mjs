import {createHash} from 'node:crypto';
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH=/^[a-f\d]{64}$/i;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const EFFECTS=new Set(['create_task','update_task','complete_task','save_note','start_focus','stop_focus','save_workflow','remember_preference','forget_preference','run_workflow','desktop_open_app','desktop_focus_window','desktop_open_url','desktop_propose_action']);
export function continuationPriorEffect(actions,name,args){
  const projectMutation=(name==='cap_project_files'&&['write','replace','undo'].includes(args?.action))||(name==='run_capability'&&args?.name==='cap_project_files'&&['write','replace','undo'].includes(args?.arguments?.action));
  if(!EFFECTS.has(name)&&!projectMutation)return null;
  const key=JSON.stringify(canonical(args));let found=null;
  const scan=(items,depth=0)=>{if(found||!Array.isArray(items)||depth>3)return;for(const action of items){if(action?.status!=='failed'&&action?.status!=='pending'&&action?.result&&!action.result.error&&!action.resultTruncated&&action.arguments&&action.tool===name&&JSON.stringify(canonical(action.arguments))===key){found={actionId:action.id,result:structuredClone(action.result)};return;}scan(action?.result?.hostActions,depth+1);scan(action?.result?.steps,depth+1);if(found)return;}};scan(actions);return found;
}
export function continuationReference(value){
  if(!value||typeof value!=='object'||['id','buildId','workId'].some(key=>typeof value[key]!=='string'||!UUID.test(value[key])))return null;
  return{id:value.id,buildId:value.buildId,workId:value.workId,...(typeof value.status==='string'?{status:value.status.slice(0,40)}:{})};
}
export function hasContinuationCapabilityReceipt(actions,pins){
  if(!Array.isArray(actions)||!Array.isArray(pins)||!pins.length)return false;
  return actions.some(action=>{
    const result=action?.result,meta=result?.capability;
    if(action?.status!=='completed'||!result||result.error||!meta||!Object.hasOwn(result,'value'))return false;
    return pins.some(pin=>pin.name===meta.name&&pin.id===meta.id&&pin.version===meta.version&&HASH.test(pin.hash||'')&&pin.hash===meta.hash);
  });
}
export function continuationTurnDigest(digest,value){
  const ref=continuationReference(value);if(!ref||typeof digest!=='string'||!HASH.test(digest))throw Object.assign(new Error('The original continuation identity could not be matched.'),{code:'invalid_continuation_context',statusCode:409});
  const pins=value.requiredCapabilities;
  if(!Array.isArray(pins)||!pins.length||pins.length>40||pins.some(pin=>!pin||typeof pin.name!=='string'||!/^cap_[a-z][a-z0-9_]{0,59}$/.test(pin.name)||typeof pin.id!=='string'||!Number.isSafeInteger(pin.version)||pin.version<1||!HASH.test(pin.hash||'')))throw Object.assign(new Error('The installed continuation capability proof is unavailable.'),{code:'invalid_continuation_context',statusCode:409});
  return createHash('sha256').update(JSON.stringify({digest,continuation:{id:ref.id,buildId:ref.buildId,workId:ref.workId},requiredCapabilities:pins.map(({name,id,version,hash})=>({name,id,version,hash}))})).digest('hex');
}
