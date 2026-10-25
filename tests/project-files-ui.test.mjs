import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectFilesUI } from '../src/project-files.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const P = { projectId: A, grantEpoch: 1, label: 'Synthetic project', localPath: 'C:\\Synthetic\\Project', available: true, mode: 'read_write' };
const Q = { ...P, projectId: B, label: 'Second project', localPath: 'C:\\Synthetic\\Second' };
const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const copy = value => structuredClone(value);
const failure = (message, status = 409, code = 'project_file_changed') => Object.assign(new Error(message), { status, code });
const all = element => [element, ...element.children.flatMap(all)];
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Files UI did not settle'); }

class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.text = ''; this.hidden = false; this.disabled = false; this.readOnly = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Files must use literal DOM text'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ??= new Set()).add(callback); }
  removeEventListener(type, callback) { this.listeners[type]?.delete(callback); }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({ preventDefault() {}, target: this }); }
  focus() { this.focused = true; }
}

function fixture({ projects = [P, Q], files = { 'notes.md': 'First note\n' }, storage = new Map(), intercept = null, echoSelection = false } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), sibling = doc.createElement('aside'); container.append(sibling);
  const calls = [], selected = [], revoked = [], notices = [], versions = new Map(Object.entries(files).map(([name, content]) => [A + ':' + name, content])), records = new Map(), metadata = projects.map(copy);
  let custom = intercept, ui;
  function packet(binding, path, raw, offset = 0, limit = 12000) {
    const ends = new Set(raw.match(/\r\n|\r|\n/g) || []), lineEndings = ends.size > 1 ? 'mixed' : ends.has('\r\n') ? 'crlf' : ends.has('\r') ? 'cr' : ends.has('\n') ? 'lf' : 'none';
    return { projectId: binding.projectId, grantEpoch: binding.grantEpoch, path, hash: hash(raw), content: raw.slice(offset, offset + limit), offset, nextOffset: offset + limit < raw.length ? offset + limit : null, hasMore: offset + limit < raw.length, characterLength: raw.length, byteLength: Buffer.byteLength(raw), readAt: '2026-10-25T12:00:00Z', sourceTrust: 'untrusted_project_file', lineEndings, bom: raw.startsWith('\uFEFF') };
  }
  async function api(path, options = {}, timeout) {
    const call = { path, options, timeout }; calls.push(call); if (custom) { const value = await custom(call); if (value !== undefined) return value; }
    const url = new URL('http://fixture/' + path), parts = url.pathname.slice(1).split('/'), projectId = parts[1], grantEpoch = Number(url.searchParams.get('grantEpoch')), binding = { projectId, grantEpoch };
    if (path === 'projects') return { projects: copy(metadata) };
    if (path === 'projects/choose') return { project: copy(metadata[0]) };
    if (parts[2] === 'revoke') { const project = metadata.find(item => item.projectId === projectId); project.grantEpoch++; project.revoked = true; project.available = false; return { project: copy(project), revoked: true }; }
    if (parts[2] === 'files') {
      const folder = url.searchParams.get('path') || '', offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      const entries = [...versions.keys()].filter(key => key.startsWith(projectId + ':')).map(key => key.slice(projectId.length + 1)).filter(name => !folder || name.startsWith(folder + '/')).map(name => ({ name: folder ? name.slice(folder.length + 1) : name, path: name, kind: 'file', byteLength: Buffer.byteLength(versions.get(projectId + ':' + name)) }));
      return { ...binding, path: folder, entries: entries.slice(offset, offset + limit), offset, hasMore: offset + limit < entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null, directoryHash: 'directory-version-1', complete: true, scanLimitReached: false, total: entries.length };
    }
    if (parts[2] === 'file') { const filePath = url.searchParams.get('path'), raw = versions.get(projectId + ':' + filePath); if (raw === undefined) throw failure('File missing', 404); if (url.searchParams.has('expectedHash') && url.searchParams.get('expectedHash') !== hash(raw)) throw failure('File changed while paging'); return packet(binding, filePath, raw, Number(url.searchParams.get('offset')), Number(url.searchParams.get('limit'))); }
    if (parts[2] === 'edit') {
      const body = JSON.parse(options.body), old = body.action === 'undo' ? records.get(body.changeId) : null, filePath = old?.receipt.path || body.path, key = projectId + ':' + filePath, before = versions.get(key) ?? null;
      if (records.has(body.operationId)) return { projectFileEdit: copy(records.get(body.operationId).receipt), replayed: true };
      if (body.action === 'write' && hash(before) !== body.expectedHash || body.action === 'undo' && hash(before) !== old.receipt.afterHash) throw failure('The file changed outside Companion; no edit was made.');
      const after = body.action === 'undo' ? old.before : body.content; if (after === null) versions.delete(key); else versions.set(key, after);
      const receipt = { id: body.operationId, projectId, grantEpoch: body.grantEpoch, path: filePath, status: 'applied', beforeHash: hash(before), afterHash: hash(after), bytes: after === null ? 0 : Buffer.byteLength(after), undoAvailable: true }; records.set(body.operationId, { before, after, receipt }); return { projectFileEdit: copy(receipt), replayed: false };
    }
    if (parts[2] === 'history') { const edits = [...records.values()].map(item => item.receipt).filter(item => item.projectId === projectId); return { ...binding, edits: copy(edits), offset: 0, hasMore: false, nextOffset: null, total: edits.length }; }
    if (parts[2] === 'edits') { const record = records.get(parts[3]); if (!record) throw failure('Edit missing', 404); const part = url.searchParams.get('part'); if (part === 'metadata') return { projectFileEdit: copy(record.receipt) }; const raw = record[part] || ''; return { ...packet(binding, record.receipt.path, raw, Number(url.searchParams.get('offset')), Number(url.searchParams.get('limit'))), changeId: parts[3], part, fileExists: record[part] !== null }; }
    throw new Error('Unexpected Files request: ' + path);
  }
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  try { ui = createProjectFilesUI({ container, api, onSelect: value => { selected.push(copy(value)); if (echoSelection) ui.selectionChanged(value); }, onRevoke: value => { revoked.push(copy(value)); }, notify: value => notices.push(value) }); }
  finally { if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; }
  const button = text => all(container).find(item => item.tagName === 'button' && item.textContent === text);
  const field = label => all(container).find(item => item.attributes['aria-label'] === label);
  return { ui, container, sibling, calls, selected, revoked, notices, versions, records, metadata, storage, button, field, packet, setIntercept: value => { custom = value; }, async choose() { await button('Choose project folder').fire('click'); await settle(); }, async open(path) { await field('Read file: ' + path).fire('click'); await settle(); }, async edit(text) { field('File text').value = text; await field('File text').fire('input'); }, async save() { await button('Save file').fire('click'); await settle(); }, close() { ui.close(); } };
}

