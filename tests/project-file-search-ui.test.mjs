import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectFileSearchUI } from '../src/project-file-search.mjs';
import { createProjectFilesUI } from '../src/project-files.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', SEARCH = '33333333-3333-4333-8333-333333333333', CURSOR = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555';
const P = { projectId: A, grantEpoch: 1, label: 'Synthetic project' }, Q = { projectId: B, grantEpoch: 4, label: 'Other synthetic project' };
const hash = text => createHash('sha256').update(text).digest('hex'), all = node => [node, ...node.children.flatMap(all)], copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (status, code = 'project_search_failed', message = 'Synthetic search failure') => Object.assign(new Error(message), { status, code });
async function settle() { for (let index = 0; index < 14; index++) await new Promise(resolve => setImmediate(resolve)); }
async function until(check) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Project search UI did not settle'); }
const hit = (patch = {}) => ({ path: 'notes.md', hash: hash('needle in saved text\n'), readAt: '2026-10-25T12:00:00Z', line: 1, column: 1, matchOffset: 0, matchLength: 6, snippet: 'needle in saved text', snippetOffset: 0, snippetTruncated: false, ...patch });
function page(patch = {}) { return { ...P, searchId: SEARCH, path: '', query: 'needle', caseSensitive: false, startedAt: '2026-10-25T12:00:00Z', observedAt: '2026-10-25T12:00:01Z', pageId: 'page-one', matches: [hit()], returned: 1, scanHasMore: false, nextCursor: null, complete: true, stopReason: null, scanned: { directories: 1, entries: 1, files: 1, bytes: 21 }, skipped: { protected: 0, unavailable: 0, binary: 0, oversized: 0 }, sourceTrust: 'untrusted_project_search', snapshot: false, ...patch }; }
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.text = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('File paths, queries and snippets must remain literal'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ??= new Set()).add(callback); }
  removeEventListener(type, callback) { this.listeners[type]?.delete(callback); }
  async fire(type) { if ((type === 'click' || type === 'submit') && this.disabled) return; for (const callback of this.listeners[type] || []) await callback({ target: this, preventDefault() {} }); }
  focus() {}
}
function fixture({ responses = [page()], intercept = null, opener = null } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), sibling = doc.createElement('aside'); container.append(sibling);
  const calls = [], opened = [], notices = []; let custom = intercept, at = 0;
  async function api(path, options = {}, timeout) { const call = { path, options, timeout }; calls.push(call); if (custom) { const result = await custom(call); if (result !== undefined) return result; } if (options.method === 'POST' && path.endsWith('/close')) return { closed: true }; assert.equal(options.method, undefined); assert.equal(options.body, undefined); return copy(responses[Math.min(at++, responses.length - 1)]); }
  const ui = createProjectFileSearchUI({ container, api, onOpen: async (value, options) => { opened.push({ value: copy(value), signal: options.signal }); return opener?.(value, options); }, notify: message => notices.push(message) });
  const field = label => all(container).find(node => node.attributes['aria-label'] === label), button = text => all(container).find(node => node.tagName === 'button' && node.textContent === text), form = all(container).find(node => node.tagName === 'form');
  return { ui, container, sibling, calls, opened, notices, field, button, form, setIntercept: value => { custom = value; }, async search(query = 'needle', path = '', matchCase = false) { field('Find text in project folder').value = query; await field('Find text in project folder').fire('input'); field('Search within subfolder').value = path; await field('Search within subfolder').fire('input'); field('Match case in folder search').checked = matchCase; await field('Match case in folder search').fire('change'); await form.fire('submit'); await settle(); }, async openFirst() { const open = all(container).find(node => node.tagName === 'button' && node.attributes['aria-label']?.startsWith('Open search result:')); assert.ok(open); await open.fire('click'); }, close() { ui.close(); } };
}
const reads = f => f.calls.filter(call => !call.options.method), closes = f => f.calls.filter(call => call.options.method === 'POST');

