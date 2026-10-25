import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceBackupsUI } from '../src/workspace-backups.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const KEY = 'companion.workspace.recovery.pending.v1', HASH = 'a'.repeat(64);
const copy = value => structuredClone(value), all = node => [node, ...node.children.flatMap(all)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (status, message = 'Synthetic request failure') => Object.assign(new Error(message), { status });
const itemId = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const items = count => Array.from({ length: count }, (_, index) => ({ kind: index % 3 === 0 ? 'workflow' : index % 3 === 1 ? 'task' : 'note', id: itemId(index + 1), title: 'Saved item ' + (index + 1), recoverable: true }));
const counts = { tasks: 5, notes: 5, workflows: 5, preferences: 1 };
const meta = id => ({ id, createdAt: '2026-10-25T12:00:00Z', revision: 5, counts, bytes: 4096, sha256: HASH, filename: 'companion-workspace-' + id + '.json', downloadPath: '/api/assistant/backups/' + id + '/download' });
function previewRecord(id = A, source = items(15)) { return { id, archiveId: B, createdAt: '2026-10-25T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z', sourceCreatedAt: '2026-10-24T12:00:00Z', sourceRevision: 5, archiveHash: HASH, counts, items: source.slice(0, 50), preferences: [{ key: 'reply_style', label: '<script>literal preference</script>', value: 'Brief 😀 answers', archived: false }], total: source.length, offset: 0, returned: Math.min(50, source.length), hasMore: source.length > 50, nextOffset: source.length > 50 ? 50 : null }; }
async function until(check) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Backup UI did not settle'); }
class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = {}; this.listeners = {}; this.text = ''; this.value = ''; this.open = false; this.checked = false; this.disabled = false; this.hidden = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Backup text must remain literal'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ??= new Set()).add(callback); }
  async fire(type) { if (type === 'click' && this.disabled) return; for (const callback of this.listeners[type] || []) await callback({ target: this, preventDefault() {} }); }
}
function fixture({ saved = [], source = items(15), previews = [previewRecord(A, source)], storage = new Map(), intercept = null, revision = 8 } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), sibling = doc.createElement('aside'); container.append(sibling);
  const calls = [], notifications = [], imported = [], backups = new Map(saved.map(value => [value.id, copy(value)])), receipts = new Map(), states = [], records = new Map(previews.map(value => [value.id, copy(value)]));
  let custom = intercept, nextPreview = 0, currentRevision = revision;
  async function api(path, options = {}, timeout) {
    const call = { path, options, timeout }; calls.push(call); if (custom) { const value = await custom(call); if (value !== undefined) return value; }
    if (path === 'backups' && options.method === 'POST') { const { id } = JSON.parse(options.body); if (!backups.has(id)) backups.set(id, meta(id)); return { backup: copy(backups.get(id)) }; }
    if (path === 'backups') return { backups: [...backups.values()].map(copy) };
    if (/^backups\/[^/]+\/delete$/.test(path)) { backups.delete(path.split('/')[1]); return { deleted: true }; }
    if (path === 'backup-recovery/preview') { const value = previews[Math.min(nextPreview++, previews.length - 1)]; return { preview: copy(value) }; }
    if (path.startsWith('backup-recovery/previews/')) { const url = new URL('http://fixture/' + path), id = url.pathname.split('/')[3], record = records.get(id); if (!record) throw failure(404); const offset = Number(url.searchParams.get('offset')); return { preview: { ...copy(record), items: source.slice(offset, offset + 50), offset, returned: Math.min(50, source.length - offset), hasMore: offset + 50 < source.length, nextOffset: offset + 50 < source.length ? offset + 50 : null } }; }
    if (path === 'backup-recovery/import') { const body = JSON.parse(options.body); if (receipts.has(body.id)) return { receipt: copy(receipts.get(body.id)), workspace: { revision: currentRevision } }; assert.equal(body.expectedRevision, currentRevision); const record = records.get(body.previewId); assert.ok(record); currentRevision++; const result = { id: body.id, previewId: body.previewId, archiveHash: record.archiveHash, appliedRevision: currentRevision, createdAt: '2026-10-25T12:01:00Z', imported: body.selection.map((item, index) => ({ kind: item.kind, sourceId: item.id, id: itemId(10000 + states.length * 100 + index), title: source.find(original => original.id === item.id)?.title || 'Recovered copy' })), counts: { tasks: 0, notes: 0, workflows: 0 } }; receipts.set(body.id, result); states.push(result); return { receipt: copy(result), workspace: { revision: currentRevision } }; }
    if (path.startsWith('backup-recovery/imports/')) { const id = path.split('/')[2]; if (!receipts.has(id)) throw failure(404); return { receipt: copy(receipts.get(id)) }; }
    throw new Error('Unexpected API ' + path);
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  let ui; try { ui = createWorkspaceBackupsUI({ container, api, getRevision: () => currentRevision, onImported: (receipt, workspace) => imported.push({ receipt, workspace }), notify: message => notifications.push(message) }); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
  const find = text => all(container).find(node => node.tagName === 'button' && node.textContent === text), field = label => all(container).find(node => node.attributes['aria-label'] === label), input = () => field('Choose workspace backup JSON file');
  return { ui, container, sibling, calls, backups, receipts, storage, notifications, imported, states, find, field, input, setIntercept: value => { custom = value; }, setRevision: value => { currentRevision = value; }, async choose(text = '{"format":"synthetic"}', name = 'Synthetic backup.json', size) { input().files = [{ name, size: size ?? Buffer.byteLength(text), text: async () => text }]; await input().fire('change'); }, async select(item, checked = true) { const checkbox = field('Recover ' + item.kind + ': ' + item.title); assert.ok(checkbox); checkbox.checked = checked; await checkbox.fire('change'); }, close: () => ui.close() };
}

test('backup UI is passive, collapsed and honest about portable content scope', async () => {
  const f = fixture(); try { assert.equal(f.calls.length, 0); assert.equal(f.container.children[0], f.sibling); const root = f.container.children[1]; assert.equal(root.tagName, 'details'); assert.equal(root.open, false); assert.match(root.textContent, /does not include chats, build history, AI keys, permissions, app source or project files/); assert.match(root.textContent, /Existing data stays in place/); assert.match(root.textContent, /Workflows are imported disabled and nothing is run/); await f.choose(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, 'backup-recovery/preview'); assert.equal(f.calls.some(call => call.path === 'backup-recovery/import'), false); assert.equal(f.find('Import 0 copies').disabled, true); } finally { f.close(); }
});

test('backup creation is explicit and exposes an exact same-origin download anchor without inventing download completion', async () => {
  const f = fixture(); try { await f.find('Create workspace backup').fire('click'); assert.equal(f.calls.length, 1); const body = JSON.parse(f.calls[0].options.body); assert.deepEqual(Object.keys(body), ['id']); const link = all(f.container).find(node => node.tagName === 'a'); assert.equal(link.href, '/api/assistant/backups/' + body.id + '/download'); assert.equal(link.download, 'companion-workspace-' + body.id + '.json'); assert.equal(link.target, undefined); assert.equal(f.calls.some(call => call.path.includes('/download')), false); await link.fire('click'); assert.match(f.notifications.at(-1), /Download requested/); assert.equal(f.notifications.some(value => /downloaded successfully/i.test(value)), false); } finally { f.close(); }
});

test('a mismatched backup path is never turned into a download link', async () => {
  const f = fixture({ intercept: call => call.path === 'backups' && call.options.method === 'POST' ? { backup: { ...meta(JSON.parse(call.options.body).id), downloadPath: 'https://example.test/private.json' } } : undefined });
  try { await f.find('Create workspace backup').fire('click'); assert.equal(all(f.container).some(node => node.tagName === 'a'), false); assert.match(f.container.textContent, /saved backup could not be matched/); assert.equal(f.find('Create workspace backup').disabled, true); } finally { f.close(); }
});

test('preview text and preference values stay literal, with preferences excluded from import choices', async () => {
  const value = { kind: 'task', id: C, title: '<img onerror="run()"> literal 😀', recoverable: true }, f = fixture({ source: [value], previews: [previewRecord(A, [value])] });
  try { await f.choose(); assert.ok(f.field('Recover task: ' + value.title)); assert.equal(all(f.container).some(node => ['img', 'script'].includes(node.tagName)), false); assert.match(f.container.textContent, /<script>literal preference<\/script>/); assert.match(f.container.textContent, /Preferences are not imported/); assert.equal(all(f.container).filter(node => node.type === 'checkbox').length, 1); await f.select(value); await f.find('Import 1 copy').fire('click'); const body = JSON.parse(f.calls.find(call => call.path === 'backup-recovery/import').options.body); assert.deepEqual(body.selection, [{ kind: 'task', id: C }]); assert.equal(Object.hasOwn(body, 'preferences'), false); } finally { f.close(); }
});

test('paged choices retain exact source identities and stop at 100 without silently selecting another page', async () => {
  const source = items(125), f = fixture({ source, previews: [previewRecord(A, source)] });
  try { await f.choose(); await f.find('Select this page').fire('click'); assert.ok(f.find('Import 50 copies')); await f.find('Next items').fire('click'); await f.find('Select this page').fire('click'); assert.ok(f.find('Import 100 copies')); await f.find('Next items').fire('click'); await f.find('Select this page').fire('click'); assert.ok(f.find('Import 100 copies')); assert.match(f.container.textContent, /at most 100/); await f.find('Previous items').fire('click'); assert.equal(f.field('Recover ' + source[50].kind + ': ' + source[50].title).checked, true); await f.find('Import 100 copies').fire('click'); const body = JSON.parse(f.calls.find(call => call.path === 'backup-recovery/import').options.body); assert.equal(body.selection.length, 100); assert.deepEqual(body.selection[0], { kind: source[0].kind, id: source[0].id }); assert.deepEqual(body.selection[99], { kind: source[99].kind, id: source[99].id }); assert.equal(f.calls.some(call => /tools|workflows.*run/.test(call.path)), false); } finally { f.close(); }
});

test('nonrecoverable items cannot be selected through the normal controls and show their actual reason', async () => {
  const source = [{ kind: 'workflow', id: C, title: 'Unavailable routine', recoverable: false, reason: 'Original action is unavailable.' }], f = fixture({ source, previews: [previewRecord(A, source)] });
  try { await f.choose(); assert.equal(f.field('Recover workflow: Unavailable routine').disabled, true); assert.match(f.container.textContent, /Original action is unavailable/); await f.find('Select this page').fire('click'); assert.equal(f.find('Import 0 copies').disabled, true); assert.equal(f.calls.some(call => call.path === 'backup-recovery/import'), false); } finally { f.close(); }
});

test('cancelling the file picker retains the current preview and a rejected oversize file sends no upload', async () => {
  const f = fixture(); try { await f.choose(); await f.select(items(15)[0]); f.input().files = []; await f.input().fire('change'); assert.ok(f.find('Import 1 copy')); const before = f.calls.length; await f.choose('{}', 'Too large.json', 96 * 1024 * 1024 + 1); assert.equal(f.calls.length, before); assert.match(f.container.textContent, /no larger than 96 MiB/); assert.equal(f.find('Import 1 copy'), undefined); await f.choose('{bad json'); assert.equal(f.calls.length, before); assert.match(f.container.textContent, /not readable JSON/); } finally { f.close(); }
});

test('a late preview or page cannot retarget a newer file selection or leave its page controls blocked', async () => {
  const source = items(65), first = previewRecord(A, source), second = previewRecord(C, source), held = deferred(), f = fixture({ source, previews: [first, second] });
  try { await f.choose(); f.setIntercept(call => call.path.startsWith('backup-recovery/previews/') ? held.promise : undefined); const paging = f.find('Next items').fire('click'); await until(() => f.calls.some(call => call.path.includes('/previews/'))); await f.choose('{"second":true}', 'Second.json'); held.resolve({ preview: { ...first, offset: 50, items: source.slice(50), hasMore: false, nextOffset: null } }); await paging; assert.match(f.container.textContent, /Preview: Second.json/); assert.equal(f.find('Next items').disabled, false); assert.equal(f.field('Recover ' + source[0].kind + ': ' + source[0].title).checked, false); assert.equal(f.calls.some(call => call.path === 'backup-recovery/import'), false); } finally { f.close(); }
});

test('import freezes preview, selection, revision and operation ID and a late receipt cannot clear a newer preview', async () => {
  const source = items(15), held = deferred(), first = previewRecord(A, source), second = previewRecord(C, source), f = fixture({ source, previews: [first, second] });
  try { await f.choose(); await f.select(source[0]); let accepted; f.setIntercept(call => { if (call.path !== 'backup-recovery/import') return; accepted = JSON.parse(call.options.body); return held.promise; }); const importing = f.find('Import 1 copy').fire('click'); await until(() => accepted); assert.equal(accepted.previewId, A); assert.equal(accepted.expectedRevision, 8); assert.deepEqual(accepted.selection, [{ kind: source[0].kind, id: source[0].id }]); assert.equal(f.find('Check import').disabled, true); await f.find('Check import').fire('click'); assert.equal(f.calls.some(call => call.path.startsWith('backup-recovery/imports/')), false); await f.choose('{"other":true}', 'Other.json'); await f.select(source[1]); held.resolve({ receipt: { id: accepted.id, previewId: A, archiveHash: HASH, appliedRevision: 9, createdAt: '2026-10-25T12:01:00Z', imported: [{ kind: source[0].kind, sourceId: source[0].id, id: itemId(9000), title: source[0].title }], counts: { workflows: 1, notes: 0, tasks: 0 } }, workspace: { revision: 9 } }); await importing; assert.match(f.container.textContent, /Preview: Other.json/); assert.equal(f.field('Recover ' + source[1].kind + ': ' + source[1].title).checked, true); assert.ok(f.find('Import 1 copy')); assert.equal(f.imported.length, 1); assert.equal(f.imported[0].receipt.id, accepted.id); assert.equal(f.calls.filter(call => call.path === 'backup-recovery/import').length, 1); } finally { f.close(); }
});

test('lost import acknowledgements store only the original UUID and explicit Check reads its exact receipt without retrying', async () => {
  const storage = new Map(), source = items(15), f = fixture({ storage, source }); let accepted;
  try { await f.choose(); await f.select(source[1]); f.setIntercept(call => { if (call.path !== 'backup-recovery/import') return; accepted = JSON.parse(call.options.body); f.receipts.set(accepted.id, { id: accepted.id, previewId: A, archiveHash: HASH, appliedRevision: 9, createdAt: '2026-10-25T12:01:00Z', imported: [{ kind: source[1].kind, sourceId: source[1].id, id: itemId(9001), title: source[1].title }] }); throw new Error('Synthetic lost acknowledgement'); }); await f.find('Import 1 copy').fire('click'); assert.deepEqual(JSON.parse(storage.get(KEY)), [accepted.id]); assert.doesNotMatch(storage.get(KEY), /Saved|preview|archive|selection|revision|filename|Synthetic/); assert.equal(f.find('Import 1 copy').disabled, true); assert.ok(f.find('Check import')); } finally { f.close(); }
  const restored = fixture({ storage }); try { restored.receipts.set(accepted.id, copy(f.receipts.get(accepted.id))); assert.equal(restored.calls.length, 0); assert.ok(restored.find('Check import')); await restored.find('Check import').fire('click'); assert.equal(restored.calls.length, 1); assert.equal(restored.calls[0].path, 'backup-recovery/imports/' + accepted.id); assert.equal(restored.calls[0].options.method, undefined); assert.deepEqual(JSON.parse(storage.get(KEY)), []); assert.match(restored.container.textContent, /Imported 1 new copy/); assert.equal(restored.imported[0].workspace, null); } finally { restored.close(); }
});

test('an unrecorded import requires explicit dismissal and never causes an automatic replacement POST', async () => {
  const storage = new Map([[KEY, JSON.stringify([C])]]), f = fixture({ storage }); try { await f.find('Check import').fire('click'); assert.match(f.container.textContent, /No import is recorded/); assert.equal(f.calls.length, 1); assert.ok(f.find('Dismiss unrecorded import')); assert.deepEqual(JSON.parse(storage.get(KEY)), [C]); await f.find('Dismiss unrecorded import').fire('click'); assert.deepEqual(JSON.parse(storage.get(KEY)), []); assert.equal(f.calls.length, 1); } finally { f.close(); }
});

test('a receipt for another preview remains uncertain instead of being claimed as the selected import', async () => {
  const f = fixture({ intercept: call => { if (call.path !== 'backup-recovery/import') return; const body = JSON.parse(call.options.body); return { receipt: { id: body.id, previewId: C, archiveHash: HASH, appliedRevision: 9, createdAt: '2026-10-25T12:01:00Z', imported: [] } }; } });
  try { await f.choose(); await f.select(items(15)[0]); await f.find('Import 1 copy').fire('click'); assert.ok(f.find('Check import')); assert.equal(f.imported.length, 0); assert.doesNotMatch(f.container.textContent, /Imported 0 new/); assert.equal(JSON.parse(f.storage.get(KEY)).length, 1); } finally { f.close(); }
});

test('revision conflicts retain choices and require a fresh explicit import with the updated revision', async () => {
  const f = fixture(); try { await f.choose(); await f.select(items(15)[1]); let rejected = false; f.setIntercept(call => { if (call.path !== 'backup-recovery/import' || rejected) return; rejected = true; f.setRevision(9); throw failure(409, 'Workspace changed. Review the selected copies, then import again.'); }); await f.find('Import 1 copy').fire('click'); assert.equal(f.field('Recover task: Saved item 2').checked, true); assert.equal(f.find('Check import'), undefined); assert.equal(f.calls.filter(call => call.path === 'backup-recovery/import').length, 1); await f.find('Import 1 copy').fire('click'); const requests = f.calls.filter(call => call.path === 'backup-recovery/import').map(call => JSON.parse(call.options.body)); assert.notEqual(requests[0].id, requests[1].id); assert.equal(requests[0].expectedRevision, 8); assert.equal(requests[1].expectedRevision, 9); assert.equal(f.imported.length, 1); } finally { f.close(); }
});

test('missing or expired previews block import while an earlier exact receipt can still be checked', async () => {
  const source = items(60), f = fixture({ source, previews: [previewRecord(A, source)] });
  try { await f.choose(); await f.select(source[0]); f.setIntercept(call => { if (call.path.startsWith('backup-recovery/previews/')) throw failure(410, 'Preview expired. Choose the backup again.'); }); await f.find('Next items').fire('click'); assert.equal(f.find('Import 1 copy').disabled, true); assert.match(f.container.textContent, /preview expired/); assert.equal(f.calls.some(call => call.path === 'backup-recovery/import'), false); } finally { f.close(); }
});

test('removing a server copy affects only its exact saved ID and refreshes the list without a workspace mutation', async () => {
  const f = fixture({ saved: [meta(A), meta(B)] }); try { await f.ui.refresh(); await f.find('Remove saved copy').fire('click'); const call = f.calls.find(value => value.path.endsWith('/delete')); assert.equal(call.path, 'backups/' + A + '/delete'); assert.equal(call.options.body, '{}'); assert.equal(f.backups.has(A), false); assert.equal(f.backups.has(B), true); assert.equal(f.calls.some(value => /workspace\/operations|backup-recovery\/import/.test(value.path)), false); assert.match(f.notifications.join('\n'), /Downloaded files are unchanged/); } finally { f.close(); }
});

test('closing aborts pending UI I/O without cancelling accepted imports or losing their recovery identity', async () => {
  const held = deferred(), f = fixture(); await f.choose(); await f.select(items(15)[0]); let signal, id; f.setIntercept(call => { if (call.path !== 'backup-recovery/import') return; signal = call.options.signal; id = JSON.parse(call.options.body).id; return held.promise; }); const importing = f.find('Import 1 copy').fire('click'); await until(() => signal); f.close(); assert.equal(signal.aborted, true); held.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); await importing; assert.deepEqual(JSON.parse(f.storage.get(KEY)), [id]); assert.equal(f.calls.some(call => /cancel|\/stop/.test(call.path)), false); assert.equal(f.container.children.length, 1); assert.equal(f.container.children[0], f.sibling);
});