test('Files starts without scans or authority and explicit chooser uses an empty body with opaque callbacks', async () => {
  const f = fixture({ echoSelection: true });
  try { assert.equal(f.calls.length, 0); assert.match(f.container.textContent, /Companion and connected AI tools can read and write requested text files/); f.ui.selectionChanged({ projectId: A, grantEpoch: 1, label: P.label }); assert.equal(f.calls.length, 0); f.ui.selectionChanged(null); await f.choose(); const choose = f.calls.find(call => call.path === 'projects/choose'); assert.equal(choose.options.body, '{}'); assert.equal(choose.timeout, 120000); assert.deepEqual(f.selected, [{ projectId: A, grantEpoch: 1, label: P.label }]); assert.equal('localPath' in f.selected[0], false); assert.ok(f.calls.some(call => call.path.startsWith('projects/' + A + '/files?'))); assert.match(f.container.textContent, /C:\\Synthetic\\Project/); }
  finally { f.close(); }
});

test('chooser cancellation preserves the existing folder and unsent draft; late chooser results cannot replace a newer selection', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('Kept draft'); f.setIntercept(call => call.path === 'projects/choose' ? { project: null, cancelled: true } : undefined); await f.choose(); assert.equal(f.field('File text').value, 'Kept draft'); assert.equal(f.selected.length, 1); const late = deferred(); f.setIntercept(call => call.path === 'projects/choose' ? late.promise : undefined); await f.button('Choose project folder').fire('click'); await until(() => f.calls.filter(call => call.path === 'projects/choose').length === 3); f.ui.selectionChanged(Q); late.resolve({ project: P }); await settle(); assert.match(f.container.textContent, /Second project/); assert.equal(f.selected.length, 1); }
  finally { f.close(); }
});

