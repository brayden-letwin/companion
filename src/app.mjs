import { sampleExpression } from './core/math.mjs';
import { concepts, familiarityLevels, cleanFamiliarity, localIntent, definitions, sampleExplanation, TurnState } from './core/tutor.mjs';

const $ = (id) => document.getElementById(id);
const desktop = window.companionDesktop;
const mode = new URLSearchParams(location.search).get('mode') || 'reader';
document.body.classList.add(`mode-${mode}`);
if (desktop) document.body.classList.add('desktop');
const SAMPLE = 'A first look at fixed points';
const SAMPLE_CONTEXT = { id: 'complete', documentId: 'sample', paper: SAMPLE, page: 1, text: document.querySelector('[data-target="complete"]').textContent.trim() };
const state = new TurnState(SAMPLE_CONTEXT);
let service = { aiConfigured: false, reasoningReady: false, transcriptionReady: false, provider: desktop ? 'unknown' : 'preview', desktop: Boolean(desktop) };
let connectionCheck = null;
let familiarity = cleanFamiliarity(readStored('familiarity', {}));
let speak = Boolean(readStored('readAloud', false));
let expanded = !desktop || mode !== 'companion';
let activeId = null;
let activeTurn = null;
let pending = null;
let recorder = null;
let mediaStream = null;
let recordingTurn = null;
let recordingTimer = null;
let recordingStarted = 0;
let latestAnswer = null;
let history = [];
let pdfReader = null;
let currentPaper = 'sample';
let hoverTimer;
let toastTimer;
let micOpening = false;
let speechVersion = 0;
let pdfDocumentId = null;
let pdfLoading = false;

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`companion.${key}`)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(`companion.${key}`, JSON.stringify(value)); return true; }
  catch { toast('Could not save on this device. Storage may be full.'); return false; }
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function status(message = '') { $('inline-status').textContent = message; }
function readerHint() {
  if (service.provider === 'local') return 'Point to a passage to give Companion context. Local questions and selected text stay on this PC.';
  if (service.provider === 'openai') return 'Opening a paper stays local. Asking the cloud AI sends only the selected passage and question context.';
  return 'Point to a passage to give Companion context. This browser preview reads papers locally.';
}
function renderConnection() {
  const ready = service.reasoningReady;
  const local = service.provider === 'local';
  const cloud = service.provider === 'openai';
  $('connection-label').textContent = local ? (ready ? 'LOCAL MODEL' : 'AI OFFLINE') : cloud ? (ready ? 'CLOUD AI' : 'AI OFFLINE') : desktop ? 'AI OFFLINE' : 'LOCAL SAMPLE';
  $('settings-connection').textContent = local ? (ready ? 'Local model is ready' : 'Local model is offline') : cloud ? (ready ? 'Cloud AI is connected' : 'Cloud AI is not connected') : desktop ? 'AI connection unavailable' : 'Browser preview';
  if (local) {
    $('settings-connection-detail').textContent = `${service.model || 'Companion’s local model'} runs on this PC. ${ready ? 'You can type a question now.' : service.unavailableReason || 'Start the local model, then refresh the connection.'} ${service.transcriptionReady ? 'Local voice input is available.' : 'Local voice input is not connected yet.'}`;
    $('connection-privacy').textContent = 'Your questions, selected passages, recent chat and familiarity settings are processed on this PC. Companion does not switch to a cloud service when the local model is unavailable. No background listening.';
    $('read-aloud-detail').textContent = 'Local mode uses an offline device voice only. If none is available, answers stay as text.';
  } else if (cloud) {
    $('settings-connection-detail').textContent = ready ? `Questions use ${service.model}. ${service.transcriptionReady ? 'Voice questions are transcribed when you finish recording.' : 'Voice input is unavailable.'} Live requests may incur API charges.` : service.unavailableReason || 'Connect the cloud service to ask open-ended questions. Local reading, plots and notes still work.';
    $('connection-privacy').textContent = 'When you ask, OpenAI receives your question, chosen passage, recent chat and stated familiarity. Submitted recordings go to OpenAI for transcription. Opening a PDF does not upload it. No background listening.';
    $('read-aloud-detail').textContent = 'Uses your device’s available synthetic voices; some voices may require a network connection.';
  } else {
    $('settings-connection-detail').textContent = desktop ? service.unavailableReason || 'The desktop connection could not be checked. Local tools still work.' : 'The sample paper includes prepared explanations. Plotting, notes and PDF reading work locally. Open the desktop app to use a connected model.';
    $('connection-privacy').textContent = 'The browser preview has no AI service connection. Papers, notes and familiarity settings stay in this local preview. Microphone transcription requires the desktop app.';
    $('read-aloud-detail').textContent = 'Uses your device’s available synthetic voices; some voices may require a network connection.';
  }
  $('refresh-connection').hidden = !desktop;
  if (currentPaper === 'sample') $('reader-hint').textContent = readerHint();
  if (desktop) $('mic-button').title = !service.transcriptionReady ? (local ? 'Local voice input is not connected. You can type a question.' : 'Voice input is not connected.') : service.shortcutAvailable ? 'Ctrl + Alt + Space to start or finish' : 'Global microphone shortcut unavailable. Use this button.';
}
async function refreshConnection(announce = false) {
  if (!desktop) { renderConnection(); return service; }
  if (connectionCheck) return connectionCheck;
  $('refresh-connection').disabled = true;
  $('refresh-connection').textContent = 'Checking…';
  connectionCheck = (async () => {
    try {
      const value = await desktop.getStatus();
      service = { ...value, reasoningReady: value.reasoningReady ?? Boolean(value.aiConfigured), transcriptionReady: value.transcriptionReady ?? (value.provider !== 'local' && Boolean(value.aiConfigured)), provider: value.provider || 'openai' };
    } catch {
      service = { ...service, aiConfigured: false, reasoningReady: false, transcriptionReady: false, unavailableReason: 'Could not check the desktop connection. Local tools still work.' };
    }
    renderConnection();
    if (announce) toast(service.reasoningReady ? `${service.provider === 'local' ? 'Local model' : 'Cloud AI'} is ready.` : 'AI is offline. Check the connection details.');
    return service;
  })();
  try { return await connectionCheck; }
  finally { connectionCheck = null; $('refresh-connection').disabled = false; $('refresh-connection').textContent = 'Refresh connection'; }
}
function setExpanded(value) {
  expanded = Boolean(value);
  $('companion').classList.toggle('expanded', expanded);
  $('companion').classList.toggle('collapsed', !expanded);
  $('toggle-panel').setAttribute('aria-expanded', String(expanded));
  $('collapse-panel').setAttribute('aria-label', expanded ? 'Collapse Companion' : 'Expand Companion');
  $('collapse-panel').textContent = expanded ? '−' : '+';
  if (desktop && mode === 'companion') desktop.setExpanded(expanded);
}
function showDialog(id) {
  setExpanded(true);
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function updateContext() {
  const context = state.context;
  const pinned = Boolean(state.pinned);
  const short = context.text ? context.text.slice(0, 42).replace(/\s+/g, ' ') : 'Point to a passage';
  $('context-label').textContent = `${pinned ? 'Pinned' : 'Following'} · ${short}${context.text?.length > 42 ? '…' : ''}`;
  $('context-chip').title = `${context.paper} · page ${context.page}\n${context.text}`;
  $('context-chip').classList.toggle('frozen', pinned);
  $('release-context').hidden = !pinned;
}
function point(context, publish = true) {
  if (context.documentId && context.documentId !== state.latest.documentId) {
    stopEverything(''); state.changeDocument(context); history = []; latestAnswer = null;
    $('messages').replaceChildren(); $('welcome').hidden = false;
  }
  state.point(context); updateContext();
  if (publish && desktop) desktop.publishContext(context);
}
function selectSample(element) {
  document.querySelectorAll('.passage.pointed').forEach(el => el.classList.remove('pointed'));
  element.classList.add('pointed');
  point({ id: element.dataset.target, documentId: 'sample', text: element.textContent.trim().replace(/\s+/g, ' '), paper: SAMPLE, page: 1 });
}
document.querySelectorAll('[data-target]').forEach(el => {
  el.addEventListener('pointerenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => selectSample(el), 400); });
  el.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
  el.addEventListener('click', () => selectSample(el));
  el.addEventListener('focus', () => selectSample(el));
});
function addMessage(role, text, label = role === 'user' ? 'You' : 'Companion', context = state.context) {
  $('welcome').hidden = true;
  const article = document.createElement('article'); article.className = `message ${role}`;
  const title = document.createElement('div'); title.className = 'message-label'; title.textContent = label;
  const body = document.createElement('div'); body.className = 'message-text'; body.textContent = text;
  article.append(title, body);
  if (role === 'assistant') {
    const actions = document.createElement('div'); actions.className = 'response-actions';
    const save = document.createElement('button'); save.textContent = 'Keep this thought'; save.addEventListener('click', () => saveNote(body.textContent, context));
    actions.append(save);
    if (context.documentId === 'sample' && label.includes('Sample')) {
      const simpler = document.createElement('button'); simpler.textContent = 'A simpler angle';
      simpler.addEventListener('click', () => { body.textContent = sampleExplanation(context, familiarity, true); latestAnswer = { text: body.textContent, context: { ...context } }; });
      actions.append(simpler);
    }
    article.append(actions); latestAnswer = { text, context: { ...context } };
  }
  $('messages').append(article);
  while ($('messages').children.length > 30) $('messages').firstElementChild.remove();
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return article;
}
function finishTurn(turn) {
  if (!state.isCurrent(turn)) return;
  pending?.remove(); pending = null;
  activeId = null; activeTurn = null;
  $('stop-button').hidden = true; $('companion-status').textContent = 'Here with you';
}
function readAloud(text) {
  if (!speak || !window.speechSynthesis) return;
  const version = ++speechVersion;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text); utterance.rate = .95;
  if (service.provider === 'local') {
    const voices = speechSynthesis.getVoices().filter(voice => voice.localService === true);
    const voice = voices.find(item => item.lang.toLowerCase().startsWith('en')) || voices[0];
    if (!voice) { status('No offline voice is available on this device. Your answer is shown as text.'); return; }
    utterance.voice = voice; utterance.lang = voice.lang;
  }
  $('stop-button').hidden = false;
  const finish = () => { if (version === speechVersion && !activeId && recorder?.state !== 'recording') $('stop-button').hidden = true; };
  utterance.onend = finish; utterance.onerror = finish;
  speechSynthesis.speak(utterance);
}
function stopEverything(message = 'Stopped.') {
  state.cancel();
  if (activeId && desktop) desktop.cancel(activeId);
  activeId = null; activeTurn = null; recordingTurn = null;
  if (recorder?.state === 'recording') recorder.stop();
  mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = null;
  clearTimeout(recordingTimer); micOpening = false;
  speechVersion += 1; window.speechSynthesis?.cancel();
  pending?.remove(); pending = null;
  $('stop-button').hidden = true; $('companion-status').textContent = 'Here with you';
  $('mic-button').classList.remove('recording'); $('mic-label').textContent = 'Talk it through';
  $('mic-button').setAttribute('aria-label', 'Start recording');
  status(message);
}

async function ask(question, existingTurn = null) {
  question = question.trim(); if (!question) return;
  if (/^stop[.!]?$/i.test(question)) { stopEverything(); return; }
  if (!existingTurn) stopEverything('');
  const turn = existingTurn || state.start();
  if (!state.isCurrent(turn)) return;
  const context = turn.context;
  activeTurn = turn; updateContext(); setExpanded(true); status('');
  $('question').value = '';
  addMessage('user', question);
  const intent = localIntent(question);
  if (intent.type === 'plot') {
    const result = openPlot(intent.expression);
    addMessage('assistant', result ? `Plotted f(x) = ${intent.expression}. The graph is in your math canvas.` : 'I could not draw that expression. The math canvas shows what needs changing.', 'Local action', context);
    finishTurn(turn); return;
  }
  if (intent.type === 'enlarge') { enlarge(context); finishTurn(turn); return; }
  if (intent.type === 'note') { saveNote(intent.text, context); finishTurn(turn); return; }
  if (intent.type === 'definition') {
    const text = definitions[intent.concept];
    addMessage('assistant', text, 'Local glossary', context); finishTurn(turn); readAloud(text); return;
  }
  if (desktop) {
    $('stop-button').hidden = false;
    $('companion-status').textContent = 'Checking the connection…';
    await refreshConnection();
    if (!state.isCurrent(turn)) return;
  }
  if (!service.reasoningReady) {
    if (context.documentId === 'sample') {
      const text = sampleExplanation(context, familiarity);
      addMessage('assistant', text, 'Sample walkthrough · prepared', context);
      status(service.provider === 'local' ? 'The local model is offline. This is a prepared passage walkthrough.' : 'This is a prepared passage walkthrough. Connect AI for open-ended questions.');
      finishTurn(turn); readAloud(text); return;
    } else {
      addMessage('assistant', service.provider === 'local' ? `Your passage is selected, but the local model is unavailable. ${service.unavailableReason || 'Start it and refresh the connection in Preferences.'} Your question has not been sent to a cloud service. You can still enlarge text, plot functions, and save notes.` : 'Your passage is selected. Connect AI in the desktop app to ask about this paper. You can already enlarge text, plot a function, use the local glossary, and save your thoughts.', 'AI not connected', context);
    }
    finishTurn(turn); return;
  }
  const id = crypto.randomUUID(); activeId = id;
  $('stop-button').hidden = false; $('companion-status').textContent = 'Thinking with you…';
  pending = document.createElement('div'); pending.className = 'pending'; pending.textContent = 'Following your thought…'; $('messages').append(pending);
  try {
    const result = await desktop.ask({ id, question, context, familiarity, history: history.slice(-8) });
    if (!state.isCurrent(turn)) return;
    finishTurn(turn); addMessage('assistant', result.text, service.provider === 'local' ? 'Companion · local AI' : 'Companion · cloud AI', context);
    history.push({ role: 'user', text: question }, { role: 'assistant', text: result.text.slice(0, 6000) }); history = history.slice(-8);
    readAloud(result.text);
  } catch (error) { if (state.isCurrent(turn)) { finishTurn(turn); status(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
}

async function toggleMic() {
  setExpanded(true);
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  if (micOpening) return;
  stopEverything(''); micOpening = true;
  const turn = state.start(); recordingTurn = turn; updateContext();
  $('stop-button').hidden = false;
  let acquiredStream = null;
  try {
    if (desktop) await refreshConnection();
    if (!state.isCurrent(turn)) return;
    if (!service.transcriptionReady) { finishTurn(turn); status(service.provider === 'local' ? `${service.transcriptionUnavailableReason || 'Local voice input is not connected yet.'} You can type your question.` : 'Voice needs a transcription service connected in the desktop app. You can type a question or try the sample now.'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { finishTurn(turn); status('Microphone recording is unavailable in this browser. Use the desktop app.'); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    acquiredStream = stream;
    if (!state.isCurrent(turn)) { stream.getTracks().forEach(track => track.stop()); return; }
    mediaStream = stream;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const recording = new MediaRecorder(stream, { mimeType }); recorder = recording;
    let ownTimer = null;
    const chunks = []; let bytes = 0;
    recording.addEventListener('dataavailable', event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 9*1024*1024) stopEverything('Recording is too large. Try a shorter question.'); } });
    recording.addEventListener('error', () => stopEverything('The microphone stopped unexpectedly. Please try again.'));
    recording.addEventListener('stop', async () => {
      stream.getTracks().forEach(track => track.stop()); clearTimeout(ownTimer);
      if (recorder === recording) recorder = null;
      if (!state.isCurrent(turn) || recordingTurn !== turn) return;
      $('mic-button').classList.remove('recording'); $('mic-label').textContent = 'Talk it through'; $('mic-button').setAttribute('aria-label', 'Start recording');
      if (Date.now() - recordingStarted < 400 || !bytes) { status('That was a little short. Try again.'); finishTurn(turn); return; }
      const id = crypto.randomUUID(); activeId = id;
      $('companion-status').textContent = 'Listening back…'; status('Transcribing your question…');
      try {
        const audio = await new Blob(chunks, { type: mimeType }).arrayBuffer();
        if (!state.isCurrent(turn)) return;
        const { text } = await desktop.transcribe({ id, bytes: audio, mimeType });
        if (!state.isCurrent(turn)) return;
        activeId = null;
        if (!text.trim()) { finishTurn(turn); status('I didn’t catch any words. Try again.'); return; }
        await ask(text, turn);
      } catch (error) { if (state.isCurrent(turn)) { finishTurn(turn); status(error.message); } }
    });
    recording.start(1000); recordingStarted = Date.now();
    $('mic-button').classList.add('recording'); $('mic-label').textContent = 'Finish question'; $('mic-button').setAttribute('aria-label', 'Finish recording');
    $('stop-button').hidden = false; $('companion-status').textContent = 'Listening…';
    status('Passage pinned. Tap the microphone when you’re done.');
    ownTimer = setTimeout(() => { if (recording.state === 'recording') recording.stop(); }, 60000); recordingTimer = ownTimer;
  } catch (error) { acquiredStream?.getTracks().forEach(track => track.stop()); if (state.isCurrent(turn)) { finishTurn(turn); status(error.name === 'NotAllowedError' ? 'Microphone permission was not granted. You can still type your question.' : `Could not start the microphone: ${error.message}`); } }
  finally { if (recordingTurn === turn) micOpening = false; }
}

function enlarge(context = state.context) {
  if (!context.text) { status('Point to some text first.'); return; }
  $('detail-title').textContent = 'One idea, a little larger.';
  const text = document.createElement('div'); text.className = 'large-passage'; text.textContent = context.text;
  const source = document.createElement('div'); source.className = 'source-line'; source.textContent = `${context.paper} · page ${context.page}`;
  $('detail-body').replaceChildren(text, source); showDialog('detail-dialog');
}

function notes() { const value = readStored('notes', []); return Array.isArray(value) ? value.filter(n => n && typeof n.text === 'string' && typeof n.id === 'string').slice(0, 200) : []; }
function updateNoteCount() { document.querySelectorAll('.note-count').forEach(el => { el.textContent = notes().length; }); }
function saveNote(text, context = state.context) {
  if (!text?.trim()) { status('Ask a question or select a passage first.'); return; }
  const existing = notes();
  if (existing.some(n => n.text === text && n.context?.text === context.text && n.context?.paper === context.paper)) { toast('That thought is already in your notes.'); return; }
  if (existing.length >= 200) { toast('Your notebook is full. Export or remove some notes first.'); return; }
  existing.unshift({ id: crypto.randomUUID(), text: text.slice(0, 12000), context: { ...context }, date: new Date().toISOString() });
  if (store('notes', existing)) { updateNoteCount(); toast('Thought saved to your notes.'); }
}
function renderNotes() {
  const list = notes(); $('notes-list').replaceChildren();
  if (!list.length) { const empty = document.createElement('p'); empty.className = 'empty-notes'; empty.textContent = 'A place for the ideas that click.'; $('notes-list').append(empty); }
  for (const note of list) {
    const article = document.createElement('article'); article.className = 'note';
    const text = document.createElement('p'); text.textContent = note.text; article.append(text);
    if (note.context?.text && note.context.text !== note.text) { const quote = document.createElement('blockquote'); quote.textContent = note.context.text; article.append(quote); }
    const source = document.createElement('small'); source.textContent = `${note.context?.paper || 'Math canvas'} · page ${note.context?.page || 1} · ${new Date(note.date).toLocaleDateString()}`; article.append(source);
    const remove = document.createElement('button'); remove.textContent = 'Remove note'; remove.addEventListener('click', () => { if (store('notes', notes().filter(n => n.id !== note.id))) { renderNotes(); updateNoteCount(); } }); article.append(remove);
    $('notes-list').append(article);
  }
  $('export-notes').disabled = !list.length;
}
function exportNotes() {
  const text = '# Companion notes\n\n' + notes().map(n => `${n.text}\n\n> ${n.context?.text || ''}\n\nSource: ${n.context?.paper || 'Unknown'} · page ${n.context?.page || 1}\nSaved: ${n.date}\n\n---\n`).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'companion-notes.md'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function openPlot(expression) { if (expression) $('plot-expression').value = expression; showDialog('plot-dialog'); return drawPlot(); }
function drawPlot() {
  const canvas = $('plot-canvas'); const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height); $('plot-caption').textContent = ''; $('plot-error').textContent = '';
  try {
    const result = sampleExpression($('plot-expression').value, Number($('plot-min').value), Number($('plot-max').value));
    const { minX, maxX, minY, maxY } = result;
    const left = 60, top = 24, width = canvas.width - 86, height = canvas.height - 76;
    const x = n => left + (n - minX) / (maxX - minX) * width;
    const y = n => top + height - (n - minY) / (maxY - minY) * height;
    ctx.fillStyle = '#f7f7f1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#e2e7d9'; ctx.lineWidth = 1; ctx.font = '17px Segoe UI'; ctx.fillStyle = '#879779';
    for (let i = 0; i <= 6; i++) {
      const xv = minX + (maxX-minX)*i/6, yv = minY + (maxY-minY)*i/6;
      ctx.beginPath(); ctx.moveTo(x(xv), top); ctx.lineTo(x(xv), top+height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left, y(yv)); ctx.lineTo(left+width, y(yv)); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(formatNumber(xv), x(xv), top+height+28);
      ctx.textAlign = 'right'; ctx.fillText(formatNumber(yv), left-9, y(yv)+5);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.strokeStyle = '#a8b99b'; ctx.lineWidth = 1.5;
    if (minX <= 0 && maxX >= 0) { ctx.beginPath(); ctx.moveTo(x(0),top); ctx.lineTo(x(0),top+height); ctx.stroke(); }
    if (minY <= 0 && maxY >= 0) { ctx.beginPath(); ctx.moveTo(left,y(0)); ctx.lineTo(left+width,y(0)); ctx.stroke(); }
    ctx.strokeStyle = '#5c7e4d'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    for (const segment of result.segments) { ctx.beginPath(); segment.forEach((p, i) => i ? ctx.lineTo(x(p.x),y(p.y)) : ctx.moveTo(x(p.x),y(p.y))); ctx.stroke(); }
    ctx.restore();
    $('plot-caption').textContent = `f(x) = ${result.expression} · ${result.points.length} samples · undefined regions omitted`;
    canvas.setAttribute('aria-label', `Graph of ${result.expression} from ${minX} to ${maxX}. Numerical sampling; undefined regions omitted.`);
    return true;
  } catch (error) { $('plot-error').textContent = error.message; return false; }
}
function formatNumber(value) { return Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < .01) ? value.toExponential(1) : Number(value.toPrecision(3)).toString(); }

function renderPreferences() {
  $('familiarity-fields').replaceChildren();
  for (const concept of Object.keys(concepts)) {
    const label = document.createElement('label'); label.className = 'familiarity-row'; label.textContent = concept;
    const select = document.createElement('select'); select.setAttribute('aria-label', concept);
    for (const level of familiarityLevels) { const option = document.createElement('option'); option.textContent = level; option.value = level; select.append(option); }
    select.value = familiarity[concept];
    select.addEventListener('change', () => { familiarity[concept] = select.value; store('familiarity', familiarity); });
    label.append(select); $('familiarity-fields').append(label);
  }
  $('read-aloud').checked = speak;
}

async function loadPdf(file) {
  if (!file || pdfLoading) return;
  pdfLoading = true; $('import-pdf').disabled = true;
  stopEverything('');
  const wasPdf = currentPaper === 'pdf';
  const previousDocumentId = pdfDocumentId;
  pdfDocumentId = crypto.randomUUID();
  $('pdf-view').hidden = false; $('sample-paper').hidden = true;
  try {
    if (!pdfReader) {
      const { createPdfReader } = await import('./core/pdf-reader.mjs');
      pdfReader = createPdfReader({ canvas: $('pdf-canvas'), textLayer: $('pdf-text'),
        onContext: context => point({ ...context, id: 'pdf', documentId: pdfDocumentId }),
        onStatus: info => {
          $('reader-hint').textContent = info.error || info.message || 'Point to selectable text to ask about this passage. Mathematics in PDFs may extract imperfectly; check your selected passage.';
          $('page-label').textContent = info.pages ? `${info.page} / ${info.pages}` : '…';
          $('prev-page').disabled = info.loading || info.page <= 1;
          $('next-page').disabled = info.loading || info.page >= info.pages;
          if (info.error) toast(info.error);
        },
      });
    }
    const success = await pdfReader.load(file);
    if (!success) { pdfDocumentId = previousDocumentId; $('pdf-view').hidden = !wasPdf; $('sample-paper').hidden = wasPdf; return; }
    currentPaper = 'pdf'; history = []; latestAnswer = null;
    $('paper-name').textContent = file.name; $('document-label').textContent = file.name; $('document-tag').textContent = 'LOCAL PDF';
    $('return-sample').hidden = false; document.querySelector('.outline').hidden = true;
  } catch (error) { pdfDocumentId = previousDocumentId; $('pdf-view').hidden = !wasPdf; $('sample-paper').hidden = wasPdf; toast(`Could not open this PDF: ${error.message}`); }
  finally { $('pdf-file').value = ''; pdfLoading = false; $('import-pdf').disabled = false; }
}
function returnSample() {
  stopEverything(''); pdfReader?.destroy(); pdfReader = null; currentPaper = 'sample';
  $('pdf-view').hidden = true; $('sample-paper').hidden = false; $('return-sample').hidden = true;
  document.querySelector('.outline').hidden = false; $('paper-name').textContent = SAMPLE; $('document-label').textContent = SAMPLE;
  $('document-tag').textContent = 'SAMPLE PAPER'; $('page-label').textContent = '1 / 1'; $('prev-page').disabled = true; $('next-page').disabled = true;
  $('reader-hint').textContent = readerHint();
  history = []; latestAnswer = null; state.release(); point(SAMPLE_CONTEXT);
}

$('question-form').addEventListener('submit', event => { event.preventDefault(); void ask($('question').value); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask($('question').value); } });
$('toggle-panel').addEventListener('click', () => setExpanded(!expanded));
$('collapse-panel').addEventListener('click', () => setExpanded(!expanded));
$('open-reader').addEventListener('click', () => desktop ? desktop.openReader() : window.scrollTo({ top: 0, behavior: 'smooth' }));
$('release-context').addEventListener('click', () => { if (activeId || recorder?.state === 'recording' || micOpening) { status('Finish or stop your question before changing its passage.'); return; } state.release(); updateContext(); });
$('mic-button').addEventListener('click', toggleMic); $('stop-button').addEventListener('click', () => stopEverything());
$('enlarge-action').addEventListener('click', () => enlarge()); $('suggest-larger').addEventListener('click', () => enlarge());
$('suggest-explain').addEventListener('click', () => ask('Why does this converge?'));
$('plot-action').addEventListener('click', () => openPlot()); $('plot-nav').addEventListener('click', () => openPlot());
$('plot-form').addEventListener('submit', event => { event.preventDefault(); drawPlot(); });
$('save-action').addEventListener('click', () => saveNote(latestAnswer?.text || state.context.text, latestAnswer?.context || state.context));
$('notes-nav').addEventListener('click', () => { renderNotes(); showDialog('notes-dialog'); });
$('export-notes').addEventListener('click', exportNotes);
for (const id of ['settings-nav', 'corner-settings']) $(id).addEventListener('click', () => { renderPreferences(); showDialog('settings-dialog'); });
$('refresh-connection').addEventListener('click', () => void refreshConnection(true));
$('forget-profile').addEventListener('click', () => { familiarity = cleanFamiliarity({}); store('familiarity', familiarity); renderPreferences(); toast('Familiarity preferences cleared.'); });
$('read-aloud').addEventListener('change', event => { speak = event.target.checked; store('readAloud', speak); if (!speak) window.speechSynthesis?.cancel(); });
$('import-pdf').addEventListener('click', () => $('pdf-file').click());
$('pdf-file').addEventListener('change', event => void loadPdf(event.target.files?.[0]));
$('prev-page').addEventListener('click', () => pdfReader?.previous()); $('next-page').addEventListener('click', () => pdfReader?.next());
$('return-sample').addEventListener('click', returnSample);
$('reading-nav').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('group-nav').addEventListener('click', () => desktop ? desktop.openGroup() : window.location.assign('group.html'));
$('shared-nav').addEventListener('click', async () => {
  if (!desktop) { window.location.assign('http://127.0.0.1:4174/room.html'); return; }
  try { await desktop.openSharedRoom(); }
  catch { toast('Could not open the shared room. Start its local server, then open http://127.0.0.1:4174/room.html.'); }
});
document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => $(button.dataset.section).scrollIntoView({ behavior: 'smooth', block: 'center' })));
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const b = dialog.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) dialog.close(); } }));
window.addEventListener('keydown', event => { if (event.key === 'Escape' && (activeId || recorder?.state === 'recording' || micOpening || window.speechSynthesis?.speaking)) stopEverything(); });
window.addEventListener('storage', event => { if (event.key === 'companion.familiarity') familiarity = cleanFamiliarity(readStored('familiarity', {})); if (event.key === 'companion.notes') updateNoteCount(); if (event.key === 'companion.readAloud') speak = Boolean(readStored('readAloud', false)); });
window.addEventListener('beforeunload', () => { stopEverything(''); pdfReader?.destroy(); });
if (desktop) {
  desktop.onContext(context => point(context, false)); desktop.onToggleMic(toggleMic); desktop.onStop(() => stopEverything());
  await refreshConnection();
}
setExpanded(expanded); updateContext(); updateNoteCount(); renderPreferences(); renderConnection();
if (desktop && mode === 'reader') desktop.publishContext(SAMPLE_CONTEXT);