test('saved-copy refresh and creation are serialized so an old list cannot hide a newly created download',async()=>{
  const held=deferred(),f=fixture({intercept:call=>call.path==='backups'&&!call.options.method?held.promise:undefined});try{const refreshing=f.ui.refresh();assert.equal(f.find('Create workspace backup').disabled,true);await f.find('Create workspace backup').fire('click');assert.equal(f.calls.some(call=>call.options.method==='POST'),false);held.resolve({backups:[]});await refreshing;f.setIntercept(null);await f.find('Create workspace backup').fire('click');assert.equal(all(f.container).filter(node=>node.tagName==='a').length,1);assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);}finally{f.close();}
});

test('duplicate-source or reused-ID import receipts stay unconfirmed rather than claim separate recovered copies',async()=>{
  const source=items(15),f=fixture();try{await f.choose();await f.select(source[0]);await f.select(source[1]);f.setIntercept(call=>{if(call.path!=='backup-recovery/import')return;const body=JSON.parse(call.options.body);return{receipt:{id:body.id,previewId:A,archiveHash:HASH,appliedRevision:9,createdAt:'2026-10-25T12:01:00Z',imported:[{kind:source[0].kind,sourceId:source[0].id,id:C,title:source[0].title},{kind:source[0].kind,sourceId:source[0].id,id:C,title:source[0].title}]}};});await f.find('Import 2 copies').fire('click');assert.ok(f.find('Check import'));assert.equal(f.imported.length,0);assert.equal(f.calls.filter(call=>call.path==='backup-recovery/import').length,1);}finally{f.close();}
});

test('a still-uncertain sending window retains its import ID if another window changed pending storage before the lost response',async()=>{
  const f=fixture();try{await f.choose();await f.select(items(15)[0]);let id;f.setIntercept(call=>{if(call.path!=='backup-recovery/import')return;id=JSON.parse(call.options.body).id;f.storage.set(KEY,'[]');throw new Error('Synthetic lost acknowledgement after another window changed storage');});await f.find('Import 1 copy').fire('click');assert.deepEqual(JSON.parse(f.storage.get(KEY)),[id]);assert.ok(f.find('Check import'));assert.equal(f.calls.filter(call=>call.path==='backup-recovery/import').length,1);}finally{f.close();}
});
