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
let currentView = 'today', showCompleted = false, workspacePending = false, jobsPending = false;
let operationBusy = false, featureBusy = false, providerBusy = false, editingProviderId = null, editingTarget = null;
let pendingWorkspaceRequest = null;
let generation = 0, activeRequest = null, recording = null, microphoneOpening = false, turnBusy = false;
let speechGeneration = 0, speechResolve = null, voicePipeline = false, destroyed = false, messages = [], latestAnswer = null, toastTimer = null;
let workflowEditingId = null, workflowEditingRevision = null, workflowDraft = [], featureRenderKey = '', extensionRefreshKey = '', extensionGeneration = 0;
const extensions = new Map();
const runningWorkflows = new Set(), workflowResults = new Map();
const jobDetails = new Map(), jobDetailPending = new Set();
const jobDetailRetryAt = new Map();
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
function emptyState(title,description) { const node=element('div','empty-state'); node.append(element('span','empty-glyph','✧'),element('h2','',title),element('p','',description)); return node; }
function showDialog(id) { ensureCornerExpanded();disableHandsFree(); if(recording||microphoneOpening)stopRecording(false); if(!$(id).open)$(id).showModal(); }
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
  $('corner-hide').addEventListener('click',()=>{if(!nativeShell)return;cancelTurn(false);try{nativeShell.hide();}catch{toast('The corner could not be hidden.');}});
  $('corner-desktop').addEventListener('click',()=>{ensureCornerExpanded();showView('desktop');});
  $('restart-desktop').addEventListener('click',restartNativeDesktop);
  if(!nativeShell)return;
  try{
    shellSubscriptions.push(nativeShell.onStop(event=>{if(event?.reason==='hidden')cancelTurn(false);else stopAllActivity(false,{global:event?.reason==='shortcut'});}));
    shellSubscriptions.push(nativeShell.onModeChanged(state=>{
      if(!state||state.mode!==nativeShell.mode)return;
      if(typeof state.expanded==='boolean')cornerExpanded=state.expanded;
      if(typeof state.sourceRuntime==='boolean'){nativeSourceRuntime=state.sourceRuntime;featureRenderKey='';renderJobs();}
      if(state.visible===false)cancelTurn(false);if(typeof state.visible==='boolean')nativeWindowVisible=state.visible;
      if(state.shortcuts){$('native-shortcut-hint').hidden=false;$('native-shortcut-hint').textContent=[state.shortcuts.toggle?'Ctrl + Alt + Space shows corner':'Corner shortcut unavailable',state.shortcuts.stop?'Ctrl + Alt + Esc stops':'Global stop unavailable'].join(' · ');}
      renderCorner();
    }));
  }catch{toast('Native window controls are unavailable.');}
}
function restartNativeDesktop(){if(typeof nativeShell?.restart!=='function'){toast('Close and relaunch the Companion desktop app to load its updated controls.');return;}stopAllActivity();try{nativeShell.restart();}catch{toast('The desktop app could not be relaunched.');}}
function desktopUpdateNotice(){return nativeSourceRuntime===true?'Desktop source changed. Restart the desktop app to load its updated controls; a server-worker restart does not reload desktop code.':nativeSourceRuntime===false?'Desktop source changed. Rebuild the desktop app to load it; relaunching this copied package does not load repository edits.':'Desktop source changed. Relaunch from the updated source, or rebuild a copied desktop package, to load it.';}
for(const close of document.querySelectorAll('.close-dialog'))close.addEventListener('click',()=>close.closest('dialog').close());
function showView(view) {
  if(!['today','tasks','notes','workflows','build','settings','desktop'].includes(view)&&!extensions.has(view))return;
  currentView=view;
  document.querySelectorAll('.view-panel').forEach(panel=>panel.hidden=panel.id!==view+'-view');
  document.querySelectorAll('[data-view]').forEach(item=>{item.classList.toggle('active',item.dataset.view===view);item.setAttribute('aria-current',item.dataset.view===view?'page':'false');});
  $('view-title').textContent=extensions.get(view)?.title||({today:'Today',tasks:'Tasks',notes:'Notes',workflows:'Workflows',build:'Build a feature',settings:'Settings',desktop:'Computer'})[view];
  $('content-scroll').scrollTop=0;
  if(view==='settings'){renderProviders();renderRuntime();if(!mcpConfiguration)void loadIntegrations();void refreshDesktop().catch(error=>{$('desktop-settings-status').textContent=error.message;});}
  if(view==='build'){renderJobs();refreshJobsSafely();}
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
  if(!response.ok){const error=new Error(data?.error?.message||'This request could not be completed.');error.code=data?.error?.code;error.status=response.status;error.workspace=data?.workspace;error.actions=data?.actions;throw error;}
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
  if(!turnBusy&&!recording&&!microphoneOpening)setState('idle');updateVoiceHelp();
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
async function loadIntegrations(){
  if(integrationsPending||destroyed||runtimeReconnectPromise)return;integrationsPending=true;$('mcp-load').disabled=true;$('mcp-error').textContent='';
  mcpConfiguration='';$('mcp-copy').disabled=true;$('mcp-config-panel').hidden=true;
  try{
    if(!csrfToken)await checkService();
    const value=await boundedApi('integrations');
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
  finally{clearTimeout(timeout);if(activeDesktopRequest?.turn===turn)activeDesktopRequest=null;if(turn===desktopExecutionGeneration){desktopToolBusy=false;setState('idle');renderDesktopStatus();renderRuntime();}}
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
  finally{clearTimeout(timeout);if(activeDesktopRequest?.turn===turn)activeDesktopRequest=null;if(turn===desktopExecutionGeneration){desktopMutationBusy=false;renderDesktopReview();renderDesktopStatus();renderRuntime();}}
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
function renderWorkflows(){const list=$('workflow-list');list.replaceChildren();if(!workspace?.workflows.length)list.append(emptyState('No workflows yet.','Create a workflow from the actions you use often.'));
  for(const flow of workspace?.workflows||[]){const wrapper=element('div'),card=element('article','workflow-card'),info=element('div','workflow-info');info.append(element('h2','',flow.name),element('p','',flow.description||'Saved actions, ready to run.'),element('small','',`${flow.steps?.length||0} steps${flow.enabled===false?' · Disabled':''}`));const actions=element('div','workflow-actions');const run=button(runningWorkflows.has(flow.id)?'Running…':'Run workflow ↗','secondary-button',()=>void runWorkflow(flow));run.disabled=flow.enabled===false||runningWorkflows.has(flow.id);actions.append(run,button('Edit','quiet-button',()=>openWorkflow(flow)));card.append(element('span','workflow-icon','↳'),info,actions);wrapper.append(card);const result=workflowResults.get(flow.id);if(result){const receipt=element('div','workflow-result');receipt.append(element('strong','',result.status==='completed'?'Workflow finished.':'Workflow stopped: '+(result.error||'A step could not finish.')));for(const [index,step]of(result.steps||[]).entries())receipt.append(element('div','',`${index+1}. ${STEP_TYPES[step.tool]||step.tool} · completed`));wrapper.append(receipt);}list.append(wrapper);}
}
async function runWorkflow(flow){if(runningWorkflows.has(flow.id)||runtimeReconnectPromise)return;runningWorkflows.add(flow.id);renderWorkflows();$('workflow-error').textContent='';try{const result=await boundedApi(`workspace/workflows/${encodeURIComponent(flow.id)}/run`,{method:'POST',body:JSON.stringify({operationId:crypto.randomUUID()})},45000);workflowResults.set(flow.id,result);if(result.workspace)applyWorkspace(result.workspace);toast(result.status==='completed'?'Workflow finished.':'The workflow stopped before all steps finished.');}catch(error){$('workflow-error').textContent=error.message;}finally{runningWorkflows.delete(flow.id);renderWorkflows();}}
function openWorkflow(flow=null){workflowEditingId=flow?.id||null;workflowEditingRevision=workspace?.revision;$('workflow-name').value=flow?.name||'';$('workflow-description').value=flow?.description||'';workflowDraft=clone(flow?.steps||[{tool:'create_task',arguments:{title:''}}]);$('workflow-form-error').textContent='';renderWorkflowSteps();showDialog('workflow-dialog');}
const STEP_TYPES={create_task:'Create a task',save_note:'Save a note',start_focus:'Start focus time',stop_focus:'End focus time',list_tasks:'List tasks',list_notes:'List notes',search_notes:'Search notes'};
function renderWorkflowSteps(){const list=$('workflow-steps');list.replaceChildren();workflowDraft.forEach((step,index)=>{const row=element('div','workflow-step'),header=element('div','workflow-step-header'),select=element('select');select.setAttribute('aria-label',`Action for step ${index+1}`);for(const [value,label] of Object.entries(STEP_TYPES)){const option=element('option','',label);option.value=value;select.append(option);}if(!STEP_TYPES[step.tool]){const option=element('option','',step.tool);option.value=step.tool;select.append(option);}select.value=step.tool;select.addEventListener('change',()=>{workflowDraft[index]={tool:select.value,arguments:{}};renderWorkflowSteps();});header.append(element('span','',String(index+1).padStart(2,'0')),select,button('Remove','quiet-button',()=>{workflowDraft.splice(index,1);renderWorkflowSteps();}));row.append(header);
    if(['create_task','save_note','start_focus','search_notes'].includes(step.tool)){const field=element(step.tool==='save_note'?'textarea':'input');field.setAttribute('aria-label',step.tool==='start_focus'?'Focus minutes':`Content for step ${index+1}`);if(step.tool==='start_focus'){field.type='number';field.min='1';field.max='240';field.value=step.arguments?.minutes||25;}else{field.maxLength=step.tool==='save_note'?12000:300;field.placeholder=step.tool==='create_task'?'Task title':step.tool==='save_note'?'The note to save':'Words to search for';field.value=step.arguments?.title||step.arguments?.text||step.arguments?.query||'';}field.addEventListener('input',()=>{const key=step.tool==='create_task'?'title':step.tool==='save_note'?'text':step.tool==='start_focus'?'minutes':'query';workflowDraft[index].arguments={...workflowDraft[index].arguments,[key]:step.tool==='start_focus'?Number(field.value):field.value};});row.append(field);if(step.tool==='start_focus')workflowDraft[index].arguments={...step.arguments,minutes:Number(field.value)};}
    list.append(row);});}
$('new-workflow').addEventListener('click',()=>openWorkflow());$('add-workflow-step').addEventListener('click',()=>{if(workflowDraft.length>=12){toast('Keep this workflow to 12 steps.');return;}workflowDraft.push({tool:'create_task',arguments:{title:''}});renderWorkflowSteps();});
$('workflow-form').addEventListener('submit',async event=>{event.preventDefault();$('workflow-form-error').textContent='';$('workflow-save').disabled=true;try{if(!workflowDraft.length)throw new Error('Add at least one step.');if(workflowEditingId&&workflowEditingRevision!==workspace.revision){workflowEditingRevision=workspace.revision;throw new Error('Your workspace changed. Review these steps, then save again.');}for(const[index,step]of workflowDraft.entries()){const required={create_task:'title',save_note:'text',search_notes:'query'}[step.tool];if(required&&!String(step.arguments?.[required]||'').trim())throw new Error(`Add the content for step ${index+1}.`);if(step.tool==='start_focus'&&(!Number.isInteger(step.arguments?.minutes)||step.arguments.minutes<1||step.arguments.minutes>240))throw new Error(`Choose 1 to 240 focus minutes for step ${index+1}.`);}await workspaceOperation('saveWorkflow',{...(workflowEditingId?{workflowId:workflowEditingId}:{}),name:$('workflow-name').value.trim(),description:$('workflow-description').value.trim(),steps:clone(workflowDraft),enabled:true});$('workflow-dialog').close();}catch(error){$('workflow-form-error').textContent=error.message;workflowEditingRevision=workspace?.revision;}finally{$('workflow-save').disabled=false;}});
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
async function refreshJobs(){if(jobsPending||destroyed)return;jobsPending=true;try{const value=await boundedApi('features');if(!Array.isArray(value.jobs))throw new Error('Feature builds could not be read.');jobs=value.jobs;if(!selectedJobId&&jobs.length)selectedJobId=jobs[0].id;renderJobs();const activation=jobs.filter(job=>['applied','rolled_back'].includes(job.status)).map(job=>job.id+':'+job.status+':'+job.updatedAt).join('|');if(activation!==extensionRefreshKey){extensionRefreshKey=activation;void loadExtensions();}}finally{jobsPending=false;}}
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
  if(actions.childNodes.length)detail.append(actions);
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
async function loadExtensions(){
  const version=++extensionGeneration;
  try{const response=await fetch('/src/features/manifest.json',{cache:'no-store',credentials:'same-origin'});if(version!==extensionGeneration)return;if(response.status===404){for(const[id,entry]of extensions){try{entry.cleanup?.();}catch{}entry.panel.remove();entry.button.remove();extensions.delete(id);}if(currentView.startsWith('extension-'))showView('today');$('extension-nav').hidden=true;return;}if(!response.ok)throw new Error('Installed features could not be loaded.');const manifest=await response.json();if(version!==extensionGeneration)return;if(manifest.version!==1||!Array.isArray(manifest.features)||manifest.features.length>40)throw new Error('The feature manifest could not be read.');
    const nextIds=new Set();
    for(const feature of manifest.features){if(!feature||!/^[a-z][a-z0-9-]{0,63}$/.test(feature.id)||typeof feature.title!=='string'||feature.title.length>100||!/^\.\/features\/[a-z][a-z0-9-]{0,59}\.mjs$/.test(feature.module))continue;const id='extension-'+feature.id;nextIds.add(id);const old=extensions.get(id);try{old?.cleanup?.();}catch{}old?.panel.remove();old?.button.remove();
      const panel=element('section','view-panel extension-panel');panel.id=id+'-view';panel.hidden=currentView!==id;
      const nav=button(feature.title,'nav-item',()=>showView(id));nav.dataset.view=id;nav.setAttribute('aria-label',feature.title);nav.title=feature.title;$('extension-panels').append(panel);$('extension-nav').append(nav);const entry={panel,button:nav,title:feature.title,cleanup:null};extensions.set(id,entry);
      try{const module=await import(new URL(feature.module+'?activation='+Date.now(),import.meta.url).href);if(version!==extensionGeneration){panel.remove();nav.remove();return;}if(typeof module.mount!=='function')throw new Error('This feature has no interface.');const cleanup=await module.mount({container:panel,api:Object.freeze({getWorkspace:async()=>clone(workspace),workspaceOperation,runTool:async(tool,args={})=>{if(runtimeReconnectPromise)throw new Error('Companion is reconnecting. Try this action again when it is ready.');const result=await boundedApi('tools/run',{method:'POST',body:JSON.stringify({tool,arguments:args,operationId:crypto.randomUUID()})},45000);if(result.workspace)applyWorkspace(result.workspace);ingestDesktopResult(result.result);if(result.result?.desktopAction)void refreshDesktop().catch(error=>toast(error.message));return result;},notify:toast})});if(version!==extensionGeneration){if(typeof cleanup==='function'){try{cleanup();}catch{}}panel.remove();nav.remove();if(extensions.get(id)===entry)extensions.delete(id);return;}if(typeof cleanup==='function')entry.cleanup=cleanup;}catch(error){panel.replaceChildren(emptyState('This feature could not open.',error.message));}
    }
    if(version!==extensionGeneration)return;for(const [id,entry] of extensions){if(nextIds.has(id))continue;try{entry.cleanup?.();}catch{}entry.panel.remove();entry.button.remove();extensions.delete(id);if(currentView===id)showView('today');}$('extension-nav').hidden=!extensions.size;
  }catch(error){toast(error.message);}
}
function setState(state,detail=''){
  const labels={idle:'Here when you need me.',opening:'Opening your microphone…',listening:'Listening to you.',transcribing:'Turning speech into text…',thinking:'Working on it…',desktop:'Working with your computer…',speaking:'Reading the reply aloud.'};
  $('voice-state').textContent=labels[state]||state;$('voice-detail').textContent=detail||(state==='idle'?'Type, or tap the mic.':'');
  $('corner-state').textContent=labels[state]||state;
  $('desktop-review-mic').textContent=state==='listening'?'Finish recording':'Speak this command';$('desktop-review-mic').setAttribute('aria-pressed',String(state==='listening'));
  $('mic-button').classList.toggle('recording',state==='listening');$('mic-button').classList.toggle('working',['thinking','transcribing','desktop'].includes(state));$('mic-button').setAttribute('aria-pressed',String(state==='listening'));$('mic-button').setAttribute('aria-label',state==='listening'?'Finish recording':'Start recording');
  $('turn-progress').hidden=!['thinking','transcribing','speaking','opening','listening','desktop'].includes(state);$('progress-text').textContent=state==='listening'?'Microphone on · up to 60 seconds':labels[state]||state;
}
function setBusy(busy){turnBusy=busy;$('send-question').disabled=busy||!!runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy;}
function addMessage(role,text,label=role==='user'?'You':'Companion'){
  $('welcome-card').hidden=true;$('today-summary').hidden=true;$('today-bottom').hidden=true;
  const article=element('article','message '+role);article.append(element('div','message-label',label),element('div','message-text',text));
  if(role==='assistant'){latestAnswer={text};const actions=element('div','message-actions');actions.append(button('Save as a note','quiet-button',async()=>{try{await workspaceOperation('addNote',{text});toast('Saved in your notes.');}catch(error){toast(error.message);}}));article.append(actions);}
  $('messages').append(article);messages.push({role,text});if(messages.length>40)messages.shift();while($('messages').children.length>40)$('messages').firstElementChild.remove();updateCornerPreview(text);
  $('content-scroll').scrollTop=$('content-scroll').scrollHeight;return article;
}
function renderActionReceipts(container,actions){
  if(!container||!Array.isArray(actions))return;
  const labels={create_task:'Task saved',update_task:'Task updated',complete_task:'Task completed',save_note:'Note saved',list_tasks:'Tasks checked',list_notes:'Notes checked',search_notes:'Notes searched',read_note:'Note opened',start_focus:'Focus started',stop_focus:'Focus ended',save_workflow:'Workflow saved',run_workflow:'Workflow run',build_feature:'Feature build',list_feature_builds:'Builds checked',get_time:'Current time'};
  for(const action of actions){const result=action.result||{},failed=action.status==='failed'||!!action.error||!!result.error;let text;
    if(failed){const error=result.error||action.error;text=(labels[action.tool]||action.tool||'Action')+' · could not finish: '+(typeof error==='string'?error:error?.message||'Unknown error');}
    else if(result.desktopAction){ingestDesktopResult(result);text=(desktopPending(result.desktopAction)?'Needs your review · ':DESKTOP_LABELS[result.desktopAction.status]+' · ')+result.desktopAction.summary;}
    else if(result.desktopReceipt){ingestDesktopResult(result);text=result.desktopReceipt.summary;}
    else if(result.featureJob)text='Feature build started · '+(JOB_LABELS[result.featureJob.status]||result.featureJob.status);
    else if(result.task)text=(labels[action.tool]||'Task updated')+' · '+result.task.title;
    else if(result.note)text=(labels[action.tool]||'Note opened')+' · '+result.note.title;
    else if(Array.isArray(result.tasks))text='Tasks checked · '+result.tasks.length+' found';
    else if(Array.isArray(result.notes))text='Notes checked · '+result.notes.length+' found';
    else if(result.formatted)text=result.formatted;
    else text=action.summary||result.summary||result.message||labels[action.tool]||action.tool||'Action completed';
    const receipt=element('div','action-receipt'+(failed?' receipt-failed':''),text);container.append(receipt);
    if(!failed&&desktopPending(result.desktopAction))receipt.append(button('Review action ↗','quiet-button',()=>void openDesktopReview(result.desktopAction.id)));
  }
}
async function requestWithTurn(path,body,options,turn){const id=crypto.randomUUID(),controller=new AbortController();activeRequest={id,controller,turn};const timeout=setTimeout(()=>controller.abort(),path==='transcribe'?90000:300000);try{const value=await api(path,{method:'POST',body:options?.raw?body:JSON.stringify({...body,id}),signal:controller.signal,raw:options?.raw,id,headers:options?.headers});if(value.id!==id)throw new Error('The response could not be matched to this request. Try again.');return value;}catch(error){if(error.name==='AbortError'&&turn===generation){void cancelBackend(id);throw new Error('This request took too long. Check your connection, then try again.');}throw error;}finally{clearTimeout(timeout);if(activeRequest?.id===id)activeRequest=null;}}
async function cancelBackend(id){if(!csrfToken||!id)return;try{await boundedApi('cancel',{method:'POST',body:JSON.stringify({id})},4000);}catch{}}
function cancelTurn(announce=true){const wasWorking=turnBusy||!!activeRequest;generation+=1;voicePipeline=false;disableHandsFree();stopRecording(false);stopSpeech();if(activeRequest){const request=activeRequest;activeRequest=null;request.controller.abort();void cancelBackend(request.id);}setBusy(false);setState('idle');if(wasWorking&&!runtimeReconnectPromise)void refreshWorkspace().catch(()=>{});if(announce)toast('Stopped. Completed actions stay in your workspace.');}
$('cancel-turn').addEventListener('click',()=>{if(desktopToolBusy||desktopMutationBusy)stopAllActivity(true);else cancelTurn();});
async function runCommand(value,options={}){
  const message=value.trim();if(!message)return;if(await localDesktopApproval(message,options))return;if(options.voice&&options.approvalContext){$('desktop-review-error').textContent='Say “approve desktop action” or “cancel desktop action” for this preview. These words have not approved any input.';return;}if(turnBusy||runtimeReconnectPromise||desktopToolBusy||desktopMutationBusy)return;$('question-error').textContent='';
  ensureCornerExpanded();
  if(!options.voice&&(recording||microphoneOpening)){disableHandsFree();stopRecording(false);}
  const providerId=Object.hasOwn(options,'providerId')?options.providerId:activeProviderId;const provider=providers.find(item=>item.id===providerId);
  if(!provider?.ready){$('question-error').textContent=provider?.unavailableReason||'Choose an AI connection in Settings first. Your message stays here.';if(options.voice)disableHandsFree();return;}
  const turn=++generation,history=messages.filter(item=>['user','assistant'].includes(item.role)&&item.text.length<=12000).slice(-12).map(({role,text})=>({role,text}));
  showView('today');addMessage('user',message);$('question').value='';setBusy(true);setState('thinking',provider.label+' is working on your request.');
  try{const result=await requestWithTurn('chat',{message,providerId,history},{},turn);if(turn!==generation||destroyed)return;if(typeof result.text!=='string')throw new Error('The AI returned an unreadable reply.');
    const article=addMessage('assistant',result.text,'Companion · '+provider.label);
    renderActionReceipts(article,result.actions);
    if(result.workspace)applyWorkspace(result.workspace);else void refreshWorkspace().catch(error=>toast(error.message));
    if(result.featureJob){const job=result.featureJob.job||result.featureJob;rememberJob(job);if(job.id){jobs=[job,...jobs.filter(item=>item.id!==job.id)];selectedJobId=job.id;renderJobs();article.append(button('View feature build ↗','quiet-button',()=>showView('build')));}else refreshJobsSafely();}
    await speakText(result.text,turn);
  }catch(error){if(turn===generation&&error.name!=='AbortError'){$('question-error').textContent=error.message;renderActionReceipts($('messages').lastElementChild,error.actions);void refreshWorkspace().catch(()=>{});if(options.voice)disableHandsFree();}}
  finally{if(turn===generation){voicePipeline=false;setBusy(false);setState('idle');maybeResume();}}
}
$('question-form').addEventListener('submit',event=>{event.preventDefault();void runCommand($('question').value);});
$('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('question-form').requestSubmit();}});
$('question').addEventListener('input',()=>{$('question').style.height='auto';$('question').style.height=Math.min(110,$('question').scrollHeight)+'px';});
function localVoice() { return window.speechSynthesis?.getVoices().find(voice => voice.localService && /^en(?:-|$)/i.test(voice.lang)) || window.speechSynthesis?.getVoices().find(voice => voice.localService); }
function updateVoiceHelp() {
  const local = localVoice();
  $('voice-help').textContent = $('read-aloud').checked && !local ? 'No offline device voice is available. Answers stay as text.' : $('hands-free').checked ? 'Hands-free is on. Pause to send; Companion pauses while answering.' : 'Mic only listens when you turn it on.';
}
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
function disableHandsFree() { $('hands-free').checked = false; updateVoiceHelp(); }
function maybeResume() {
  if (!$('hands-free').checked || document.hidden || destroyed || turnBusy || recording || microphoneOpening || document.querySelector('dialog[open]')) return;
  setTimeout(() => { if ($('hands-free').checked && !document.hidden && !turnBusy && !recording && !microphoneOpening) void startRecording(); }, 450);
}
async function startRecording() {
  if (recording || microphoneOpening || turnBusy || runtimeReconnectPromise || desktopToolBusy || desktopMutationBusy || document.hidden || destroyed) return;
  ensureCornerExpanded();
  $('question-error').textContent = '';
  if (!service.transcriptionReady) { disableHandsFree(); $('question-error').textContent = 'Voice input is not ready. Open Connection details, or type a message.'; return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { disableHandsFree(); $('question-error').textContent = 'This browser cannot record audio. You can type a message instead.'; return; }
  const frozenProviderId = activeProviderId;
  const frozenApprovalContext = clone(captureDesktopApprovalContext());
  stopSpeech(); const turn = ++generation; microphoneOpening = true; voicePipeline = true; setState('opening', 'Your browser may ask for microphone access.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (turn !== generation || document.hidden || destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const item = { recorder, stream, turn, providerId: frozenProviderId, approvalContext:frozenApprovalContext, chunks: [], bytes: 0, submit: true, timer: null, frame: null, audioContext: null, speech: false, firstSound: 0, lastSound: 0, started: performance.now(), silenceChecked: false };
    recording = item;
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size) return; item.bytes += event.data.size; item.chunks.push(event.data);
      if (item.bytes > 10 * 1024 * 1024) { item.submit = false; stopRecording(false); $('question-error').textContent = 'That recording was too large. Try a shorter question.'; disableHandsFree(); }
    });
    recorder.addEventListener('error', () => { item.submit = false; disableHandsFree(); stopRecording(false); $('question-error').textContent = 'The recording stopped unexpectedly. Try the microphone again.'; });
    recorder.addEventListener('stop', () => finishRecording(item));
    recorder.start(500); item.timer = setTimeout(() => stopRecording(true), MAX_RECORDING);
    if ($('hands-free').checked) attachSilenceDetection(item);
    setState('listening', $('hands-free').checked ? 'Pause when you finish. Tap the mic to finish sooner.' : 'Tap the mic again when you finish. Up to 60 seconds.');
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (turn === generation) {
      voicePipeline = false; disableHandsFree(); setState('idle');
      $('question-error').textContent = error.name === 'NotAllowedError' ? 'Microphone access was not allowed. You can type below or enable microphone access in your browser.' : 'The microphone could not be opened. Check that it is connected and try again.';
    }
  } finally { if (turn === generation) microphoneOpening = false; }
}
function attachSilenceDetection(item) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) { disableHandsFree(); toast('Automatic turn ending is unavailable. Tap the mic to finish.'); return; }
  try {
    const audio = new AudioContext(); item.audioContext = audio;
    const input = audio.createMediaStreamSource(item.stream), analyser = audio.createAnalyser(); analyser.fftSize = 1024; input.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    void audio.resume().catch(() => {});
    const check = () => {
      if (recording !== item || item.recorder.state !== 'recording') return;
      analyser.getFloatTimeDomainData(buffer); const rms = Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length); const now = performance.now();
      if (rms > .022) { item.lastSound = now; item.firstSound ||= now; item.speech = true; }
      if (item.speech && now - item.lastSound > 1500 && now - item.firstSound > 500) { item.silenceChecked = true; stopRecording(true); return; }
      if (!item.speech && now - item.started > 10_000) { item.submit = false; item.silenceChecked = true; stopRecording(false, true); return; }
      item.frame = requestAnimationFrame(check);
    };
    item.frame = requestAnimationFrame(check);
  } catch { disableHandsFree(); toast('Tap the microphone when you finish; automatic turn ending is unavailable.'); }
}
function stopRecording(submit = true, resume = false) {
  const item = recording;
  if (!item) {
    if (microphoneOpening) { generation += 1; microphoneOpening = false; setState('idle'); }
    return;
  }
  item.submit = submit; item.resume = resume; clearTimeout(item.timer); cancelAnimationFrame(item.frame);
  if (item.recorder.state !== 'inactive') item.recorder.stop();
  item.stream.getTracks().forEach(track => track.stop()); void item.audioContext?.close().catch(() => {});
  recording = null;
  if (!submit) setState('idle');
}
async function finishRecording(item) {
  if (!item.submit || item.turn !== generation || destroyed || document.hidden) { if (item.turn === generation) voicePipeline = false; if (item.resume && item.turn === generation) maybeResume(); return; }
  const blob = new Blob(item.chunks, { type: item.recorder.mimeType || 'audio/webm' });
  if (blob.size < 100) { $('question-error').textContent = 'That recording was too short. Try again.'; setState('idle'); disableHandsFree(); return; }
  setBusy(true); setState('transcribing', 'The microphone is off while your speech becomes text.');
  try {
    const result = await requestWithTurn('transcribe', blob, { raw: true, headers: { 'Content-Type': blob.type } }, item.turn);
    if (item.turn !== generation || destroyed) return;
    if (typeof result.text !== 'string' || !result.text.trim()) { disableHandsFree(); throw new Error('No words were detected. Tap the microphone to try again.'); }
    $('question').value = result.text.slice(0, 4000); setBusy(false);
    await runCommand($('question').value, { providerId: item.providerId, approvalContext:item.approvalContext, voice: true });
  } catch (error) {
    if (item.turn === generation && error.name !== 'AbortError') { $('question-error').textContent = error.message; disableHandsFree(); }
  } finally {
    if (item.turn === generation) { voicePipeline = false; setBusy(false); setState('idle'); maybeResume(); }
  }
}
$('mic-button').addEventListener('click', () => {
  if (recording) stopRecording(true);
  else if (microphoneOpening) cancelTurn(false);
  else if (turnBusy) toast('Wait for this reply, or use Cancel to stop it.');
  else void startRecording();
});
$('hands-free').addEventListener('change', () => {
  updateVoiceHelp();
  if ($('hands-free').checked) {
    if (document.hidden || turnBusy || document.querySelector('dialog[open]')) { disableHandsFree(); toast('Turn on hands-free when this page is ready.'); return; }
    if (recording) { attachSilenceDetection(recording); setState('listening', 'Pause when you finish. Tap the mic to finish sooner.'); }
    else void startRecording();
  } else { if (recording || microphoneOpening) stopRecording(false); }
});


