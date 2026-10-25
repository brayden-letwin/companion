const CONVERSATION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** Workflow form state and save lifecycle. Transport and execution stay with the host. */
export function createWorkflowEditor({document,getWorkspace,getCatalog,refreshCatalog,saveOperation,getPendingOperationId,showDialog,notify,randomUUID}){
  const $=id=>document.getElementById(id);
  const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
  const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
  const button=(text,className,action)=>{const node=element('button',className,text);node.type='button';if(action)node.addEventListener('click',action);return node;};
  function humanLabel(value){return String(value||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/^./,letter=>letter.toUpperCase());}
  function toolLabel(name){const meta=getCatalog().tools.find(item=>item.name===name);return meta?.title||humanLabel(name);}
  let workflowEditorGeneration=0,workflowOriginalSteps=[];
  let workflowEditingId=null,workflowEditingRevision=null,workflowDraft=[];
  const workflowPendingSaves=new Map(),workflowFieldDrafts=new WeakMap();
function workflowMeta(step){return getCatalog().tools.find(item=>item.name===step.tool);}
function workflowAvailability(step){
  const {ready:toolCatalogReady,error:toolCatalogError,capabilityStatus}=getCatalog();
  const meta=workflowMeta(step);if(!toolCatalogReady)return {available:false,reason:toolCatalogError||'Checking available actions…',meta};
  if(!meta)return {available:false,reason:capabilityStatus?.ready===false?'Installed actions are unavailable. Your saved step is preserved.':'This saved action is not installed. Your step is preserved.',meta};
  if(meta.workflowAllowed!==true)return {available:false,reason:'This action is not available in workflows.',meta};
  if(step.capability&&(meta.capabilityId!==step.capability.id||meta.version!==step.capability.version||meta.hash!==step.capability.hash))return {available:false,changed:true,reason:'This tool changed. Review the values, then choose Use updated action.',meta};
  return {available:true,meta};
}
function schemaType(schema){return Array.isArray(schema?.type)?schema.type.find(type=>type!=='null'):schema?.type;}
function validateWorkflowValue(value,schema={},label='Value',depth=0){
  if(depth>8)throw new Error(label+' has too many nested details.');
  if(value===null&&Array.isArray(schema.type)&&schema.type.includes('null'))return;
  if(Array.isArray(schema.enum)&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))throw new Error('Choose a listed value for '+label+'.');
  const type=schemaType(schema);
  if(type==='string'){if(typeof value!=='string')throw new Error(label+' must be text.');if(value.length<(schema.minLength??0)||value.length>(schema.maxLength??24000))throw new Error('Check the length of '+label+'.');}
  else if(type==='number'||type==='integer'){if(typeof value!=='number'||!Number.isFinite(value)||(type==='integer'&&!Number.isInteger(value)))throw new Error(label+' must be '+(type==='integer'?'a whole number.':'a number.'));if(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum)throw new Error(label+' is outside its allowed range.');}
  else if(type==='boolean'){if(typeof value!=='boolean')throw new Error('Choose Yes or No for '+label+'.');}
  else if(type==='array'){if(!Array.isArray(value))throw new Error(label+' must be a list.');if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??1000))throw new Error('Check the number of items in '+label+'.');for(const item of value)validateWorkflowValue(item,schema.items||{},label+' item',depth+1);}
  else if(type==='object'||schema.properties){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(label+' must contain details in braces.');const properties=schema.properties||{};for(const key of schema.required||[])if(value[key]===undefined||(typeof value[key]==='string'&&!value[key].trim()))throw new Error('Add '+humanLabel(key)+' for '+label+'.');for(const[key,item]of Object.entries(value)){if(!Object.hasOwn(properties,key)&&schema.additionalProperties===false)throw new Error(label+' contains an unsupported field: '+humanLabel(key)+'.');if(Object.hasOwn(properties,key))validateWorkflowValue(item,properties[key],humanLabel(key),depth+1);else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateWorkflowValue(item,schema.additionalProperties,humanLabel(key),depth+1);}}
  if(JSON.stringify(value)?.length>80000)throw new Error(label+' is too large.');
}
function workflowRawFields(step){let fields=workflowFieldDrafts.get(step);if(!fields){fields=new Map();workflowFieldDrafts.set(step,fields);}return fields;}
function validateWorkflowSteps(steps){
  if(!steps.length)throw new Error('Add at least one step.');
  for(const[index,step]of steps.entries()){
    if(!step.tool)throw new Error('Choose an action for step '+(index+1)+'.');
    const state=workflowAvailability(step);if(!state.available)throw new Error('Step '+(index+1)+': '+state.reason);
    for(const draft of workflowRawFields(step).values())if(draft.error)throw new Error('Step '+(index+1)+': '+draft.error);
    validateWorkflowValue(step.arguments||{},state.meta.parameters,'step '+(index+1));
  }
}
function openWorkflow(flow=null){workflowEditorGeneration++;workflowEditingId=flow?.id||null;workflowEditingRevision=getWorkspace()?.revision;$('workflow-name').value=flow?.name||'';$('workflow-description').value=flow?.description||'';$('workflow-enabled').checked=flow?.enabled!==false;workflowDraft=clone(flow?.steps||[{tool:'',arguments:{}}]);workflowOriginalSteps=clone(flow?.steps||[]);$('workflow-form-error').textContent='';$('workflow-save').disabled=false;renderWorkflowSteps();showDialog('workflow-dialog');void refreshCatalog({quiet:true});}
function selectedWorkflowStep(tool,args={}){const meta=getCatalog().tools.find(item=>item.name===tool);return{tool,arguments:clone(args),...(meta?.kind==='capability'?{capability:{id:meta.capabilityId,version:meta.version,hash:meta.hash}}:{})};}
function reconcileWorkflowSave(operationId,result){
  const binding=workflowPendingSaves.get(operationId);if(!binding)return false;workflowPendingSaves.delete(operationId);if(binding.generation!==workflowEditorGeneration||binding.workflowId!==workflowEditingId)return false;const expectedId=binding.workflowId||operationId,saved=result.workflow?.id===expectedId?result.workflow:result.workspace?.workflows.find(flow=>flow.id===expectedId);if(!saved||!CONVERSATION_ID.test(saved.id))return false;workflowEditingId=saved.id;if(Array.isArray(saved.steps))workflowOriginalSteps=clone(saved.steps);workflowEditingRevision=getWorkspace().revision;return true;
}
function workflowFormData(){return{name:$('workflow-name').value.trim(),description:$('workflow-description').value.trim(),enabled:$('workflow-enabled').checked,steps:clone(workflowDraft)};}
function replaceWorkflowArgument(step,name,value){const args={...(step.arguments||{})};if(value===undefined)delete args[name];else args[name]=value;step.arguments=args;}
function renderWorkflowField(step,index,name,schema,required){
  const label=element('label','workflow-field field-label'),title=schema.title||humanLabel(name);label.append(element('span','',title+(required?'':' · optional')));
  const type=schemaType(schema),value=step.arguments?.[name],draft=workflowRawFields(step).get(name);let field;
  if(Array.isArray(schema.enum)&&schema.enum.every(item=>item===null||['string','number','boolean'].includes(typeof item))){field=element('select');const empty=element('option','',required?'Choose a value':'Not set');empty.value='';field.append(empty);schema.enum.forEach((item,position)=>{const option=element('option','',String(item));option.value=String(position);field.append(option);});const position=schema.enum.findIndex(item=>JSON.stringify(item)===JSON.stringify(value));field.value=position<0?'':String(position);field.addEventListener('change',()=>replaceWorkflowArgument(step,name,field.value===''?undefined:clone(schema.enum[Number(field.value)])));}
  else if(type==='boolean'){field=element('select');for(const[choice,text]of[['',required?'Choose Yes or No':'Not set'],['true','Yes'],['false','No']]){const option=element('option','',text);option.value=choice;field.append(option);}field.value=typeof value==='boolean'?String(value):'';field.addEventListener('change',()=>replaceWorkflowArgument(step,name,field.value===''?undefined:field.value==='true'));}
  else if(type==='array'||type==='object'||schema.properties||!['string','number','integer'].includes(type)){
    field=element('textarea');field.rows=4;field.maxLength=24000;field.value=draft?.text??(value===undefined?'':JSON.stringify(value,null,2));field.placeholder=type==='array'?'[ ]':'{ }';const error=element('small','workflow-field-error',draft?.error||'');
    field.addEventListener('input',()=>{let message='';try{if(!field.value.trim()){replaceWorkflowArgument(step,name,undefined);}else{const parsed=JSON.parse(field.value);validateWorkflowValue(parsed,schema,title);replaceWorkflowArgument(step,name,parsed);}}catch(problem){message=problem instanceof SyntaxError?'Use a valid list or details with quoted field names.':problem.message;}workflowRawFields(step).set(name,{text:field.value,error:message});error.textContent=message;});label.append(field,element('small','workflow-field-hint',type==='array'?'Enter a list in square brackets.':'Enter details in braces, with quoted field names.'),error);
  }else{
    field=element(type==='string'&&(schema.maxLength??0)>500?'textarea':'input');if(type==='number'||type==='integer'){field.type='number';field.step=type==='integer'?'1':'any';if(schema.minimum!==undefined)field.min=String(schema.minimum);if(schema.maximum!==undefined)field.max=String(schema.maximum);field.value=draft?.text??(value===undefined?'':String(value));}
    else{field.maxLength=schema.maxLength??24000;field.value=value??'';if(field.tagName.toLowerCase()==='textarea')field.rows=3;}
    field.addEventListener('input',()=>{if(type==='number'||type==='integer'){const number=field.value.trim()===''?undefined:Number(field.value),error=number!==undefined&&!Number.isFinite(number)?'Enter a valid number.':'';workflowRawFields(step).set(name,{text:field.value,error});if(!error)replaceWorkflowArgument(step,name,number);}else replaceWorkflowArgument(step,name,field.value===''&&!required?undefined:field.value);});
  }
  field.setAttribute('aria-label',title+' for step '+(index+1));field.dataset.argument=name;if(![...label.childNodes].includes(field))label.append(field);if(schema.description)label.append(element('small','workflow-field-hint',schema.description));return label;
}
function renderWorkflowSteps(){
  const {tools:toolCatalog,ready:toolCatalogReady,error:toolCatalogError,capabilityStatus}=getCatalog();
  const list=$('workflow-steps');list.replaceChildren();$('workflow-catalog-status').textContent=toolCatalogError||(!toolCatalogReady?'Checking available actions…':capabilityStatus?.ready===false?capabilityStatus.message||'Installed actions are unavailable.':'Choose an action, then fill in its values.');
  const eligible=toolCatalog.filter(item=>item.workflowAllowed===true);
  workflowDraft.forEach((step,index)=>{const state=workflowAvailability(step),row=element('div','workflow-step'),header=element('div','workflow-step-header'),select=element('select');select.setAttribute('aria-label','Action for step '+(index+1));const empty=element('option','','Choose an action');empty.value='';select.append(empty);
    for(const meta of eligible){const option=element('option','',meta.title||humanLabel(meta.name));option.value=meta.name;select.append(option);}if(step.tool&&!eligible.some(item=>item.name===step.tool)){const option=element('option','',toolLabel(step.tool)+' · unavailable');option.value=step.tool;select.append(option);}select.value=step.tool||'';select.addEventListener('change',()=>{workflowDraft[index]=selectedWorkflowStep(select.value);renderWorkflowSteps();});header.append(element('span','',String(index+1).padStart(2,'0')),select,button('Remove','quiet-button',()=>{workflowDraft.splice(index,1);renderWorkflowSteps();}));row.append(header);
    if(step.tool&&!state.available){row.append(element('p','workflow-unavailable',state.reason));if(state.changed){row.append(button('Use updated action','secondary-button',()=>{workflowDraft[index]=selectedWorkflowStep(step.tool,step.arguments||{});renderWorkflowSteps();}));}}
    if(state.meta?.parameters){const schema=state.meta.parameters,optional=element('details','workflow-optional');optional.append(element('summary','','More options'));let optionalCount=0;for(const[name,property]of Object.entries(schema.properties||{})){const required=(schema.required||[]).includes(name),field=renderWorkflowField(step,index,name,property,required);if(required)row.append(field);else{optionalCount++;optional.append(field);if(Object.hasOwn(step.arguments||{},name))optional.open=true;}}if(optionalCount)row.append(optional);}
    else if(step.tool){const details=element('details','workflow-saved-values');details.append(element('summary','','Saved values'),element('pre','',JSON.stringify(step.arguments||{},null,2)));row.append(details);}
    list.append(row);
  });
}
$('new-workflow').addEventListener('click',()=>openWorkflow());$('add-workflow-step').addEventListener('click',()=>{if(workflowDraft.length>=12){notify('Keep this workflow to 12 steps.');return;}workflowDraft.push({tool:'',arguments:{}});renderWorkflowSteps();});
$('workflow-form').addEventListener('submit',async event=>{
  event.preventDefault();const session=workflowEditorGeneration,target={id:workflowEditingId,revision:workflowEditingRevision},draft=workflowFormData(),operationId=randomUUID(),encoded=JSON.stringify(draft),stepsChanged=!target.id||JSON.stringify(draft.steps)!==JSON.stringify(workflowOriginalSteps);$('workflow-form-error').textContent='';$('workflow-save').disabled=true;
  try{await refreshCatalog();if(session!==workflowEditorGeneration)return;if(JSON.stringify(workflowFormData())!==encoded)throw new Error('Your draft changed while checking actions. Review it, then save again.');if(target.revision!==getWorkspace().revision)throw new Error('Your workspace changed. Review your draft, then save again.');for(const[index,step]of workflowDraft.entries())for(const raw of workflowRawFields(step).values())if(raw.error)throw new Error('Step '+(index+1)+': '+raw.error);if(stepsChanged)validateWorkflowSteps(workflowDraft);
    workflowPendingSaves.set(operationId,{generation:session,workflowId:target.id});const {steps,...metadata}=draft,result=await saveOperation({...(target.id?{workflowId:target.id}:{}),...metadata,...(stepsChanged?{steps}: {})},{operationId});reconcileWorkflowSave(operationId,result);if(session!==workflowEditorGeneration)return;if(JSON.stringify(workflowFormData())===encoded)$('workflow-dialog').close();else $('workflow-form-error').textContent='The saved version is confirmed. Your newer draft is still here.';
  }catch(error){if(getPendingOperationId()!==operationId)workflowPendingSaves.delete(operationId);if(session===workflowEditorGeneration){$('workflow-form-error').textContent=error.message;workflowEditingRevision=getWorkspace()?.revision;}}finally{if(session===workflowEditorGeneration)$('workflow-save').disabled=false;}
});
  return {open:openWorkflow,render:renderWorkflowSteps,validateSteps:validateWorkflowSteps,availability:workflowAvailability,reconcileSave:reconcileWorkflowSave,getDraft:()=>workflowDraft};
}
