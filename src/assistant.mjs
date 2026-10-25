import { SAMPLE_PAPER, buildReadingGraph, parseCommand, searchNotes, pinSource, prepareHistory } from './core/assistant.mjs';
import { sampleExpression } from './core/math.mjs';
import { concepts, familiarityLevels, cleanFamiliarity, definitions } from './core/tutor.mjs';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const STORAGE = 'companion.personal.v1.';
const MAX_RECORDING = 60_000;
let graph = buildReadingGraph();
const sampleGraph = graph;
const samplePassages = graph.nodes.filter(node => node.type === 'passage');
let selectedNode = null;
let selectedSource = null;
let currentPaper = SAMPLE_PAPER.title;
let pdfReader = null;
let pdfDocumentId = null;
let pdfPassages = [];
let pdfImportGeneration = 0;
let pdfReaderGeneration = 0;
let pdfImportPending = false;
let service = { reasoningReady: false, transcriptionReady: false, provider: 'local' };
let csrfToken = '';
let checkingService = null;
let serviceError = '';
let generation = 0;
let activeRequest = null;
let recording = null;
let microphoneOpening = false;
let turnBusy = false;
let speechGeneration = 0;
let speechResolve = null;
let voicePipeline = false;
let messages = [];
let latestAnswer = null;
let toastTimer = null;
let destroyed = false;
let profile = cleanFamiliarity(readStored('profile', {}));
let notes = cleanNotes(readStored('notes', []));
let preferences = readStored('preferences', {});
$('read-aloud').checked = preferences?.readAloud === true;

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(STORAGE + key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(STORAGE + key, JSON.stringify(value)); return true; }
  catch { toast('This browser could not save your changes.'); return false; }
}
function cleanNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(note => note && typeof note.id === 'string' && typeof note.text === 'string')
    .slice(0, 100).map(note => ({ id: note.id.slice(0, 100), text: note.text.slice(0, 4000), createdAt: typeof note.createdAt === 'string' ? note.createdAt : '', source: note.source && typeof note.source.text === 'string' ? { ...note.source, text: note.source.text.slice(0, 1500), paper: String(note.source.paper || '').slice(0, 200) } : null }));
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
function clone(value) { return value ? JSON.parse(JSON.stringify(value)) : null; }
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function showDialog(id) {
  disableHandsFree();
  if (recording || microphoneOpening) stopRecording(false);
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());

