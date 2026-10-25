import { createVoiceSession } from './voice-session.mjs';
const $ = id => document.getElementById(id);
const shellCandidate = window.companionShell;
const nativeShell = shellCandidate?.desktop===true&&['corner','workspace'].includes(shellCandidate.mode)
  &&['openWorkspace','setExpanded','hide','onStop','onModeChanged'].every(name=>typeof shellCandidate[name]==='function')?shellCandidate:null;
const modeParameters = new URLSearchParams(location.search||'');
const cornerMode = nativeShell?nativeShell.mode==='corner':(modeParameters.get('mode')||modeParameters.get('desktop'))==='corner';
let cornerExpanded = false;
let nativeWindowVisible = null;
let nativeSourceRuntime = null;
const shellSubscriptions = [];
const MAX_RECORDING = 60_000;
const ACTIVE_JOBS = new Set(['queued','generating','validating','applying']);
const JOB_LABELS = {queued:'Queued',generating:'Building',validating:'Checking changes',ready:'Ready to activate',review_required:'Needs your review',applying:'Activating',applied:'Activated',conflict:'Files changed',failed:'Could not finish',cancelled:'Cancelled',rolled_back:'Rolled back',interrupted:'Interrupted',recovery_required:'Needs recovery'};
let workspace = null, providers = [], activeProviderId = '', jobs = [], selectedJobId = null;
let service = { transcriptionReady:false }, csrfToken = '', serviceError = '', checkingService = null;
let serviceCheckGeneration = 0, runtimeInfo = null, runtimeReconnectPromise = null, runtimeReconnectGeneration = 0;
let runtimeNotice = null, runtimeRetry = null, mcpConfiguration = '', integrationsPending = false;
let desktopStatus=null, desktopActions=[], desktopRefreshPromise=null, desktopEpoch=0, desktopToolBusy=false, desktopMutationBusy=false;
let desktopExecutionGeneration=0, activeDesktopRequest=null, desktopStopPromise=null, desktopSnapshot=null, desktopReview=null, desktopInputTarget=null;
let desktopReviewGeneration=0;
let voiceDialogOverride=false;
let voiceSession=null,voiceSessionState={enabled:false,optedIn:false,visible:true,status:'off'},voiceCaptureContext=null,voiceFirstContext=null,activeVoiceSegment=null,voiceOwnershipRequest=null,voiceOwnsCapture=false;
let chatOpen=false,memoryBusy=false;
let currentView = 'today', showCompleted = false, workspacePending = false, jobsPending = false;
let operationBusy = false, featureBusy = false, providerBusy = false, editingProviderId = null, editingTarget = null;
let pendingWorkspaceRequest = null;
let generation = 0, activeRequest = null, recording = null, microphoneOpening = false, turnBusy = false;
let speechGeneration = 0, speechResolve = null, voicePipeline = false, destroyed = false, messages = [], latestAnswer = null, toastTimer = null;
let workflowEditingId = null, workflowEditingRevision = null, workflowDraft = [], featureRenderKey = '', extensionRefreshKey = '', extensionGeneration = 0;
const extensions = new Map();
let extensionProblems=[],toolCatalog=[],toolCatalogReady=false,toolCatalogError='',toolCatalogPending=null,capabilityStatus=null;
const knownFeatureNames=new Set();
const workflowFieldDrafts=new WeakMap();
const runningWorkflows = new Set(), workflowResults = new Map();
const jobDetails = new Map(), jobDetailPending = new Set();
const jobDetailRetryAt = new Map();
const CONVERSATION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const pendingWorkflowRuns=new Map();
syncPendingWorkflowRuns();
const savedConversationId = readStored('conversationId', null);
let conversationId = typeof savedConversationId==='string'&&CONVERSATION_ID.test(savedConversationId)?savedConversationId:null;
let conversations=[], conversationDetail=null, conversationInitialized=false, conversationSelectionGeneration=0;
let conversationListPending=null, conversationDetailRequest=null, conversationLoading=false, conversationError='', conversationRenderKey='';
let localChatTurn=null, newConversationRequest=null, conversationOptionsKey='';
const conversationDrafts=new Map(), conversationUncertain=new Map();
let conversationEarlierTurns=[],conversationEarlierCursor=null,conversationHasEarlier=false,conversationEarlierLoaded=false,conversationEarlierRequest=null;
const preferences = readStored('preferences', {});
$('read-aloud').checked = preferences?.readAloud === true;
$('settings-read-aloud').checked = $('read-aloud').checked;
function readStored(key, fallback) { try { return JSON.parse(localStorage.getItem('companion.workspace.ui.v1.'+key)) ?? fallback; } catch { return fallback; } }
function store(key,value) { try { localStorage.setItem('companion.workspace.ui.v1.'+key,JSON.stringify(value)); return true; } catch { toast('This browser could not save your preferences.'); return false; } }
function clone(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
function element(tag,className,text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=String(text); return node; }
function button(text,className,action) { const node=element('button',className,text); node.type='button'; if(action)node.addEventListener('click',action); return node; }
function timeLabel(value) { const date=new Date(value); return Number.isNaN(date.getTime())?'':date.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
function dateLabel(value) { const date=new Date(value); return Number.isNaN(date.getTime())?'':date.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function captureConversationContext(){return {id:conversationId,selection:conversationSelectionGeneration};}
function currentConversationContext(context){return !!context&&context.selection===conversationSelectionGeneration&&context.id===conversationId;}
function conversationLocallyBusy(){return turnBusy||!!recording||microphoneOpening||voicePipeline;}
function saveConversationDraft(){conversationDrafts.set(conversationId||'new',$('question').value);}
function selectedConversationRunning(){return !!conversationDetail?.activeRequestId||conversationDetail?.turns?.some(turn=>turn.status==='running');}
function renderConversationControls(){
  const busy=conversationLocallyBusy()||conversationLoading||!!runtimeReconnectPromise;
  const listKey=JSON.stringify(conversations.map(item=>[item.id,item.title,item.lastStatus]));
  if(listKey!==conversationOptionsKey){conversationOptionsKey=listKey;const options=[element('option','','New conversation')];options[0].value='';for(const item of conversations){const option=element('option','',item.title||'Conversation');option.value=item.id;options.push(option);}$('conversation-select').replaceChildren(...options);}
  $('conversation-select').value=conversationId||'';$('conversation-select').disabled=busy;$('conversation-new').disabled=busy;$('conversation-refresh').disabled=!!conversationListPending||!!conversationDetailRequest||!!runtimeReconnectPromise;
  const uncertain=conversationId&&conversationUncertain.has(conversationId),running=selectedConversationRunning();
  const last=conversationDetail?.turns?.at(-1);
  $('conversation-status').textContent=conversationLoading?'Opening saved conversation…':uncertain?'Check the saved request before sending again. Use Refresh.':busy&&localChatTurn?'Working on this request. Cancel before switching conversations.':busy?'Finish recording or use Cancel before switching conversations.':running?'A saved request is running. You can open another conversation.':last?.status==='interrupted'?'Interrupted. Completed actions stay saved. Send a new message to continue.':conversationId?'Saved on this PC.':'Saved on this PC after you send.';
  $('conversation-error').textContent=conversationError;
  $('conversation-earlier').hidden=!conversationHasEarlier;$('conversation-load-earlier').disabled=!!conversationEarlierRequest||!!runtimeReconnectPromise;$('conversation-load-earlier').textContent=conversationEarlierRequest?'Loading…':'Load earlier';
  const cannotSend=turnBusy||!!runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy||conversationLoading||running||!!uncertain;
  $('send-question').disabled=cannotSend;
  if(running||uncertain||conversationLoading)$('mic-button').disabled=true;
  else if(!runtimeReconnectPromise&&!desktopToolBusy&&!desktopMutationBusy)$('mic-button').disabled=false;
}
function summarizeConversation(detail){return {id:detail.id,title:detail.title,revision:detail.revision,createdAt:detail.createdAt,updatedAt:detail.updatedAt,activeRequestId:detail.activeRequestId,turnCount:detail.totalTurns??detail.turns.length,lastStatus:detail.turns.at(-1)?.status||null};}
function validateConversation(detail,id=detail?.id){if(!detail||detail.id!==id||!CONVERSATION_ID.test(detail.id)||!Number.isSafeInteger(detail.revision)||!Array.isArray(detail.turns))throw new Error('The saved conversation could not be read.');return detail;}
function clearAcceptedDraft(turn){if(!turn||turn.conversationId!==conversationId)return;if($('question').value.trim()===turn.message){$('question').value='';conversationDrafts.set(conversationId,'');}}
function adoptConversation(detail,context){
  validateConversation(detail);if(!currentConversationContext(context)||detail.id!==conversationId)return false;
  if(conversationDetail&&conversationDetail.id===detail.id&&conversationDetail.revision>detail.revision)return false;
  if(conversationEarlierLoaded&&conversationDetail?.id===detail.id){const retained=new Map([...conversationEarlierTurns,...conversationDetail.turns].map(turn=>[turn.id,turn]));conversationEarlierTurns=[...retained.values()];}
  if(!conversationEarlierLoaded){conversationEarlierCursor=detail.olderThan||detail.turns[0]?.id||null;conversationHasEarlier=detail.hasMore===true;}
  conversationDetail=detail;const summary=summarizeConversation(detail);conversations=[summary,...conversations.filter(item=>item.id!==summary.id)];
  conversationUncertain.delete(detail.id);
  if(localChatTurn?.conversationId===detail.id&&detail.turns.some(turn=>turn.id===localChatTurn.id))clearAcceptedDraft(localChatTurn);
  renderSavedConversation();renderConversationControls();return true;
}
function attachSavedFeatureLink(article,featureJob){const job=featureJob?.job||featureJob;if(!job?.id)return;article.append(button('View feature build ↗','quiet-button',()=>{selectedJobId=job.id;showView('build');}));appendInstalledFeatureReady(article,jobDetails.get(job.id)||jobs.find(item=>item.id===job.id));}
function renderSavedConversation(){
  const merged=new Map([...conversationEarlierTurns,...(conversationDetail?.turns||[])].map(turn=>[turn.id,turn]));const turns=[...merged.values()];if(localChatTurn?.conversationId===conversationId&&!turns.some(turn=>turn.id===localChatTurn.id))turns.push(localChatTurn);
  const key=JSON.stringify([conversationId,conversationDetail?.revision,turns,desktopActions.map(action=>[action.id,action.status]),jobs.map(job=>[job.id,job.status,job.updatedAt]),[...extensions.values()].map(entry=>[entry.featureId,entry.ready])]);if(key===conversationRenderKey)return;conversationRenderKey=key;
  const scroll=$('content-scroll'),previousTop=scroll.scrollTop,nearBottom=scroll.scrollHeight-scroll.scrollTop-(scroll.clientHeight||0)<120;
  messages=[];latestAnswer=null;$('messages').replaceChildren();$('welcome-card').hidden=turns.length>0;$('today-summary').hidden=turns.length>0;$('today-bottom').hidden=turns.length>0;
  const labels={running:'Working…',failed:'Could not finish',cancelled:'Stopped',interrupted:'Interrupted'};
  for(const turn of turns){
    const user=addMessage('user',typeof turn.message==='string'?turn.message:'');user.dataset.turnId=turn.id;
    if(turn.reply&&typeof turn.reply.text==='string'){const provider=providers.find(item=>item.id===(turn.reply.providerId||turn.providerId));const answer=addMessage('assistant',turn.reply.text,'Companion'+(provider?' · '+provider.label:''));renderActionReceipts(answer,turn.reply.actions,{historical:true});attachSavedFeatureLink(answer,turn.reply.featureJob);}
    else if(turn.status!=='completed'){const fallback=turn.status==='interrupted'?'Companion restarted before this request finished. Check completed actions before sending a new request.':turn.status==='cancelled'?'Stopped. Actions already completed remain saved.':turn.status==='failed'?'This request did not finish. Completed actions remain saved.':'This request is saved and running.';user.append(element('p','saved-turn-status status-'+turn.status,labels[turn.status]||turn.status),element('p','saved-turn-detail',turn.error?.message||fallback));renderActionReceipts(user,turn.error?.actions,{historical:true});}
  }
  updateCornerPreview(turns.at(-1)?.reply?.text||turns.at(-1)?.message||'');renderCorner();
  if(!nearBottom&&!localChatTurn)scroll.scrollTop=previousTop;
}
async function refreshConversation({quiet=false}={}){
  const context=captureConversationContext();if(!context.id||destroyed||runtimeReconnectPromise)return null;
  if(conversationDetailRequest?.id===context.id&&conversationDetailRequest.selection===context.selection)return conversationDetailRequest.promise;
  const request={...context,promise:null};conversationDetailRequest=request;renderConversationControls();
  request.promise=(async()=>{try{const detail=validateConversation(await boundedApi('conversations/'+encodeURIComponent(context.id)),context.id);if(adoptConversation(detail,context)){conversationError='';renderConversationControls();}return detail;}catch(error){if(currentConversationContext(context)){conversationError=error.message;renderConversationControls();}if(!quiet)throw error;return null;}finally{if(conversationDetailRequest===request){conversationDetailRequest=null;renderConversationControls();}}})();return request.promise;
}
async function refreshConversations({initialize=false,quiet=false}={}){
  if(conversationListPending)return conversationListPending;
  conversationListPending=(async()=>{try{const value=await boundedApi('conversations');if(!Array.isArray(value.conversations))throw new Error('Saved conversations could not be read.');conversations=value.conversations.filter(item=>item&&CONVERSATION_ID.test(item.id));if(conversationDetail?.id===conversationId&&!conversations.some(item=>item.id===conversationId))conversations.unshift(summarizeConversation(conversationDetail));conversationError='';
    if(initialize&&!conversationInitialized){conversationInitialized=true;const desired=conversations.some(item=>item.id===conversationId)?conversationId:conversations[0]?.id||null;conversationId=desired;if(desired)store('conversationId',desired);}
    renderConversationControls();if(conversationId)await refreshConversation({quiet});else renderSavedConversation();
  }catch(error){conversationError=error.message;renderConversationControls();if(!quiet)throw error;}finally{conversationListPending=null;renderConversationControls();}})();return conversationListPending;
}
async function selectConversation(id,{allowVoiceCommand=false}={}){
  if((conversationLocallyBusy()&&!(allowVoiceCommand&&!turnBusy&&!recording&&!microphoneOpening))||conversationLoading||runtimeReconnectPromise){toast('Use Cancel or finish this request before switching conversations.');renderConversationControls();return false;}
  if(id!==null&&(!CONVERSATION_ID.test(id)||!conversations.some(item=>item.id===id)))return false;
  if(id===conversationId){conversationInitialized=true;store('conversationId',id);if(id)await refreshConversation({quiet:true});else renderConversationControls();return true;}
  saveConversationDraft();disableHandsFree();stopSpeech();conversationInitialized=true;conversationSelectionGeneration++;conversationId=id;conversationDetail=null;conversationEarlierTurns=[];conversationEarlierCursor=null;conversationHasEarlier=false;conversationEarlierLoaded=false;conversationEarlierRequest=null;conversationRenderKey='';conversationError='';newConversationRequest=null;store('conversationId',id);$('question').value=conversationDrafts.get(id||'new')||'';conversationLoading=!!id;renderSavedConversation();renderConversationControls();
  const context=captureConversationContext();try{if(id)await refreshConversation({quiet:true});}finally{if(currentConversationContext(context)){conversationLoading=false;renderConversationControls();}}return true;
}
async function loadEarlierConversation(){
  const context=captureConversationContext(),cursor=conversationEarlierCursor;if(!context.id||!cursor||!conversationHasEarlier||conversationEarlierRequest||runtimeReconnectPromise)return;
  const request={...context,cursor};conversationEarlierRequest=request;conversationError='';renderConversationControls();
  const scroll=$('content-scroll'),previousTop=scroll.scrollTop,previousHeight=scroll.scrollHeight;
  try{const page=validateConversation(await boundedApi('conversations/'+encodeURIComponent(context.id)+'?before='+encodeURIComponent(cursor)),context.id);if(!currentConversationContext(context)||conversationEarlierRequest!==request)return;
    const merged=new Map([...page.turns,...conversationEarlierTurns].map(turn=>[turn.id,turn]));conversationEarlierTurns=[...merged.values()];conversationEarlierLoaded=true;conversationEarlierCursor=page.olderThan||page.turns[0]?.id||null;conversationHasEarlier=page.hasMore===true;renderSavedConversation();scroll.scrollTop=previousTop+Math.max(0,scroll.scrollHeight-previousHeight);
  }catch(error){if(currentConversationContext(context)){conversationError=error.message;}}
  finally{if(conversationEarlierRequest===request){conversationEarlierRequest=null;renderConversationControls();}}
}
async function ensureConversation(context){
  if(context.id){const detail=validateConversation(await boundedApi('conversations/'+encodeURIComponent(context.id)),context.id);return detail;}
  newConversationRequest??={id:crypto.randomUUID()};const request=newConversationRequest;const detail=validateConversation(await boundedApi('conversations',{method:'POST',body:JSON.stringify(request)}),request.id);return detail;
}
$('question').addEventListener('input',saveConversationDraft);
$('conversation-select').addEventListener('change',event=>{void selectConversation(event.target.value||null);});
$('conversation-new').addEventListener('click',()=>{void selectConversation(null);});
$('conversation-refresh').addEventListener('click',()=>{void refreshConversations({initialize:true,quiet:true});});
$('conversation-load-earlier').addEventListener('click',()=>{void loadEarlierConversation();});
function emptyState(title,description) { const node=element('div','empty-state'); node.append(element('span','empty-glyph','✧'),element('h2','',title),element('p','',description)); return node; }
function showDialog(id) { ensureCornerExpanded();voiceDialogOverride=false;voiceSession?.pause('dialog');disableHandsFree(); if(recording||microphoneOpening)stopRecording(false); if(!$(id).open)$(id).showModal(); }
function renderCorner(){
  document.body.classList.toggle('corner-mode',cornerMode);document.body.classList.toggle('native-shell',!!nativeShell);
  document.body.classList.toggle('corner-expanded',cornerMode&&cornerExpanded);document.body.classList.toggle('corner-collapsed',cornerMode&&!cornerExpanded);
  $('native-corner-header').hidden=!cornerMode;$('corner-empty').hidden=!cornerMode||messages.length>0;
  $('corner-expand').textContent=cornerExpanded?'⌄':'⌃';$('corner-expand').setAttribute('aria-expanded',String(cornerExpanded));
  $('corner-expand').setAttribute('aria-label',cornerExpanded?'Collapse corner':'Expand corner');$('corner-expand').title=cornerExpanded?'Collapse corner':'Expand corner';
  $('corner-hide').disabled=!nativeShell;
  $('restart-desktop').hidden=typeof nativeShell?.restart!=='function';
}
function setCornerExpanded(value){if(!cornerMode)return;const previous=cornerExpanded;cornerExpanded=!!value;renderCorner();if(nativeShell)try{nativeShell.setExpanded(cornerExpanded);}catch{cornerExpanded=previous;renderCorner();toast('The corner could not be resized.');}}
function ensureCornerExpanded(){if(cornerMode&&!cornerExpanded)setCornerExpanded(true);}
function updateCornerPreview(text){if(!cornerMode)return;$('corner-recent').textContent=String(text||'').slice(0,360);$('corner-recent').hidden=!text;$('corner-empty').hidden=messages.length>0;}
function initNativeShell(){
  renderCorner();
  $('corner-expand').addEventListener('click',()=>setCornerExpanded(!cornerExpanded));
  $('corner-recent').addEventListener('click',()=>{ensureCornerExpanded();showView('today');});
  $('corner-open-workspace').addEventListener('click',()=>{if(nativeShell){try{nativeShell.openWorkspace();}catch{toast('The workspace could not be opened.');}}else location.assign('assistant.html?mode=workspace');});
  $('corner-hide').addEventListener('click',()=>{if(!nativeShell)return;setVoiceVisible(false);cancelTurn(false,{preserveVoice:true});try{nativeShell.hide();}catch{toast('The corner could not be hidden.');}});
  $('corner-desktop').addEventListener('click',()=>{ensureCornerExpanded();showView('desktop');});
  $('restart-desktop').addEventListener('click',restartNativeDesktop);
  if(!nativeShell)return;
  try{
    shellSubscriptions.push(nativeShell.onStop(event=>{if(event?.reason==='hidden'){setVoiceVisible(false);cancelTurn(false,{preserveVoice:true});}else stopAllActivity(false,{global:event?.reason==='shortcut'});}));
    shellSubscriptions.push(nativeShell.onModeChanged(state=>{
      if(!state||state.mode!==nativeShell.mode)return;
      if(typeof state.expanded==='boolean')cornerExpanded=state.expanded;
      if(typeof state.sourceRuntime==='boolean'){nativeSourceRuntime=state.sourceRuntime;featureRenderKey='';renderJobs();}
      if(state.visible===false){setVoiceVisible(false);cancelTurn(false,{preserveVoice:true});}if(typeof state.visible==='boolean'){nativeWindowVisible=state.visible;if(state.visible)void setVoiceVisible(true);}
      if(state.shortcuts){$('native-shortcut-hint').hidden=false;$('native-shortcut-hint').textContent=[state.shortcuts.toggle?'Ctrl + Alt + Space shows corner':'Corner shortcut unavailable',state.shortcuts.stop?'Ctrl + Alt + Esc stops':'Global stop unavailable'].join(' · ');}
      renderCorner();
    }));
  }catch{toast('Native window controls are unavailable.');}
}
function restartNativeDesktop(){if(typeof nativeShell?.restart!=='function'){toast('Close and relaunch the Companion desktop app to load its updated controls.');return;}stopAllActivity();try{nativeShell.restart();}catch{toast('The desktop app could not be relaunched.');}}
function desktopUpdateNotice(){return nativeSourceRuntime===true?'Desktop source changed. Restart the desktop app to load its updated controls; a server-worker restart does not reload desktop code.':nativeSourceRuntime===false?'Desktop source changed. Rebuild the desktop app to load it; relaunching this copied package does not load repository edits.':'Desktop source changed. Relaunch from the updated source, or rebuild a copied desktop package, to load it.';}
for(const close of document.querySelectorAll('.close-dialog'))close.addEventListener('click',()=>close.closest('dialog').close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>{void Promise.resolve().then(()=>{if(!document.querySelector('dialog[open]')){voiceDialogOverride=false;maybeResume();}});});
function setChatOpen(value){chatOpen=!!value;document.body.classList.toggle('chat-open',chatOpen);$('chat-toggle').setAttribute('aria-expanded',String(chatOpen));$('chat-toggle').setAttribute('aria-pressed',String(chatOpen));showView('today');if(chatOpen)void refreshConversations({initialize:true,quiet:true});}
$('chat-toggle').addEventListener('click',()=>setChatOpen(!chatOpen));
$('voice-home').addEventListener('click',()=>setChatOpen(false));
function showView(view) {
  if(!['today','tasks','notes','workflows','build','settings','desktop'].includes(view)&&!extensions.has(view))return;
  currentView=view;document.body.classList.toggle('tools-open',view!=='today');$('voice-home').setAttribute('aria-pressed',String(view==='today'&&!chatOpen));
  document.querySelectorAll('.view-panel').forEach(panel=>panel.hidden=panel.id!==view+'-view');
  document.querySelectorAll('[data-view]').forEach(item=>{item.classList.toggle('active',item.dataset.view===view);item.setAttribute('aria-current',item.dataset.view===view?'page':'false');});
  $('view-title').textContent=extensions.get(view)?.title||({today:'Chat',tasks:'Tasks',notes:'Notes',workflows:'Workflows',build:'Build a feature',settings:'Settings',desktop:'Computer'})[view];
  $('content-scroll').scrollTop=0;
  if(view==='settings'){renderMemory();renderProviders();renderRuntime();if(!mcpConfiguration)void loadIntegrations();void refreshDesktop().catch(error=>{$('desktop-settings-status').textContent=error.message;});}
  if(view==='build'){renderJobs();refreshJobsSafely();}
  if(view==='workflows')void refreshToolCatalog({quiet:true});
  if(view==='desktop')void refreshDesktop().catch(error=>{$('desktop-error').textContent=error.message;});
  if(view!=='settings')$('provider-key').value='';
}
for(const nav of document.querySelectorAll('[data-view]'))nav.addEventListener('click',()=>showView(nav.dataset.view));
for(const suggestion of document.querySelectorAll('[data-prompt]'))suggestion.addEventListener('click',()=>{$('question').value=suggestion.dataset.prompt;$('question').focus();});
$('welcome-build').addEventListener('click',()=>{showView('build');$('feature-prompt').focus();});
async function api(path,options={}) {
  const {signal,raw,id,csrfTokenOverride,...rest}=options;const headers=new Headers(rest.headers||{});
  if(rest.method==='POST'){headers.set('X-CSRF-Token',csrfTokenOverride??csrfToken);if(!raw)headers.set('Content-Type','application/json');if(id)headers.set('X-Request-Id',id);}
  let response;
  try{response=await fetch('/api/assistant/'+path,{...rest,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal});}
  catch(error){if(error.name==='AbortError')throw error;throw new Error('Companion’s service could not be reached. Double-click Start Companion.cmd, then check again.');}
  let data;try{data=await response.json();}catch{throw new Error('The service returned an unreadable response. Check the connection and try again.');}
  if(!response.ok){const error=new Error(data?.error?.message||'This request could not be completed.');error.code=data?.error?.code;error.status=response.status;error.workspace=data?.workspace;error.actions=data?.actions;error.conversation=data?.conversation;error.conversationId=data?.conversationId;error.hostActions=data?.hostActions;error.capability=data?.capability;throw error;}
  return data;
}
async function boundedApi(path,options={},milliseconds=15000){const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),milliseconds);try{return await api(path,{...options,signal:controller.signal});}catch(error){if(error.name==='AbortError')throw new Error('This request took too long. Check the connection and try again.');throw error;}finally{clearTimeout(timeout);}}
function activeProvider(){return providers.find(provider=>provider.id===activeProviderId);}
function applyProviders(value){if(!Array.isArray(value?.providers))throw new Error('AI connections could not be read.');providers=value.providers;activeProviderId=value.activeProviderId||value.defaultProviderId||'';renderProviders();renderService();}
async function checkService({reconnecting=false,force=false,deadline=Infinity}={}){
  if(destroyed||(runtimeReconnectPromise&&!reconnecting))return;
  if(force){serviceCheckGeneration+=1;checkingService=null;}
  if(checkingService)return checkingService;
  const check=++serviceCheckGeneration;
  const timeout=()=>Math.max(1,Math.min(15000,deadline-Date.now()));
  $('connection-refresh').disabled=true;$('retry-service').disabled=true;
  checkingService=(async()=>{
    try{
      const session=await boundedApi('session',{},timeout());if(typeof session.csrfToken!=='string')throw new Error('Companion’s session could not be opened.');if(check!==serviceCheckGeneration)return;csrfToken=session.csrfToken;
      const results=await Promise.allSettled([boundedApi('providers',{},timeout()),boundedApi('status',{},timeout()),boundedApi('workspace',{},timeout()),boundedApi('features',{},timeout()),boundedApi('runtime',{},timeout()),boundedApi('desktop',{},timeout())]);
      if(check!==serviceCheckGeneration)return;
      if(results[0].status==='fulfilled'){applyProviders(results[0].value);serviceError='';}else{providers=[];activeProviderId='';serviceError=results[0].reason.message;}
      if(results[1].status==='fulfilled')service=results[1].value;else service={transcriptionReady:false,transcriptionUnavailableReason:results[1].reason.message};
      if(results[2].status==='fulfilled')applyWorkspace(results[2].value);else serviceError||=results[2].reason.message;
      if(results[3].status==='fulfilled'&&Array.isArray(results[3].value.jobs)){jobs=results[3].value.jobs;if(!selectedJobId&&jobs.length)selectedJobId=jobs[0].id;renderJobs();}else if(results[3].status==='rejected')serviceError||=results[3].reason.message;
      if(results[4].status==='fulfilled')applyRuntime(results[4].value);
      if(results[5].status==='fulfilled')applyDesktopStatus(results[5].value);
      void refreshConversations({initialize:true,quiet:true});void refreshToolCatalog({quiet:true});
      return {workspaceReady:results[2].status==='fulfilled',jobsReady:results[3].status==='fulfilled',runtimeReady:results[4].status==='fulfilled'};
    }catch(error){if(check===serviceCheckGeneration){serviceError=error.message;providers=[];activeProviderId='';service={transcriptionReady:false};}return {workspaceReady:false,jobsReady:false,runtimeReady:false};}
    finally{if(check===serviceCheckGeneration){renderProviders();renderService();renderRuntime();$('connection-refresh').disabled=!!runtimeReconnectPromise;$('retry-service').disabled=!!runtimeReconnectPromise;checkingService=null;}}
  })();return checkingService;
}
function renderService(){
  const provider=activeProvider();const ready=provider?.ready===true;
  $('connection-dot').className='status-dot '+(ready?'ready':'offline');
  $('connection-label').textContent=provider?(ready?provider.label+' is ready':provider.label+' needs attention'):'No AI connected';
  const supported=!!(navigator.mediaDevices?.getUserMedia&&window.MediaRecorder);
  $('hands-free').disabled=!!runtimeReconnectPromise||!service.transcriptionReady||!supported;
  if($('hands-free').disabled&&$('hands-free').checked)disableHandsFree();
  $('transcription-status').textContent=service.transcriptionReady?'Local transcription is ready. Tap the microphone to start.':service.transcriptionUnavailableReason||'Local transcription is not ready yet. You can type messages and use the workspace.';
  const details=$('service-status');details.replaceChildren();details.append(element('strong','',ready?'Your AI is ready':'Choose an AI connection'));
  details.append(element('p','',ready?`${provider.label}${provider.model?' · '+provider.model:''}`:serviceError||provider?.unavailableReason||'Open Settings to use your existing Codex sign-in, or connect GPT, Claude, a compatible API, or a local model.'));
  details.append(element('strong','',service.transcriptionReady?'Voice input is ready':'Voice input is not ready'),element('p','',$('transcription-status').textContent));
  details.append(element('small','','Your chosen provider handles your messages. API connections may incur provider charges. Tasks, notes, workflows, and build history are saved on this PC.'));
  if(!turnBusy&&!voicePipeline&&!recording&&!microphoneOpening)setState('idle');updateVoiceHelp();void restoreVoiceIfAllowed();
  renderRuntime();
}
function applyRuntime(value){
  if(!value||typeof value.managed!=='boolean'||!Number.isInteger(value.workerPid)||value.workerPid<1)throw new Error('Companion’s runtime status could not be read.');
  const previous=runtimeInfo;runtimeInfo={managed:value.managed,restarting:value.restarting===true,workerPid:value.workerPid,hostPid:value.hostPid};
  if(previous&&previous.workerPid!==runtimeInfo.workerPid&&!runtimeReconnectPromise){runtimeNotice={phase:'ready',message:'Companion reconnected to its new server.'};void loadExtensions();}
  renderRuntime();
}
function renderRuntime(){
  const busy=!!runtimeReconnectPromise;
  $('runtime-summary').textContent=busy?'Companion is restarting and reconnecting. Your drafts stay here.':runtimeInfo===null?'Service information is unavailable. Check the connection before restarting.':runtimeInfo.managed?'Companion is managed by its launcher. Server updates can restart and reconnect here.':'This is a development server. Server updates need it to be stopped, then opened with Start Companion.cmd.';
  $('restart-runtime').disabled=busy||!runtimeInfo?.managed;
  $('connection-refresh').disabled=busy||!!checkingService;
  $('retry-service').disabled=busy||!!checkingService;
  $('desktop-refresh').disabled=busy||!!desktopRefreshPromise;
  $('desktop-settings-refresh').disabled=busy||!!desktopRefreshPromise;
  $('runtime-banner').hidden=!runtimeNotice;
  $('runtime-banner').className='runtime-banner'+(runtimeNotice?` runtime-${runtimeNotice.phase}`:'');
  $('runtime-message').textContent=runtimeNotice?.message||'';
  $('runtime-retry').hidden=!runtimeRetry||busy||!['failed','manual'].includes(runtimeNotice?.phase);
  $('runtime-retry').disabled=busy;
  $('mic-button').disabled=busy||desktopToolBusy||desktopMutationBusy;$('send-question').disabled=busy||turnBusy||desktopToolBusy||desktopMutationBusy;
  $('desktop-review-mic').disabled=busy||desktopToolBusy||desktopMutationBusy||!service.transcriptionReady;
  $('provider-select').disabled=busy||providerBusy||!providers.length;
  $('provider-save').disabled=busy||providerBusy;
  $('build-submit').disabled=busy||featureBusy;
  renderConversationControls();renderVoiceControls();
  if(busy||desktopToolBusy||desktopMutationBusy)$('hands-free').disabled=true;if(busy){$('connection-label').textContent='Reconnecting to Companion…';$('connection-dot').className='status-dot offline';}
}
async function reconnectAfterRestart(metadata,{jobId=null,action='restart'}={}){
  if(runtimeReconnectPromise)return runtimeReconnectPromise;
  ensureCornerExpanded();
  const baselinePid=metadata?.workerPid||runtimeInfo?.workerPid;
  if(!Number.isInteger(baselinePid)||baselinePid<1)throw new Error('The previous server could not be identified. Check the connection before restarting.');
  runtimeRetry={baselinePid,jobId,action};
  if(metadata.requiresManualRestart||metadata.managed===false){runtimeNotice={phase:'manual',message:'Source changes are saved. Stop this development server, then double-click Start Companion.cmd. Choose Check again after it opens.'};renderRuntime();return {confirmed:false,manual:true};}
  const token=++runtimeReconnectGeneration;
  runtimeNotice={phase:'waiting',message:'Restarting Companion. Reconnecting your workspace…'};
  runtimeReconnectPromise=Promise.resolve().then(async()=>{
    cancelTurn(false);serviceCheckGeneration+=1;checkingService=null;
    const deadline=Date.now()+60000;let delay=300,lastError='';
    while(Date.now()<deadline&&token===runtimeReconnectGeneration&&!destroyed){
      try{
        const budget=()=>Math.max(1,Math.min(4000,deadline-Date.now()));
        const session=await boundedApi('session',{},budget());
        if(typeof session.csrfToken!=='string')throw new Error('The new session is not ready.');csrfToken=session.csrfToken;
        const current=await boundedApi('runtime',{},budget());applyRuntime(current);
        if(current.workerPid!==baselinePid&&!current.restarting){
          runtimeNotice={phase:'waiting',message:'The new server is running. Restoring your workspace…'};renderRuntime();
          const refreshed=await checkService({reconnecting:true,force:true,deadline});
          if(!refreshed?.workspaceReady||!refreshed.jobsReady||!refreshed.runtimeReady)throw new Error('The new server is running, but the workspace is not ready yet.');
          let job=null;
          if(jobId){job=await boundedApi(`features/${encodeURIComponent(jobId)}`,{},budget());job=job.job||job;if(job.id!==jobId)throw new Error('The build status could not be matched.');rememberJob(job);jobs=jobs.map(item=>item.id===job.id?job:item);featureRenderKey='';renderJobs();}
          if(token!==runtimeReconnectGeneration||destroyed)return {confirmed:false};
          if(job?.status==='rolled_back'&&action==='apply'){runtimeNotice={phase:'rolled-back',message:'The update could not start. Companion restored the previous version and reconnected.'};toast('The update was rolled back. Your previous version is running.');}
          else if(job&&['failed','conflict','interrupted','recovery_required'].includes(job.status)){runtimeNotice={phase:'failed',message:job.error||'Companion reconnected, but this build needs attention. Check its status below.'};}
          else{const message=action==='rollback'?'Changes rolled back. Companion restarted and reconnected.':action==='apply'&&job?.status==='applied'?'Feature activated. Companion restarted and reconnected.':'Companion restarted and reconnected.';runtimeNotice={phase:'ready',message};toast(message);}
          runtimeRetry=null;void loadExtensions();return {confirmed:true,job};
        }
      }catch(error){lastError=error.message;}
      const remaining=deadline-Date.now();if(remaining<=0)break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(delay,remaining)));delay=Math.min(4000,Math.ceil(delay*1.6));
    }
    if(token===runtimeReconnectGeneration&&!destroyed){runtimeNotice={phase:'failed',message:'Companion has not confirmed a new server within 60 seconds. Double-click Start Companion.cmd, then choose Check again.'};if(lastError)$('build-error').textContent=lastError;}
    return {confirmed:false};
  }).finally(()=>{if(token===runtimeReconnectGeneration){runtimeReconnectPromise=null;renderProviders();renderService();renderRuntime();featureRenderKey='';renderJobs();}});
  renderRuntime();return runtimeReconnectPromise;
}
$('runtime-retry').addEventListener('click',()=>{if(!runtimeRetry||runtimeReconnectPromise)return;const retry={...runtimeRetry};void reconnectAfterRestart({managed:true,restartRequested:true,workerPid:retry.baselinePid},retry).catch(error=>toast(error.message));});
$('restart-runtime').addEventListener('click',async()=>{if(runtimeReconnectPromise||!runtimeInfo?.managed)return;$('restart-runtime').disabled=true;try{const value=await boundedApi('runtime/restart',{method:'POST',body:JSON.stringify({})},15000);await reconnectAfterRestart(value);}catch(error){toast(error.message);}finally{renderRuntime();}});
function humanLabel(value){return String(value||'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/^./,letter=>letter.toUpperCase());}
function toolLabel(name){const meta=toolCatalog.find(item=>item.name===name);return meta?.title||humanLabel(name);}
function applyToolCatalog(value){
  if(!Array.isArray(value?.tools)||value.tools.length>512)throw new Error('Available actions could not be read.');
  const counts=new Map();for(const item of value.tools)if(item?.name)counts.set(item.name,(counts.get(item.name)||0)+1);
  toolCatalog=value.tools.filter(item=>item&&/^[a-z][a-z0-9_]{0,99}$/.test(item.name)&&counts.get(item.name)===1&&item.parameters&&typeof item.parameters==='object').map(item=>clone(item));
  capabilityStatus=value.capabilityStatus||null;toolCatalogReady=true;toolCatalogError='';renderToolsCatalog();renderWorkflows();if($('workflow-dialog').open)renderWorkflowSteps();
}
async function refreshToolCatalog({quiet=false}={}){
  if(toolCatalogPending)return toolCatalogPending;
  toolCatalogPending=(async()=>{try{const value=await boundedApi('integrations');applyToolCatalog(value);return value;}catch(error){toolCatalogError=error.message;renderToolsCatalog();if($('workflow-dialog').open)renderWorkflowSteps();if(!quiet)throw error;return null;}finally{toolCatalogPending=null;}})();return toolCatalogPending;
}
function normalizedFeatureName(value){return String(value||'').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');}
function featureNames(entry){return [...new Set([entry.title,...(entry.aliases||[])].map(normalizedFeatureName).filter(Boolean))];}
function showToolsList(message=''){ensureCornerExpanded();$('tools-menu').open=true;$('tools-message').textContent=message;$('tools-message').hidden=!message;renderToolsCatalog();}
function openInstalledFeature(id){const entry=extensions.get('extension-'+id);if(!entry?.ready){showToolsList(entry?.error?entry.title+' could not open. Review its status below.':'That tool is not available in this interface.');return false;}showView('extension-'+id);$('tools-menu').open=false;return true;}
function openFeatureByName(name,{unknown=true}={}){
  const normalized=normalizedFeatureName(name),matches=[...extensions.values()].filter(entry=>featureNames(entry).includes(normalized));
  if(matches.length>1){showToolsList('More than one tool matches “'+name+'”. Choose the tool below.');return true;}
  if(matches.length===1){openInstalledFeature(matches[0].featureId);return true;}
  const capability=toolCatalog.find(item=>item.kind==='capability'&&[item.title,item.name].some(value=>normalizedFeatureName(value)===normalized));
  if(capability){showToolsList((capability.title||humanLabel(capability.name))+' is available by voice. Tell Companion what you want it to do.');return true;}
  if(unknown||knownFeatureNames.has(normalized)){showToolsList('That tool is not available. Choose an installed tool below.');return true;}return false;
}
function renderToolsCatalog(){
  const list=$('extension-nav');list.replaceChildren();list.hidden=false;
  for(const entry of extensions.values()){
    const row=element('div','installed-tool'),open=button(entry.title,'nav-item',()=>openInstalledFeature(entry.featureId));open.setAttribute('aria-label','Open '+entry.title);open.disabled=!entry.ready;row.append(open,element('small','',entry.ready?'Say “open '+entry.title+'”':entry.error?'Could not open':'Loading…'));if(entry.error)row.append(element('p','tool-unavailable',entry.error));list.append(row);
  }
  for(const problem of extensionProblems)list.append(element('p','tool-unavailable',problem));
  const panels=new Set([...extensions.values()].map(entry=>entry.capabilityId).filter(Boolean));
  for(const meta of toolCatalog.filter(item=>item.kind==='capability'&&!panels.has(item.capabilityId)&&!extensions.has('extension-'+item.featureId))){const row=element('div','installed-tool capability-tool');row.append(element('strong','',meta.title||humanLabel(meta.name)),element('small','','Available by voice'));if(meta.description)row.append(element('p','',meta.description));list.append(row);}
  if(capabilityStatus?.ready===false)list.append(element('p','tool-unavailable',capabilityStatus.message||'Installed actions are unavailable. Your saved work is still available.'));
  else if(toolCatalogError)list.append(element('p','tool-unavailable',toolCatalogError));
  if(!extensions.size&&!toolCatalog.some(item=>item.kind==='capability')&&!extensionProblems.length&&capabilityStatus?.ready!==false&&!toolCatalogError)list.append(element('p','tools-empty','No installed tools yet. Ask Companion to build one.'));
}
async function loadIntegrations(){
  if(integrationsPending||destroyed||runtimeReconnectPromise)return;integrationsPending=true;$('mcp-load').disabled=true;$('mcp-error').textContent='';
  mcpConfiguration='';$('mcp-copy').disabled=true;$('mcp-config-panel').hidden=true;
  try{
    if(!csrfToken)await checkService();
    const value=await boundedApi('integrations');applyToolCatalog(value);
    if(typeof value.mcp?.command!=='string'||!value.mcp.command||!Array.isArray(value.mcp.args)||value.mcp.args.some(arg=>typeof arg!=='string'))throw new Error('The AI tool configuration could not be read.');
    const configuration={command:value.mcp.command,args:value.mcp.args};
    if(value.mcp.env!==undefined){
      const env=value.mcp.env;
      if(!env||typeof env!=='object'||Array.isArray(env)||Object.keys(env).some(key=>key!=='COMPANION_URL')||typeof env.COMPANION_URL!=='string')throw new Error('The AI tool connection address could not be read.');
      let address;try{address=new URL(env.COMPANION_URL);}catch{throw new Error('The AI tool connection address is invalid.');}
      if(address.protocol!=='http:'||!['127.0.0.1','localhost'].includes(address.hostname)||address.username||address.password||address.search||address.hash||address.pathname!=='/')throw new Error('AI tools must connect to Companion on this computer.');
      configuration.env={COMPANION_URL:address.origin};
    }
    mcpConfiguration=JSON.stringify({mcpServers:{companion:configuration}},null,2);
    $('mcp-config').value=mcpConfiguration;$('mcp-config-panel').hidden=false;$('mcp-copy').disabled=false;
    $('mcp-status').textContent=`${Array.isArray(value.tools)?value.tools.length:0} actions are available through Companion’s tools. Paste this configuration into your AI client’s MCP settings, then reconnect that client.`;
  }catch(error){$('mcp-error').textContent=error.message;}
  finally{integrationsPending=false;$('mcp-load').disabled=false;}
}
$('mcp-load').addEventListener('click',()=>void loadIntegrations());
$('mcp-copy').addEventListener('click',async()=>{if(!mcpConfiguration)return;try{if(!navigator.clipboard?.writeText)throw new Error('Select and copy the configuration below.');await navigator.clipboard.writeText(mcpConfiguration);toast('Configuration copied. Paste it into your AI client’s MCP settings.');}catch(error){$('mcp-config').focus();$('mcp-config').select();$('mcp-error').textContent=error.message||'Select and copy the configuration below.';}});
const DESKTOP_LABELS={pending:'Needs review',executing:'Sending input',completed:'Completed',failed:'Could not finish',cancelled:'Cancelled',expired:'Preview expired'};
function desktopPending(action){return action?.status==='pending'&&(!action.expiresAt||Date.parse(action.expiresAt)>Date.now());}
function desktopSignature(action){return JSON.stringify({id:action.id,target:action.target,preview:action.preview,expiresAt:action.expiresAt});}
function rememberDesktopAction(action){
  if(!action||typeof action.id!=='string'||!Object.hasOwn(DESKTOP_LABELS,action.status))return;
  const old=desktopActions.find(item=>item.id===action.id);
  if(old?.status==='completed'&&action.status!=='completed')return;
  if(old&&['failed','cancelled','expired'].includes(old.status)&&['pending','executing'].includes(action.status))return;
  desktopActions=[clone(action),...desktopActions.filter(item=>item.id!==action.id)].slice(0,80);desktopEpoch+=1;
  if(desktopPending(action)&&!old)ensureCornerExpanded();renderDesktopActions();renderDesktopReview();
}
function ingestDesktopResult(result){
  if(result?.desktopAction)rememberDesktopAction(result.desktopAction);
  if(result?.desktopReceipt){const receipt=result.desktopReceipt;if(receipt.status==='completed'){
    const row={id:receipt.id,status:'completed',summary:receipt.summary,target:receipt.target,createdAt:receipt.completedAt,receipt};rememberDesktopAction(row);updateCornerPreview(receipt.summary);
  }}
}
function applyDesktopStatus(value){
  if(!value||typeof value.available!=='boolean')throw new Error('Computer control availability could not be read.');desktopStatus=clone(value);renderDesktopStatus();
  if(value.pendingCount>0&&!desktopRefreshPromise&&!runtimeReconnectPromise)void refreshDesktop().catch(()=>{});
}
function renderDesktopStatus(){
  const ready=desktopStatus?.available===true,busy=desktopToolBusy||desktopMutationBusy||!!runtimeReconnectPromise;
  const detail=desktopStatus?ready?'Computer controls are available on this PC. Input actions need a prepared preview.':desktopStatus.reason||'Computer controls are unavailable in this runtime.':'Checking computer control availability…';
  $('desktop-status').textContent=detail;$('desktop-settings-status').textContent=detail;$('desktop-status-dot').className='status-dot '+(ready?'ready':'offline');
  $('desktop-app-search').disabled=busy||!ready||desktopStatus?.capabilities?.installedApps===false;
  $('desktop-window-list').disabled=busy||!ready||desktopStatus?.capabilities?.windows===false;
  $('desktop-refresh').disabled=!!desktopRefreshPromise||!!runtimeReconnectPromise;
  $('desktop-settings-refresh').disabled=!!desktopRefreshPromise||!!runtimeReconnectPromise;
  renderDesktopActions();
}
async function refreshDesktop(){
  if(desktopRefreshPromise||destroyed||runtimeReconnectPromise)return desktopRefreshPromise;
  const epoch=desktopEpoch;
  desktopRefreshPromise=Promise.resolve().then(async()=>{
    if(!csrfToken)await checkService();
    const [status,listing]=await Promise.all([boundedApi('desktop'),boundedApi('desktop/actions')]);
    applyDesktopStatus(status);if(!Array.isArray(listing.actions))throw new Error('Computer action history could not be read.');
    if(epoch===desktopEpoch)desktopActions=desktopActions.filter(action=>['completed','failed','cancelled','expired'].includes(action.status));
    for(const action of [...listing.actions].reverse())rememberDesktopAction(action);
    renderDesktopActions();renderDesktopReview();
  }).finally(()=>{desktopRefreshPromise=null;renderDesktopStatus();});
  renderDesktopStatus();return desktopRefreshPromise;
}
function renderDesktopActions(){
  const list=$('desktop-action-list');list.replaceChildren();
  if(!desktopActions.length)list.append(element('p','desktop-hint','Actions and their real outcomes will appear here.'));
  for(const action of desktopActions.slice(0,15)){
    const row=element('article','desktop-action-row'),main=element('div');main.append(element('strong','',action.summary||'Computer action'));
    const status=action.status==='pending'&&!desktopPending(action)?'expired':action.status;
    main.append(element('span','desktop-action-state '+status,DESKTOP_LABELS[status]||status));if(action.error)main.append(element('p','inline-error',typeof action.error==='string'?action.error:action.error.message));row.append(main);
    if(desktopPending(action))row.append(button('Review ↗','secondary-button',()=>void openDesktopReview(action.id)));
    list.append(row);
  }
  const pending=desktopActions.filter(desktopPending);$('desktop-pending-banner').hidden=!pending.length;$('desktop-nav-count').hidden=!pending.length;$('desktop-nav-count').textContent=pending.length;
  document.body.classList.toggle('has-desktop-pending',pending.length>0);
  $('desktop-pending-text').textContent=`${pending.length} computer action${pending.length===1?' needs':'s need'} your review.`;
}
async function runDesktopTool(tool,args={}){
  if(desktopToolBusy||desktopMutationBusy||runtimeReconnectPromise)throw new Error('Let the current computer action finish, or stop it first.');
  if(!desktopStatus?.available)throw new Error(desktopStatus?.reason||'Computer controls are not ready. Check availability first.');
  const turn=++desktopExecutionGeneration,controller=new AbortController();activeDesktopRequest={controller,turn};desktopToolBusy=true;ensureCornerExpanded();disableHandsFree();if(recording||microphoneOpening)stopRecording(false);stopSpeech();setState('desktop','A real computer request is running.');renderDesktopStatus();renderRuntime();
  const timeout=setTimeout(()=>controller.abort(),45000);
  try{const value=await api('tools/run',{method:'POST',body:JSON.stringify({tool,arguments:args,operationId:crypto.randomUUID()}),signal:controller.signal});if(turn!==desktopExecutionGeneration)throw new DOMException('Stopped.','AbortError');if(value.workspace)applyWorkspace(value.workspace);if(value.result?.error)throw new Error(value.result.error);ingestDesktopResult(value.result);return value.result;}
  catch(error){if(error.name==='AbortError')throw new Error('The computer request was stopped. Check its actual result before trying again.');throw error;}
  finally{clearTimeout(timeout);if(activeDesktopRequest?.turn===turn)activeDesktopRequest=null;if(turn===desktopExecutionGeneration){desktopToolBusy=false;setState('idle');renderDesktopStatus();renderRuntime();maybeResume();}}
}
$('desktop-app-form').addEventListener('submit',async event=>{event.preventDefault();$('desktop-error').textContent='';try{const result=await runDesktopTool('desktop_list_apps',{query:$('desktop-app-query').value.trim()});const list=$('desktop-app-results');list.replaceChildren();if(!Array.isArray(result.apps))throw new Error('Installed apps could not be read.');if(!result.apps.length)list.append(element('p','desktop-hint','No matching installed apps were found.'));for(const app of result.apps){const row=element('div','desktop-app-row');row.append(element('span','',app.name),button('Open ↗','quiet-button',async()=>{try{const opened=await runDesktopTool('desktop_open_app',{appId:app.id});if(opened.desktopReceipt?.status==='completed')toast(opened.desktopReceipt.summary);}catch(error){$('desktop-error').textContent=error.message;}}));list.append(row);}if(result.truncated)list.append(element('p','form-hint','More apps match. Narrow your search.'));}catch(error){$('desktop-error').textContent=error.message;}});
$('desktop-window-list').addEventListener('click',async()=>{$('desktop-error').textContent='';try{const result=await runDesktopTool('desktop_list_windows',{});const list=$('desktop-window-results');list.replaceChildren();if(!Array.isArray(result.windows))throw new Error('Open windows could not be read.');if(!result.windows.length)list.append(element('p','desktop-hint','No available windows were found.'));for(const window of result.windows){const row=element('div','desktop-window-row'),info=element('div');info.append(element('strong','',window.title||'Untitled window'),element('span','',window.appName));const actions=element('div','desktop-window-actions');actions.append(button('Focus','quiet-button',async()=>{try{const result=await runDesktopTool('desktop_focus_window',{windowId:window.id});if(result.desktopReceipt?.status==='completed')toast(result.desktopReceipt.summary);}catch(error){$('desktop-error').textContent=error.message;}}),button('Read window','quiet-button',()=>void readDesktopWindow(window.id)));row.append(info,actions);list.append(row);}if(result.truncated)list.append(element('p','form-hint','The window list is truncated.'));}catch(error){$('desktop-error').textContent=error.message;}});
async function readDesktopWindow(windowId){$('desktop-error').textContent='';try{const result=await runDesktopTool('desktop_read_window',{windowId});const snapshot=result.snapshot;if(!snapshot?.id||!Array.isArray(snapshot.elements))throw new Error('The selected window could not be read.');desktopSnapshot=clone(snapshot);renderDesktopSnapshot();}catch(error){$('desktop-error').textContent=error.message;}}
function renderDesktopSnapshot(){
  const snapshot=desktopSnapshot;$('desktop-snapshot-panel').hidden=!snapshot;if(!snapshot)return;
  $('desktop-snapshot-title').textContent=snapshot.window?.title||snapshot.window?.appName||'Selected window';$('desktop-snapshot-expiry').textContent=snapshot.truncated?'Some controls were omitted':'';
  $('desktop-snapshot-note').textContent=snapshot.protectedInput?'This is Companion. Use its controls directly; computer input cannot approve or operate Companion’s own controls.':'This is the text and controls read from that window. Preparing input creates a separate preview for your review.';
  const list=$('desktop-snapshot-elements');list.replaceChildren();
  if(!snapshot.elements.length)list.append(element('p','desktop-hint','No readable controls were returned.'));
  for(const control of snapshot.elements.slice(0,80)){
    const row=element('article','desktop-control'),info=element('div');info.append(element('strong','',control.name||control.controlType||'Unnamed control'),element('span','',control.controlType));if(control.value!==undefined)info.append(element('pre','',String(control.value).slice(0,4000)));row.append(info);
    const actions=element('div','desktop-control-actions');
    if(!snapshot.protectedInput&&control.enabled!==false&&control.actions?.includes('setText'))actions.append(button('Prepare text ↗','quiet-button',()=>{desktopInputTarget={snapshotId:snapshot.id,elementId:control.id,windowTitle:snapshot.window?.title||'',name:control.name||control.controlType,expiresAt:snapshot.expiresAt};$('desktop-input-target').textContent=`${desktopInputTarget.windowTitle} · ${desktopInputTarget.name}`;$('desktop-input-text').value='';$('desktop-input-error').textContent='';showDialog('desktop-input-dialog');}));
    if(!snapshot.protectedInput&&control.enabled!==false&&control.actions?.includes('click'))actions.append(button('Review click ↗','quiet-button',()=>void prepareDesktopAction({snapshotId:snapshot.id,elementId:control.id,action:'click'})));
    if(actions.childNodes.length)row.append(actions);list.append(row);
  }
}
async function prepareDesktopAction(argumentsObject){
  try{const result=await runDesktopTool('desktop_propose_action',argumentsObject);if(!result.desktopAction?.id)throw new Error('No prepared action was returned. Nothing was approved.');if(result.desktopAction.status==='pending'){if($('desktop-input-dialog').open)$('desktop-input-dialog').close();await openDesktopReview(result.desktopAction.id);}}catch(error){if($('desktop-input-dialog').open)$('desktop-input-error').textContent=error.message;else $('desktop-error').textContent=error.message;}
}
$('desktop-input-form').addEventListener('submit',async event=>{event.preventDefault();if(!desktopInputTarget)return;const target=clone(desktopInputTarget);if(target.expiresAt&&Date.parse(target.expiresAt)<=Date.now()){$('desktop-input-error').textContent='This window snapshot expired. Read the window again before preparing input.';return;}$('desktop-input-prepare').disabled=true;$('desktop-input-error').textContent='';try{await prepareDesktopAction({snapshotId:target.snapshotId,elementId:target.elementId,action:'setText',text:$('desktop-input-text').value});}finally{$('desktop-input-prepare').disabled=false;}});
async function openDesktopReview(id){
  if(runtimeReconnectPromise)return;try{await refreshDesktop();const action=desktopActions.find(item=>item.id===id);if(!desktopPending(action))throw new Error('This prepared action is no longer available. Create a new preview.');desktopReviewGeneration+=1;desktopReview={id,signature:desktopSignature(action),action:clone(action)};$('desktop-review-error').textContent='';$('desktop-review-command').value='';renderDesktopReview();showDialog('desktop-review-dialog');}catch(error){toast(error.message);}
}
function renderDesktopReview(){
  if(!desktopReview)return;const current=desktopActions.find(action=>action.id===desktopReview.id),action=desktopReview.action;
  const changed=!!current&&desktopSignature(current)!==desktopReview.signature;
  $('desktop-review-summary').textContent=action.summary||'A computer action is prepared.';
  const target=$('desktop-review-target');target.replaceChildren();for(const [label,value]of[['Window',action.target?.title],['App',action.target?.appName],['Control',action.target?.name||action.target?.controlType]])if(value){target.append(element('dt','',label),element('dd','',value));}
  const preview=action.preview||{};$('desktop-preview-label').textContent=preview.action==='setText'?'Exact text':preview.action==='pressKey'?'Exact key':'Exact action';
  $('desktop-review-warning').textContent=action.warning||'';
  const validPreview=['click','setText','pressKey'].includes(preview.action)&&(preview.action!=='setText'||typeof preview.text==='string')&&(preview.action!=='pressKey'||typeof preview.key==='string');
  $('desktop-review-preview').textContent=preview.action==='setText'?String(preview.text??''):preview.action==='pressKey'?String(preview.key??''):'Click '+(action.target?.name||action.target?.controlType||'the selected control');
  $('desktop-review-expiry').textContent=action.expiresAt?'Preview expires at '+timeLabel(action.expiresAt)+'.':'';
  const status=current?.status||'unavailable';$('desktop-review-status').textContent=!validPreview?'This input preview could not be displayed safely. Create a new preview.':changed?'The target or input changed. Close this preview and open it again.':status==='pending'&&!desktopPending(current)?'Preview expired. Create a new preview.':DESKTOP_LABELS[status]||'This action is no longer available.';
  if(current?.error)$('desktop-review-error').textContent=typeof current.error==='string'?current.error:current.error.message;
  if(current?.outcomeUnknown)$('desktop-review-error').textContent=($('desktop-review-error').textContent+' Input may already have happened. Check the target window before trying again.').trim();
  $('desktop-review-approve').hidden=!!current&&['completed','failed','cancelled','expired'].includes(status);
  $('desktop-review-approve').disabled=desktopMutationBusy||desktopToolBusy||!!runtimeReconnectPromise||changed||!validPreview||!desktopPending(current);
  $('desktop-review-approve').textContent=preview.action==='setText'?'Send this text':preview.action==='pressKey'?'Press this key':'Click this control';
  $('desktop-review-cancel').hidden=!!current&&['completed','failed','cancelled','expired'].includes(status);
  $('desktop-review-cancel').disabled=desktopMutationBusy||!!runtimeReconnectPromise||!current;
  $('desktop-review-stop').hidden=!desktopMutationBusy&&status!=='executing';
}
async function desktopActionOperation(operation){
  if(!desktopReview||desktopMutationBusy||desktopToolBusy||runtimeReconnectPromise)return;
  const frozen=clone(desktopReview),current=desktopActions.find(action=>action.id===frozen.id);
  if(operation==='approve'&&(!desktopPending(current)||desktopSignature(current)!==frozen.signature)){$('desktop-review-error').textContent='This preview changed or expired. Create a new preview before sending input.';renderDesktopReview();return;}
  const turn=++desktopExecutionGeneration,controller=new AbortController();activeDesktopRequest={controller,turn};desktopMutationBusy=true;renderDesktopReview();renderDesktopStatus();renderRuntime();const timeout=setTimeout(()=>controller.abort(),45000);
  try{const value=await api(`desktop/actions/${encodeURIComponent(frozen.id)}/${operation}`,{method:'POST',body:JSON.stringify({}),signal:controller.signal});if(turn!==desktopExecutionGeneration)return;if(value.desktopAction)rememberDesktopAction(value.desktopAction);if(value.workspace)applyWorkspace(value.workspace);if(value.desktopAction?.status==='completed')updateCornerPreview(value.desktopAction.receipt?.summary||value.desktopAction.summary);}
  catch(error){if(turn===desktopExecutionGeneration){$('desktop-review-error').textContent=error.name==='AbortError'?'The action was stopped. Check the actual result before trying again.':error.message;void refreshDesktop().catch(()=>{});}}
  finally{clearTimeout(timeout);if(activeDesktopRequest?.turn===turn)activeDesktopRequest=null;if(turn===desktopExecutionGeneration){desktopMutationBusy=false;renderDesktopReview();renderDesktopStatus();renderRuntime();maybeResume();}}
}
$('desktop-review-approve').addEventListener('click',()=>void desktopActionOperation('approve'));
$('desktop-review-cancel').addEventListener('click',()=>void desktopActionOperation('cancel'));
function captureDesktopApprovalContext(){return $('desktop-review-dialog').open&&desktopReview?{id:desktopReview.id,signature:desktopReview.signature,generation:desktopReviewGeneration}:null;}
function localDesktopApprovalMatch(value){return /^(approve|cancel) desktop action\.?$/i.exec(value.trim());}
async function localDesktopApproval(value,options={}){
  const match=localDesktopApprovalMatch(value);if(!match)return false;
  if($('question').value.trim()===value.trim())$('question').value='';
  if(runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy){$('desktop-review-error').textContent='Wait for the current action or reconnection. No new input was approved.';return true;}
  const context=Object.hasOwn(options,'approvalContext')?options.approvalContext:captureDesktopApprovalContext();
  const current=desktopActions.find(action=>action.id===context?.id);
  if(!context||!$('desktop-review-dialog').open||desktopReview?.id!==context.id||desktopReview.signature!==context.signature||desktopReviewGeneration!==context.generation||!desktopPending(current)||desktopSignature(current)!==context.signature){
    const message='Open the current, unexpired action preview first. This command did not approve or cancel any input.';$('desktop-review-error').textContent=message;$('question-error').textContent=message;return true;
  }
  $('question-error').textContent='';$('desktop-review-error').textContent='';await desktopActionOperation(match[1].toLowerCase()==='approve'?'approve':'cancel');return true;
}
$('desktop-review-command-form').addEventListener('submit',async event=>{event.preventDefault();const value=$('desktop-review-command').value;if(!localDesktopApprovalMatch(value)){$('desktop-review-error').textContent='Use the exact phrase “approve desktop action” or “cancel desktop action”.';return;}cancelTurn(false);await runCommand(value,{approvalContext:captureDesktopApprovalContext()});if($('desktop-review-command').value===value)$('desktop-review-command').value='';});
$('desktop-review-mic').addEventListener('click',()=>{if(recording)stopRecording(true);else if(microphoneOpening)cancelTurn(false);else{if(turnBusy)cancelTurn(false);void startRecording();}});
$('desktop-review-dialog').addEventListener('close',()=>{desktopReviewGeneration+=1;if(recording||microphoneOpening){disableHandsFree();stopRecording(false);}});
$('desktop-review-next').addEventListener('click',()=>{const action=desktopActions.find(desktopPending);if(action)void openDesktopReview(action.id);});
$('desktop-refresh').addEventListener('click',()=>void refreshDesktop().catch(error=>{$('desktop-error').textContent=error.message;}));
$('desktop-settings-refresh').addEventListener('click',()=>void refreshDesktop().catch(error=>{$('desktop-settings-status').textContent=error.message;}));
async function stopDesktopActions(){
  desktopExecutionGeneration+=1;activeDesktopRequest?.controller.abort();activeDesktopRequest=null;desktopToolBusy=false;desktopMutationBusy=false;
  if(desktopStopPromise)return desktopStopPromise;
  desktopStopPromise=Promise.resolve().then(async()=>{const result=await postStopWithFreshSession('desktop/stop');await refreshDesktop();return result;}).finally(()=>{desktopStopPromise=null;renderDesktopStatus();renderDesktopReview();renderRuntime();});return desktopStopPromise;
}
async function postStopWithFreshSession(path){
  if(!['stop','desktop/stop'].includes(path))throw new Error('Only Stop requests can refresh and retry here.');
  for(let attempt=0;attempt<2;attempt++){
    const session=await boundedApi('session',{},4000);
    if(typeof session.csrfToken!=='string'||!session.csrfToken)throw new Error('A fresh Stop session could not be opened.');
    const stopCsrfToken=session.csrfToken;csrfToken=stopCsrfToken;
    try{return await boundedApi(path,{method:'POST',body:JSON.stringify({}),csrfTokenOverride:stopCsrfToken},path==='stop'?10000:7000);}
    catch(error){if(attempt===0&&[401,403].includes(error.status))continue;throw error;}
  }
}
function stopAllActivity(announce=false,{global=false}={}){
  cancelTurn(false);desktopExecutionGeneration+=1;activeDesktopRequest?.controller.abort();activeDesktopRequest=null;desktopToolBusy=false;desktopMutationBusy=false;
  const stop=global?Promise.resolve().then(async()=>{const result=await postStopWithFreshSession('stop');await Promise.allSettled([refreshDesktop(),refreshJobs()]);return result;}):stopDesktopActions();
  void stop.then(()=>{if(announce||global){const message=global?'Stopped running requests. Completed work is preserved.':'Stopped. Completed work is preserved.';toast(message);updateCornerPreview(message);}}).catch(error=>{if(global)void stopDesktopActions().catch(()=>{});if(announce||global)$('question-error').textContent='The current turn stopped, but the computer stop could not be confirmed. '+error.message;}).finally(()=>{renderDesktopStatus();renderDesktopReview();renderRuntime();});
}
$('connection-refresh').addEventListener('click',()=>void checkService());$('retry-service').addEventListener('click',()=>void checkService());
$('service-details').addEventListener('click',()=>{renderService();showDialog('service-dialog');});
$('open-connections').addEventListener('click',()=>{$('service-dialog').close();showView('settings');});
function applyWorkspace(value){if(!value||!Number.isSafeInteger(value.revision)||!Array.isArray(value.tasks)||!Array.isArray(value.notes)||!Array.isArray(value.workflows))throw new Error('Your workspace could not be read.');if(workspace&&value.revision<workspace.revision)return;workspace=value;renderWorkspace();}
function renderMemory(){
  const list=$('memory-list');list.replaceChildren();const all=Array.isArray(workspace?.preferences)?workspace.preferences:[],visible=all.filter(item=>$('memory-show-forgotten').checked||!item.archived);
  if(!visible.length){list.append(element('p','memory-empty','No preferences saved yet.'));return;}
  for(const item of visible){const row=element('article','memory-row'+(item.archived?' memory-forgotten':'')),text=element('div');text.append(element('strong','',item.label||item.key),element('p','',item.value));const action=button(item.archived?'Remember again':'Forget','quiet-button',()=>void changeMemory(item));action.disabled=memoryBusy;row.append(text,action);list.append(row);}
}
async function changeMemory(item){if(memoryBusy||runtimeReconnectPromise)return;memoryBusy=true;$('memory-error').textContent='';renderMemory();try{const tool=item.archived?'remember_preference':'forget_preference',args=item.archived?{key:item.key,label:item.label,value:item.value}:{preferenceId:item.id};const value=await boundedApi('tools/run',{method:'POST',body:JSON.stringify({tool,arguments:args,operationId:crypto.randomUUID()})});if(value.result?.error)throw new Error(value.result.error);if(value.workspace)applyWorkspace(value.workspace);else await refreshWorkspace();}catch(error){$('memory-error').textContent=error.message;}finally{memoryBusy=false;renderMemory();}}
$('memory-show-forgotten').addEventListener('change',renderMemory);
async function refreshWorkspace(){if(workspacePending||destroyed)return;workspacePending=true;try{applyWorkspace(await boundedApi('workspace'));}finally{workspacePending=false;}}
async function workspaceOperation(type,fields={}){
  if(runtimeReconnectPromise)throw new Error('Companion is reconnecting. Your draft is still here; save when it is ready.');
  if(operationBusy)throw new Error('Let the current change finish, then try again.');
  if(pendingWorkspaceRequest)throw new Error('Confirm the previous change using the button below before saving another. Your draft is still here.');
  if(!workspace)throw new Error('Your workspace is not connected yet. Check the connection first.');
  operationBusy=true;
  const request={operationId:crypto.randomUUID(),expectedRevision:workspace.revision,type,...fields};
  try{return await sendWorkspaceOperation(request);}
  finally{operationBusy=false;}
}
async function sendWorkspaceOperation(request){
  try{const result=await boundedApi('workspace/operations',{method:'POST',body:JSON.stringify(request)});applyWorkspace(result.workspace);pendingWorkspaceRequest=null;$('workspace-retry').hidden=true;return result;}
  catch(error){
    if(error.status===409){pendingWorkspaceRequest=null;$('workspace-retry').hidden=true;if(error.workspace)applyWorkspace(error.workspace);throw new Error('Your workspace changed. Your draft is still here; review it and save again.');}
    if(!error.status||error.status>=500){pendingWorkspaceRequest=clone(request);$('workspace-retry').hidden=false;throw new Error('The change may have been saved. Use Confirm last change below to check it safely.');}
    pendingWorkspaceRequest=null;$('workspace-retry').hidden=true;throw error;
  }
}
$('retry-workspace-change').addEventListener('click',async()=>{
  if(operationBusy||!pendingWorkspaceRequest||runtimeReconnectPromise)return;
  operationBusy=true;const request=clone(pendingWorkspaceRequest);$('retry-workspace-change').disabled=true;
  try{await sendWorkspaceOperation(request);
    if(request.type==='addTask'&&$('new-task').value.trim()===request.title)$('new-task').value='';
    if(request.type==='addNote'&&$('new-note').value.trim()===request.text){$('new-note').value='';$('note-title').value='';}
    toast('Previous change confirmed and saved.');
  }catch(error){toast(error.message);}finally{operationBusy=false;$('retry-workspace-change').disabled=false;}
});
function renderWorkspace(){
  renderMemory();
  if(!workspace)return;
  const tasks=workspace.tasks.filter(task=>task.status!=='done'),notes=workspace.notes.filter(note=>!note.archived);
  $('task-count').textContent=tasks.length;$('note-count').textContent=notes.length;$('today-task-count').textContent=tasks.length;$('today-note-count').textContent=notes.length;$('today-workflow-count').textContent=workspace.workflows.length;
  renderTasks();renderNotes();renderWorkflows();renderFocus();
  const activity=$('activity-list');activity.replaceChildren();
  const recent=[...(workspace.activity||[])].slice(-3).reverse();
  if(!recent.length)activity.append(element('p','activity-empty','Your space is ready. Add a task, keep a thought, or ask for something new.'));
  for(const item of recent){const row=element('div','activity-item');row.append(element('span','',item.summary||item.type),element('time','',timeLabel(item.at)));activity.append(row);}
}
function renderFocus(){const focus=workspace?.focus;$('focus-card').hidden=!focus;if(!focus)return;$('focus-label').textContent=focus.label||'Time to focus';const minutes=Math.max(0,Math.ceil((new Date(focus.endsAt)-Date.now())/60000));$('focus-remaining').textContent=minutes?`${minutes} min remaining`:'Focus time complete';}
$('stop-focus').addEventListener('click',async()=>{try{await workspaceOperation('stopFocus');}catch(error){toast(error.message);}});
function renderTasks(){const list=$('task-list');list.replaceChildren();const tasks=(workspace?.tasks||[]).filter(task=>showCompleted||task.status!=='done');
  if(!tasks.length)list.append(emptyState('No open tasks.','Add a task above or ask Companion to create one.'));
  for(const task of tasks){const row=element('article','task-row'+(task.status==='done'?' done':''));const check=button(task.status==='done'?'✓':'','task-check',async()=>{check.disabled=true;try{await workspaceOperation(task.status==='done'?'updateTask':'completeTask',{taskId:task.id,...(task.status==='done'?{status:'todo'}:{})});}catch(error){toast(error.message);check.disabled=false;}});check.setAttribute('aria-label',(task.status==='done'?'Reopen task: ':'Complete task: ')+task.title);check.setAttribute('aria-pressed',String(task.status==='done'));
    const main=element('div','task-main');main.append(element('p','task-title',task.title));if(task.details)main.append(element('p','task-details',task.details));const meta=element('div','task-meta');if(task.priority==='high')meta.append(element('span','priority-high','High priority'));if(task.project)meta.append(element('span','',task.project));if(task.dueAt)meta.append(element('span','','Due '+dateLabel(task.dueAt)));if(meta.childNodes.length)main.append(meta);row.append(check,main,button('Edit','quiet-button',()=>openEditor('task',task)));list.append(row);}
}
$('toggle-completed').addEventListener('click',()=>{showCompleted=!showCompleted;$('toggle-completed').textContent=showCompleted?'Hide completed':'Show completed';renderTasks();});
$('task-form').addEventListener('submit',async event=>{event.preventDefault();const title=$('new-task').value.trim();if(!title)return;$('task-error').textContent='';const submit=event.submitter;submit.disabled=true;try{await workspaceOperation('addTask',{title});if($('new-task').value.trim()===title)$('new-task').value='';}catch(error){$('task-error').textContent=error.message;}finally{submit.disabled=false;}});
function renderNotes(){const list=$('notes-list');list.replaceChildren();const query=$('notes-search').value.trim().toLowerCase();const notes=(workspace?.notes||[]).filter(note=>!note.archived&&(!query||[note.title,note.text,...(note.tags||[])].join(' ').toLowerCase().includes(query)));
  if(!notes.length)list.append(emptyState(query?'No matching notes.':'No notes to show.',query?'Try another word.':'Save a note above or ask Companion to save one.'));
  for(const note of [...notes].reverse()){const card=element('article','note-card');if(note.title)card.append(element('h2','',note.title));card.append(element('p','note-text',note.text));const meta=element('div','note-meta');meta.append(element('time','',dateLabel(note.updatedAt||note.createdAt)),button('Edit','quiet-button',()=>openEditor('note',note)),button('Archive','quiet-button',async()=>{try{await workspaceOperation('archiveNote',{noteId:note.id,archived:true});}catch(error){toast(error.message);}}));card.append(meta);list.append(card);}
}
$('notes-search').addEventListener('input',renderNotes);
$('note-form').addEventListener('submit',async event=>{event.preventDefault();const text=$('new-note').value.trim(),title=$('note-title').value.trim();if(!text)return;$('note-error').textContent='';const submit=event.submitter;submit.disabled=true;try{await workspaceOperation('addNote',{text,...(title?{title}:{})});if($('new-note').value.trim()===text){$('new-note').value='';$('note-title').value='';}}catch(error){$('note-error').textContent=error.message;}finally{submit.disabled=false;}});
function openEditor(kind,item){editingTarget={kind,id:item.id,revision:workspace.revision};$('edit-title').textContent=kind==='task'?'Edit task':'Edit note';$('edit-name').value=item.title||'';$('edit-name').required=true;$('edit-name').maxLength=kind==='task'?300:200;$('edit-text').value=kind==='task'?item.details||'':item.text;$('edit-text').maxLength=kind==='task'?12000:40000;$('task-edit-fields').hidden=kind!=='task';$('edit-priority').value=item.priority||'normal';$('edit-project').value=item.project||'';$('edit-error').textContent='';showDialog('edit-dialog');}
$('edit-form').addEventListener('submit',async event=>{event.preventDefault();if(!editingTarget)return;const target={...editingTarget};$('edit-error').textContent='';$('edit-save').disabled=true;try{if(workspace.revision!==target.revision){editingTarget.revision=workspace.revision;throw new Error('Your workspace changed while this editor was open. Review your draft, then save again.');}await workspaceOperation(target.kind==='task'?'updateTask':'updateNote',target.kind==='task'?{taskId:target.id,title:$('edit-name').value.trim(),details:$('edit-text').value,priority:$('edit-priority').value,project:$('edit-project').value.trim()}:{noteId:target.id,title:$('edit-name').value.trim(),text:$('edit-text').value});$('edit-dialog').close();}catch(error){$('edit-error').textContent=error.message;if(editingTarget)editingTarget.revision=workspace.revision;}finally{$('edit-save').disabled=false;}});
function workflowMeta(step){return toolCatalog.find(item=>item.name===step.tool);}
function workflowAvailability(step){
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
function savedWorkflowRunIds(){const saved=readStored('pendingWorkflowRuns',[]),map=new Map();if(Array.isArray(saved))for(const item of saved.slice(0,100))if(item&&CONVERSATION_ID.test(item.workflowId)&&CONVERSATION_ID.test(item.operationId))map.set(item.workflowId,item.operationId);return map;}
function syncPendingWorkflowRuns(){for(const[id,operationId]of savedWorkflowRunIds())if(!pendingWorkflowRuns.has(id))pendingWorkflowRuns.set(id,operationId);}
function rememberWorkflowRun(id,operationId){pendingWorkflowRuns.set(id,operationId);const saved=savedWorkflowRunIds();saved.set(id,operationId);store('pendingWorkflowRuns',[...saved].map(([workflowId,operationId])=>({workflowId,operationId})));}
function forgetWorkflowRun(id,operationId){if(pendingWorkflowRuns.get(id)===operationId)pendingWorkflowRuns.delete(id);const saved=savedWorkflowRunIds();if(saved.get(id)===operationId)saved.delete(id);store('pendingWorkflowRuns',[...saved].map(([workflowId,operationId])=>({workflowId,operationId})));}
function renderWorkflows(){
  syncPendingWorkflowRuns();const list=$('workflow-list');list.replaceChildren();if(!workspace?.workflows.length)list.append(emptyState('No workflows yet.','Create a workflow from the actions you use often.'));
  for(const flow of workspace?.workflows||[]){const wrapper=element('div'),card=element('article','workflow-card'),info=element('div','workflow-info');info.append(element('h2','',flow.name),element('p','',flow.description||'Saved actions, ready to run.'),element('small','',(flow.steps?.length||0)+' steps'+(flow.enabled===false?' · Disabled':'')));const unavailable=toolCatalogReady&&(flow.steps||[]).find(step=>!workflowAvailability(step).available);if(unavailable)info.append(element('p','workflow-unavailable',workflowAvailability(unavailable).reason));
    const pendingRun=pendingWorkflowRuns.has(flow.id);if(pendingRun)info.append(element('p','form-hint','The last run needs confirmation. Checking it will not start a new run.'));
    const actions=element('div','workflow-actions'),run=button(runningWorkflows.has(flow.id)?(pendingRun?'Checking…':'Running…'):pendingRun?'Check last run':'Run workflow ↗','secondary-button',()=>void runWorkflow(flow));run.disabled=runningWorkflows.has(flow.id)||(!pendingRun&&(flow.enabled===false||!!unavailable));actions.append(run,button('Edit','quiet-button',()=>openWorkflow(flow)));card.append(element('span','workflow-icon','↳'),info,actions);wrapper.append(card);
    const result=workflowResults.get(flow.id);if(result){const receipt=element('div','workflow-result');receipt.append(element('strong','',result.status==='completed'?'Workflow finished.':result.status==='running'?'This workflow is still running. Use Check last run to read its saved result.':result.status==='interrupted'?'Workflow interrupted. Check the completed actions below before making another request.':'Workflow stopped: '+(result.error||'A step could not finish.')));for(const[index,step]of(result.steps||[]).entries()){const failed=step.status==='failed'||!!step.error||!!step.result?.error,pending=step.status==='pending';receipt.append(element('div','',(index+1)+'. '+toolLabel(step.tool)+' · '+(failed?'could not finish':pending?'needs review':'completed')));if(step.result?.capability&&step.result.value)receipt.append(element('pre','capability-output',JSON.stringify(step.result.value,null,2).slice(0,4000)));}wrapper.append(receipt);}list.append(wrapper);
  }
}
async function runWorkflow(flow){
  if(runningWorkflows.has(flow.id)||runtimeReconnectPromise)return;syncPendingWorkflowRuns();let operationId=pendingWorkflowRuns.get(flow.id)||null;runningWorkflows.add(flow.id);renderWorkflows();$('workflow-error').textContent='';
  try{
    if(!operationId){await refreshToolCatalog();validateWorkflowSteps(flow.steps||[]);syncPendingWorkflowRuns();operationId=pendingWorkflowRuns.get(flow.id)||crypto.randomUUID();rememberWorkflowRun(flow.id,operationId);renderWorkflows();}
    const result=await boundedApi('workspace/workflows/'+encodeURIComponent(flow.id)+'/run',{method:'POST',body:JSON.stringify({operationId})},45000);
    if(result?.id!==flow.id||!['completed','failed','cancelled','running','interrupted'].includes(result.status))throw new Error('The saved run result could not be confirmed.');
    workflowResults.set(flow.id,result);if(result.workspace)applyWorkspace(result.workspace);
    if(['completed','failed','cancelled'].includes(result.status)){forgetWorkflowRun(flow.id,operationId);toast(result.status==='completed'?'Workflow finished.':'The workflow stopped. Completed actions are shown below.');}
    else toast(result.status==='running'?'This workflow is still running. Check its saved result again shortly.':'The workflow was interrupted. Its completed actions remain visible.');
  }catch(error){$('workflow-error').textContent=operationId?'The last run could not be confirmed. Use Check last run to check the same request safely. '+error.message:error.message;}
  finally{runningWorkflows.delete(flow.id);renderWorkflows();}
}
function openWorkflow(flow=null){workflowEditingId=flow?.id||null;workflowEditingRevision=workspace?.revision;$('workflow-name').value=flow?.name||'';$('workflow-description').value=flow?.description||'';workflowDraft=clone(flow?.steps||[{tool:'',arguments:{}}]);$('workflow-form-error').textContent='';renderWorkflowSteps();showDialog('workflow-dialog');void refreshToolCatalog({quiet:true});}
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
  const list=$('workflow-steps');list.replaceChildren();$('workflow-catalog-status').textContent=toolCatalogError||(!toolCatalogReady?'Checking available actions…':capabilityStatus?.ready===false?capabilityStatus.message||'Installed actions are unavailable.':'Choose an action, then fill in its values.');
  const eligible=toolCatalog.filter(item=>item.workflowAllowed===true);
  workflowDraft.forEach((step,index)=>{const state=workflowAvailability(step),row=element('div','workflow-step'),header=element('div','workflow-step-header'),select=element('select');select.setAttribute('aria-label','Action for step '+(index+1));const empty=element('option','','Choose an action');empty.value='';select.append(empty);
    for(const meta of eligible){const option=element('option','',meta.title||humanLabel(meta.name));option.value=meta.name;select.append(option);}if(step.tool&&!eligible.some(item=>item.name===step.tool)){const option=element('option','',toolLabel(step.tool)+' · unavailable');option.value=step.tool;select.append(option);}select.value=step.tool||'';select.addEventListener('change',()=>{workflowDraft[index]={tool:select.value,arguments:{}};renderWorkflowSteps();});header.append(element('span','',String(index+1).padStart(2,'0')),select,button('Remove','quiet-button',()=>{workflowDraft.splice(index,1);renderWorkflowSteps();}));row.append(header);
    if(step.tool&&!state.available){row.append(element('p','workflow-unavailable',state.reason));if(state.changed){row.append(button('Use updated action','secondary-button',()=>{workflowDraft[index]={tool:step.tool,arguments:clone(step.arguments||{})};renderWorkflowSteps();}));}}
    if(state.meta?.parameters){const schema=state.meta.parameters,optional=element('details','workflow-optional');optional.append(element('summary','','More options'));let optionalCount=0;for(const[name,property]of Object.entries(schema.properties||{})){const required=(schema.required||[]).includes(name),field=renderWorkflowField(step,index,name,property,required);if(required)row.append(field);else{optionalCount++;optional.append(field);if(Object.hasOwn(step.arguments||{},name))optional.open=true;}}if(optionalCount)row.append(optional);}
    else if(step.tool){const details=element('details','workflow-saved-values');details.append(element('summary','','Saved values'),element('pre','',JSON.stringify(step.arguments||{},null,2)));row.append(details);}
    list.append(row);
  });
}
$('new-workflow').addEventListener('click',()=>openWorkflow());$('add-workflow-step').addEventListener('click',()=>{if(workflowDraft.length>=12){toast('Keep this workflow to 12 steps.');return;}workflowDraft.push({tool:'',arguments:{}});renderWorkflowSteps();});
$('workflow-form').addEventListener('submit',async event=>{event.preventDefault();$('workflow-form-error').textContent='';$('workflow-save').disabled=true;try{await refreshToolCatalog();if(workflowEditingId&&workflowEditingRevision!==workspace.revision){workflowEditingRevision=workspace.revision;throw new Error('Your workspace changed. Review these steps, then save again.');}validateWorkflowSteps(workflowDraft);await workspaceOperation('saveWorkflow',{...(workflowEditingId?{workflowId:workflowEditingId}:{}),name:$('workflow-name').value.trim(),description:$('workflow-description').value.trim(),steps:clone(workflowDraft),enabled:true});$('workflow-dialog').close();}catch(error){$('workflow-form-error').textContent=error.message;workflowEditingRevision=workspace?.revision;}finally{$('workflow-save').disabled=false;}});
function renderProviders(){
  const picker=$('provider-select');picker.replaceChildren();
  if(!providers.length){const option=element('option','','No AI connected');option.value='';picker.append(option);}
  for(const provider of providers){const option=element('option','',`${provider.label}${provider.model?' · '+provider.model:''}${provider.ready?'':' · not ready'}`);option.value=provider.id;picker.append(option);}
  picker.value=activeProviderId;picker.disabled=providerBusy||!providers.length;
  const list=$('provider-list');list.replaceChildren();
  if(!providers.length)list.append(emptyState('Bring your preferred AI.','Connect a provider below, or check that Companion’s service is running.'));
  for(const provider of providers){const card=element('article','provider-card'),info=element('div','provider-info'),actions=element('div','provider-actions');const mark={codex:'C',openai:'G',anthropic:'A',compatible:'↗',ollama:'○'}[provider.type]||'◇';
    info.append(element('h2','',provider.label));let status=provider.ready?(provider.verified===false&&provider.type!=='codex'?'Configured · not yet tested':'Ready to use'):'Needs attention';
    info.append(element('p','',status+(provider.hasKey?' · Key saved':'')),element('p','provider-model',provider.model|| (provider.type==='codex'?'Uses your existing Codex model setting':'Provider default model')));
    if(provider.type==='codex')info.append(element('p','','Uses your existing Codex sign-in on this computer.'));
    if(!provider.ready&&provider.unavailableReason)info.append(element('p','provider-reason',provider.unavailableReason));
    if(provider.secretStorage==='memory'&&provider.hasKey)info.append(element('p','provider-reason','This key is held in memory. Reconnect after restarting Companion.'));
    if(provider.id===activeProviderId)actions.append(element('span','active-provider-tag','Selected'));else{const use=button('Use this AI','secondary-button',()=>void selectProvider(provider.id));use.disabled=providerBusy;actions.append(use);}
    if(provider.type!=='codex'){actions.append(button('Edit connection','quiet-button',()=>editProvider(provider)));const remove=button('Remove','quiet-button danger-button',()=>void removeProvider(provider));remove.disabled=providerBusy;actions.append(remove);}
    card.append(element('span','provider-mark',mark),info,actions);list.append(card);
  }
}
async function selectProvider(id){if(providerBusy||runtimeReconnectPromise||id===activeProviderId)return;providerBusy=true;cancelTurn(false);renderProviders();try{applyProviders(await boundedApi('providers/select',{method:'POST',body:JSON.stringify({id})}));toast('Selected '+(activeProvider()?.label||'your AI')+'.');}catch(error){toast(error.message);}finally{providerBusy=false;renderProviders();renderService();}}
$('provider-select').addEventListener('change',event=>void selectProvider(event.target.value));
function providerFormType(){const type=$('provider-type').value;$('provider-url-field').hidden=!['compatible','ollama'].includes(type);$('provider-url').required=type==='compatible';$('provider-key-field').hidden=type==='ollama';$('provider-key').required=false;$('provider-model').placeholder=type==='openai'?'For example: gpt-6.1-sol':type==='anthropic'?'For example: claude-sonnet-5-5':type==='ollama'?'Your installed local model':'Model name from your provider';}
$('provider-type').addEventListener('change',()=>{$('provider-key').value='';providerFormType();});
function editProvider(provider){editingProviderId=provider.id;$('provider-type').value=provider.type;$('provider-label').value=provider.label||'';$('provider-model').value=provider.model||'';$('provider-url').value=provider.baseUrl||'';$('provider-key').value='';$('provider-key').placeholder=provider.hasKey?'Leave blank to keep the saved key':'Paste your provider’s API key';$('provider-error').textContent='';providerFormType();$('connect-panel').open=true;$('connect-panel').scrollIntoView({block:'nearest'});}
async function removeProvider(provider){if(providerBusy||runtimeReconnectPromise)return;providerBusy=true;renderProviders();try{applyProviders(await boundedApi('providers/remove',{method:'POST',body:JSON.stringify({id:provider.id})}));toast('Connection removed.');}catch(error){toast(error.message);}finally{providerBusy=false;renderProviders();renderService();}}
$('provider-form').addEventListener('submit',async event=>{event.preventDefault();if(providerBusy||runtimeReconnectPromise)return;providerBusy=true;$('provider-save').disabled=true;$('provider-error').textContent='';const type=$('provider-type').value,key=$('provider-key').value;const body={id:editingProviderId||type+'-'+crypto.randomUUID().slice(0,8),type,model:$('provider-model').value.trim(),label:$('provider-label').value.trim()||undefined,...(['compatible','ollama'].includes(type)&&$('provider-url').value.trim()?{baseUrl:$('provider-url').value.trim()}:{}),...(key?{apiKey:key}:{})};$('provider-key').value='';try{applyProviders(await boundedApi('providers/configure',{method:'POST',body:JSON.stringify(body)},30000));editingProviderId=null;$('provider-form').reset();providerFormType();$('connect-panel').open=false;toast('Connection saved. Choose Use this AI to select it.');}catch(error){$('provider-error').textContent=error.message;}finally{providerBusy=false;$('provider-save').disabled=false;renderProviders();renderService();}});
$('connect-panel').addEventListener('toggle',()=>{if(!$('connect-panel').open){$('provider-key').value='';editingProviderId=null;}});
async function refreshJobs(){if(jobsPending||destroyed)return;jobsPending=true;try{const value=await boundedApi('features');if(!Array.isArray(value.jobs))throw new Error('Feature builds could not be read.');jobs=value.jobs;if(!selectedJobId&&jobs.length)selectedJobId=jobs[0].id;renderJobs();const activation=jobs.filter(job=>['applied','rolled_back'].includes(job.status)).map(job=>job.id+':'+job.status+':'+job.updatedAt).join('|');if(activation!==extensionRefreshKey){extensionRefreshKey=activation;void loadExtensions();}renderSavedConversation();}finally{jobsPending=false;}}
function refreshJobsSafely(){if(runtimeReconnectPromise)return;void refreshJobs().catch(error=>{$('build-error').textContent=error.message;});}
function rememberJob(job){if(!job?.id)return;if(Array.isArray(job.files)&&(!jobDetails.get(job.id)||String(job.updatedAt)>=String(jobDetails.get(job.id).updatedAt)))jobDetails.set(job.id,job);while(jobDetails.size>12){const id=jobDetails.keys().next().value;if(id===selectedJobId){const value=jobDetails.get(id);jobDetails.delete(id);jobDetails.set(id,value);}else jobDetails.delete(id);}}
async function ensureJobDetail(id){
  const summary=jobs.find(job=>job.id===id);if(runtimeReconnectPromise||!summary||jobDetailPending.has(id)||Date.now()<(jobDetailRetryAt.get(id)||0)||(jobDetails.get(id)&&String(jobDetails.get(id).updatedAt)>=String(summary.updatedAt)))return;
  jobDetailPending.add(id);
  try{const value=await boundedApi(`features/${encodeURIComponent(id)}`),job=value.job||value;if(job.id!==id)throw new Error('The build details could not be matched.');rememberJob(job);jobDetailRetryAt.delete(id);}
  catch(error){$('build-error').textContent=error.message;jobDetailRetryAt.set(id,Date.now()+5000);}
  finally{jobDetailPending.delete(id);featureRenderKey='';if(selectedJobId===id)renderJobs();}
}
function jobStatus(job){const label=element('span','job-status'+(['failed','conflict','interrupted','recovery_required'].includes(job.status)?' error':job.status==='review_required'?' review':ACTIVE_JOBS.has(job.status)?' active':''),JOB_LABELS[job.status]||job.status);return label;}
function renderJobs(){
  if(selectedJobId)void ensureJobDetail(selectedJobId);
  const cached=jobDetails.get(selectedJobId);const key=JSON.stringify([selectedJobId,jobs,cached?.updatedAt]);if(key===featureRenderKey)return;featureRenderKey=key;
  const openFiles=new Set([...document.querySelectorAll('.change-file[open]')].map(node=>node.dataset.path));
  const list=$('job-list');list.replaceChildren();
  for(const job of [...jobs].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))){const item=button('','job-button'+(job.id===selectedJobId?' active':''),()=>{selectedJobId=job.id;renderJobs();});item.append(element('span','job-name',job.prompt||job.summary||'Feature build'),jobStatus(job));list.append(item);}
  const detail=$('job-detail'),summary=jobs.find(item=>item.id===selectedJobId);detail.replaceChildren();
  if(!summary){detail.append(emptyState('Build a feature.','Describe it above. Changes and checks will appear here.'));return;}
  const fresh=!!cached&&String(cached.updatedAt)>=String(summary.updatedAt);
  const job=fresh?cached:summary;
  if(!fresh)void ensureJobDetail(job.id);
  const header=element('div','job-header'),heading=element('div');heading.append(element('h2','',job.prompt||'Your feature'),jobStatus(job));header.append(heading);detail.append(header);
  if(job.summary)detail.append(element('p','job-summary',job.summary));
  else detail.append(element('p','job-summary',ACTIVE_JOBS.has(job.status)?'The build is running. Actual changes and check results will appear here as they are available.':'No build summary was returned.'));
  if(job.error)detail.append(element('p','inline-error',typeof job.error==='string'?job.error:job.error.message||'This build could not finish.'));
  if(job.reviewRequired&&['ready','review_required'].includes(job.status))detail.append(element('p','review-note','This change touches core controls. Review the files and checks, then activate it when you are ready.'));
  const actions=element('div','job-actions');
  if(['ready','review_required'].includes(job.status)){const activate=button('Activate feature ↗','primary-button',()=>void jobAction(job,'apply'));activate.disabled=featureBusy||!fresh||job.verification?.passed!==true;actions.append(activate);}
  if(job.status==='applied'){actions.append(button('Reload interface ↻','secondary-button',()=>location.reload()),button('Roll back changes','quiet-button',()=>void jobAction(job,'rollback')));if(job.files?.some(file=>file.path.startsWith('electron/'))){detail.append(element('p','review-note',desktopUpdateNotice()));if(nativeSourceRuntime===true&&typeof nativeShell?.restart==='function')actions.append(button('Restart desktop ↻','secondary-button',restartNativeDesktop));}}
  if(['queued','generating','validating'].includes(job.status)){const cancel=button('Cancel build','quiet-button',()=>void jobAction(job,'cancel'));cancel.disabled=featureBusy;actions.append(cancel);}
  if(actions.childNodes.length)detail.append(actions);appendInstalledFeatureReady(detail,job);
  if(!fresh)detail.append(element('p','form-hint','Loading the actual file changes and check results…'));
  if(job.files?.length){detail.append(element('h3','checks-heading','Changes'));for(const file of job.files){const section=element('details','change-file');section.dataset.path=file.path;section.open=openFiles.has(file.path);const summary=element('summary');summary.append(element('span','',file.path),element('span','change-count',`+${file.added||0} −${file.removed||0}`));section.append(summary,element('pre','file-diff',typeof file.diff==='string'?file.diff:JSON.stringify(file.diff,null,2)));detail.append(section);}}
  const checks=job.verification?.checks||[];if(checks.length){detail.append(element('h3','checks-heading','Checks'));for(const check of checks){const row=element('div','verification-check'+(check.passed?'':' failed'));row.append(element('strong','',(check.passed?'✓ ':'× ')+check.name));if(check.output)row.append(element('pre','',check.output));detail.append(row);}}
  if(job.events?.length){const events=element('div','job-events');for(const event of [...job.events].slice(-12).reverse()){const row=element('div','job-event');row.append(element('time','',timeLabel(event.at)),element('span','',event.message||event.type));events.append(row);}detail.append(events);}
}
async function jobAction(job,action){
  if(featureBusy||runtimeReconnectPromise)return;featureBusy=true;$('build-error').textContent='';
  try{
    const value=await boundedApi(`features/${encodeURIComponent(job.id)}/${action}`,{method:'POST',body:JSON.stringify({})},90000);
    const changed=value.job||value;rememberJob(changed);
    if(changed?.id){jobs=jobs.map(item=>item.id===changed.id?changed:item);selectedJobId=changed.id;featureRenderKey='';renderJobs();}
    if(changed.runtime&&['apply','rollback'].includes(action))await reconnectAfterRestart(changed.runtime,{jobId:job.id,action});
    else{await refreshJobs();if(action==='apply'||action==='rollback')void loadExtensions();const latest=jobDetails.get(job.id)||changed;toast(latest.status==='rolled_back'?'Changes rolled back.':action==='apply'&&latest.status==='applied'?'Feature activated.':action==='cancel'?'Build cancelled.':'Build status updated.');}
    const latest=jobDetails.get(job.id)||changed;if(latest.status==='applied'&&latest.files?.some(file=>file.path.startsWith('electron/'))){runtimeNotice={phase:'manual',message:desktopUpdateNotice()};runtimeRetry=null;renderRuntime();toast(nativeSourceRuntime===false?'Desktop source changed. Rebuild the desktop app to load it.':'Desktop source changed. Relaunch from the updated source to load it.');}
  }catch(error){$('build-error').textContent=error.message;refreshJobsSafely();}
  finally{featureBusy=false;featureRenderKey='';renderJobs();renderRuntime();}
}
$('build-form').addEventListener('submit',async event=>{event.preventDefault();if(featureBusy||runtimeReconnectPromise)return;const prompt=$('feature-prompt').value.trim();if(!prompt)return;$('build-error').textContent='';const provider=activeProvider();if(!provider?.ready){$('build-error').textContent=provider?.unavailableReason||'Choose a ready AI connection in Settings first.';return;}featureBusy=true;$('build-submit').disabled=true;try{const value=await boundedApi('features',{method:'POST',body:JSON.stringify({prompt,providerId:provider.id,autoApply:$('feature-auto-apply').checked})},30000);const job=value.job||value;rememberJob(job);if(!job.id)throw new Error('The build could not be opened. Refresh to check build history.');jobs=[job,...jobs.filter(item=>item.id!==job.id)];selectedJobId=job.id;renderJobs();if($('feature-prompt').value.trim()===prompt)$('feature-prompt').value='';}catch(error){$('build-error').textContent=error.message;refreshJobsSafely();}finally{featureBusy=false;$('build-submit').disabled=false;}});
async function runInstalledTool(tool,args={}){
  if(runtimeReconnectPromise)throw new Error('Companion is reconnecting. Try this action again when it is ready.');
  try{const value=await boundedApi('tools/run',{method:'POST',body:JSON.stringify({tool,arguments:args,operationId:crypto.randomUUID()})},45000);if(value.workspace)applyWorkspace(value.workspace);ingestDesktopResult(value.result);for(const action of value.result?.hostActions||[])ingestDesktopResult(action.result);if(value.result?.desktopAction)void refreshDesktop().catch(error=>toast(error.message));if(value.result?.error){const error=new Error(typeof value.result.error==='string'?value.result.error:value.result.error.message||'This action could not finish.');error.hostActions=value.result.hostActions;throw error;}return value;}
  catch(error){void refreshWorkspace().catch(()=>{});throw error;}
}
async function loadExtensionModule(url){return import(url);}
function disposeExtension(entry){try{entry.cleanup?.();}catch{}entry.panel.remove();entry.button?.remove();}
async function applyExtensionManifest(manifest,version=++extensionGeneration){
  if(manifest?.version!==1||!Array.isArray(manifest.features)||manifest.features.length>40)throw new Error('Installed tools could not be read.');
  extensionProblems=[];const counts=new Map();for(const item of manifest.features)if(item?.id)counts.set(item.id,(counts.get(item.id)||0)+1);const nextIds=new Set();
  for(const feature of manifest.features){
    if(version!==extensionGeneration)return;
    if(!feature||!/^[a-z][a-z0-9-]{0,59}$/.test(feature.id)||typeof feature.title!=='string'||!feature.title.trim()||feature.title.length>100||!/^\.\/features\/[a-z][a-z0-9-]{0,59}\.mjs$/.test(feature.module)||(feature.aliases!==undefined&&(!Array.isArray(feature.aliases)||feature.aliases.length>12||feature.aliases.some(alias=>typeof alias!=='string'||!alias.trim()||alias.length>120)))){extensionProblems.push('A tool has invalid installation details and is unavailable.');continue;}
    if(counts.get(feature.id)>1){const message=feature.title+' has a duplicate installation ID and is unavailable.';if(!extensionProblems.includes(message))extensionProblems.push(message);for(const name of [feature.title,...(feature.aliases||[])])knownFeatureNames.add(normalizedFeatureName(name));continue;}
    const id='extension-'+feature.id;nextIds.add(id);const old=extensions.get(id);if(old)disposeExtension(old);
    const panel=element('section','view-panel extension-panel');panel.id=id+'-view';panel.hidden=currentView!==id;$('extension-panels').append(panel);
    const entry={panel,button:null,featureId:feature.id,title:feature.title.trim(),description:typeof feature.description==='string'?feature.description:'',aliases:clone(feature.aliases||[]),capabilityId:typeof feature.capabilityId==='string'?feature.capabilityId:null,ready:false,error:null,cleanup:null};extensions.set(id,entry);for(const name of featureNames(entry))knownFeatureNames.add(name);renderToolsCatalog();
    try{const module=await loadExtensionModule(new URL(feature.module+'?activation='+version+'-'+Date.now(),import.meta.url).href);if(version!==extensionGeneration){disposeExtension(entry);return;}if(typeof module.mount!=='function')throw new Error('This tool has no interface.');
      const cleanup=await module.mount({container:panel,api:Object.freeze({getWorkspace:async()=>clone(workspace),workspaceOperation,runTool:runInstalledTool,notify:toast})});
      if(version!==extensionGeneration){if(typeof cleanup==='function'){try{cleanup();}catch{}}disposeExtension(entry);if(extensions.get(id)===entry)extensions.delete(id);return;}
      if(typeof cleanup==='function')entry.cleanup=cleanup;entry.ready=true;
    }catch(error){if(version!==extensionGeneration)return;entry.error=String(error.message||'This tool could not open.').slice(0,300);entry.ready=false;panel.replaceChildren(emptyState('This tool could not open.',entry.error));}
  }
  if(version!==extensionGeneration)return;
  for(const[id,entry]of extensions){if(nextIds.has(id))continue;disposeExtension(entry);extensions.delete(id);if(currentView===id)showView('today');}
  renderToolsCatalog();featureRenderKey='';renderJobs();conversationRenderKey='';renderSavedConversation();void refreshToolCatalog({quiet:true});
}
async function loadExtensions(){
  const version=++extensionGeneration;
  try{const response=await fetch('/src/features/manifest.json',{cache:'no-store',credentials:'same-origin'});if(version!==extensionGeneration)return;if(response.status===404){await applyExtensionManifest({version:1,features:[]},version);return;}if(!response.ok)throw new Error('Installed tools could not be loaded.');const manifest=await response.json();if(version!==extensionGeneration)return;await applyExtensionManifest(manifest,version);}
  catch(error){if(version!==extensionGeneration)return;for(const entry of extensions.values()){entry.ready=false;entry.error='The current installation could not be verified.';}extensionProblems=[error.message];renderToolsCatalog();toast(error.message);}
}
function appendInstalledFeatureReady(container,job){
  const provided=job?.providedFeatures??job?.installedFeatures;if(job?.status!=='applied'||!Array.isArray(provided))return;
  for(const installed of provided){if(!installed||typeof installed.id!=='string')continue;const entry=extensions.get('extension-'+installed.id);const row=element('div','feature-ready');if(entry?.ready){row.append(element('span','',entry.title+' ready.'),button('Open','quiet-button',()=>openInstalledFeature(installed.id)),element('small','','Say “open '+entry.title+'”.'));}
    else{row.append(element('span','',(installed.title||'The tool')+(entry?.error?' could not open.':' is not currently available.')),button('Check tool','quiet-button',()=>showToolsList(entry?.error||'Check that this tool is available below.')));}container.append(row);
  }
}
function setState(state,detail=''){
  const labels={idle:voiceSessionState.enabled?'Microphone paused':'Microphone off',opening:'Opening your microphone…',listening:'Listening…',transcribing:'Turning speech into text…',thinking:'Working…',desktop:'Working with your computer…',speaking:'Reading the reply aloud.'};
  $('voice-state').textContent=labels[state]||state;$('voice-detail').textContent=detail||(state==='idle'?'Type, or tap the mic.':'');
  $('corner-state').textContent=labels[state]||state;
  $('desktop-review-mic').textContent=state==='listening'?'Finish recording':'Speak this command';$('desktop-review-mic').setAttribute('aria-pressed',String(state==='listening'));
  $('mic-button').classList.toggle('recording',state==='listening');$('mic-button').classList.toggle('working',['thinking','transcribing','desktop'].includes(state));$('mic-button').setAttribute('aria-pressed',String(state==='listening'));$('mic-button').setAttribute('aria-label',state==='listening'?'Finish recording':'Start recording');
  $('turn-progress').hidden=!['thinking','transcribing','speaking','opening','listening','desktop'].includes(state);$('progress-text').textContent=state==='listening'?'Microphone on · up to 60 seconds':labels[state]||state;renderConversationControls();
}
function setBusy(busy){turnBusy=busy;if(busy)voiceSession?.pause('busy');renderConversationControls();if(!busy)maybeResume();}
function addMessage(role,text,label=role==='user'?'You':'Companion'){
  $('welcome-card').hidden=true;$('today-summary').hidden=true;$('today-bottom').hidden=true;
  const article=element('article','message '+role);article.append(element('div','message-label',label),element('div','message-text',text));
  if(role==='assistant'){latestAnswer={text};const actions=element('div','message-actions');actions.append(button('Save as a note','quiet-button',async()=>{try{await workspaceOperation('addNote',{text});toast('Saved in your notes.');}catch(error){toast(error.message);}}));article.append(actions);}
  $('messages').append(article);messages.push({role,text});updateCornerPreview(text);
  $('content-scroll').scrollTop=$('content-scroll').scrollHeight;return article;
}
function renderActionReceipts(container,actions,{historical=false,nested=false}={}){
  if(!container||!Array.isArray(actions))return;
  const labels={create_task:'Task saved',update_task:'Task updated',complete_task:'Task completed',save_note:'Note saved',list_tasks:'Tasks checked',list_notes:'Notes checked',search_notes:'Notes searched',read_note:'Note opened',start_focus:'Focus started',stop_focus:'Focus ended',save_workflow:'Workflow saved',run_workflow:'Workflow run',build_feature:'Feature build',list_feature_builds:'Builds checked',get_time:'Current time'};
  for(const action of actions){let result=action.result||{};if(historical&&result.desktopAction){const current=desktopActions.find(item=>item.id===result.desktopAction.id);if(current)result={...result,desktopAction:current};}const failed=action.status==='failed'||!!action.error||!!result.error;let text;
    if(failed){const error=result.error||action.error;text=(labels[action.tool]||toolLabel(action.arguments?.name||action.tool)||'Action')+' · could not finish: '+(typeof error==='string'?error:error?.message||'Unknown error');}
    else if(result.desktopAction){if(!historical)ingestDesktopResult(result);text=(desktopPending(result.desktopAction)?(historical?'Prepared desktop action · ':'Needs your review · '):DESKTOP_LABELS[result.desktopAction.status]+' · ')+result.desktopAction.summary;}
    else if(result.desktopReceipt){if(!historical)ingestDesktopResult(result);text=result.desktopReceipt.summary;}
    else if(result.capability)text=toolLabel(result.capability.name||action.arguments?.name||action.tool)+' · completed';
    else if(result.featureJob)text=historical?'Feature build requested · check build history for its current state':'Feature build started · '+(JOB_LABELS[result.featureJob.status]||result.featureJob.status);
    else if(result.task)text=(labels[action.tool]||'Task updated')+' · '+result.task.title;
    else if(result.note)text=(labels[action.tool]||'Note opened')+' · '+result.note.title;
    else if(Array.isArray(result.tasks))text='Tasks checked · '+result.tasks.length+' found';
    else if(Array.isArray(result.notes))text='Notes checked · '+result.notes.length+' found';
    else if(result.formatted)text=result.formatted;
    else text=action.summary||result.summary||result.message||labels[action.tool]||action.tool||'Action completed';
    const receipt=element('div','action-receipt'+(failed?' receipt-failed':''),text);container.append(receipt);
    if(!failed&&result.capability&&result.value)receipt.append(element('pre','capability-output',JSON.stringify(result.value,null,2).slice(0,4000)));
    if(!nested&&Array.isArray(result.hostActions))renderActionReceipts(receipt,result.hostActions,{historical,nested:true});
    if(!failed&&desktopPending(result.desktopAction))receipt.append(button('Review action ↗','quiet-button',()=>void openDesktopReview(result.desktopAction.id)));
  }
}
async function requestWithTurn(path,body,options,turn){const id=options?.requestId||crypto.randomUUID(),controller=new AbortController();activeRequest={id,controller,turn};const timeout=setTimeout(()=>controller.abort(),path==='transcribe'?90000:300000);try{const value=await api(path,{method:'POST',body:options?.raw?body:JSON.stringify({...body,id}),signal:controller.signal,raw:options?.raw,id,headers:options?.headers});if(value.id!==id)throw new Error('The response could not be matched to this request. Try again.');return value;}catch(error){if(error.name==='AbortError'&&turn===generation){void cancelBackend(id);throw new Error('This request took too long. Check your connection, then try again.');}throw error;}finally{clearTimeout(timeout);if(activeRequest?.id===id)activeRequest=null;}}
async function cancelBackend(id){if(!csrfToken||!id)return;try{await boundedApi('cancel',{method:'POST',body:JSON.stringify({id})},4000);}catch{}}
function cancelTurn(announce=true,{preserveVoice=false}={}){if(preserveVoice)voiceSession?.pause('hidden');else voiceSession?.disable({remember:false});const cancelledConversation=localChatTurn?.conversationId;localChatTurn=null;const wasWorking=turnBusy||!!activeRequest;generation+=1;voicePipeline=false;disableHandsFree();stopRecording(false);stopSpeech();if(activeRequest){const request=activeRequest;activeRequest=null;request.controller.abort();void cancelBackend(request.id);}setBusy(false);setState('idle');if(wasWorking&&!runtimeReconnectPromise)void refreshWorkspace().catch(()=>{});if(cancelledConversation===conversationId)void refreshConversation({quiet:true});renderSavedConversation();renderConversationControls();if(announce)toast('Stopped. Completed actions stay in your workspace.');}
$('cancel-turn').addEventListener('click',()=>{if(desktopToolBusy||desktopMutationBusy)stopAllActivity(true);else cancelTurn();});
async function runCommand(value,options={}){
  const message=value.trim();if(!message)return;if(await localDesktopApproval(message,options))return;if(await localVoiceCommand(message,options))return;if(options.voice&&options.approvalContext){$('desktop-review-error').textContent='Say “approve desktop action” or “cancel desktop action” for this preview. These words have not approved any input.';return;}
  if(turnBusy||runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy||conversationLoading)return;$('question-error').textContent='';
  const context=Object.hasOwn(options,'conversationContext')?options.conversationContext:captureConversationContext();if(!currentConversationContext(context)){$('question-error').textContent='The conversation changed. Review your words and send them in the intended conversation.';if(options.voice)voiceSession?.disable({remember:false});return;}
  if(conversationId&&conversationUncertain.has(conversationId)){$('question-error').textContent='Refresh this saved conversation before sending another request.';if(options.voice)voiceSession?.disable({remember:false});return;}
  if(!options.voice)ensureCornerExpanded();if(!options.voice&&(recording||microphoneOpening)){disableHandsFree();stopRecording(false);}
  const providerId=Object.hasOwn(options,'providerId')?options.providerId:activeProviderId;const provider=providers.find(item=>item.id===providerId);
  if(!provider?.ready){$('question-error').textContent=provider?.unavailableReason||'Choose an AI connection in Settings first. Your message stays here.';if(options.voice)voiceSession?.disable({remember:false});return;}
  conversationInitialized=true;const turn=++generation,requestId=crypto.randomUUID();setBusy(true);setState('thinking','Opening your saved conversation…');let targetId=context.id;
  try{
    const detail=await ensureConversation(context);if(turn!==generation||destroyed||!currentConversationContext(context))return;
    if(!context.id){conversationDrafts.set(detail.id,$('question').value);conversationDrafts.delete('new');conversationId=detail.id;context.id=detail.id;targetId=detail.id;newConversationRequest=null;store('conversationId',detail.id);}
    adoptConversation(detail,context);conversationInitialized=true;conversationError='';
    if(detail.activeRequestId||detail.turns.some(item=>item.status==='running'))throw new Error('A request is already running in this conversation. Wait, refresh, or open another conversation. Your draft is still here.');
    localChatTurn={id:requestId,conversationId:detail.id,message,providerId,status:'running',startedAt:new Date().toISOString()};renderSavedConversation();showView('today');setState('thinking',provider.label+' is working on your request.');
    const result=await requestWithTurn('chat',{message,providerId,conversationId:detail.id,expectedRevision:detail.revision},{requestId},turn);
    if(turn!==generation||destroyed||!currentConversationContext(context))return;if(typeof result.text!=='string')throw new Error('The AI returned an unreadable reply.');
    clearAcceptedDraft(localChatTurn);if(result.workspace)applyWorkspace(result.workspace);else void refreshWorkspace().catch(error=>toast(error.message));
    for(const action of result.actions||[])ingestDesktopResult(action.result);
    if(result.featureJob){const job=result.featureJob.job||result.featureJob;rememberJob(job);if(job.id){jobs=[job,...jobs.filter(item=>item.id!==job.id)];selectedJobId=job.id;renderJobs();}else refreshJobsSafely();}
    await refreshConversation();if(turn!==generation||!currentConversationContext(context))return;await speakText(result.text,turn);
  }catch(error){
    if(turn===generation&&currentConversationContext(context)&&error.name!=='AbortError'){
      $('question-error').textContent=error.message;
      if(error.conversation?.id===conversationId)adoptConversation(error.conversation,context);
      if(targetId){if(!error.status)conversationUncertain.set(targetId,{requestId,message});await refreshConversation({quiet:true});}
      void refreshWorkspace().catch(()=>{});if(options.voice)voiceSession?.disable({remember:false});
    }
  }finally{
    if(localChatTurn?.id===requestId)localChatTurn=null;
    if(turn===generation){voicePipeline=false;setBusy(false);setState('idle');renderSavedConversation();renderConversationControls();maybeResume();}
  }
}
$('question-form').addEventListener('submit',event=>{event.preventDefault();void runCommand($('question').value);});
$('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('question-form').requestSubmit();}});
$('question').addEventListener('input',()=>{$('question').style.height='auto';$('question').style.height=Math.min(110,$('question').scrollHeight)+'px';});
function localVoice() { return window.speechSynthesis?.getVoices().find(voice => voice.localService && /^en(?:-|$)/i.test(voice.lang)) || window.speechSynthesis?.getVoices().find(voice => voice.localService); }
function updateVoiceHelp(){const local=localVoice();$('voice-help').textContent=voiceSessionState.enabled?(!$('read-aloud').checked||!local?'Replies use text. Say “show chat” to read them.':'Speak, then pause. Voice pauses while Companion works.'):'Enable voice to listen. Chat is always available.';}
function stopSpeech() {
  speechGeneration += 1;
  window.speechSynthesis?.cancel(); speechResolve?.(); speechResolve = null;
}
async function speakText(text, turn = generation) {
  if (!$('read-aloud').checked || !window.speechSynthesis || document.hidden) return;
  const voice = localVoice(); if (!voice) { updateVoiceHelp(); return; }
  stopSpeech(); const version = speechGeneration;
  if (turn !== generation) return;
  setState('speaking', 'The microphone is paused while Companion speaks.');
  await new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 6000)); utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1;
    speechResolve = resolve;
    const done = () => { if (version === speechGeneration) speechResolve = null; resolve(); };
    utterance.onend = done; utterance.onerror = done; window.speechSynthesis.speak(utterance);
  });
}
$('read-aloud').addEventListener('change', () => {
  store('preferences', { readAloud: $('read-aloud').checked });
  if (!$('read-aloud').checked) stopSpeech();
  updateVoiceHelp();
});
window.speechSynthesis?.addEventListener('voiceschanged', updateVoiceHelp);
function disableHandsFree(){$('hands-free').checked=false;updateVoiceHelp();}
function renderVoiceControls(){
  $('voice-enable').textContent=voiceSessionState.enabled?'Turn voice off':'Enable voice';$('voice-enable').setAttribute('aria-pressed',String(voiceSessionState.enabled));$('voice-enable').disabled=!!runtimeReconnectPromise&&!voiceSessionState.enabled;
  document.body.classList.toggle('voice-enabled',voiceSessionState.enabled);document.body.classList.toggle('voice-listening',['listening','speech'].includes(voiceSessionState.status));updateVoiceHelp();
}
function releaseVoiceOwnership(){const entry=voiceOwnershipRequest;voiceOwnershipRequest=null;voiceOwnsCapture=false;entry?.release?.();entry?.resolve?.(false);}
async function ownVoice(action){
  if(voiceOwnsCapture)return action();if(voiceOwnershipRequest)return voiceOwnershipRequest.ready;
  if(!navigator.locks?.request){$('question-error').textContent='Automatic voice needs a browser with shared microphone coordination. Use the Companion desktop app or Chat.';return false;}
  let resolve;const entry={ready:new Promise(done=>resolve=done),resolve:null,release:null};entry.resolve=resolve;voiceOwnershipRequest=entry;
  entry.closed=navigator.locks.request('companion.voice.capture.v1',{mode:'exclusive',ifAvailable:true},async lock=>{
    if(voiceOwnershipRequest!==entry)return;
    if(!lock){voiceOwnershipRequest=null;entry.resolve(false);microphoneOpening=false;setState('idle');$('question-error').textContent='Voice is active in another Companion window. Turn it off there, then enable it here.';return;}
    voiceOwnsCapture=true;const held=new Promise(done=>entry.release=done);
    try{await action();entry.resolve(true);if(!voiceSession?.getState().enabled)releaseVoiceOwnership();await held;}
    catch(error){entry.resolve(false);$('question-error').textContent=error.message;releaseVoiceOwnership();}
    finally{if(voiceOwnershipRequest===entry){voiceOwnershipRequest=null;voiceOwnsCapture=false;}}
  }).catch(error=>{if(voiceOwnershipRequest===entry){releaseVoiceOwnership();$('question-error').textContent=error.message;}});
  return entry.ready;
}
function makeVoiceContext(){conversationInitialized=true;return {providerId:activeProviderId,conversationContext:clone(captureConversationContext()),approvalContext:clone(captureDesktopApprovalContext())};}
function initVoiceSession(){
  voiceSession=createVoiceSession({mediaDevices:navigator.mediaDevices,permissions:navigator.permissions,MediaRecorder:window.MediaRecorder,AudioContext:window.AudioContext||window.webkitAudioContext,now:()=>performance.now(),requestFrame:requestAnimationFrame,cancelFrame:cancelAnimationFrame,setTimer:setTimeout,clearTimer:clearTimeout,readOptIn:()=>readStored('voiceEnabled',false)===true,writeOptIn:value=>store('voiceEnabled',value),
    captureContext:()=>{const context=voiceFirstContext||makeVoiceContext();voiceFirstContext=null;voiceCaptureContext=clone(context);return context;},
    onState:state=>{voiceSessionState=state;microphoneOpening=state.status==='opening';recording=['listening','speech'].includes(state.status)?{controller:true,...clone(voiceCaptureContext)}:null;
      if(!state.enabled||!state.visible)releaseVoiceOwnership();
      if(state.status==='opening')setState('opening','Opening your microphone…');else if(['listening','speech'].includes(state.status))setState('listening','Pause when you finish speaking.');else if(state.status==='processing'&&!turnBusy)setState('transcribing','Microphone off while Companion works.');else if(!turnBusy&&!voicePipeline)setState('idle');
      renderConversationControls();renderVoiceControls();},
    onSegment:processVoiceSegment,onError:error=>{$('question-error').textContent=error.message;setState('idle');renderVoiceControls();}
  });
  if(document.hidden||nativeWindowVisible===false)void voiceSession.setVisible(false);renderVoiceControls();
}
async function restoreVoiceIfAllowed(){
  if(!voiceSession||destroyed||document.hidden||nativeWindowVisible===false||!service.transcriptionReady||runtimeReconnectPromise||readStored('voiceEnabled',false)!==true||(voiceSessionState.enabled&&voiceOwnsCapture))return;
  await ownVoice(async()=>{await voiceSession.setVisible(true);if(voiceSessionState.enabled)await voiceSession.resume();else await voiceSession.restore();});
}
function setVoiceVisible(visible){
  if(!voiceSession)return Promise.resolve();if(!visible){const entry=voiceOwnershipRequest,result=voiceSession.setVisible(false);releaseVoiceOwnership();return Promise.all([result,entry?.closed]);}
  if(document.hidden||nativeWindowVisible===false)return Promise.resolve();
  if(voiceOwnsCapture)return voiceSession.setVisible(true).then(()=>voiceSession.resume());return restoreVoiceIfAllowed();
}
function maybeResume(){if(!voiceSession||document.hidden||nativeWindowVisible===false||destroyed||turnBusy||runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy||!voiceOwnsCapture||(document.querySelector('dialog[open]')&&!voiceDialogOverride))return;void voiceSession.resume();}
async function startRecording(){
  if(!voiceSession||microphoneOpening||turnBusy||runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy||document.hidden||nativeWindowVisible===false||destroyed)return;
  $('question-error').textContent='';voiceDialogOverride=!!document.querySelector('dialog[open]');if(!service.transcriptionReady){$('question-error').textContent='Voice is not ready. Open Settings to check the speech service, or use Chat.';return;}
  if(voiceSessionState.enabled&&recording){voiceSession.finish();return;}
  if(voiceSessionState.enabled){const frozen=makeVoiceContext();await ownVoice(async()=>{voiceFirstContext=clone(frozen);await voiceSession.enable();});return;}
  const saved=readStored('preferences',{});if(!Object.hasOwn(saved||{},'readAloud')&&localVoice()){$('read-aloud').checked=true;$('settings-read-aloud').checked=true;store('preferences',{...saved,readAloud:true});}
  const frozen=makeVoiceContext();microphoneOpening=true;setState('opening','Opening your microphone…');
  await ownVoice(async()=>{voiceFirstContext=clone(frozen);await voiceSession.enable();});microphoneOpening=voiceSessionState.status==='opening';renderConversationControls();renderVoiceControls();
}
function stopRecording(submit=true){if(!voiceSession)return;if(submit)voiceSession.finish();else voiceSession.pause('stopped');recording=null;microphoneOpening=false;renderConversationControls();}
async function processVoiceSegment({blob,context,signal}){
  if(signal.aborted||destroyed||document.hidden||nativeWindowVisible===false)return;
  const entry={};activeVoiceSegment=entry;const turn=++generation;voicePipeline=true;setBusy(true);setState('transcribing','Microphone off while Companion works.');
  const abort=()=>{if(activeVoiceSegment===entry)cancelTurn(false,{preserveVoice:true});};signal.addEventListener('abort',abort,{once:true});
  try{const result=await requestWithTurn('transcribe',blob,{raw:true,headers:{'Content-Type':blob.type}},turn);if(signal.aborted||turn!==generation||destroyed)return;if(typeof result.text!=='string'||!result.text.trim())throw new Error('No words were detected. Please try again.');
    $('question').value=result.text.slice(0,4000);setBusy(false);await runCommand($('question').value,{voice:true,providerId:context?.providerId,conversationContext:context?.conversationContext,approvalContext:context?.approvalContext});
  }catch(error){if(!signal.aborted&&activeVoiceSegment===entry){$('question-error').textContent=error.message;voiceSession.disable({remember:false});}}
  finally{signal.removeEventListener('abort',abort);if(activeVoiceSegment===entry){activeVoiceSegment=null;voicePipeline=false;setBusy(false);if(!recording&&!microphoneOpening)setState('idle');maybeResume();}}
}
async function localVoiceCommand(message,options={}){
  if(!options.voice)return false;const phrase=message.trim().toLowerCase().replace(/[.!?]+$/,'');
  if(['stop listening','microphone off','mic off','turn voice off','disable voice'].includes(phrase)){voiceSession?.disable();stopSpeech();$('question').value='';return true;}
  if(['stop','cancel','stop current work','cancel current work','stop everything'].includes(phrase)){void stopAllActivity(true,{global:true});$('question').value='';return true;}
  const views={'show tasks':'tasks','open tasks':'tasks','show notes':'notes','open notes':'notes','show workflows':'workflows','open workflows':'workflows','show computer':'desktop','open computer':'desktop','show settings':'settings','open settings':'settings','show memory':'settings','open memory':'settings','show build':'build','open build':'build','build a feature':'build'};
  const featureMatch=/^(?:open|show) (?:the )?(?:(?:tool|feature) )?(.+)$/.exec(phrase),featureName=featureMatch?.[1],dynamicMatch=featureName&&[...extensions.values()].some(entry=>featureNames(entry).includes(normalizedFeatureName(featureName))),capabilityMatch=featureName&&toolCatalog.some(item=>item.kind==='capability'&&[item.title,item.name].some(value=>normalizedFeatureName(value)===normalizedFeatureName(featureName))),toolList=['show tools','open tools','list tools','show installed tools'].includes(phrase);
  const recognized=toolList||!!dynamicMatch||!!capabilityMatch||!!(featureName&&knownFeatureNames.has(normalizedFeatureName(featureName)))||/^(?:open|show) (?:the )?(?:tool|feature) /i.test(phrase)||['show chat','open chat','hide chat','close chat','new conversation','review desktop action','review computer action','close preview'].includes(phrase)||Object.hasOwn(views,phrase);if(!recognized)return false;
  if(!currentConversationContext(options.conversationContext)){$('question-error').textContent='The conversation changed. Repeat that command here.';voiceSession?.disable({remember:false});return true;}
  if(toolList)showToolsList();
  else if(dynamicMatch&&Object.hasOwn(views,phrase))showToolsList('More than one tool matches that name. Choose the installed tool below, or use the bottom controls.');
  else if(featureName&&!Object.hasOwn(views,phrase)&&!['show chat','open chat','show memory','open memory'].includes(phrase)){openFeatureByName(featureName);}
  else if(['show chat','open chat'].includes(phrase)){setChatOpen(true);ensureCornerExpanded();}
  else if(['hide chat','close chat'].includes(phrase))setChatOpen(false);
  else if(phrase==='new conversation')await selectConversation(null,{allowVoiceCommand:true});
  else if(phrase==='close preview')$('desktop-review-dialog').close();
  else if(phrase==='review desktop action'||phrase==='review computer action'){await refreshDesktop();const action=desktopActions.find(desktopPending);if(action)await openDesktopReview(action.id);else toast('No computer action needs review.');}
  else{showView(views[phrase]);ensureCornerExpanded();if(phrase.includes('memory'))$('memory-panel').scrollIntoView({block:'start'});}
  if($('question').value.trim()===message.trim())$('question').value='';return true;
}
$('voice-enable').addEventListener('click',()=>{if(voiceSessionState.enabled){voiceSession.disable();stopSpeech();}else void startRecording();});
$('voice-stop').addEventListener('click',()=>void stopAllActivity(true,{global:true}));
$('mic-button').addEventListener('click',()=>{if(recording)stopRecording(true);else if(microphoneOpening)cancelTurn(false);else if(turnBusy)toast('Use Stop to cancel this request.');else void startRecording();});
$('hands-free').addEventListener('change',()=>{if($('hands-free').checked)void startRecording();else voiceSession?.disable();});
$('settings-read-aloud').addEventListener('change',()=>{$('read-aloud').checked=$('settings-read-aloud').checked;$('read-aloud').dispatchEvent(new Event('change'));});
$('read-aloud').addEventListener('change',()=>{$('settings-read-aloud').checked=$('read-aloud').checked;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){setVoiceVisible(false);if(voicePipeline||recording||microphoneOpening)cancelTurn(false,{preserveVoice:true});else{disableHandsFree();stopSpeech();}$('provider-key').value='';}else{void setVoiceVisible(true);void checkService();void refreshConversations({initialize:true,quiet:true});}});
window.addEventListener('pagehide',event=>{setVoiceVisible(false);cancelTurn(false,{preserveVoice:true});if(!event.persisted)voiceSession?.destroy();extensionGeneration+=1;$('provider-key').value='';if(!event.persisted){destroyed=true;for(const unsubscribe of shellSubscriptions)if(typeof unsubscribe==='function')unsubscribe();}});
window.addEventListener('pageshow',event=>{if(!event.persisted)return;destroyed=false;setBusy(false);setState('idle');updateVoiceHelp();void setVoiceVisible(true);void checkService();void loadExtensions();});
initNativeShell();initVoiceSession();renderConversationControls();renderDesktopStatus();renderDesktopActions();providerFormType();renderTasks();renderNotes();renderWorkflows();renderJobs();updateVoiceHelp();
void checkService();void loadExtensions();
setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;renderFocus();if(jobs.some(job=>ACTIVE_JOBS.has(job.status))||currentView==='build')void refreshJobs().catch(error=>{$('build-error').textContent=error.message;});},2000);
setInterval(()=>{if(!document.hidden&&!destroyed&&!operationBusy&&!runtimeReconnectPromise)void refreshWorkspace().catch(error=>{$('connection-label').textContent=error.message;});},5000);
setInterval(()=>{if(!document.hidden&&!destroyed&&!turnBusy&&!recording&&!microphoneOpening&&!runtimeReconnectPromise)void checkService();},30000);

$('desktop-stop').addEventListener('click',()=>stopAllActivity(true));
$('desktop-review-stop').addEventListener('click',()=>stopAllActivity(true));
setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;if(currentView==='desktop'||$('desktop-review-dialog').open||desktopActions.some(action=>['pending','executing'].includes(action.status)))void refreshDesktop().catch(error=>{$('desktop-error').textContent=error.message;});},2500);

setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;if(selectedConversationRunning()||localChatTurn)void refreshConversation({quiet:true});},2500);
setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;void refreshConversations({initialize:true,quiet:true});},12000);