test('search is passive and hidden without a chosen folder; selection never starts a scan', async () => {
  const f = fixture(); try { assert.equal(f.calls.length, 0); assert.equal(f.container.children[1].hidden, true); assert.equal(f.container.children[0], f.sibling); f.ui.selectionChanged(P); assert.equal(f.calls.length, 0); assert.equal(f.container.children[1].hidden, false); assert.equal(f.field('Find text in project folder').value, ''); assert.match(f.container.textContent, /No search has run/); await f.search('   '); assert.equal(f.calls.length, 0); assert.match(f.container.textContent, /Enter literal text/); } finally { f.close(); }
});

test('literal search preserves spaces and special characters and freezes explicit subfolder and case choices', async () => {
  const text = '  [a+b].* <script> 😀  ', path = 'research/notes', f = fixture({ responses: [page({ query: text, path, caseSensitive: true })] });
  try { f.ui.selectionChanged(P); await f.search(text, path, true); assert.equal(reads(f).length, 1); const params = new URL('http://fixture/' + reads(f)[0].path).searchParams; assert.equal(params.get('query'), text); assert.equal(params.get('path'), path); assert.equal(params.get('caseSensitive'), 'true'); assert.equal(params.get('grantEpoch'), '1'); assert.equal(f.field('Find text in project folder').value, text); assert.equal(all(f.container).some(node => node.tagName === 'script'), false); assert.equal(f.opened.length, 0); } finally { f.close(); }
});

test('an empty partial page retains its exact cursor and cumulative progress, then loads matches without repeating the query', async () => {
  const first = page({ matches: [], returned: 0, scanHasMore: true, nextCursor: CURSOR, complete: false, scanned: { directories: 1, entries: 30, files: 20, bytes: 1000 } }), second = page({ pageId: 'page-two', scanned: { directories: 3, entries: 50, files: 35, bytes: 2000 } }), f = fixture({ responses: [first, second] });
  try { f.ui.selectionChanged(P); await f.search(); assert.equal(f.button('Load more search results').hidden, false); assert.match(f.container.textContent, /does not establish that the whole project has no matches/); assert.match(f.container.textContent, /20 files examined/); await f.button('Load more search results').fire('click'); const params = new URL('http://fixture/' + reads(f)[1].path).searchParams; assert.deepEqual([...params.keys()].sort(), ['cursor', 'grantEpoch', 'searchId']); assert.equal(params.get('cursor'), CURSOR); assert.equal(params.get('searchId'), SEARCH); assert.match(f.container.textContent, /1 matching results shown · 35 files examined/); assert.equal(f.button('Load more search results').hidden, true); assert.equal(f.opened.length, 0); } finally { f.close(); }
});

test('complete scans with skipped files and budget-stopped scans never claim whole-project absence', async () => {
  for (const response of [page({ matches: [], returned: 0, skipped: { protected: 2, unavailable: 1, binary: 3, oversized: 4 } }), page({ matches: [], returned: 0, complete: false, stopReason: 'byte_limit' })]) {
    const f = fixture({ responses: [response] }); try { f.ui.selectionChanged(P); await f.search(); assert.match(f.container.textContent, /does not establish that the whole project has no matches/); assert.match(f.container.textContent, /not a folder snapshot/); if (response.stopReason) assert.match(f.container.textContent, /byte limit/); else { assert.match(f.container.textContent, /some files were skipped/); assert.match(f.container.textContent, /2 protected · 1 unavailable · 3 binary · 4 oversized/); } } finally { f.close(); }
  }
});

test('paths and snippets are literal, shortened snippets are labeled and opening waits for an explicit click', async () => {
  const value = hit({ path: '<img onerror=run()>.txt', snippet: '<script>literal text</script>', snippetTruncated: true }), f = fixture({ responses: [page({ matches: [value] })] });
  try { f.ui.selectionChanged(P); await f.search(); assert.equal(all(f.container).some(node => ['img', 'script'].includes(node.tagName)), false); assert.match(f.container.textContent, /<script>literal text<\/script>/); assert.match(f.container.textContent, /Snippet shortened/); assert.equal(f.opened.length, 0); await f.openFirst(); assert.deepEqual(f.opened[0].value, { projectId: P.projectId, grantEpoch: P.grantEpoch, path: value.path, hash: value.hash, searchId: SEARCH, line: 1, column: 1 }); } finally { f.close(); }
});