test('directory paging is explicit and pins its original directory hash, and filenames remain literal', async () => {
  const files = Object.fromEntries(Array.from({ length: 45 }, (_, index) => ['task-' + index + '.md', 'x'])); files['<img onerror=alert(1)>.md'] = 'literal'; const f = fixture({ files });
  try { await f.choose(); assert.equal(f.calls.filter(call => call.path.includes('/files?')).length, 1); await f.button('Load more files').fire('click'); await settle(); const list = f.calls.filter(call => call.path.includes('/files?')); assert.equal(list.length, 2); assert.equal(new URL('http://fixture/' + list[1].path).searchParams.get('expectedDirectoryHash'), 'directory-version-1'); assert.ok(f.field('Read file: <img onerror=alert(1)>.md')); assert.equal(all(f.container).some(item => item.tagName === 'img'), false); assert.match(f.container.textContent, /Showing 46 entries/); }
  finally { f.close(); }
});

test('whole-file Save preserves one BOM and uniform CRLF, sends the exact original hash, and has a real Undo receipt', async () => {
  const original = '\uFEFFalpha\r\nbeta\r\n', f = fixture({ files: { 'notes.md': original } });
  try { await f.choose(); await f.open('notes.md'); assert.equal(f.field('File text').value, 'alpha\nbeta\n'); await f.edit('alpha\nbeta\ngamma\n'); assert.equal(f.calls.filter(call => call.options.method === 'POST' && call.path.endsWith('/edit')).length, 0); await f.save(); const request = f.calls.find(call => call.path.endsWith('/edit')), body = JSON.parse(request.options.body); assert.equal(body.expectedHash, hash(original)); assert.equal(body.content, '\uFEFFalpha\r\nbeta\r\ngamma\r\n'); assert.equal(f.versions.get(A + ':notes.md'), body.content); assert.match(f.container.textContent, /Saved/); assert.ok(f.button('Undo')); await f.edit('A newer unsaved draft'); await f.button('Undo').fire('click'); await settle(); assert.equal(f.versions.get(A + ':notes.md'), original); assert.equal(f.field('File text').value, 'A newer unsaved draft'); assert.equal(f.field('File text').readOnly, true); assert.match(f.container.textContent, /The file changed through Undo\. Reload to see its current contents before editing\./); assert.doesNotMatch(f.container.textContent, /This edit needs inspection/); await f.button('Discard draft and reload').fire('click'); await settle(); assert.equal(f.field('File text').value, 'alpha\nbeta\n'); assert.equal(f.field('File text').readOnly, false); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 2); assert.ok(f.notices.includes('Undo saved.')); }
  finally { f.close(); }
});

test('partial and mixed-line-ending files are read-only; explicit page completion enables only eligible whole files', async () => {
  const f = fixture({ files: { 'long.txt': 'a'.repeat(13000), 'mixed.txt': 'a\r\nb\n' } });
  try { await f.choose(); await f.open('long.txt'); assert.equal(f.field('File text').readOnly, true); assert.equal(f.button('Save file').disabled, true); await f.button('Load more text').fire('click'); await settle(); assert.equal(f.field('File text').value.length, 13000); assert.equal(f.field('File text').readOnly, false); const reads = f.calls.filter(call => call.path.includes('/file?')); assert.equal(new URL('http://fixture/' + reads[1].path).searchParams.get('expectedHash'), hash('a'.repeat(13000))); await f.open('mixed.txt'); assert.equal(f.field('File text').readOnly, true); assert.match(f.container.textContent, /Mixed line endings/); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); }
  finally { f.close(); }
});