function graphLayout(nodes) {
  const center = nodes.find(node => node.id === 'passage:theorem') || nodes.find(node => node.id === 'concept:fixed-point') || nodes[0];
  const others = nodes.filter(node => node !== center);
  const spots = [[17,24],[79,22],[84,54],[76,82],[25,83],[13,55],[48,13],[48,88]];
  const map = new Map();
  if (center) map.set(center.id, { x: 48, y: 48, central: true });
  others.forEach((node, i) => { const [x,y] = spots[i] || [50 + 35 * Math.cos(i * 2.4), 50 + 32 * Math.sin(i * 2.4)]; map.set(node.id, { x, y }); });
  return map;
}
function renderGraph() {
  const conceptNodes = graph.nodes.filter(node => node.type === 'concept');
  const visibleNodes = graph.prepared && conceptNodes.length
    ? [...graph.nodes.filter(node => ['passage:theorem', 'passage:bound'].includes(node.id)), ...conceptNodes]
    : graph.nodes.slice(-7);
  const layout = graphLayout(visibleNodes);
  $('graph-nodes').replaceChildren(); $('graph-lines').replaceChildren();
  if (!visibleNodes.length) {
    const empty = element('button', 'graph-empty', 'Select a passage in your PDF\nYour reading map starts there.');
    empty.addEventListener('click', () => showDialog('paper-dialog')); $('graph-nodes').append(empty);
  }
  for (const edge of graph.edges) {
    const a = layout.get(edge.source), b = layout.get(edge.target);
    if (!a || !b) continue;
    const line = svgElement('line', { x1: a.x * 7.8, y1: a.y * 3.9, x2: b.x * 7.8, y2: b.y * 3.9 });
    if (selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id)) line.classList.add('selected');
    $('graph-lines').append(line);
    const dot = svgElement('circle', { cx: (a.x + b.x) * 3.9, cy: (a.y + b.y) * 1.95, r: 2 });
    $('graph-lines').append(dot);
  }
  visibleNodes.forEach(node => {
    const position = layout.get(node.id);
    const button = element('button', `graph-node${position.central ? ' central' : ''}${selectedNode?.id === node.id ? ' active' : ''}`);
    button.dataset.nodeId = node.id;
    button.style.left = `${position.x}%`; button.style.top = `${position.y}%`;
    button.setAttribute('aria-pressed', String(selectedNode?.id === node.id));
    const label = element('span', 'node-label'); label.append(element('span', 'node-type', node.type === 'concept' ? 'CONCEPT' : 'PASSAGE'), document.createTextNode(node.label));
    button.append(element('span', 'node-dot'), label);
    button.addEventListener('click', () => selectNode(node));
    $('graph-nodes').append(button);
  });
  $('map-caption').textContent = graph.prepared ? 'A reading map of our original sample, not an AI analysis.' : 'Passages you selected in this PDF. No connections have been inferred.';
  document.querySelector('.map-badge').lastChild.textContent = graph.prepared ? 'Source map' : 'Your passages';
  document.querySelector('.graph-key').hidden = !graph.prepared;
}
function selectNode(node) {
  selectedNode = node;
  selectedSource = pinSource(node.source || node, { paper: node.source?.paper || currentPaper, documentId: node.source?.documentId || 'sample', kind: node.source?.kind || 'sample' });
  renderGraph(); renderSource();
  document.querySelectorAll('.sample-passage').forEach(item => item.classList.toggle('active', item.dataset.passageId === selectedSource.passageId || item.dataset.passageId === selectedSource.id));
}
function renderSource() {
  $('source-heading').textContent = selectedNode?.label || selectedSource?.label || 'Selected passage';
  $('source-text').textContent = selectedSource?.text || 'Choose a line in your PDF. Its exact text will appear here.';
  $('source-page').textContent = `${currentPaper !== SAMPLE_PAPER.title ? 'YOUR PDF' : 'SAMPLE'} · PAGE ${selectedSource?.page || pdfReader?.getState().page || 1}`;
  $('attached-source').textContent = selectedSource?.text ? 'WITH SELECTED PASSAGE' : 'NO PASSAGE SELECTED';
  $('explain-source').disabled = !selectedSource?.text;
  $('save-source').disabled = !selectedSource?.text;
  $('source-hint').textContent = activeRequest ? 'Your current question keeps the passage it started with.' : 'This passage will be attached to your next question.';
}
function renderSamplePaper() {
  $('sample-passages').replaceChildren();
  samplePassages.forEach(node => {
    const button = element('button', 'sample-passage'); button.dataset.passageId = node.passageId || node.source?.passageId || node.source?.id || node.id.replace(/^passage:/, '');
    button.append(element('strong', '', node.label), document.createTextNode(node.text || node.source?.text || ''));
    button.addEventListener('click', () => { returnToSample(false); selectNode(sampleGraph.nodes.find(item => item.id === node.id) || node); toast('Passage selected for your next question.'); });
    $('sample-passages').append(button);
  });
}
function returnToSample(announce = true) {
  pdfImportGeneration += 1; pdfReaderGeneration += 1;
  pdfImportPending = false; $('import-pdf').disabled = false;
  pdfReader?.destroy(); pdfReader = null; pdfDocumentId = null; pdfPassages = [];
  graph = sampleGraph; currentPaper = SAMPLE_PAPER.title;
  $('paper-title').textContent = currentPaper; $('reader-title').textContent = currentPaper;
  $('sample-passages').hidden = false; $('pdf-view').hidden = true; $('reset-map').hidden = true;
  $('reader-status').textContent = 'Select a passage to give Companion context.';
  $('reader-page').textContent = '1 / 1'; $('previous-page').disabled = true; $('next-page').disabled = true;
  const initial = graph.nodes.find(node => node.id === 'passage:theorem') || graph.nodes[0];
  if (initial) selectNode(initial);
  if (announce) toast('Back to the sample paper.');
}
$('map-nav').addEventListener('click', () => $('source-panel').scrollIntoView({ block: 'nearest' }));
$('paper-nav').addEventListener('click', () => showDialog('paper-dialog'));
$('source-toggle').addEventListener('click', () => showDialog('paper-dialog'));
$('reset-map').addEventListener('click', () => returnToSample());
$('import-pdf').addEventListener('click', () => { disableHandsFree(); $('pdf-file').click(); });
$('pdf-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  if (pdfImportPending) { toast('Let this PDF finish opening, then choose another.'); return; }
  const importGeneration = ++pdfImportGeneration;
  pdfImportPending = true; $('import-pdf').disabled = true;
  showDialog('paper-dialog');
  try {
    if (!pdfReader) {
      const { createPdfReader } = await import('./core/pdf-reader.mjs');
      if (importGeneration !== pdfImportGeneration || destroyed) return;
      const readerGeneration = ++pdfReaderGeneration;
      pdfReader = createPdfReader({ canvas: $('pdf-canvas'), textLayer: $('pdf-text'),
        onStatus: state => { if (readerGeneration === pdfReaderGeneration && !destroyed) renderPdfStatus(state); },
        onContext: context => { if (readerGeneration === pdfReaderGeneration && !destroyed) receivePdfContext(context); } });
    }
    const previousId = pdfDocumentId, previousPassages = pdfPassages;
    pdfDocumentId = crypto.randomUUID(); pdfPassages = [];
    const loaded = await pdfReader.load(file);
    if (!loaded && importGeneration === pdfImportGeneration) { pdfDocumentId = previousId; pdfPassages = previousPassages; }
  } catch (error) { if (importGeneration === pdfImportGeneration) $('reader-status').textContent = error.message || 'The PDF could not be opened.'; }
  finally { if (importGeneration === pdfImportGeneration) { pdfImportPending = false; $('import-pdf').disabled = false; } }
});
function renderPdfStatus(state) {
  $('reader-status').textContent = state.error || state.message || 'Opening your PDF…';
  $('previous-page').disabled = state.loading || state.page <= 1;
  $('next-page').disabled = state.loading || state.page >= state.pages;
  if (state.pages) $('reader-page').textContent = `${state.page} / ${state.pages}`;
  if (!state.loading && !state.error && state.pages) {
    $('sample-passages').hidden = true; $('pdf-view').hidden = false;
    currentPaper = state.name; $('paper-title').textContent = currentPaper; $('reader-title').textContent = currentPaper;
    $('reset-map').hidden = false;
  }
}
function receivePdfContext(context) {
  if (!context.text) {
    selectedNode = null;
    selectedSource = null;
    graph = buildReadingGraph(pdfPassages, { paper: { id: pdfDocumentId, title: context.paper }, documentId: pdfDocumentId, preparedSample: false });
    renderGraph(); renderSource(); return;
  }
  const passage = { id: `pdf-${crypto.randomUUID()}`, label: context.text.replace(/\s+/g, ' ').slice(0, 35) + (context.text.length > 35 ? '…' : ''), text: context.text, page: context.page };
  const existing = pdfPassages.find(item => item.text === context.text && item.page === context.page);
  if (!existing) { pdfPassages.push(passage); if (pdfPassages.length > 7) pdfPassages.shift(); }
  graph = buildReadingGraph(pdfPassages, { paper: { id: pdfDocumentId, title: context.paper }, documentId: pdfDocumentId, preparedSample: false });
  const id = (existing || passage).id;
  const node = graph.nodes.find(item => item.passageId === id || item.source?.id === id || item.id === `passage:${id}`);
  if (node) selectNode(node);
}
$('previous-page').addEventListener('click', () => pdfReader?.previous());
$('next-page').addEventListener('click', () => pdfReader?.next());