test('a lost continuation response rechecks the exact same cursor and does not restart the folder scan', async () => {
  const first = page({ scanHasMore: true, nextCursor: CURSOR, complete: false }), second = page({ pageId: 'page-two', matches: [hit({ path: 'second.md' })], scanned: { directories: 1, entries: 2, files: 2, bytes: 42 } }), f = fixture({ responses: [first] });
  try { f.ui.selectionChanged(P); await f.search(); let failures = 0; f.setIntercept(call => { if (call.options.method) return; if (new URL('http://fixture/' + call.path).searchParams.has('cursor')) { if (!failures++) throw new Error('Synthetic lost page response'); return copy(second); } }); await f.button('Load more search results').fire('click'); assert.match(f.container.textContent, /Synthetic lost page response/); await f.button('Load more search results').fire('click'); assert.equal(reads(f).length, 3); assert.equal(reads(f)[1].path, reads(f)[2].path); assert.match(f.container.textContent, /2 matching results shown/); assert.equal(reads(f).filter(call => new URL('http://fixture/' + call.path).searchParams.has('query')).length, 1); } finally { f.close(); }
});

test('typing a new query aborts old work and a late old result is closed without being painted', async () => {
  const held = deferred(), f = fixture({ intercept: call => !call.options.method && new URL('http://fixture/' + call.path).searchParams.get('query') === 'old' ? held.promise : undefined, responses: [page({ searchId: OTHER, query: 'new', matches: [hit({ snippet: 'ONLY_NEW_RESULT' })] })] });
  try { f.ui.selectionChanged(P); await f.search('old'); const old = reads(f)[0]; assert.equal(old.options.signal.aborted, false); await f.search('new'); assert.equal(old.options.signal.aborted, true); held.resolve(page({ query: 'old', matches: [hit({ snippet: 'OLD_SHOULD_NOT_APPEAR' })] })); await settle(); assert.match(f.container.textContent, /ONLY_NEW_RESULT/); assert.doesNotMatch(f.container.textContent, /OLD_SHOULD_NOT_APPEAR/); assert.ok(closes(f).some(call => call.path.includes('/' + SEARCH + '/close'))); assert.equal(f.field('Find text in project folder').value, 'new'); } finally { f.close(); }
});

test('folder or grant changes drop queries and snippets, abort old reads and never scan the new selection automatically', async () => {
  const held = deferred(), f = fixture({ intercept: call => !call.options.method ? held.promise : undefined });
  try { f.ui.selectionChanged(P); await f.search(); const original = reads(f)[0]; f.ui.selectionChanged(Q); assert.equal(original.options.signal.aborted, true); assert.equal(f.field('Find text in project folder').value, ''); assert.equal(reads(f).length, 1); held.resolve(page({ matches: [hit({ snippet: 'PRIVATE_OLD_SNIPPET' })] })); await settle(); assert.doesNotMatch(f.container.textContent, /PRIVATE_OLD_SNIPPET/); assert.ok(closes(f).some(call => call.path.startsWith('projects/' + A + '/'))); f.ui.selectionChanged({ ...Q, grantEpoch: 5 }); assert.equal(reads(f).length, 1); assert.equal(f.opened.length, 0); } finally { f.close(); }
});

test('Stop aborts an opening search and a late first page cannot restart or populate it', async () => {
  const held = deferred(), f = fixture({ intercept: call => !call.options.method ? held.promise : undefined });
  try { f.ui.selectionChanged(P); await f.search(); await f.button('Stop search').fire('click'); assert.equal(reads(f)[0].options.signal.aborted, true); assert.match(f.container.textContent, /stopped before a page was returned/); held.resolve(page({ scanHasMore: true, nextCursor: CURSOR, complete: false })); await settle(); assert.equal(f.button('Load more search results').hidden, true); assert.equal(f.opened.length, 0); assert.doesNotMatch(f.container.textContent, /needle in saved text/); assert.ok(closes(f).some(call => call.path.endsWith('/' + SEARCH + '/close'))); } finally { f.close(); }
});