test('a lost Save response persists IDs only and Check save across reload is GET-only with the original binding', async () => {
  const storage = new Map(), f = fixture({ storage });
  try { await f.choose(); await f.open('notes.md'); await f.edit('Private exact draft'); let submitted; f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; submitted = JSON.parse(call.options.body); throw new Error('Synthetic lost response'); }); await f.save(); assert.equal(f.button('Save file').disabled, true); assert.ok(f.button('Check save')); const stored = JSON.parse(storage.get('companion.project.files.pending.v1')); assert.deepEqual(Object.keys(stored[0]).sort(), ['grantEpoch', 'id', 'projectId']); assert.equal(stored[0].id, submitted.operationId); assert.ok([...storage.values()].every(value => !value.includes('Private exact draft') && !value.includes('notes.md') && !value.includes(P.label)));
    const reloaded = fixture({ storage }); try { assert.equal(reloaded.calls.length, 0); reloaded.records.set(submitted.operationId, { before: 'First note\n', after: 'Private exact draft', receipt: { id: submitted.operationId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'applied', beforeHash: hash('First note\n'), afterHash: hash('Private exact draft'), bytes: 19, undoAvailable: true } }); await reloaded.button('Check save').fire('click'); await settle(); assert.equal(reloaded.calls.length, 1); assert.equal(reloaded.calls[0].options.method, undefined); assert.ok(reloaded.calls[0].path.includes('/edits/' + submitted.operationId)); assert.equal(new URL('http://fixture/' + reloaded.calls[0].path).searchParams.get('grantEpoch'), '1'); assert.equal(reloaded.button('Check save'), undefined); assert.ok(reloaded.notices.some(value => value.startsWith('Saved'))); } finally { reloaded.close(); }
  } finally { f.close(); }
});

test('a file hash conflict preserves the draft and never silently retries or overwrites an outside edit', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('My unsent draft'); f.versions.set(A + ':notes.md', 'External editor text'); await f.save(); assert.equal(f.versions.get(A + ':notes.md'), 'External editor text'); assert.equal(f.field('File text').value, 'My unsent draft'); assert.ok(f.button('Check save')); await f.button('Check save').fire('click'); await settle(); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 1); assert.match(f.container.textContent, /No saved edit was found/); await f.button('Discard draft and reload').fire('click'); await settle(); assert.equal(f.field('File text').value, 'External editor text'); }
  finally { f.close(); }
});

test('Undo uses its recorded change identity and refuses a later external file version', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('Saved version'); await f.save(); const saved = [...f.records.values()][0].receipt; f.versions.set(A + ':notes.md', 'Outside change after save'); await f.button('Undo').fire('click'); await settle(); const edits = f.calls.filter(call => call.path.endsWith('/edit')).map(call => JSON.parse(call.options.body)); assert.equal(edits.length, 2); assert.equal(edits[1].action, 'undo'); assert.equal(edits[1].changeId, saved.id); assert.equal(f.versions.get(A + ':notes.md'), 'Outside change after save'); assert.ok(f.button('Check save')); }
  finally { f.close(); }
});

test('switching folders or files rejects late reads and retains independent in-memory drafts', async () => {
  const f = fixture({ files: { 'a.txt': 'A disk', 'b.txt': 'B disk' } });
  try { await f.choose(); const late = deferred(); f.setIntercept(call => call.path.includes('/file?') && new URL('http://fixture/' + call.path).searchParams.get('path') === 'a.txt' ? late.promise : undefined); await f.field('Read file: a.txt').fire('click'); await f.open('b.txt'); assert.equal(f.field('File text').value, 'B disk'); late.resolve(f.packet(P, 'a.txt', 'A late result')); await settle(); assert.equal(f.field('File text').value, 'B disk'); await f.edit('B unsent draft'); f.ui.selectionChanged(Q); f.ui.selectionChanged(P); await f.ui.refresh(); await f.open('b.txt'); assert.equal(f.field('File text').value, 'B unsent draft'); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); }
  finally { f.close(); }
});

