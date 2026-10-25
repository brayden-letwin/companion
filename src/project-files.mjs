const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const STORAGE_KEY = 'companion.project.files.pending.v1';
const TERMINAL = new Set(['applied', 'failed', 'interrupted', 'recovery_required']);
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const same = (a, b) => !!a && !!b && a.projectId === b.projectId && a.grantEpoch === b.grantEpoch;
const validBinding = value => !!value && UUID.test(value.projectId) && Number.isSafeInteger(value.grantEpoch) && value.grantEpoch > 0;
const bindingOf = value => ({ projectId: value.projectId, grantEpoch: value.grantEpoch, label: value.label || 'Project folder' });
const normalText = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
function serialize(text, file) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const ending = file.lineEndings === 'crlf' ? '\r\n' : file.lineEndings === 'cr' ? '\r' : '\n';
  return (file.bom ? '\uFEFF' : '') + normalized.replace(/\n/g, ending);
}
function statusText(edit) {
  const label = edit.status === 'applied' && edit.receiptPending ? 'File changed · receipt needs checking' : { applied: 'Saved', failed: 'Not saved', interrupted: 'Interrupted', recovery_required: 'Needs recovery' }[edit.status] || edit.status || 'Unconfirmed';
  return label + (edit.outcomeUnknown ? ' · file state needs checking' : '');
}

