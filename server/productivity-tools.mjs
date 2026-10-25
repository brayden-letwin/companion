import { createHash, randomUUID } from 'node:crypto';

import { BUILTIN_TOOL_DEFINITIONS, builtinCatalog, validateToolArguments, capabilityHash, validateWorkflowSteps } from './capability-registry.mjs';
const defaultExecuteCapability=async options=>(await import('./capability-runtime.mjs')).executeCapability(options);
export const TOOL_DEFINITIONS = BUILTIN_TOOL_DEFINITIONS;
const fail = (message, code = 'invalid_tool') => Object.assign(new Error(message), { code, statusCode: 400 });
function operationId(requestId, callId) { const h = createHash('sha256').update(`${requestId}:${callId}`).digest('hex').slice(0, 32); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }
function executionBudget(context){if(!context.executionBudget)context.executionBudget={remaining:48};const budget=context.executionBudget;if(!budget||!Number.isInteger(budget.remaining)||budget.remaining<0||budget.remaining>48)throw fail('Use a bounded shared execution budget.');return budget;}
function validateArguments(name,value,registry) { const definition=registry.get(name); if(!definition)throw fail('That tool is not registered. Ask Companion to build the missing feature.'); return validateToolArguments(definition,value); }

export function createProductivityTools({ store, builder, desktop, root, capabilities = [], capabilityStatus = {ready:true}, executeCapability = defaultExecuteCapability, owner = 'local-workspace', now = Date.now } = {}) {
  if (!store) throw new Error('The productivity store is required.');
  const definitions = [...TOOL_DEFINITIONS, ...(desktop?.definitions || [])];
  const registry = new Map(definitions.map(tool => [tool.name, tool]));
  if (registry.size !== definitions.length) throw new Error('Tool names must be unique.');
  if(definitions.length>32)throw new Error('Keep provider tool definitions bounded.');
  const custom=new Map();for(const capability of capabilities){if(!capability?.tool?.name||registry.has(capability.tool.name)||custom.has(capability.tool.name))throw new Error('Capability tool names must be unique.');custom.set(capability.tool.name,structuredClone(capability));}
  const desktopNames = new Set((desktop?.definitions || []).map(tool => tool.name));
  const desktopReads = new Set(['desktop_list_apps','desktop_list_windows','desktop_read_window']);
  const catalog = () => [...builtinCatalog(),...(desktop?.definitions||[]).map(item=>({...structuredClone(item),title:item.name.replaceAll('_',' '),kind:'desktop',version:1,workflowAllowed:false,effectPolicy:desktopReads.has(item.name)?'pure':'desktop'})),...[...custom.values()].map(capability=>({name:capability.tool.name,title:capability.title,description:capability.tool.description,parameters:structuredClone(capability.tool.parameters),kind:'capability',capabilityId:capability.id,version:capability.version,hash:capability.hash,workflowAllowed:capability.workflowAllowed,effectPolicy:capability.effectPolicy,...(capability.featureId?{featureId:capability.featureId}:{})}))];
  store.configureWorkflowTools?.(catalog());
  const brokerNames=new Set(builtinCatalog().filter(item=>item.workflowAllowed).map(item=>item.name));
  const execute = async (name, raw = {}, context = {}) => {
    const { requestId, callId, providerId, signal } = context;
    if (signal?.aborted) throw Object.assign(new Error('Request stopped.'), { name: 'AbortError' });
    const budget=executionBudget(context);if(!budget.remaining)throw fail('This request reached its shared action budget. Completed actions are retained.','execution_budget_exceeded');budget.remaining-=1;
    if(typeof name==='string'&&name.startsWith('cap_'))return runCapability(name,raw,context);
    const args = validateArguments(name, raw, registry);
    if (desktopNames.has(name)) {
      if (desktopReads.has(name)) return desktop.execute(name, args, { signal, requestId });
      const receiptId = `desktop:${operationId(requestId || 'local', callId || JSON.stringify([name,args]))}`;
      const digest = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
      const saved = store.beginChat(receiptId, digest);
      if (saved) {
        if (saved.state === 'in_progress') throw Object.assign(fail('This desktop action is running or was interrupted. Inspect the target before requesting another action.', 'desktop_action_uncertain'), { statusCode: 409 });
        if (saved.state === 'failed') throw Object.assign(fail(saved.reply.message, saved.reply.code), { statusCode: saved.reply.statusCode });
        if (saved.reply.desktopAction) {
          const current = (await desktop.listActions()).find(action => action.id === saved.reply.desktopAction.id);
          if (!current || ['cancelled','expired','failed','uncertain'].includes(current.status)) throw Object.assign(fail('This desktop action is no longer pending. Read its actual result and request a fresh action if needed.', 'desktop_action_expired'), { statusCode: 409 });
          return { ...saved.reply, desktopAction: current };
        }
        return saved.reply;
      }
      try {
        const result = await desktop.execute(name, args, { signal, requestId: receiptId });
        store.finishChat(receiptId, digest, result); return result;
      } catch (error) {
        const receipt = { message: error.message || 'The desktop action could not complete. Inspect its target before retrying.', code: error.code || 'desktop_action_failed', statusCode: error.statusCode || 500 };
        store.finishChat(receiptId, digest, receipt, true); throw error;
      }
    }
    const state = store.snapshot();
    const mutate = (type, fields) => {
      const entityId = operationId(requestId || 'local', callId || JSON.stringify([name, args, state.revision]));
      const result = store.apply({ operationId: entityId, expectedRevision: state.revision, type, ...fields });
      return { ...result, entityId };
    };
    switch (name) {
      case 'list_capabilities': return {capabilities:catalog().filter(item=>item.kind==='capability'),ready:capabilityStatus.ready!==false,...(capabilityStatus.ready===false?{unavailableReason:capabilityStatus.unavailableReason||capabilityStatus.message||'The capability registry could not be loaded.'}:{})};
      case 'run_capability': return runCapability(args.name,args.arguments,context);
      case 'list_tasks': return { tasks: state.tasks.filter(task => (!args.status || task.status === args.status) && (!args.project || task.project.toLowerCase() === args.project.toLowerCase())).slice(-100), revision: state.revision };
      case 'create_task': { const result = mutate('addTask', args); return { task: result.workspace.tasks.find(item => item.id === result.entityId), replayed: result.replayed }; }
      case 'update_task': case 'complete_task': { const result = mutate(name === 'update_task' ? 'updateTask' : 'completeTask', args); return { task: result.workspace.tasks.find(task => task.id === args.taskId), replayed: result.replayed }; }
      case 'list_notes': case 'search_notes': {
        const terms = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        return { notes: state.notes.filter(note => (args.includeArchived || !note.archived) && terms.every(term => `${note.title}\n${note.text}\n${note.tags.join(' ')}`.toLowerCase().includes(term))).slice(-30).map(note => ({ ...note, text: note.text.slice(0, 1200), truncated: note.text.length > 1200 })), revision: state.revision };
      }
      case 'read_note': {
        const note = state.notes.find(item => item.id === args.noteId); if (!note) throw fail('That note was not found.', 'not_found');
        const offset = args.offset ?? 0, limit = args.limit ?? 12000;
        if (offset < 0 || limit < 1 || limit > 12000) throw fail('Choose a valid note section.');
        return { note: { ...note, text: note.text.slice(offset, offset + limit) }, offset, hasMore: note.text.length > offset + limit };
      }
      case 'save_note': { const result = mutate('addNote', args); return { note: result.workspace.notes.find(item => item.id === result.entityId), replayed: result.replayed }; }
      case 'start_focus': return { focus: mutate('startFocus', args).workspace.focus };
      case 'stop_focus': return { focus: mutate('stopFocus', {}).workspace.focus };
      case 'get_time': {
        let formatted; try { formatted = new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'long', timeZone: args.timezone }).format(new Date(now())); } catch { throw fail('Choose a valid IANA timezone.', 'invalid_timezone'); }
        return { iso: new Date(now()).toISOString(), formatted, timezone: args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      case 'list_workflows': return { workflows: state.workflows };
      case 'save_workflow': { const result = mutate('saveWorkflow', args); return { workflow: result.workspace.workflows.find(item => item.id === result.entityId), replayed: result.replayed }; }
      case 'get_preferences': return { preferences: state.preferences.filter(preference => args.includeArchived || !preference.archived), revision: state.revision };
      case 'remember_preference': { const result = mutate('rememberPreference', args); return { preference: result.workspace.preferences.find(preference => preference.key === args.key.trim()), replayed: result.replayed }; }
      case 'forget_preference': { const result = mutate('forgetPreference', args); return { preference: result.workspace.preferences.find(preference => preference.id === args.preferenceId), replayed: result.replayed }; }
      case 'run_workflow': return runWorkflow(args.workflowId, { requestId, callId, providerId, signal });
      case 'build_feature': {
        if (!builder) throw fail('The feature builder is not available.', 'builder_unavailable');
        const receiptId = `tool:${operationId(requestId || 'local', callId || JSON.stringify([name, args]))}`;
        const digest = createHash('sha256').update(JSON.stringify({ name, args, providerId })).digest('hex');
        const saved = store.beginChat?.(receiptId, digest);
        if (saved) {
          if (saved.state === 'in_progress') throw Object.assign(fail('This build request was interrupted. Inspect build history before starting another.', 'request_interrupted'), { statusCode: 409 });
          if (saved.state === 'failed') throw Object.assign(fail(saved.reply.message, saved.reply.code), { statusCode: saved.reply.statusCode });
          return saved.reply;
        }
        try {
          const result = { featureJob: await builder.request({ prompt: args.prompt, providerId, autoApply: true }, owner), message: 'The feature build has started. Check its real progress before saying it is installed.' };
          store.finishChat?.(receiptId, digest, result); return result;
        } catch (error) { store.finishChat?.(receiptId, digest, { message: 'The feature build could not be started. Check build history before retrying.', code: error.code || 'build_failed', statusCode: error.statusCode || 500 }, true); throw error; }
      }
      case 'list_feature_builds': return { jobs: builder ? await builder.list(owner) : [] };
      default: throw fail('That tool is not registered.');
    }
  };
  function replayCapability(saved){
    if(saved.state==='in_progress'||saved.state==='interrupted')throw Object.assign(fail('This capability was already started. Inspect its recorded actions before making a fresh request.','capability_interrupted'),{statusCode:409,hostActions:saved.checkpoint?.hostActions||[],capability:saved.definition});
    if(saved.state==='failed'){const error=saved.result;throw Object.assign(fail(error.error,error.code),{statusCode:error.statusCode||500,hostActions:error.hostActions||[],capability:error.capability,...(error.code==='capability_cancelled'?{name:'AbortError'}:{})});}
    return {...saved.result,replayed:true};
  }
  async function runCapability(name,args,context={}){
    if(typeof name!=='string'||!/^cap_[a-z][a-z0-9_]{0,59}$/.test(name)||!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>80000)throw fail('Choose a registered capability and bounded arguments.');
    const receiptId=`capability:${operationId(context.requestId||randomUUID(),context.callId||'capability')}`,digest=capabilityHash({name,arguments:args});
    const prior=store.executionReceipt(receiptId,digest);if(prior)return replayCapability(prior);
    const capability=custom.get(name);if(!capability)throw Object.assign(fail('This capability is not installed. Inspect the capability catalog.','capability_unavailable'),{statusCode:409});
    const checked=validateToolArguments(capability.tool,args),meta={id:capability.id,name,version:capability.version,hash:capability.hash};
    const saved=store.beginExecution({id:receiptId,digest,definition:meta});if(saved)return replayCapability(saved);
    const hostActions=[];let budgetFailure=null;
    try{
      const output=await executeCapability({root,capability:structuredClone(capability),arguments:checked,signal:context.signal,now,runTool:async(tool,argumentsValue,brokerContext={})=>{
        if(capability.effectPolicy!=='workspace'||!brokerNames.has(tool)||hostActions.length>=12)throw fail('This capability cannot call that host tool.','capability_broker_denied');
        const id=`host:${hostActions.length+1}`,signals=[context.signal,brokerContext.signal].filter(Boolean),brokerSignal=signals.length?AbortSignal.any(signals):undefined;
        const action={id,tool,arguments:structuredClone(argumentsValue),result:{outcomeUnknown:true,message:'The host call has not returned a receipt.'},status:'pending'};hostActions.push(action);store.checkpointExecution({id:receiptId,digest,checkpoint:{hostActions}});
        try{const result=await execute(tool,argumentsValue,{...context,requestId:receiptId,callId:id,signal:brokerSignal});const review=result?.status==='pending'||result?.requiresApproval===true||result?.desktopAction?.status==='pending';action.result=result;action.status=result?.error?'failed':review?'pending':'completed';store.checkpointExecution({id:receiptId,digest,checkpoint:{hostActions}});if(review)throw fail('Review is required before any further capability action.','capability_review_required');return result;}
        catch(error){if(error.code==='execution_budget_exceeded')budgetFailure=error;if(action.status==='pending'&&action.result?.outcomeUnknown){action.result={error:error.message,code:error.code||'tool_failed'};action.status='failed';store.checkpointExecution({id:receiptId,digest,checkpoint:{hostActions}});}throw error;}
      }});
      if(budgetFailure)throw budgetFailure;
      const result={capability:meta,value:output.value,hostActions};
      return store.finishExecution({id:receiptId,digest,result}).result;
    }catch(error){const result={capability:meta,error:String(error.message||'The capability failed.').slice(0,2000),code:error.name==='AbortError'?'capability_cancelled':error.code||'capability_failed',statusCode:error.name==='AbortError'?499:error.statusCode||500,hostActions};store.finishExecution({id:receiptId,digest,result,failed:true});throw Object.assign(error,{code:result.code,statusCode:result.statusCode,hostActions,capability:meta});}
  }
  async function runWorkflow(workflowId, context = {}) {
    executionBudget(context);
    if(context.signal?.aborted)throw Object.assign(new Error('Workflow stopped.'),{name:'AbortError'});
    const receiptId=`workflow:${operationId(context.requestId||randomUUID(),context.callId||'workflow')}`,digest=capabilityHash({workflowId});
    const replay=saved=>saved.state==='in_progress'||saved.state==='interrupted'?{id:workflowId,status:'interrupted',steps:saved.checkpoint?.steps||[],error:'This workflow was already started. Inspect its completed actions before making a fresh request.',code:'workflow_interrupted',workspace:store.snapshot()}:{...saved.result,workspace:store.snapshot(),replayed:true};
    const prior=store.executionReceipt(receiptId,digest);if(prior)return replay(prior);
    const workflow = store.snapshot().workflows.find(item => item.id === workflowId);
    if (!workflow || !workflow.enabled) throw fail('Choose an enabled saved workflow.', 'workflow_unavailable');
    const pinned={...structuredClone(workflow),steps:validateWorkflowSteps(workflow.steps,catalog(),{requirePins:true})};
    const saved=store.beginExecution({id:receiptId,digest,definition:pinned});if(saved)return replay(saved);
    const results = [];
    for (const [index, step] of pinned.steps.entries()) {
      try {
        if(context.signal?.aborted)throw Object.assign(new Error('Workflow stopped.'),{name:'AbortError'});
        results.push({tool:step.tool,result:await execute(step.tool,step.arguments,{...context,requestId:receiptId,callId:`step:${index}`})});
        store.checkpointExecution({id:receiptId,digest,checkpoint:{steps:results}});
      }catch(error){const result={id:workflowId,status:error.name==='AbortError'?'cancelled':'failed',steps:results,error:error.message,code:error.code|| (error.name==='AbortError'?'workflow_cancelled':'workflow_failed'),failedStep:{index,tool:step.tool,...(error.hostActions?.length?{hostActions:error.hostActions}:{})}};const finished=store.finishExecution({id:receiptId,digest,result,failed:true});return{...finished.result,workspace:store.snapshot()};}
    }
    const finished=store.finishExecution({id:receiptId,digest,result:{id:workflowId,status:'completed',steps:results}});return{...finished.result,workspace:store.snapshot()};
  }
  return { definitions, catalog, execute, runWorkflow };
}