test('a late acknowledged Save cannot overwrite a newly opened editor or clear newer text', async () => {
  const f = fixture({ files: { 'a.txt': 'A disk', 'b.txt': 'B disk' } });
  try { await f.choose(); await f.open('a.txt'); await f.edit('A save'); const saved = deferred(); let id; f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; id = JSON.parse(call.options.body).operationId; return saved.promise; }); await f.button('Save file').fire('click'); await until(() => !!id); await f.open('b.txt'); await f.edit('B newer draft'); saved.resolve({ projectFileEdit: { id, projectId: A, grantEpoch: 1, path: 'a.txt', status: 'applied', beforeHash: hash('A disk'), afterHash: hash('A save'), bytes: 6, undoAvailable: true } }); await settle(); assert.equal(f.field('File text').value, 'B newer draft'); assert.match(f.container.textContent, /Unsaved changes/); }
  finally { f.close(); }
});

test('revocation is explicit and never clears a newer selected folder; terminal metadata remains checkable', async () => {
  const f = fixture();
  try { await f.choose(); const delayed = deferred(); f.setIntercept(call => call.path.endsWith('/revoke') ? delayed.promise : undefined); await f.button('Remove access').fire('click'); f.ui.selectionChanged(Q); delayed.resolve({ project: { ...P, grantEpoch: 2, revoked: true, available: false }, revoked: true }); await settle(); assert.deepEqual(f.revoked, [{ projectId: A, grantEpoch: 1 }]); assert.match(f.container.textContent, /Second project/); assert.equal(f.calls.filter(call => call.path.endsWith('/revoke')).length, 1); }
  finally { f.close(); }
});

test('interrupted and uncertain recovery receipts stay visible without saying Saved or retrying effects', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('Draft needing recovery'); f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; const body = JSON.parse(call.options.body); return { projectFileEdit: { id: body.operationId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'recovery_required', beforeHash: hash('First note\n'), afterHash: null, bytes: 0, undoAvailable: false, outcomeUnknown: true } }; }); await f.save(); assert.match(f.container.textContent, /Needs recovery/); assert.match(f.container.textContent, /file state needs checking/); assert.equal(f.button('Save file').disabled, true); assert.equal(f.button('Undo'), undefined); assert.equal(f.notices.includes('File saved.'), false); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 1); }
  finally { f.close(); }
});

test('new files use null expectedHash and literal text; close aborts pending UI requests and preserves sibling DOM', async () => {
  const f = fixture();
  await f.choose(); f.field('New text file path').value = 'new.md'; await all(f.container).find(item => item.tagName === 'form' && all(item).includes(f.field('New text file path'))).fire('submit'); await f.edit('<script>literal</script>'); await f.save(); const body = JSON.parse(f.calls.find(call => call.path.endsWith('/edit')).options.body); assert.equal(body.expectedHash, null); assert.equal(body.path, 'new.md'); assert.equal(f.versions.get(A + ':new.md'), '<script>literal</script>'); assert.equal(all(f.container).some(item => item.tagName === 'script'), false);
  const delayed = deferred(); f.setIntercept(call => call.path === 'projects/choose' ? delayed.promise : undefined); const chooserButton = f.button('Choose project folder'); await chooserButton.fire('click'); const request = f.calls.at(-1); f.close(); assert.equal(request.options.signal.aborted, true); assert.deepEqual(f.container.children, [f.sibling]); delayed.resolve({ project: Q }); await settle(); assert.equal(f.selected.length, 1); await chooserButton.fire('click'); assert.equal(f.calls.at(-1), request);
});


test('editor write bounds count restored line endings and encoded JSON without creating a pending mutation', async () => {
  const f = fixture({ files: { 'crlf.txt': 'a\r\n' } });
  try { await f.choose(); assert.equal(f.field('New text file path').maxLength, 240); await f.open('crlf.txt'); await f.edit('\n'.repeat(12001)); await f.save(); assert.match(f.container.textContent, /exceeds the text editor limit/); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); assert.equal(f.button('Check save'), undefined); await f.edit('\u0001'.repeat(14000)); await f.save(); assert.match(f.container.textContent, /exceeds the text editor limit/); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); }
  finally { f.close(); }
});