/** A human-facing folder browser. The host supplies all authenticated I/O. */
export function createProjectFilesUI({ container, api, onSelect = () => {}, onRevoke = () => {}, notify = () => {} }) {
  if (!container || typeof api !== 'function') throw new TypeError('A Files container and API function are required.');
  const doc = container.ownerDocument || globalThis.document;
  const node = (tag, className, text) => { const result = doc.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = String(text); return result; };
  const cleanups = [], requests = new Set(), drafts = new Map(), pending = new Map(), pendingPayloads = new Map();
  let closed = false, generation = 0, chooser = 0, choosing = false, refreshing = false, revoking = false, mutationBusy = false;
  let selection = null, projects = [], directory = '', directoryPage = null, entries = [], listing = false, file = null, reading = false;
  let fileGeneration = 0, directoryGeneration = 0, history = [], historyPage = null, historyBusy = false, inspection = null, inspecting = false, error = '';
  let storage = null;
  try { storage = globalThis.localStorage; const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(saved)) for (const item of saved.slice(0, 100)) if (validBinding(item) && UUID.test(item.id)) pending.set(item.id, { projectId: item.projectId, grantEpoch: item.grantEpoch, id: item.id }); } catch { /* Storage is optional. Text is never persisted here. */ }

  const root = node('section', 'project-files');
  const heading = node('div', 'page-heading'), headingText = node('div'); headingText.append(node('h1', '', 'Files'), node('p', '', 'Work with a project folder.'));
  const refreshButton = node('button', 'quiet-button', 'Refresh'); refreshButton.type = 'button'; refreshButton.setAttribute('aria-label', 'Refresh project files'); heading.append(headingText, refreshButton);
  const consent = node('p', 'project-access-copy', 'Companion and connected AI tools can read and write requested text files in this folder. Recent edits have Undo.');
  const chooserRow = node('div', 'project-chooser'), chooseButton = node('button', 'primary-button', 'Choose project folder'); chooseButton.type = 'button'; chooserRow.append(chooseButton);
  const projectList = node('div', 'project-choices'), selected = node('div', 'project-selected'), selectedName = node('strong'), selectedPath = node('p', 'project-location');
  const selectedControls = node('div', 'project-actions'), leaveButton = node('button', 'quiet-button', 'Leave folder'), revokeButton = node('button', 'quiet-button', 'Remove access'); leaveButton.type = revokeButton.type = 'button'; selectedControls.append(leaveButton, revokeButton); selected.append(selectedName, selectedPath, selectedControls);
  const errors = node('p', 'inline-error'); errors.setAttribute('role', 'alert');
  const pendingBox = node('div', 'project-pending'); pendingBox.setAttribute('role', 'status');
  const browser = node('div', 'project-browser'), folderHeading = node('div', 'project-folder-heading'), breadcrumbs = node('div', 'project-breadcrumbs'), browseStatus = node('p', 'project-hint'), fileList = node('div', 'project-file-list'); breadcrumbs.setAttribute('aria-label', 'Folder location');
  const moreFiles = node('button', 'quiet-button', 'Load more files'); moreFiles.type = 'button'; folderHeading.append(breadcrumbs); browser.append(folderHeading, browseStatus, fileList, moreFiles);
  const newForm = node('form', 'project-new-file'), newLabel = node('label', 'field-label', 'New text file'), newPath = node('input'), newButton = node('button', 'secondary-button', 'New file'); newPath.maxLength = 240; newPath.placeholder = 'notes.md'; newPath.setAttribute('aria-label', 'New text file path'); newLabel.append(newPath); newButton.type = 'submit'; newForm.append(newLabel, newButton); browser.append(newForm);
  const editorPanel = node('section', 'project-editor'), editorTitle = node('h2'), editorStatus = node('p', 'project-hint'), editor = node('textarea'), editorActions = node('div', 'project-actions'); editor.rows = 12; editor.maxLength = 24000; editor.spellcheck = false; editor.setAttribute('aria-label', 'File text');
  const saveButton = node('button', 'primary-button', 'Save file'), reloadButton = node('button', 'quiet-button', 'Reload file'), moreText = node('button', 'quiet-button', 'Load more text'); saveButton.type = reloadButton.type = moreText.type = 'button'; editorActions.append(saveButton, reloadButton, moreText); editorPanel.append(editorTitle, editorStatus, editor, editorActions);
  const historyPanel = node('section', 'project-history'), historyHeading = node('div', 'project-folder-heading'), historyButton = node('button', 'quiet-button', 'Load recent edits'), historyList = node('div'), historyMore = node('button', 'quiet-button', 'Load more edits'); historyButton.type = historyMore.type = 'button'; historyHeading.append(node('h2', '', 'Recent edits'), historyButton); historyPanel.append(historyHeading, historyList, historyMore);
  const inspectionPanel = node('section', 'project-inspection'), inspectionTitle = node('h3'), inspectionNote = node('p', 'project-hint'), inspectionText = node('textarea'), inspectionMore = node('button', 'quiet-button', 'Load more saved text'); inspectionText.readOnly = true; inspectionText.rows = 9; inspectionText.setAttribute('aria-label', 'Saved edit text'); inspectionMore.type = 'button'; inspectionPanel.append(inspectionTitle, inspectionNote, inspectionText, inspectionMore); historyPanel.append(inspectionPanel);
  root.append(heading, consent, chooserRow, projectList, selected, errors, pendingBox, browser, editorPanel, historyPanel); container.append(root);

  function listen(target, type, callback) { target.addEventListener(type, callback); cleanups.push(() => target.removeEventListener(type, callback)); }
  function button(text, callback, className = 'quiet-button') { const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', callback); return result; }
  function alive(binding, stamp = generation) { return !closed && stamp === generation && same(binding, selection); }
  function draftKey(binding, path) { return binding.projectId + ':' + binding.grantEpoch + ':' + path; }
  function rememberDraft() { if (selection && file) drafts.set(draftKey(selection, file.path), file); }
  function persistPending(removeId) {
    if (!storage) return;
    try { const stored = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(stored)) for (const item of stored) if (validBinding(item) && UUID.test(item.id) && item.id !== removeId && !pending.has(item.id)) pending.set(item.id, { projectId: item.projectId, grantEpoch: item.grantEpoch, id: item.id }); if (removeId) pending.delete(removeId); storage.setItem(STORAGE_KEY, JSON.stringify([...pending.values()].map(item => ({ projectId: item.projectId, grantEpoch: item.grantEpoch, id: item.id })))); } catch { /* The visible pending receipt remains usable in this window. */ }
  }
  function forgetPending(id) { pending.delete(id); pendingPayloads.delete(id); persistPending(id); }
  async function request(path, options = {}, timeout = 15000) {
    const controller = new AbortController(); requests.add(controller);
    try { return await api(path, { ...options, signal: controller.signal }, timeout); }
    finally { requests.delete(controller); }
  }
  function query(binding, fields = {}) { const params = new URLSearchParams({ grantEpoch: String(binding.grantEpoch) }); for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) params.set(key, String(value)); return params.toString(); }
  const projectRoute = binding => 'projects/' + encodeURIComponent(binding.projectId);
  function upsertProject(project) { if (!validBinding(project)) throw new Error('The selected folder could not be confirmed.'); projects = [clone(project), ...projects.filter(item => item.projectId !== project.projectId)]; }
  function historyReceiptValid(edit, binding) { return !!edit && UUID.test(edit.id) && validBinding(edit) && edit.projectId === binding?.projectId && typeof edit.path === 'string' && typeof edit.status === 'string'; }
  function receiptValid(edit, binding, id = edit?.id) { return !!edit && UUID.test(edit.id) && edit.id === id && same(edit, binding) && typeof edit.path === 'string' && typeof edit.status === 'string'; }
  function rememberReceipt(edit) { history = [clone(edit), ...history.filter(item => item.id !== edit.id)]; }
  function hasUnconfirmed(binding) { return [...pending.values()].some(item => same(item, binding)); }
  function grantUnavailable() { const project = projects.find(item => item.projectId === selection?.projectId); return !!project && (!same(project, selection) || project.available === false || project.revoked === true); }
  function editable() { return !!file && !grantUnavailable() && !file.hasMore && file.raw.length === file.characterLength && file.lineEndings !== 'mixed' && file.raw.length <= 24000 && !file.stale && !file.blocked; }

  function render() {
    if (closed) return;
    chooseButton.disabled = choosing; chooseButton.textContent = choosing ? 'Choosing folder…' : 'Choose project folder'; refreshButton.disabled = refreshing;
    errors.textContent = error; selected.hidden = !selection; browser.hidden = !selection; editorPanel.hidden = !selection || !file; historyPanel.hidden = !selection;
    projectList.replaceChildren();
    for (const project of projects) {
      if (same(project, selection)) continue;
      const row = node('div', 'project-choice'), use = button(project.label || 'Project folder', () => { void activate(project); }); use.disabled = project.available === false || project.revoked === true; row.append(use);
      if (project.revoked || project.available === false) row.append(node('small', '', project.revoked ? 'Access removed' : 'Unavailable'));
      projectList.append(row);
    }
    if (selection) {
      const project = projects.find(item => same(item, selection)); selectedName.textContent = selection.label; selectedPath.textContent = project?.localPath || ''; selectedPath.hidden = !project?.localPath; revokeButton.disabled = revoking; leaveButton.disabled = revoking;
    }
    pendingBox.replaceChildren(); pendingBox.hidden = pending.size === 0;
    for (const item of pending.values()) { const row = node('div', 'project-pending-row'); row.append(node('span', '', 'An edit has not been confirmed.'), button('Check save', () => { void checkSave(item); })); pendingBox.append(row); }
    breadcrumbs.replaceChildren(); if (selection) { breadcrumbs.append(button(selection.label, () => { void listDirectory(''); })); let prefix = ''; for (const part of directory.split('/').filter(Boolean)) { prefix += (prefix ? '/' : '') + part; const target = prefix; breadcrumbs.append(node('span', '', '/'), button(part, () => { void listDirectory(target); })); } }
    fileList.replaceChildren(); for (const entry of entries) { const row = node('div', 'project-file-row'), open = button(entry.name, () => { if (entry.kind === 'directory') void listDirectory(entry.path); else void readFile(entry.path); }); open.setAttribute('aria-label', (entry.kind === 'directory' ? 'Open folder: ' : 'Read file: ') + entry.path); row.append(open, node('small', '', entry.kind === 'directory' ? 'Folder' : entry.reason || (Number.isFinite(entry.byteLength) ? entry.byteLength + ' bytes' : 'Text file'))); fileList.append(row); }
    browseStatus.textContent = listing ? 'Reading folder…' : directoryPage ? 'Showing ' + entries.length + ' entries.' + (directoryPage.scanLimitReached ? ' The folder scan limit was reached; this is not the complete folder.' : directoryPage.complete === false && !directoryPage.hasMore ? ' This folder list is incomplete.' : '') : 'Choose a file or browse this folder.';
    moreFiles.hidden = !directoryPage?.hasMore; moreFiles.disabled = listing;
    if (file) {
      const canEdit = editable(); editorTitle.textContent = file.path; if (editor.value !== file.text) editor.value = file.text; editor.readOnly = !canEdit || reading;
      editorStatus.textContent = reading ? 'Reading file…' : grantUnavailable() ? 'Folder access is unavailable. Choose the folder again before editing.' : file.stale ? 'The file changed outside this draft. Your draft is kept; discard it and reload before saving.' : file.blocked ? (file.blockReason === 'undo' ? 'The file changed through Undo. Reload to see its current contents before editing.' : 'This edit needs inspection before another save. Your draft is kept.') : file.hasMore || file.raw.length !== file.characterLength ? 'This is a partial preview. Load the complete file before editing.' : file.lineEndings === 'mixed' ? 'Mixed line endings: manual editing is read-only. Companion can make a requested literal replacement.' : !canEdit ? 'This file is too large for a whole-file editor save. Companion can make a requested literal replacement.' : file.dirty ? 'Unsaved changes. Save writes this exact file in the selected folder.' : 'No unsaved changes.';
      saveButton.disabled = !canEdit || !file.dirty || reading || mutationBusy || hasUnconfirmed(selection); reloadButton.disabled = reading || mutationBusy; reloadButton.textContent = file.dirty ? 'Discard draft and reload' : 'Reload file'; moreText.hidden = !file.hasMore; moreText.disabled = reading;
    }
    historyButton.disabled = historyBusy; historyMore.hidden = !historyPage?.hasMore; historyMore.disabled = historyBusy; historyList.replaceChildren();
    if (!history.length) historyList.append(node('p', 'project-hint', 'Edits made through Companion appear here.'));
    for (const edit of history.filter(item => historyReceiptValid(item, selection))) {
      const row = node('article', 'project-edit-row'); row.append(node('strong', '', edit.path), node('span', 'project-hint', statusText(edit)));
      const actions = node('div', 'project-actions'); actions.append(button('Before', () => { void inspectEdit(edit, 'before'); }), button('After', () => { void inspectEdit(edit, 'after'); }));
      if (edit.undoAvailable) { const undo = button('Undo', () => { void mutate({ action: 'undo', changeId: edit.id }); }); undo.disabled = mutationBusy || hasUnconfirmed(selection); actions.append(undo); }
      row.append(actions); historyList.append(row);
    }
    inspectionPanel.hidden = !inspection; if (inspection) { inspectionTitle.textContent = inspection.part === 'before' ? 'Before · ' + inspection.path : 'After · ' + inspection.path; inspectionNote.textContent = inspection.fileExists === false ? 'The file did not exist in this saved version.' : inspection.fileExists === true && !inspection.content && !inspection.hasMore ? 'This saved file is empty.' : ''; inspectionNote.hidden = !inspectionNote.textContent; inspectionText.value = inspection.content; inspectionMore.hidden = !inspection.hasMore; inspectionMore.disabled = inspecting; }
  }

  function selectionChanged(value) {
    if (closed) return;
    if (value !== null && !validBinding(value)) throw new TypeError('A valid project binding is required.');
    if (value && same(value, selection)) { selection = bindingOf(value); render(); return; }
    rememberDraft(); generation++; fileGeneration++; directoryGeneration++; selection = value ? bindingOf(value) : null; directory = ''; entries = []; directoryPage = null; file = null; history = []; historyPage = null; inspection = null; error = ''; listing = reading = historyBusy = inspecting = false; render();
  }
  async function activate(project) {
    if (closed || project.available === false || project.revoked) return;
    const stamp = generation, next = bindingOf(project); let accepted;
    try { accepted = await onSelect(clone(next)); } catch (failure) { error = failure.message; render(); return; }
    if (closed || accepted === false) return;
    if (same(selection, next)) { /* Root may synchronously echo selectionChanged. */ }
    else if (stamp === generation) selectionChanged(next); else return;
    await listDirectory('');
  }
  async function choose() {
    if (closed || choosing) return;
    const stamp = generation, ticket = ++chooser; choosing = true; error = ''; render();
    try { const value = await request('projects/choose', { method: 'POST', body: '{}' }, 120000); if (closed || ticket !== chooser) return; if (!value.project) return; upsertProject(value.project); if (stamp === generation) await activate(value.project); }
    catch (failure) { if (!closed && stamp === generation) error = failure.message; }
    finally { if (ticket === chooser) { choosing = false; render(); } }
  }
  async function refresh() {
    if (closed || refreshing) return; refreshing = true; error = ''; const stamp = generation;
    try { const value = await request('projects'); if (closed) return; if (!Array.isArray(value.projects)) throw new Error('Project folders could not be read.'); projects = value.projects.filter(validBinding).map(clone); if (stamp === generation && selection) await listDirectory(directory); }
    catch (failure) { if (!closed && stamp === generation) error = failure.message; }
    finally { refreshing = false; render(); }
  }
  async function listDirectory(path, more = false) {
    if (!selection || closed || more && listing) return;
    const binding = clone(selection), stamp = generation, ticket = ++directoryGeneration, offset = more ? directoryPage?.nextOffset : 0;
    if (more && (!directoryPage?.hasMore || !Number.isSafeInteger(offset))) return;
    listing = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/files?' + query(binding, { path, offset, limit: 40, expectedDirectoryHash: more ? directoryPage.directoryHash : undefined })); if (!alive(binding, stamp) || ticket !== directoryGeneration) return; if (!same(value, binding) || value.path !== path || !Array.isArray(value.entries) || value.offset !== offset || typeof value.directoryHash !== 'string') throw new Error('The folder page could not be matched. Refresh the folder.'); if (more && value.directoryHash !== directoryPage.directoryHash) throw new Error('The folder changed. Refresh before loading more.'); directory = path; directoryPage = value; const merged = more ? [...entries, ...value.entries] : value.entries; entries = [...new Map(merged.filter(item => typeof item.name === 'string' && typeof item.path === 'string' && ['file', 'directory'].includes(item.kind)).map(item => [item.kind + ':' + item.path, item])).values()]; }
    catch (failure) { if (alive(binding, stamp) && ticket === directoryGeneration) error = failure.message; }
    finally { if (alive(binding, stamp) && ticket === directoryGeneration) listing = false; render(); }
  }
  async function readFile(path, { more = false, discard = false } = {}) {
    if (!selection || closed || more && reading) return;
    const binding = clone(selection), stamp = generation, ticket = ++fileGeneration, previous = file;
    const offset = more ? previous?.nextOffset : 0; if (more && (!previous?.hasMore || !Number.isSafeInteger(offset))) return;
    rememberDraft(); if (discard) drafts.delete(draftKey(binding, path)); reading = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/file?' + query(binding, { path, offset, limit: 12000, expectedHash: more ? previous.hash : undefined })); if (!alive(binding, stamp) || ticket !== fileGeneration) return; if (!same(value, binding) || value.path !== path || value.offset !== offset || typeof value.hash !== 'string' || typeof value.content !== 'string' || !Number.isSafeInteger(value.characterLength) || value.characterLength < 0 || !['none', 'lf', 'crlf', 'cr', 'mixed'].includes(value.lineEndings) || typeof value.bom !== 'boolean') throw new Error('The file page could not be matched. Reload the file.'); if (more && (value.hash !== previous.hash || value.characterLength !== previous.characterLength)) throw new Error('The file changed while reading. Reload the file.');
      const draft = !more && !discard ? drafts.get(draftKey(binding, path)) : null;
      if (draft?.dirty) { file = draft; file.stale = file.hash !== value.hash; }
      else { const raw = (more ? previous.raw : '') + value.content; file = { path, hash: value.hash, raw, characterLength: value.characterLength, text: normalText(raw), hasMore: value.hasMore === true, nextOffset: value.nextOffset, lineEndings: more ? previous.lineEndings : value.lineEndings, bom: more ? previous.bom : value.bom === true, readAt: value.readAt, dirty: false, stale: false, blocked: false }; }
      rememberDraft();
    } catch (failure) { if (alive(binding, stamp) && ticket === fileGeneration) error = failure.message; }
    finally { if (alive(binding, stamp) && ticket === fileGeneration) reading = false; render(); }
  }
  function newFile() { if (!selection || closed) return; const path = newPath.value; if (!path.trim()) return; if (path.length > 240) { error = 'Use a relative file path of at most 240 characters.'; render(); return; } rememberDraft(); fileGeneration++; const existing = drafts.get(draftKey(selection, path)); file = existing?.isNew ? existing : { path, hash: null, raw: '', characterLength: 0, text: '', hasMore: false, lineEndings: 'lf', bom: false, dirty: true, stale: false, blocked: false }; file.isNew = true; rememberDraft(); newPath.value = ''; render(); editor.focus(); }
  function acceptReceipt(edit, binding, payload) {
    if (!receiptValid(edit, binding)) throw new Error('The saved edit receipt could not be matched.');
    rememberReceipt(edit); if (TERMINAL.has(edit.status) && !edit.receiptPending) forgetPending(edit.id);
    if (alive(binding) && file && file.path === edit.path) {
      if (edit.status === 'applied' && payload?.action === 'write' && payload.uiFileGeneration === fileGeneration && file.hash === payload.expectedHash) { file.hash = edit.afterHash; file.raw = payload.content; file.characterLength = payload.content.length; file.dirty = serialize(file.text, file) !== payload.content; file.isNew = false; file.stale = false; file.blocked = false; file.blockReason = null; rememberDraft(); }
      else if (edit.status !== 'failed' && (payload?.action !== 'write' || edit.status !== 'applied')) { file.blocked = true; file.blockReason = edit.status === 'applied' && payload?.action === 'undo' && !edit.receiptPending && !edit.outcomeUnknown ? 'undo' : 'inspection'; rememberDraft(); }
    }
    return edit;
  }
  async function mutate(fields) {
    if (!selection || closed || mutationBusy || hasUnconfirmed(selection)) return;
    const binding = clone(selection), id = globalThis.crypto.randomUUID(), stamp = generation;
    const body = { grantEpoch: binding.grantEpoch, operationId: id, ...fields };
    if (fields.action === 'write' && (typeof fields.content !== 'string' || fields.content.length > 24000 || new TextEncoder().encode(JSON.stringify(body)).length > 80000)) { error = 'The complete save exceeds the text editor limit. Ask Companion for a literal replacement instead.'; render(); return; }
    pending.set(id, { ...binding, id }); pendingPayloads.set(id, { ...fields, uiFileGeneration: fileGeneration }); persistPending(); mutationBusy = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/edit', { method: 'POST', body: JSON.stringify(body) }, 45000); if (closed) return; if (!receiptValid(value.projectFileEdit, binding, id)) throw new Error('The save could not be matched to its receipt.'); const edit = acceptReceipt(value.projectFileEdit, binding, pendingPayloads.get(id)); if (alive(binding, stamp)) error = edit.status === 'applied' && !edit.receiptPending ? '' : 'The edit ' + statusText(edit).toLowerCase() + '. Inspect its recorded result before another change.'; notify(edit.status === 'applied' && !edit.receiptPending ? fields.action === 'undo' ? 'Undo saved.' : 'File saved.' : statusText(edit)); }
    catch (failure) { if (closed) return; if (receiptValid(failure.projectFileEdit, binding, id)) acceptReceipt(failure.projectFileEdit, binding, pendingPayloads.get(id)); else if ([400, 403, 404, 413, 422].includes(failure.status)) forgetPending(id); if (alive(binding, stamp)) error = pending.has(id) ? 'The edit has not been confirmed. Use Check save before trying it again. ' + failure.message : failure.message; }
    finally { mutationBusy = false; render(); }
  }
  async function checkSave(item) {
    if (closed) return;
    try { const value = await request(projectRoute(item) + '/edits/' + encodeURIComponent(item.id) + '?' + query(item, { part: 'metadata' })); if (closed) return; if (!receiptValid(value.projectFileEdit, item, item.id)) throw new Error('This saved edit could not be matched.'); const edit = acceptReceipt(value.projectFileEdit, item, pendingPayloads.get(item.id)); error = TERMINAL.has(edit.status) && !edit.receiptPending ? '' : 'This edit is still being checked. Read its saved result again before another change.'; notify(statusText(edit) + ' · ' + edit.path); }
    catch (failure) { if (closed) return; if (failure.status === 404) { forgetPending(item.id); error = 'No saved edit was found. Your draft is kept; save again only if you still want that change.'; } else error = 'The edit still could not be confirmed. ' + failure.message; }
    render();
  }
  async function loadHistory(more = false) {
    if (!selection || closed || historyBusy) return; const binding = clone(selection), stamp = generation, offset = more ? historyPage?.nextOffset : 0; if (more && (!historyPage?.hasMore || !Number.isSafeInteger(offset))) return; historyBusy = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/history?' + query(binding, { offset, limit: 20 })); if (!alive(binding, stamp)) return; if (!same(value, binding) || !Array.isArray(value.edits)) throw new Error('Recent edits could not be read.'); history = more ? [...history, ...value.edits] : value.edits; history = [...new Map(history.filter(edit => historyReceiptValid(edit, binding)).map(edit => [edit.id, edit])).values()]; historyPage = value; }
    catch (failure) { if (alive(binding, stamp)) error = failure.message; }
    finally { if (alive(binding, stamp)) historyBusy = false; render(); }
  }
  async function inspectEdit(edit, part, more = false) {
    if (!selection || closed || inspecting) return; const binding = clone(selection), stamp = generation, prior = inspection, offset = more ? prior?.nextOffset : 0; if (more && (!prior?.hasMore || !Number.isSafeInteger(offset))) return; inspecting = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/edits/' + encodeURIComponent(edit.id) + '?' + query(binding, { part, offset, limit: 12000 })); if (!alive(binding, stamp)) return; if (!same(value, binding) || value.changeId !== edit.id || value.part !== part || value.offset !== offset || typeof value.content !== 'string' || more && value.hash !== prior.hash) throw new Error('The saved text page could not be matched.'); inspection = { ...value, path: edit.path, content: (more ? prior.content : '') + value.content, edit }; }
    catch (failure) { if (alive(binding, stamp)) error = failure.message; }
    finally { if (alive(binding, stamp)) inspecting = false; render(); }
  }
  async function revoke() {
    if (!selection || closed || revoking) return; const binding = clone(selection); revoking = true; error = ''; render();
    try { const value = await request(projectRoute(binding) + '/revoke', { method: 'POST', body: JSON.stringify({ grantEpoch: binding.grantEpoch }) }); if (closed) return; if (value.revoked !== true || value.project?.projectId !== binding.projectId) throw new Error('Folder access removal was not confirmed.'); upsertProject(value.project); await onRevoke({ projectId: binding.projectId, grantEpoch: binding.grantEpoch }); if (same(selection, binding)) selectionChanged(null); notify('Folder access removed. Saved receipts remain.'); }
    catch (failure) { if (!closed) error = failure.message; }
    finally { revoking = false; render(); }
  }

  listen(chooseButton, 'click', () => { void choose(); }); listen(refreshButton, 'click', () => { void refresh(); });
  listen(leaveButton, 'click', () => { const stamp = generation; Promise.resolve().then(() => onSelect(null)).then(accepted => { if (!closed && accepted !== false && stamp === generation) selectionChanged(null); }).catch(failure => { error = failure.message; render(); }); });
  listen(revokeButton, 'click', () => { void revoke(); }); listen(moreFiles, 'click', () => { void listDirectory(directory, true); });
  listen(newForm, 'submit', event => { event.preventDefault(); newFile(); });
  listen(editor, 'input', () => { if (!file || !editable()) return; file.text = editor.value; file.dirty = file.isNew || serialize(file.text, file) !== file.raw; rememberDraft(); render(); });
  listen(saveButton, 'click', () => { if (file && editable() && file.dirty) void mutate({ action: 'write', path: file.path, content: serialize(file.text, file), expectedHash: file.hash }); });
  listen(reloadButton, 'click', () => { if (file) void readFile(file.path, { discard: true }); }); listen(moreText, 'click', () => { if (file) void readFile(file.path, { more: true }); });
  listen(historyButton, 'click', () => { void loadHistory(); }); listen(historyMore, 'click', () => { void loadHistory(true); });
  listen(inspectionMore, 'click', () => { if (inspection) void inspectEdit(inspection.edit, inspection.part, true); });
  render();
  return Object.freeze({ refresh, selectionChanged, close() { if (closed) return; closed = true; generation++; chooser++; fileGeneration++; for (const controller of requests) controller.abort(); for (const cleanup of cleanups) cleanup(); root.remove(); } });
}