$('settings-read-aloud').addEventListener('change',()=>{$('read-aloud').checked=$('settings-read-aloud').checked;$('read-aloud').dispatchEvent(new Event('change'));});
$('read-aloud').addEventListener('change',()=>{$('settings-read-aloud').checked=$('read-aloud').checked;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(voicePipeline||recording||microphoneOpening)cancelTurn(false);else{disableHandsFree();stopSpeech();}$('provider-key').value='';}else{void checkService();}});
window.addEventListener('pagehide',event=>{cancelTurn(false);extensionGeneration+=1;$('provider-key').value='';if(!event.persisted){destroyed=true;for(const unsubscribe of shellSubscriptions)if(typeof unsubscribe==='function')unsubscribe();}});
window.addEventListener('pageshow',event=>{if(!event.persisted)return;destroyed=false;setBusy(false);setState('idle');updateVoiceHelp();void checkService();void loadExtensions();});
initNativeShell();renderDesktopStatus();renderDesktopActions();providerFormType();renderTasks();renderNotes();renderWorkflows();renderJobs();updateVoiceHelp();
void checkService();void loadExtensions();
setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;renderFocus();if(jobs.some(job=>ACTIVE_JOBS.has(job.status))||currentView==='build')void refreshJobs().catch(error=>{$('build-error').textContent=error.message;});},2000);
setInterval(()=>{if(!document.hidden&&!destroyed&&!operationBusy&&!runtimeReconnectPromise)void refreshWorkspace().catch(error=>{$('connection-label').textContent=error.message;});},5000);
setInterval(()=>{if(!document.hidden&&!destroyed&&!turnBusy&&!recording&&!microphoneOpening&&!runtimeReconnectPromise)void checkService();},30000);

$('desktop-stop').addEventListener('click',()=>stopAllActivity(true));
$('desktop-review-stop').addEventListener('click',()=>stopAllActivity(true));
setInterval(()=>{if(document.hidden||destroyed||runtimeReconnectPromise)return;if(currentView==='desktop'||$('desktop-review-dialog').open||desktopActions.some(action=>['pending','executing'].includes(action.status)))void refreshDesktop().catch(error=>{$('desktop-error').textContent=error.message;});},2500);