test('recent history and immutable before/after text are explicit, paged and distinguish absent from empty files', async () => {
  const f = fixture(), changeId = '33333333-3333-4333-8333-333333333333';
  try { await f.choose(); assert.equal(f.calls.some(call => call.path.includes('/history?')), false); f.records.set(changeId, { before: null, after: 'saved '.repeat(4500), receipt: { id: changeId, projectId: A, grantEpoch: 1, path: 'created.md', status: 'applied', beforeHash: null, afterHash: hash('saved '.repeat(4500)), bytes: 27000, undoAvailable: false } }); await f.button('Load recent edits').fire('click'); await settle(); await f.button('Before').fire('click'); await settle(); assert.match(f.container.textContent, /did not exist in this saved version/); assert.equal(f.field('Saved edit text').value, ''); await f.button('After').fire('click'); await settle(); assert.equal(f.field('Saved edit text').value.length, 12000); while (!f.button('Load more saved text').hidden) { await f.button('Load more saved text').fire('click'); await settle(); } assert.equal(f.field('Saved edit text').value, 'saved '.repeat(4500)); const inspections = f.calls.filter(call => call.path.includes('/edits/' + changeId)); assert.equal(inspections.length, 4); assert.deepEqual(inspections.map(call => new URL('http://fixture/' + call.path).searchParams.get('part')), ['before', 'after', 'after', 'after']); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 0); }
  finally { f.close(); }
});

test('an HTTP failure retains its actual recovery receipt and draft without claiming a save or a rollback', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('Kept unknown-effect draft'); f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; const body = JSON.parse(call.options.body), error = failure('Write verification was interrupted', 500, 'project_edit_interrupted'); error.projectFileEdit = { id: body.operationId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'interrupted', beforeHash: hash('First note\n'), afterHash: null, bytes: 0, undoAvailable: false, outcomeUnknown: true }; throw error; }); await f.save(); assert.match(f.container.textContent, /Interrupted/); assert.match(f.container.textContent, /file state needs checking/); assert.equal(f.field('File text').value, 'Kept unknown-effect draft'); assert.equal(f.button('Save file').disabled, true); assert.equal(f.notices.includes('File saved.'), false); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 1); }
  finally { f.close(); }
});

test('an unconfirmed edit remains inspectable by its original ID and epoch after explicit access removal', async () => {
  const f = fixture();
  try { await f.choose(); await f.open('notes.md'); await f.edit('Saved before revocation'); let operation; f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; operation = JSON.parse(call.options.body); throw new Error('Synthetic response lost'); }); await f.save(); f.records.set(operation.operationId, { before: 'First note\n', after: 'Saved before revocation', receipt: { id: operation.operationId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'applied', beforeHash: hash('First note\n'), afterHash: hash('Saved before revocation'), bytes: 23, undoAvailable: true } }); f.setIntercept(null); await f.button('Remove access').fire('click'); await settle(); assert.deepEqual(f.revoked, [{ projectId: A, grantEpoch: 1 }]); const before = f.calls.length; await f.button('Check save').fire('click'); await settle(); const check = f.calls.slice(before); assert.equal(check.length, 1); assert.equal(check[0].options.method, undefined); assert.equal(new URL('http://fixture/' + check[0].path).searchParams.get('grantEpoch'), '1'); assert.ok(check[0].path.includes('/edits/' + operation.operationId)); assert.equal(f.button('Check save'), undefined); }
  finally { f.close(); }
});


test('fresh access can view and Undo an older same-project edit without accepting another project history', async () => {
  const current = { ...P, grantEpoch: 3 }, f = fixture({ projects: [current], files: { 'notes.md': 'After old edit' } }), oldId = '33333333-3333-4333-8333-333333333333';
  try {
    const old = { id: oldId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'applied', beforeHash: hash('Before old edit'), afterHash: hash('After old edit'), bytes: 14, undoAvailable: true }, foreign = { ...old, id: '44444444-4444-4444-8444-444444444444', projectId: B, path: 'foreign-private.txt' }; f.records.set(oldId, { before: 'Before old edit', after: 'After old edit', receipt: old });
    await f.choose(); f.setIntercept(call => call.path.includes('/history?') ? { projectId: A, grantEpoch: 3, edits: [old, foreign], offset: 0, hasMore: false, nextOffset: null } : undefined); await f.button('Load recent edits').fire('click'); await settle(); assert.ok(f.button('Undo')); assert.match(f.container.textContent, /notes.md/); assert.doesNotMatch(f.container.textContent, /foreign-private/);
    await f.button('Before').fire('click'); await settle(); assert.equal(f.field('Saved edit text').value, 'Before old edit'); const inspected = f.calls.find(call => call.path.includes('/edits/' + oldId)); assert.equal(new URL('http://fixture/' + inspected.path).searchParams.get('grantEpoch'), '3');
    await f.button('Undo').fire('click'); await settle(); const body = JSON.parse(f.calls.find(call => call.path.endsWith('/edit')).options.body); assert.equal(body.grantEpoch, 3); assert.equal(body.changeId, oldId); assert.equal(f.versions.get(A + ':notes.md'), 'Before old edit');
  } finally { f.close(); }
});