async function api(path, options = {}) {
  const { signal, raw, id, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  if (rest.method === 'POST') {
    headers.set('X-CSRF-Token', csrfToken);
    if (!raw) headers.set('Content-Type', 'application/json');
    if (id) headers.set('X-Request-Id', id);
  }
  let response;
  try { response = await fetch(`/api/assistant/${path}`, { ...rest, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('The local service could not be reached. Double-click Start Companion.cmd, then check the connection.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('The local service returned an unreadable response. Check the connection and try again.'); }
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'The local request could not be completed.'); error.code = data?.error?.code; error.status = response.status; throw error;
  }
  return data;
}
async function checkService() {
  if (checkingService || destroyed) return checkingService;
  $('connection-refresh').disabled = true; $('retry-service').disabled = true;
  checkingService = (async () => {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const session = await api('session', { signal: controller.signal });
      if (typeof session.csrfToken !== 'string') throw new Error('The local service session could not be opened.');
      csrfToken = session.csrfToken;
      service = await api('status', { signal: controller.signal }); serviceError = '';
    } catch (error) {
      service = { provider: 'local', reasoningReady: false, transcriptionReady: false };
      serviceError = error.name === 'AbortError' ? 'The local service did not respond. Double-click Start Companion.cmd, then check again.' : error.message;
    } finally {
      clearTimeout(timeout); renderService(); $('connection-refresh').disabled = false; $('retry-service').disabled = false; checkingService = null;
    }
    return service;
  })();
  return checkingService;
}
function renderService() {
  $('connection-label').textContent = service.reasoningReady ? 'Local model ready' : 'Local model not ready';
  $('connection-dot').className = `status-dot ${service.reasoningReady ? 'ready' : 'offline'}`;
  const voiceSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  $('hands-free').disabled = !service.transcriptionReady || !voiceSupported;
  if (!$('hands-free').disabled && !recording && !turnBusy && !microphoneOpening) $('voice-detail').textContent = 'Type below, or tap the mic to speak.';
  else if (!service.transcriptionReady && !recording && !turnBusy) $('voice-detail').textContent = 'Type a question. Local voice is not ready yet.';
  if (!service.transcriptionReady && $('hands-free').checked) disableHandsFree();
  const status = $('service-status'); status.replaceChildren();
  status.append(element('strong', '', service.reasoningReady ? 'Local model is ready' : 'Local model needs to be started'));
  status.append(element('p', '', service.reasoningReady ? `${service.model || 'Your model'} is running on this computer.` : serviceError || service.unavailableReason || 'Double-click Start Companion.cmd, then choose Check again. The local model must also be running.'));
  status.append(element('strong', '', service.transcriptionReady ? 'Voice input is ready' : 'Voice input is not ready'));
  status.append(element('p', '', service.transcriptionReady ? 'Tap the microphone to start, and tap again when you finish. Hands-free ends each turn after a short pause.' : service.transcriptionUnavailableReason || 'Local transcription needs to be set up before the microphone can turn your speech into text. You can still type commands.'));
  status.append(element('small', '', 'To reopen Companion, double-click Start Companion.cmd. A shared-room account is only needed for group discussion.'));
  status.append(element('p', '', 'Check the assumptions and proof steps in AI explanations.'));
  updateVoiceHelp();
}
$('connection-refresh').addEventListener('click', () => checkService());
$('retry-service').addEventListener('click', () => checkService());
$('service-details').addEventListener('click', () => { renderService(); showDialog('service-dialog'); });

function setState(state, detail = '') {
  const labels = { idle: 'One thought at a time.', opening: 'Opening your microphone…', listening: 'Listening to you.', transcribing: 'Turning speech into text…', thinking: 'Working through your question…', speaking: 'Reading the answer aloud.' };
  $('voice-state').textContent = labels[state] || state;
  $('voice-detail').textContent = detail || (state === 'idle' ? (service.transcriptionReady ? 'Type below, or tap the mic to speak.' : 'Type a question. Local voice is not ready yet.') : '');
  $('mic-button').classList.toggle('recording', state === 'listening');
  $('mic-button').classList.toggle('working', state === 'thinking' || state === 'transcribing');
  $('mic-button').setAttribute('aria-pressed', String(state === 'listening'));
  $('mic-button').setAttribute('aria-label', state === 'listening' ? 'Finish recording' : 'Start recording');
  $('turn-progress').hidden = !['thinking','transcribing','speaking','opening','listening'].includes(state);
  $('progress-text').textContent = state === 'listening' ? 'Microphone is on · up to 60 seconds' : labels[state] || state;
}
function addMessage(role, text, source, label = role === 'user' ? 'You' : 'Companion · AI draft') {
  $('welcome-card').hidden = true;
  const article = element('article', `message ${role}`);
  article.append(element('div', 'message-label', label), element('div', 'message-text', text));
  const captured = clone(source);
  if (captured?.text && role === 'assistant') {
    const sourceLabel = element('div', 'message-source', `${captured.paper} · page ${captured.page}\n${captured.text}`);
    sourceLabel.title = 'The source captured when this question began'; article.append(sourceLabel);
  }
  if (role === 'assistant') {
    const actions = element('div', 'message-actions'); const save = element('button', 'quiet-button', 'Keep this answer');
    save.addEventListener('click', () => saveNote(text, captured)); actions.append(save); article.append(actions);
    latestAnswer = { text, source: captured };
  }
  $('messages').append(article); messages.push({ role, text, source: captured });
  if (messages.length > 40) messages.shift();
  while ($('messages').children.length > 40) $('messages').firstElementChild.remove();
  $('conversation').scrollTop = $('conversation').scrollHeight;
}
function setBusy(busy) {
  turnBusy = busy; $('send-question').disabled = busy; $('explain-source').disabled = busy || !selectedSource?.text;
  $('source-hint').textContent = busy ? 'Your current question keeps the passage it started with.' : 'This passage will be attached to your next question.';
}
async function requestWithTurn(path, body, options, turn) {
  const id = crypto.randomUUID(); const controller = new AbortController(); activeRequest = { id, controller, turn };
  const timeout = setTimeout(() => controller.abort(), path === 'ask' ? 150_000 : 90_000);
  try {
    const result = await api(path, { method: 'POST', body: options?.raw ? body : JSON.stringify({ ...body, id }), signal: controller.signal, raw: options?.raw, id, headers: options?.headers });
    if (result.id !== id) throw new Error('The local response could not be matched to this question. Try again.');
    return result;
  }
  catch (error) {
    if (error.name === 'AbortError' && turn === generation) {
      void cancelBackend(id);
      throw new Error('The local model took too long. Check the connection, then try a shorter question.');
    }
    throw error;
  } finally { clearTimeout(timeout); if (activeRequest?.id === id) activeRequest = null; }
}
async function cancelBackend(id) {
  if (!csrfToken || !id) return;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 4000);
  try { await api('cancel', { method: 'POST', body: JSON.stringify({ id }), signal: controller.signal }); } catch {} finally { clearTimeout(timeout); }
}
function cancelTurn(announce = true) {
  generation += 1; voicePipeline = false; disableHandsFree(); stopRecording(false); stopSpeech();
  if (activeRequest) { const request = activeRequest; activeRequest = null; request.controller.abort(); void cancelBackend(request.id); }
  setBusy(false); setState('idle');
  if (announce) toast('Stopped. Your selected passage is still here.');
}
$('cancel-turn').addEventListener('click', () => cancelTurn());
async function runCommand(value, options = {}) {
  const question = value.trim(); if (!question || turnBusy) return;
  $('question-error').textContent = '';
  if (!options.voice && (recording || microphoneOpening)) { disableHandsFree(); stopRecording(false); }
  const source = clone(Object.hasOwn(options, 'source') ? options.source : selectedSource);
  let command;
  try { command = parseCommand(question); }
  catch (error) { $('question-error').textContent = error.message; return; }
  if (command.type === 'plot') {
    $('plot-expression').value = command.expression; $('plot-min').value = command.min; $('plot-max').value = command.max;
    showDialog('plot-dialog'); drawPlot(); $('question').value = ''; return;
  }
  if (command.type === 'saveNote') {
    if (command.text) saveNote(command.text, source);
    else if (/\bpassage\b/i.test(question) && source?.text) saveNote(source.text, source);
    else if (latestAnswer) saveNote(latestAnswer.text, latestAnswer.source);
    else if (source?.text) saveNote(source.text, source);
    else toast('Ask a question first, or say “save note: …” with your thought.');
    $('question').value = ''; return;
  }
  if (command.type === 'searchNotes') { $('notes-search').value = command.query; renderNotes(); showDialog('notes-dialog'); $('question').value = ''; return; }
  if (command.type === 'selectPassage') {
    const target = command.target.toLowerCase();
    const match = graph.nodes.find(node => node.label.toLowerCase().includes(target) || node.passageId === target || node.id.endsWith(`:${target}`)
      || (/^\d+$/.test(target) && Number(node.source?.number) === Number(target)));
    if (match) { selectNode(match); toast(`Selected ${match.label}.`); $('question').value = ''; }
    else toast('That passage is not in this map. Choose a node or select text in the paper.');
    return;
  }
  if (command.type === 'openSharedRoom') { disableHandsFree(); stopRecording(false); location.assign('room.html'); return; }
  if (command.type === 'findDefinition' && definitions[command.concept]) {
    const turn = ++generation;
    const definitionSource = sampleGraph.nodes.find(node => node.concept === command.concept)?.source;
    setBusy(true);
    addMessage('user', question, definitionSource); addMessage('assistant', definitions[command.concept], definitionSource, 'Companion · prepared definition');
    $('question').value = ''; await speakText(definitions[command.concept], turn);
    if (turn === generation) { voicePipeline = false; setBusy(false); setState('idle'); maybeResume(); }
    return;
  }
  if (!service.reasoningReady) {
    $('question-error').textContent = 'The local model is not ready. Open Details below for setup help. Your question stays here.';
    if (options.voice) disableHandsFree(); renderService(); return;
  }
  const turn = ++generation; const frozenProfile = clone(profile); const history = prepareHistory(messages, source);
  addMessage('user', question, source); $('question').value = ''; setBusy(true); setState('thinking', 'The selected passage stays attached while you explore.');
  try {
    const result = await requestWithTurn('ask', { question: command.question || question, context: source, familiarity: frozenProfile, history }, {}, turn);
    if (turn !== generation || destroyed) return;
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('The local model returned no answer. Try a more specific question.');
    addMessage('assistant', result.text, source); await speakText(result.text, turn);
  } catch (error) { if (turn === generation && error.name !== 'AbortError') { $('question-error').textContent = error.message; if (options.voice) disableHandsFree(); } }
  finally { if (turn === generation) { voicePipeline = false; setBusy(false); setState('idle'); maybeResume(); } }
}
$('question-form').addEventListener('submit', event => { event.preventDefault(); void runCommand($('question').value); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('question-form').requestSubmit(); } });
$('explain-source').addEventListener('click', () => void runCommand('Explain this passage intuitively, then show the mathematical reasoning.'));
$('suggest-question').addEventListener('click', () => void runCommand('Why do we need completeness?'));
$('suggest-plot').addEventListener('click', () => void runCommand('plot x/2'));