test('Stop retains already-read hits as partial evidence and closes only that exact search resource', async () => {
  const f = fixture({ responses: [page({ scanHasMore: true, nextCursor: CURSOR, complete: false })] });
  try { f.ui.selectionChanged(P); await f.search(); await f.button('Stop search').fire('click'); await settle(); assert.match(f.container.textContent, /Stopped here; returned results are kept/); assert.equal(f.button('Load more search results').hidden, true); assert.deepEqual(JSON.parse(closes(f)[0].options.body), { grantEpoch: 1 }); assert.equal(closes(f)[0].path, 'projects/' + A + '/search/' + SEARCH + '/close'); assert.equal(f.calls.some(call => /desktop|\/stop$|\/edit/.test(call.path)), false); await f.openFirst(); assert.equal(f.opened.length, 1); assert.equal(f.opened[0].value.hash, hit().hash); } finally { f.close(); }
});

test('access errors clear private search data and require a deliberate folder re-selection', async () => {
  const f = fixture({ responses: [page({ scanHasMore: true, nextCursor: CURSOR, complete: false })] });
  try { f.ui.selectionChanged(P); await f.search(); f.setIntercept(call => { if (!call.options.method) throw failure(409, 'project_grant_changed'); }); await f.button('Load more search results').fire('click'); assert.equal(f.field('Find text in project folder').value, ''); assert.doesNotMatch(f.container.textContent, /needle in saved text/); assert.match(f.container.textContent, /Folder access changed/); assert.equal(f.button('Search').disabled, true); const before = reads(f).length; await f.search('another'); assert.equal(reads(f).length, before); f.ui.selectionChanged(null); f.ui.selectionChanged(P); assert.equal(f.button('Search').disabled, false); } finally { f.close(); }
});

test('expired or changed directory cursors stop continuation without silently starting another search', async () => {
  for (const [status, code] of [[410, 'project_search_expired'], [409, 'project_directory_changed']]) { const f = fixture({ responses: [page({ scanHasMore: true, nextCursor: CURSOR, complete: false })] }); try { f.ui.selectionChanged(P); await f.search(); f.setIntercept(call => { if (!call.options.method) throw failure(status, code); }); await f.button('Load more search results').fire('click'); assert.equal(reads(f).length, 2); assert.equal(f.button('Load more search results').hidden, true); assert.match(f.container.textContent, /Stopped here|no longer available/); assert.equal(reads(f).filter(call => new URL('http://fixture/' + call.path).searchParams.has('query')).length, 1); } finally { f.close(); } }
});

test('a changed hit fails its original hash and never invokes an unpinned fallback', async () => {
  const f = fixture({ opener: () => { throw failure(409, 'project_file_changed'); } });
  try { f.ui.selectionChanged(P); await f.search(); await f.openFirst(); assert.equal(f.opened.length, 1); assert.equal(f.opened[0].value.hash, hit().hash); assert.match(f.container.textContent, /not opened without its original hash/); assert.equal(f.notices.length, 0); assert.equal(reads(f).length, 1); } finally { f.close(); }
});

test('malformed identity, decreasing counters or missing match hashes cannot be merged into earlier evidence', async () => {
  const f = fixture({ responses: [page({ scanHasMore: true, nextCursor: CURSOR, complete: false, scanned: { directories: 2, entries: 20, files: 10, bytes: 100 } })] });
  try { f.ui.selectionChanged(P); await f.search(); f.setIntercept(call => !call.options.method ? page({ pageId: 'bad', matches: [hit({ snippet: 'NOT_MERGED' })] }) : undefined); await f.button('Load more search results').fire('click'); assert.match(f.container.textContent, /This search changed/); assert.doesNotMatch(f.container.textContent, /NOT_MERGED/); f.setIntercept(call => !call.options.method ? page({ ...Q, matches: [hit({ hash: '', snippet: 'WRONG_SCOPE' })] }) : undefined); await f.search(); assert.match(f.container.textContent, /could not be matched/); assert.doesNotMatch(f.container.textContent, /WRONG_SCOPE/); assert.equal(f.opened.length, 0); } finally { f.close(); }
});

test('queries, paths and snippets never enter browser storage, and close aborts reads without preserving private RAM fields', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), accesses = []; Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => { accesses.push(key); return null; }, setItem: (key, value) => accesses.push([key, value]) } });
  const held = deferred(), f = fixture({ intercept: call => !call.options.method ? held.promise : undefined });
  try { f.ui.selectionChanged(P); await f.search('private literal phrase'); const input = f.field('Find text in project folder'); f.close(); assert.equal(input.value, ''); assert.equal(reads(f)[0].options.signal.aborted, true); held.resolve(page({ query: 'private literal phrase' })); await settle(); assert.equal(f.container.children.length, 1); assert.equal(f.container.children[0], f.sibling); assert.deepEqual(accesses, []); } finally { f.close(); if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage; }
});