test('Check save still rejects an operation receipt carrying a different original access epoch', async () => {
  const f = fixture();
  try {
    await f.choose(); await f.open('notes.md'); await f.edit('Pending original-epoch text'); let id;
    f.setIntercept(call => { if (call.path.endsWith('/edit')) { id = JSON.parse(call.options.body).operationId; throw new Error('Synthetic lost response'); } if (id && call.path.includes('/edits/' + id)) return { projectFileEdit: { id, projectId: A, grantEpoch: 9, path: 'notes.md', status: 'applied', beforeHash: hash('First note\n'), afterHash: hash('Pending original-epoch text'), undoAvailable: true } }; });
    await f.save(); await f.button('Check save').fire('click'); await settle(); assert.ok(f.button('Check save')); assert.equal(f.button('Save file').disabled, true); assert.match(f.container.textContent, /could not be matched/); assert.equal(f.notices.includes('File saved.'), false); assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 1);
  } finally { f.close(); }
});


test('applied bytes with an unfinished receipt retain Check save identity across Leave and reload until exact metadata finalizes', async () => {
  const storage = new Map(), f = fixture({ storage }); let operation, finalReceipt;
  try {
    await f.choose(); await f.open('notes.md'); await f.edit('Actually changed bytes');
    f.setIntercept(call => { if (!call.path.endsWith('/edit')) return; operation = JSON.parse(call.options.body); f.versions.set(A + ':notes.md', operation.content); finalReceipt = { id: operation.operationId, projectId: A, grantEpoch: 1, path: 'notes.md', status: 'applied', beforeHash: hash('First note\n'), afterHash: hash(operation.content), bytes: Buffer.byteLength(operation.content), undoAvailable: true }; const error = failure('Durable receipt write failed', 503, 'project_receipt_unavailable'); error.projectFileEdit = { ...finalReceipt, receiptPending: true }; throw error; });
    await f.save(); assert.equal(f.versions.get(A + ':notes.md'), 'Actually changed bytes'); assert.match(f.container.textContent, /File changed · receipt needs checking/); assert.ok(f.button('Check save')); assert.equal(f.button('Save file').disabled, true); assert.equal(f.button('Undo').disabled, true); assert.equal(f.notices.includes('File saved.'), false); assert.deepEqual(JSON.parse(storage.get('companion.project.files.pending.v1')), [{ projectId: A, grantEpoch: 1, id: operation.operationId }]);
    await f.button('Leave folder').fire('click'); await settle(); assert.ok(f.button('Check save')); assert.deepEqual(f.selected.at(-1), null);
    const reload = fixture({ storage }); try { assert.equal(reload.calls.length, 0); reload.records.set(operation.operationId, { before: 'First note\n', after: operation.content, receipt: finalReceipt }); await reload.button('Check save').fire('click'); await settle(); assert.equal(reload.calls.length, 1); assert.equal(reload.calls[0].options.method, undefined); assert.ok(reload.calls[0].path.includes('/edits/' + operation.operationId)); assert.equal(new URL('http://fixture/' + reload.calls[0].path).searchParams.get('grantEpoch'), '1'); assert.equal(reload.button('Check save'), undefined); assert.deepEqual(JSON.parse(storage.get('companion.project.files.pending.v1')), []); assert.ok(reload.notices.some(value => value.startsWith('Saved'))); assert.equal(reload.selected.length, 0); } finally { reload.close(); }
    assert.equal(f.calls.filter(call => call.path.endsWith('/edit')).length, 1);
  } finally { f.close(); }
});