function saveNote(text, source = selectedSource) {
  if (!text?.trim()) return false;
  if (notes.length >= 100) { toast('Your notebook has 100 notes. Remove one before saving another.'); return false; }
  const next = [...notes, { id: crypto.randomUUID(), text: text.trim().slice(0, 4000), source: clone(source), createdAt: new Date().toISOString() }];
  if (store('notes', next)) { notes = next; renderNotes(); toast('Saved in your personal notes.'); return true; }
  return false;
}
function renderNotes() {
  $('note-count').textContent = notes.length;
  const results = searchNotes(notes, $('notes-search').value); $('notes-list').replaceChildren();
  if (!results.length) $('notes-list').append(element('p', 'empty-state', notes.length ? 'No notes match your search.' : 'Keep a passage, save an answer, or write your own thought below.'));
  else if (notes.length > 30 && !$('notes-search').value.trim()) $('notes-list').append(element('p', 'empty-state', 'Your 30 most recent notes. Search to find an older thought.'));
  for (const note of results) {
    const card = element('article', 'note-card'); card.append(element('p', '', note.text));
    if (note.source?.text) card.append(element('p', 'note-source', `${note.source.paper} · page ${note.source.page || 1}\n${note.source.text}`));
    const meta = element('div', 'note-meta'); const date = new Date(note.createdAt);
    meta.append(element('span', '', Number.isNaN(date.getTime()) ? 'Saved on this computer' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
    const remove = element('button', '', 'Remove'); remove.addEventListener('click', () => { const next = notes.filter(item => item.id !== note.id); if (store('notes', next)) { notes = next; renderNotes(); } });
    meta.append(remove); card.append(meta); $('notes-list').append(card);
  }
}
$('notes-nav').addEventListener('click', () => { renderNotes(); showDialog('notes-dialog'); });
$('notes-search').addEventListener('input', renderNotes);
$('save-source').addEventListener('click', () => saveNote(selectedSource?.text));
$('note-form').addEventListener('submit', event => { event.preventDefault(); if (saveNote($('new-note').value)) $('new-note').value = ''; });
for (const concept of Object.keys(concepts)) {
  const row = element('label', 'familiarity-row'); row.append(element('span', '', concept));
  const select = element('select'); select.setAttribute('aria-label', `Familiarity with ${concept}`);
  familiarityLevels.forEach(level => { const option = element('option', '', level); option.value = level; select.append(option); });
  select.value = profile[concept]; select.addEventListener('change', () => { profile = { ...profile, [concept]: select.value }; store('profile', profile); }); row.append(select); $('familiarity-fields').append(row);
}
$('profile-nav').addEventListener('click', () => showDialog('profile-dialog'));

function drawPlot() {
  $('plot-error').textContent = '';
  try {
    const data = sampleExpression($('plot-expression').value, Number($('plot-min').value), Number($('plot-max').value), 601);
    const svg = $('plot-svg'); svg.replaceChildren();
    const pad = { l: 50, r: 25, t: 25, b: 40 }, width = 700 - pad.l - pad.r, height = 390 - pad.t - pad.b;
    const x = value => pad.l + (value - data.minX) / (data.maxX - data.minX) * width;
    const y = value => pad.t + (data.maxY - value) / (data.maxY - data.minY) * height;
    for (let i = 0; i <= 4; i++) {
      const vx = data.minX + (data.maxX - data.minX) * i / 4, vy = data.minY + (data.maxY - data.minY) * i / 4;
      svg.append(svgElement('line', { x1: x(vx), x2: x(vx), y1: pad.t, y2: 350, stroke: '#2c413b', 'stroke-width': 1 }));
      svg.append(svgElement('line', { x1: pad.l, x2: 675, y1: y(vy), y2: y(vy), stroke: '#2c413b', 'stroke-width': 1 }));
      const xt = svgElement('text', { x: x(vx), y: 374, fill: '#7f9a8b', 'font-size': 11, 'text-anchor': 'middle' }); xt.textContent = Number(vx.toPrecision(3)); svg.append(xt);
      const yt = svgElement('text', { x: 41, y: y(vy) + 4, fill: '#7f9a8b', 'font-size': 10, 'text-anchor': 'end' }); yt.textContent = Number(vy.toPrecision(3)); svg.append(yt);
    }
    if (data.minX <= 0 && data.maxX >= 0) svg.append(svgElement('line', { x1: x(0), x2: x(0), y1: 25, y2: 350, stroke: '#6c8e7a' }));
    if (data.minY <= 0 && data.maxY >= 0) svg.append(svgElement('line', { x1: 50, x2: 675, y1: y(0), y2: y(0), stroke: '#6c8e7a' }));
    const defs = svgElement('defs'), clip = svgElement('clipPath', { id: 'plot-clip' }); clip.append(svgElement('rect', { x: 50, y: 25, width, height })); defs.append(clip); svg.append(defs);
    for (const segment of data.segments) {
      if (!segment.length) continue;
      const d = segment.map((point, index) => `${index ? 'L' : 'M'}${x(point.x).toFixed(2)} ${y(point.y).toFixed(2)}`).join(' ');
      svg.append(svgElement('path', { d, fill: 'none', stroke: '#b5dcc0', 'stroke-width': 2.3, 'clip-path': 'url(#plot-clip)' }));
    }
    $('plot-caption').textContent = `f(x) = ${data.expression}, from ${data.minX} to ${data.maxX}. Undefined values and possible discontinuities are separated.`;
  } catch (error) { $('plot-error').textContent = error.message; }
}
$('plot-form').addEventListener('submit', event => { event.preventDefault(); drawPlot(); });

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
  if (recording || microphoneOpening || turnBusy || document.hidden || destroyed) return;
  $('question-error').textContent = '';
  if (!service.transcriptionReady) { disableHandsFree(); $('question-error').textContent = 'Local voice input is not ready. Open Details below, or type a command.'; return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { disableHandsFree(); $('question-error').textContent = 'This browser cannot record audio. You can type a question instead.'; return; }
  const frozenSource = clone(selectedSource);
  stopSpeech(); const turn = ++generation; microphoneOpening = true; voicePipeline = true; setState('opening', 'Your browser may ask for microphone access.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (turn !== generation || document.hidden || destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const item = { recorder, stream, turn, source: frozenSource, chunks: [], bytes: 0, submit: true, timer: null, frame: null, audioContext: null, speech: false, firstSound: 0, lastSound: 0, started: performance.now(), silenceChecked: false };
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
    $('question').value = result.text.slice(0, 2000); setBusy(false);
    await runCommand($('question').value, { source: item.source, voice: true });
  } catch (error) {
    if (item.turn === generation && error.name !== 'AbortError') { $('question-error').textContent = error.message; disableHandsFree(); }
  } finally {
    if (item.turn === generation) { voicePipeline = false; setBusy(false); setState('idle'); maybeResume(); }
  }
}
$('mic-button').addEventListener('click', () => {
  if (recording) stopRecording(true);
  else if (microphoneOpening) cancelTurn(false);
  else if (turnBusy) toast('Wait for this answer, or use Cancel to stop it.');
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (voicePipeline || recording || microphoneOpening) cancelTurn(false);
    else { disableHandsFree(); stopSpeech(); }
  } else void checkService();
});
window.addEventListener('pagehide', event => {
  cancelTurn(false);
  if (!event.persisted) { destroyed = true; pdfReader?.destroy(); }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  destroyed = false; setBusy(false); setState('idle'); updateVoiceHelp();
  void checkService();
});

renderSamplePaper(); returnToSample(false); renderNotes(); updateVoiceHelp();
void checkService();
setInterval(() => { if (!document.hidden && !turnBusy && !recording && !microphoneOpening) void checkService(); }, 30_000);