function integratedFixture({ intercept = null } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), calls = [], text = 'needle in saved text\n'; let custom = intercept;
  const packet = raw => ({ ...P, path: 'notes.md', hash: hash(raw), content: raw, characterLength: raw.length, byteLength: Buffer.byteLength(raw), offset: 0, hasMore: false, nextOffset: null, lineEndings: 'lf', bom: false, readAt: '2026-10-25T12:00:00Z' });
  const ui = createProjectFilesUI({ container, api: async (path, options = {}) => { const call = { path, options }; calls.push(call); if (custom) { const value = await custom(call); if (value !== undefined) return value; } if (options.method === 'POST' && path.endsWith('/close')) return { closed: true }; if (path.includes('/search?')) return page(); if (path.includes('/file?')) { assert.equal(new URL('http://fixture/' + path).searchParams.get('expectedHash'), hash(text)); return packet(text); } throw new Error('Unexpected integrated Files I/O: ' + path); } });
  const field = label => all(container).find(node => node.attributes['aria-label'] === label), find = text => all(container).find(node => node.tagName === 'button' && node.textContent === text);
  return { ui, container, calls, field, find, packet, setIntercept: value => { custom = value; }, async search() { field('Find text in project folder').value = 'needle'; await field('Find text in project folder').fire('input'); await all(container).find(node => node.tagName === 'form' && all(node).includes(field('Find text in project folder'))).fire('submit'); await settle(); }, async open() { const button = all(container).find(node => node.attributes['aria-label']?.startsWith('Open search result:')); await button.fire('click'); }, close: () => ui.close() };
}

test('Files integration opens a search hit through the normal reader with its exact expectedHash and no write', async () => {
  const f = integratedFixture(); try { f.ui.selectionChanged(P); assert.equal(f.calls.length, 0); await f.search(); await f.open(); const reads = f.calls.filter(call => call.path.includes('/file?')); assert.equal(reads.length, 1); assert.equal(new URL('http://fixture/' + reads[0].path).searchParams.get('expectedHash'), hit().hash); assert.equal(f.field('File text').value, 'needle in saved text\n'); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); } finally { f.close(); }
});

test('Files integration preserves a dirty draft and rejects late pinned reads after a folder change even when transport ignores abort', async () => {
  const f = integratedFixture(); try { f.ui.selectionChanged(P); await f.search(); await f.open(); f.field('File text').value = 'My unsaved draft'; await f.field('File text').fire('input'); await f.open(); assert.equal(f.field('File text').value, 'My unsaved draft'); const held = deferred(); f.setIntercept(call => call.path.includes('/file?') ? held.promise : undefined); const opening = f.open(); await until(() => f.calls.filter(call => call.path.includes('/file?')).length === 3); const last = f.calls.at(-1); f.ui.selectionChanged(Q); assert.equal(last.options.signal.aborted, true); held.resolve(f.packet('OLD_RESPONSE_SHOULD_NOT_PAINT\n')); await opening; assert.doesNotMatch(f.container.textContent, /OLD_RESPONSE_SHOULD_NOT_PAINT/); assert.equal(f.field('File text').value, 'My unsaved draft'); assert.equal(all(f.container).find(node=>node.className==='project-editor').hidden,true); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); } finally { f.close(); }
});

test('Files integration rejects a fresh read with the wrong hash without replacing the editor or retrying unpinned', async () => {
  const f = integratedFixture(); try { f.ui.selectionChanged(P); await f.search(); f.setIntercept(call => call.path.includes('/file?') ? f.packet('changed saved file\n') : undefined); await f.open(); assert.match(f.container.textContent, /not opened without its original hash/); assert.equal(f.calls.filter(call => call.path.includes('/file?')).length, 1); assert.equal(f.field('File text').value, ''); assert.equal(f.calls.some(call => call.path.endsWith('/edit')), false); } finally { f.close(); }
});
