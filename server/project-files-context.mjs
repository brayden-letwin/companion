const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>Object.assign(new Error('Choose an existing project folder and its current access version.'),{code:'invalid_project_binding',statusCode:400});
export function normalizeProjectBinding(value){
  if(value===undefined)return undefined;
  if(!object(value)||Object.keys(value).some(key=>!['projectId','grantEpoch'].includes(key))||typeof value.projectId!=='string'||!UUID.test(value.projectId)||!Number.isSafeInteger(value.grantEpoch)||value.grantEpoch<1)throw fail();
  return{projectId:value.projectId.toLowerCase(),grantEpoch:value.grantEpoch};
}
export function projectReference(value){
  if(!object(value))return null;
  let binding;try{binding=normalizeProjectBinding({projectId:value.projectId,grantEpoch:value.grantEpoch});}catch{return null;}
  const result={...binding};
  if(typeof value.label==='string')result.label=value.label.slice(0,256);
  if(typeof value.validatedAt==='string'&&Number.isFinite(Date.parse(value.validatedAt)))result.validatedAt=new Date(value.validatedAt).toISOString();
  return result;
}
export function projectEditReference(value){
  if(!object(value)||typeof value.id!=='string'||!UUID.test(value.id))return null;
  const project=projectReference(value);if(!project)return null;
  const result={id:value.id,...project};
  if(typeof value.path==='string'&&value.path.length<=500&&!/[\\:\u0000-\u001f]/u.test(value.path))result.path=value.path;
  if(typeof value.status==='string')result.status=value.status.slice(0,40);
  for(const key of['beforeHash','afterHash'])if(value[key]===null||typeof value[key]==='string'&&/^[a-f\d]{64}$/.test(value[key]))result[key]=value[key];
  for(const key of['undoAvailable','outcomeUnknown','receiptPending','fileExists'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(Number.isSafeInteger(value.bytes)&&value.bytes>=0)result.bytes=value.bytes;
  return result;
}
export function projectReadReference(value){
  const project=projectReference(value);
  if(!project||typeof value.path!=='string'||value.path.length>500||!(value.fileExists===false&&value.hash===null)&&!(typeof value.hash==='string'&&/^[a-f\d]{64}$/.test(value.hash)))return null;
  const result={...project,path:value.path,hash:value.hash,sourceTrust:'untrusted_project_file',sourceOmitted:true};
  if(typeof value.fileExists==='boolean')result.fileExists=value.fileExists;
  if(typeof value.readAt==='string'&&Number.isFinite(Date.parse(value.readAt)))result.readAt=new Date(value.readAt).toISOString();
  for(const key of['offset','characterLength','byteLength'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
  if(value.nextOffset===null||Number.isSafeInteger(value.nextOffset)&&value.nextOffset>=0)result.nextOffset=value.nextOffset;
  if(typeof value.hasMore==='boolean')result.hasMore=value.hasMore;
  if(typeof value.content==='string')result.returnedCharacters=value.content.length;
  else if(Number.isSafeInteger(value.returnedCharacters)&&value.returnedCharacters>=0)result.returnedCharacters=value.returnedCharacters;
  return result;
}
