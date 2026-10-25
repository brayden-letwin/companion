const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/i;
const KINDS = new Set(['task', 'note', 'workflow']);
const PENDING_KEY = 'companion.workspace.recovery.pending.v1';
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const keyOf = item => item.kind + ':' + item.id;
const clone = value => JSON.parse(JSON.stringify(value));
const timeLabel = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time'; };
const countLabel = value => ['tasks', 'notes', 'workflows', 'preferences'].map(name => (value?.[name] || 0) + ' ' + name).join(' · ');
const validCounts = value => value && ['tasks', 'notes', 'workflows', 'preferences'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0);

/** Human-only content backup and recovery; the host owns authenticated transport. */
export function createWorkspaceBackupsUI({ container, api, getRevision = () => null, onImported = () => {}, notify = () => {} }) {
  if (!container || typeof api !== 'function') throw new TypeError('A backup container and API are required.');
  const doc = container.ownerDocument || globalThis.document;
  const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
  const button = (text, action, className = 'quiet-button') => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', action); return value; };
  const requests = new Set(), pending = new Set(), checking = new Set(), missing = new Set(), deleting = new Set(), frames = new Map(), receipts = new Map(), selected = new Map(), imported = new Set();
  let storage = null, closed = false, generation = 0, pageGeneration = 0, preview = null, previewFilename = '', backups = [], backupsLoaded = false, listBusy = false, createBusy = false, previewBusy = false, pageBusy = false, importBusy = false, pendingBackupId = null, activeImportId = null, previewUnavailable = false, error = '';
  try { storage = globalThis.localStorage; const ids = JSON.parse(storage?.getItem(PENDING_KEY) || '[]'); if (Array.isArray(ids)) for (const id of ids.slice(0, 20)) if (typeof id === 'string' && UUID.test(id)) pending.add(id); } catch { /* Text and filenames never enter browser storage. */ }

  const root = node('details', 'settings-section workspace-backups'), summary = node('summary', '', 'Backup and recovery');
  const scope = node('p', 'backup-scope', 'A workspace backup copies tasks, notes, workflows and preferences. It does not include chats, build history, AI keys, permissions, app source or project files.');
  const privacy = node('p', 'form-hint', 'Backup files contain your saved text. Keep them somewhere private.');
  const create = button('Create workspace backup', createBackup, 'secondary-button'), refreshButton = button('Refresh saved copies', () => refresh());
  const backupActions = node('div', 'backup-actions'); backupActions.append(create, refreshButton);
  const savedCopies = node('div', 'backup-saved-copies');
  const recoveryHeading = node('h3', '', 'Recover selected copies');
  const recoveryCopy = node('p', 'form-hint', 'Choose a backup, inspect its contents, then import up to 100 selected items as new copies. Existing data stays in place. Workflows are imported disabled and nothing is run.');
  const fileLabel = node('label', 'backup-file-label', 'Choose a workspace backup JSON file'), fileInput = node('input'); fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.setAttribute('aria-label', 'Choose workspace backup JSON file'); fileLabel.append(fileInput);
  const fileHint = node('p', 'form-hint', 'Maximum file size: 96 MiB. Choosing a file only creates a preview.');
  const previewArea = node('div', 'backup-preview'), pendingArea = node('div', 'backup-pending'), receiptArea = node('div', 'backup-receipts'), errorArea = node('p', 'inline-error'); errorArea.setAttribute('role', 'alert');
  root.append(summary, scope, privacy, backupActions, savedCopies, recoveryHeading, recoveryCopy, fileLabel, fileHint, previewArea, pendingArea, receiptArea, errorArea); container.append(root);
  root.addEventListener('toggle', () => { if (root.open && !backupsLoaded) void refresh(); });
  fileInput.addEventListener('change', chooseFile);

  function persist(removeId) {
    if (!storage) return;
    try { const ids = JSON.parse(storage.getItem(PENDING_KEY) || '[]'); if (Array.isArray(ids)) for (const id of ids.slice(0, 20)) if (typeof id === 'string' && UUID.test(id) && id !== removeId) pending.add(id); if (removeId) pending.delete(removeId); storage.setItem(PENDING_KEY, JSON.stringify([...pending].slice(0, 20))); } catch { /* Recovery stays available in this window. */ }
  }
  async function request(path, options = {}, timeout = 20000) {
    const controller = new AbortController(); requests.add(controller);
    try { return await api(path, { ...options, signal: controller.signal }, timeout); }
    finally { requests.delete(controller); }
  }
  function validBackup(value) { return value && UUID.test(value.id) && validCounts(value.counts) && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && HASH.test(value.sha256) && value.downloadPath === '/api/assistant/backups/' + value.id + '/download' && value.filename === 'companion-workspace-' + value.id.toLowerCase() + '.json'; }
  function validatePreview(value, expected) {
    if (!value || !UUID.test(value.id) || !UUID.test(value.archiveId) || !HASH.test(value.archiveHash) || !validCounts(value.counts) || !Number.isSafeInteger(value.sourceRevision) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.offset) || !Array.isArray(value.items) || value.items.length > 50 || !Array.isArray(value.preferences) || value.preferences.length > 50 || !Number.isFinite(Date.parse(value.expiresAt)) || value.items.some(item => !item || !KINDS.has(item.kind) || !UUID.test(item.id) || typeof item.title !== 'string' || typeof item.recoverable !== 'boolean')) throw new Error('The backup preview could not be matched. Choose the file again.');
    if (expected && (value.id !== expected.id || value.archiveHash !== expected.archiveHash || value.archiveId !== expected.archiveId)) throw new Error('This preview changed. Choose the file again before importing.');
    return value;
  }
  function validateReceipt(value, id, frame) {
    if (!value || value.id !== id || !UUID.test(value.id) || !UUID.test(value.previewId) || !HASH.test(value.archiveHash) || !Number.isSafeInteger(value.appliedRevision) || !Array.isArray(value.imported) || value.imported.length > 100 || value.imported.some(item => !KINDS.has(item.kind) || !UUID.test(item.sourceId) || !UUID.test(item.id) || typeof item.title !== 'string')) throw new Error('The import receipt could not be matched. Check this import before trying again.');
    if (new Set(value.imported.map(item => item.kind + ':' + item.sourceId)).size !== value.imported.length || new Set(value.imported.map(item => item.id)).size !== value.imported.length || value.imported.some(item => item.id === item.sourceId)) throw new Error('The import receipt does not identify separate new copies. Check it before trying again.');
    if (frame && (value.previewId !== frame.previewId || value.archiveHash !== frame.archiveHash || value.imported.length !== frame.selection.length || value.imported.some(item => !frame.selection.some(original => original.kind === item.kind && original.id === item.sourceId)))) throw new Error('The import receipt does not match the original selection. Check it before trying again.');
    return value;
  }
  function renderBackups() {
    create.disabled = createBusy || listBusy || deleting.size > 0 || !!pendingBackupId; refreshButton.disabled = listBusy || createBusy || deleting.size > 0; savedCopies.replaceChildren();
    if (pendingBackupId) savedCopies.append(node('p', 'form-hint', 'Backup creation is unconfirmed. Refresh saved copies to check it.'));
    if (!backups.length) { savedCopies.append(node('p', 'form-hint', backupsLoaded ? 'No saved server copies. Downloaded files are separate.' : 'Create a backup, or refresh to see saved copies.')); return; }
    for (const backup of backups) {
      const row = node('article', 'backup-copy'), text = node('div'); text.append(node('strong', '', timeLabel(backup.createdAt)), node('p', 'form-hint', countLabel(backup.counts) + ' · ' + Math.ceil(backup.bytes / 1024) + ' KiB · workspace revision ' + backup.revision));
      const actions = node('div', 'backup-actions'), download = node('a', 'secondary-button', 'Download JSON'); download.href = backup.downloadPath; download.download = backup.filename; download.setAttribute('aria-label', 'Download workspace backup from ' + timeLabel(backup.createdAt)); download.addEventListener('click', () => notify('Download requested. Check your downloads for the JSON file.'));
      const remove = button('Remove saved copy', () => removeBackup(backup.id)); remove.disabled = listBusy || createBusy || deleting.size > 0; actions.append(download, remove); row.append(text, actions); savedCopies.append(row);
    }
  }
  function renderPreview() {
    previewArea.replaceChildren(); fileHint.textContent = previewBusy ? 'Reading and validating the selected backup…' : 'Maximum file size: 96 MiB. Choosing a file only creates a preview.';
    if (!preview) return;
    const expired = previewUnavailable || Date.parse(preview.expiresAt) <= Date.now();
    previewArea.append(node('h4', '', 'Preview: ' + previewFilename), node('p', 'form-hint', 'Saved ' + timeLabel(preview.sourceCreatedAt) + ' · source revision ' + preview.sourceRevision + ' · ' + countLabel(preview.counts)));
    if (expired) previewArea.append(node('p', 'form-hint', 'This preview expired. Choose the backup again. Any earlier import can still be checked below.'));
    const selectPage = button('Select this page', () => { const eligible = preview.items.filter(item => item.recoverable && !imported.has(keyOf(item))); if (new Set([...selected.keys(), ...eligible.map(keyOf)]).size > 100) { error = 'Choose at most 100 items per import.'; render(); return; } for (const item of eligible) selected.set(keyOf(item), { kind: item.kind, id: item.id }); renderPreview(); });
    selectPage.disabled = expired || pageBusy; const clear = button('Clear selection', () => { selected.clear(); renderPreview(); }); const choices = node('div', 'backup-actions'); choices.append(selectPage, clear); previewArea.append(choices);
    const list = node('div', 'backup-items');
    for (const item of preview.items) {
      const row = node('label', 'backup-item'), checkbox = node('input'), text = node('span'), itemKey = keyOf(item); checkbox.type = 'checkbox'; checkbox.checked = selected.has(itemKey); checkbox.disabled = !item.recoverable || imported.has(itemKey) || expired; checkbox.setAttribute('aria-label', 'Recover ' + item.kind + ': ' + item.title);
      checkbox.addEventListener('change', () => { if (checkbox.disabled) return; if (checkbox.checked) { if (selected.size >= 100 && !selected.has(itemKey)) { checkbox.checked = false; error = 'Choose at most 100 items per import.'; } else selected.set(itemKey, { kind: item.kind, id: item.id }); } else selected.delete(itemKey); render(); });
      text.append(node('strong', '', item.title || '(Untitled)'), node('small', '', item.kind + (imported.has(itemKey) ? ' · copied in this preview' : !item.recoverable ? ' · ' + (item.reason || 'Not recoverable') : item.kind === 'workflow' ? ' · imports disabled' : ''))); row.append(checkbox, text); list.append(row);
    }
    if (!preview.items.length) list.append(node('p', 'form-hint', 'No tasks, notes or workflows on this page.')); previewArea.append(list);
    const page = node('div', 'backup-pages'); page.append(node('span', '', 'Showing ' + (preview.items.length ? preview.offset + 1 : 0) + '–' + (preview.offset + preview.items.length) + ' of ' + preview.total + ' items.'));
    if (preview.offset > 0) { const previous = button('Previous items', () => loadPage(Math.max(0, preview.offset - 50))); previous.disabled = pageBusy; page.append(previous); }
    if (preview.hasMore) { const next = button('Next items', () => loadPage(preview.nextOffset)); next.disabled = pageBusy; page.append(next); } previewArea.append(page);
    if (preview.preferences.length) { const preferences = node('details', 'backup-preferences'); preferences.append(node('summary', '', 'Preferences in this backup'), node('p', 'form-hint', 'Preferences are not imported. Teach any you want Companion to remember again.')); for (const preference of preview.preferences) { const row = node('div', 'backup-preference'); row.append(node('strong', '', preference.label || preference.key), node('p', '', preference.value), node('small', '', preference.archived ? 'Forgotten in this backup' : 'Saved in this backup')); preferences.append(row); } previewArea.append(preferences); }
    const importButton = button(importBusy ? 'Importing copies…' : 'Import ' + selected.size + ' ' + (selected.size === 1 ? 'copy' : 'copies'), importSelection, 'primary-button'); importButton.disabled = expired || !selected.size || importBusy || pending.size > 0 || !Number.isSafeInteger(getRevision());
    const footer = node('div', 'backup-import-footer'); footer.append(node('p', 'form-hint', selected.size + ' of 100 selected. Existing items will not be replaced.'), importButton); previewArea.append(footer);
  }
  function renderPending() {
    pendingArea.replaceChildren(); summary.textContent = 'Backup and recovery' + (pending.size ? ' · import needs checking' : '');
    for (const id of pending) { const row = node('div', 'backup-pending-row'); row.append(node('p', '', missing.has(id) ? 'No import is recorded for this ID. Nothing is being retried.' : 'The import result is unconfirmed. Check its original receipt before importing again.')); const check = button(checking.has(id) ? 'Checking import…' : 'Check import', () => checkImport(id)); check.disabled = checking.has(id) || id === activeImportId; row.append(check); if (missing.has(id) && id !== activeImportId) row.append(button('Dismiss unrecorded import', () => { pending.delete(id); frames.delete(id); missing.delete(id); persist(id); render(); })); pendingArea.append(row); }
  }
  function renderReceipts() { receiptArea.replaceChildren(); for (const receipt of [...receipts.values()].reverse()) { const row = node('details', 'backup-import-receipt'); row.append(node('summary', '', 'Imported ' + receipt.imported.length + ' new ' + (receipt.imported.length === 1 ? 'copy' : 'copies') + ' · ' + timeLabel(receipt.createdAt)), node('p', 'form-hint', 'Workspace revision ' + receipt.appliedRevision + '. Workflows stay disabled. Existing data and action receipts were retained.')); for (const item of receipt.imported) row.append(node('p', '', item.kind + ': ' + item.title)); receiptArea.append(row); } }
  function render() { if (closed) return; renderBackups(); renderPreview(); renderPending(); renderReceipts(); errorArea.textContent = error; }
  async function refresh() {
    if (closed || listBusy || createBusy || deleting.size > 0) return; listBusy = true; error = ''; renderBackups();
    try { const value = await request('backups'); if (closed) return; if (!Array.isArray(value.backups) || value.backups.some(item => !validBackup(item))) throw new Error('Saved backups could not be read. Refresh to check them.'); backups = value.backups; backupsLoaded = true; if (pendingBackupId) { const found = backups.some(item => item.id === pendingBackupId); pendingBackupId = null; if (found) notify('The saved backup is confirmed. You can download it.'); } }
    catch (failure) { if (!closed) error = failure.message; }
    finally { listBusy = false; render(); }
  }
  async function createBackup() {
    if (closed || createBusy || listBusy || deleting.size > 0 || pendingBackupId) return; const id = globalThis.crypto.randomUUID(); createBusy = true; error = ''; render();
    try { const value = await request('backups', { method: 'POST', body: JSON.stringify({ id }) }, 120000); if (closed) return; if (!validBackup(value.backup) || value.backup.id !== id) throw new Error('The saved backup could not be matched.'); backups = [value.backup, ...backups.filter(item => item.id !== id)]; backupsLoaded = true; notify('Workspace backup created. Download it to keep a copy.'); }
    catch (failure) { if (!failure.status || failure.status >= 500) pendingBackupId = id; if (!closed) error = failure.message; }
    finally { createBusy = false; render(); }
  }
  async function removeBackup(id) {
    if (closed || listBusy || createBusy || deleting.size > 0) return; deleting.add(id); error = ''; renderBackups();
    try { await request('backups/' + id + '/delete', { method: 'POST', body: '{}' }); if (!closed) notify('Saved server copy removed. Downloaded files are unchanged.'); }
    catch (failure) { if (!closed) error = 'Removal could not be confirmed. Refresh saved copies to check it.'; }
    finally { deleting.delete(id); if (!closed) await refresh(); }
  }
  async function chooseFile() {
    const file = fileInput.files?.[0]; if (!file || closed) return;
    const stamp = ++generation; pageGeneration++; pageBusy = false; previewUnavailable = false; preview = null; previewFilename = String(file.name || 'Selected backup'); selected.clear(); imported.clear(); previewBusy = true; error = ''; render();
    try { if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE_BYTES || file.size < 1) throw new Error('Choose a JSON backup no larger than 96 MiB.'); const text = await file.text(); if (closed || stamp !== generation) return; let archive; try { archive = JSON.parse(text); } catch { throw new Error('This file is not readable JSON. Choose a Companion workspace backup.'); } const value = await request('backup-recovery/preview', { method: 'POST', body: JSON.stringify({ archive }) }, 120000); if (closed || stamp !== generation) return; preview = validatePreview(value.preview); }
    catch (failure) { if (!closed && stamp === generation) error = failure.message; }
    finally { if (stamp === generation) { previewBusy = false; fileInput.value = ''; render(); } }
  }
  async function loadPage(offset) {
    if (closed || !preview || pageBusy || !Number.isSafeInteger(offset) || offset < 0) return; const stamp = generation, version = ++pageGeneration, target = clone(preview); pageBusy = true; error = ''; renderPreview();
    try { const value = await request('backup-recovery/previews/' + target.id + '?' + new URLSearchParams({ offset: String(offset), limit: '50' })); if (closed || stamp !== generation || version !== pageGeneration) return; preview = validatePreview(value.preview, target); }
    catch (failure) { if (!closed && stamp === generation && version === pageGeneration) { error = failure.message; if ([404, 410].includes(failure.status)) previewUnavailable = true; } }
    finally { if (stamp === generation && version === pageGeneration) { pageBusy = false; render(); } }
  }
  async function acceptReceipt(value, id, frame, workspace) {
    const receipt = validateReceipt(value, id, frame); receipts.set(id, receipt); pending.delete(id); missing.delete(id); frames.delete(id); persist(id);
    if (preview?.id === receipt.previewId && preview.archiveHash === receipt.archiveHash) for (const item of receipt.imported) { const key = keyOf({ kind: item.kind, id: item.sourceId }); imported.add(key); selected.delete(key); }
    if (!closed) { render(); notify('Imported ' + receipt.imported.length + ' new copies. Existing items were kept.'); try { await onImported(receipt, workspace || null); } catch { error = 'The import is confirmed. Refresh the workspace to see its copies.'; render(); } }
    return receipt;
  }
  async function importSelection() {
    persist(); if (closed || !preview || importBusy || pending.size || !selected.size) { render(); return; } const revision = getRevision(); if (!Number.isSafeInteger(revision)) { error = 'Connect to the current workspace before importing.'; render(); return; } if (previewUnavailable || Date.parse(preview.expiresAt) <= Date.now()) { error = 'This preview expired. Choose the backup again.'; render(); return; }
    const id = globalThis.crypto.randomUUID(), frame = { previewId: preview.id, archiveHash: preview.archiveHash, selection: clone([...selected.values()]), generation }, body = { id, previewId: frame.previewId, expectedRevision: revision, selection: frame.selection }; frames.set(id, frame); pending.add(id); persist(); importBusy = true; activeImportId = id; error = ''; render();
    try { const value = await request('backup-recovery/import', { method: 'POST', body: JSON.stringify(body) }, 120000); await acceptReceipt(value.receipt, id, frame, value.workspace); }
    catch (failure) { if (failure.status && failure.status < 500 && failure.status !== 408) { pending.delete(id); frames.delete(id); persist(id); } else if (pending.has(id)) persist(); if (!closed && frame.generation === generation) error = pending.has(id) ? 'The import may have completed. Use Check import for its saved result. Nothing will be retried automatically.' : failure.message; }
    finally { importBusy = false; if (activeImportId === id) activeImportId = null; render(); }
  }
  async function checkImport(id) {
    if (closed || checking.has(id) || id === activeImportId || !pending.has(id)) return; checking.add(id); error = ''; renderPending();
    try { const value = await request('backup-recovery/imports/' + id); await acceptReceipt(value.receipt, id, frames.get(id), null); }
    catch (failure) { if (!closed) { if (failure.status === 404) missing.add(id); else error = failure.message; } }
    finally { checking.delete(id); render(); }
  }
  render();
  return { refresh, close() { if (closed) return; closed = true; generation++; pageGeneration++; for (const controller of requests) controller.abort(); requests.clear(); root.remove(); } };
}
