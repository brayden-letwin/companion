import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildContinuationUI } from '../src/build-continuation.mjs';

const BUILD = '11111111-1111-4111-8111-111111111111', OTHER_BUILD = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333', OTHER_ID = '44444444-4444-4444-8444-444444444444', WORK = '55555555-5555-4555-8555-555555555555';
const KEY = 'companion.build.continuations.pending.v1';
const copy = value => structuredClone(value);
const all = node => [node, ...node.children.flatMap(all)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Continuation UI did not settle'); }
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.text = ''; this.hidden = false; this.disabled = false; this.open = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Continuation text must remain literal'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ??= new Set()).add(callback); }
  async fire(type) { if (type === 'click' && this.disabled) return; for (const callback of this.listeners[type] || []) await callback({ target: this, preventDefault() {} }); }
}
function record(patch = {}) { return { id: ID, buildId: BUILD, workId: WORK, status: 'ready', origin: { requestId: 'original-request', conversationId: '66666666-6666-4666-8666-666666666666', message: 'Save the report in my original project.', provider: { id: 'original-ai', label: 'Original AI', type: 'codex', model: 'Original model' }, project: { projectId: '77777777-7777-4777-8777-777777777777', grantEpoch: 3, label: 'Original project' }, windowContext: { contextId: 'selected-source', title: 'Original window' } }, buildSpec: 'Build a bounded report writer with exact acceptance criteria.', readiness: { ready: true }, ...patch }; }
function fixture({ rows = [record()], storage = new Map(), intercept = null } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), sibling = doc.createElement('aside'); container.append(sibling);
  const records = new Map(rows.map(row => [row.id, copy(row)])), calls = [], notices = [], opened = []; let custom = intercept;
  async function api(path, options = {}) {
    const call = { path, options }; calls.push(call); if (custom) { const result = await custom(call); if (result !== undefined) return result; }
    const url = new URL('http://fixture/' + path), parts = url.pathname.slice(1).split('/');
    if (parts.length === 1) { const matches = [...records.values()].filter(item => item.buildId === url.searchParams.get('buildId')), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')); return { continuations: copy(matches.slice(offset, offset + limit)), total: matches.length, offset, limit, hasMore: offset + limit < matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }; }
    const value = records.get(parts[1]); if (!value) throw Object.assign(new Error('Continuation not found'), { status: 404 });
    if (parts[2] === 'continue') { value.status = 'queued'; value.workJob = { id: value.workId, status: 'queued' }; }
    if (parts[2] === 'cancel') { value.status = 'cancelled'; }
    return { continuation: copy(value) };
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  let ui; try { ui = createBuildContinuationUI({ container, api, openWork: id => opened.push(id), notify: text => notices.push(text) }); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
  const button = text => all(container).find(node => node.tagName === 'button' && node.textContent === text);
  const card = id => all(container).find(node => node.attributes['data-continuation-id'] === id);
  const disclosure = title => all(container).find(node => node.tagName === 'details' && node.children[0]?.textContent === title);
  return { ui, container, sibling, calls, records, storage, notices, opened, button, card, disclosure, setIntercept: value => { custom = value; }, async load(id = BUILD) { ui.setBuild(id); await ui.refresh(); await settle(); }, close: () => ui.close() };
}

test('continuations are passive on construction/selection and disclose exact original intent separately from build instructions', async () => {
  const original = 'A concise first line\n' + '<img onerror="run()"> literal criteria 😀\n'.repeat(400), spec = 'Separate build specification\n'.repeat(300), f = fixture({ rows: [record({ origin: { ...record().origin, message: original }, buildSpec: spec })] });
  try {
    assert.equal(f.calls.length, 0); f.ui.setBuild(BUILD); assert.equal(f.calls.length, 0); await f.ui.refresh();
    assert.equal(f.card(ID).children[0].children[0].textContent, 'A concise first line'); assert.equal(f.disclosure('Your request').open, false); assert.equal(f.disclosure('Build instructions').open, false);
    assert.equal(f.disclosure('Your request').children[1].textContent, original); assert.equal(f.disclosure('Build instructions').children[1].textContent, spec); assert.equal(all(f.container).some(node => node.tagName === 'img'), false);
    assert.match(f.container.textContent, /Original AI: Original AI · Original model/); assert.match(f.container.textContent, /Project: Original project · access 3/); assert.match(f.container.textContent, /Original window/); assert.equal(f.calls.every(call => !call.options.method), true);
    f.disclosure('Your request').open = true; await f.disclosure('Your request').fire('toggle'); await f.ui.refresh(); assert.equal(f.disclosure('Your request').open, true);
  } finally { f.close(); }
});

test('Continue sends only the original identity and an empty body, never substitutes the current UI route or opens work automatically', async () => {
  const f = fixture(); try { await f.load(); await f.button('Continue original request').fire('click'); await settle(); const sent = f.calls.find(call => call.options.method === 'POST'); assert.equal(sent.path, 'continuations/' + ID + '/continue'); assert.equal(sent.options.body, '{}'); assert.deepEqual(JSON.parse(sent.options.body), {}); assert.equal(f.opened.length, 0); assert.equal(f.button('Continue original request'), undefined); assert.match(f.container.textContent, /Queued/); assert.ok(f.button('Open work')); await f.button('Open work').fire('click'); assert.deepEqual(f.opened, [WORK]); assert.deepEqual(JSON.parse(f.storage.get(KEY)), []); } finally { f.close(); }
});

test('waiting, blocked, runtime-unconfirmed and inconsistent ready states cannot continue; every blocked reason stays visible', async () => {
  for (const status of ['waiting_for_build', 'waiting_for_activation', 'waiting_for_runtime', 'blocked', 'ready']) {
    const f = fixture({ rows: [record({ status, reason: 'Original source is unavailable.', readiness: { ready: false, reason: 'The same source is required.' } })] });
    try { await f.load(); assert.equal(f.button('Continue original request'), undefined); assert.equal(f.button('Open work'), undefined); assert.match(f.container.textContent, /Original source is unavailable/); assert.equal(f.calls.some(call => call.options.method), false); } finally { f.close(); }
  }
});

test('lost Continue acknowledgement persists only its ID and reload offers GET-only checks of that exact original record', async () => {
  const storage = new Map(), f = fixture({ storage });
  try { await f.load(); f.setIntercept(call => { if (call.path.endsWith('/continue')) { f.records.get(ID).status = 'running'; f.records.get(ID).workJob = { id: WORK, status: 'running' }; throw new Error('Synthetic lost response'); } }); await f.button('Continue original request').fire('click'); await settle(); assert.deepEqual(JSON.parse(storage.get(KEY)), [ID]); assert.doesNotMatch(storage.get(KEY), /original|project|window|report|provider/); assert.ok(f.button('Check continuation')); assert.equal(f.button('Continue original request'), undefined); } finally { f.close(); }
  const restored = fixture({ storage, rows: [...f.records.values()] });
  try { assert.equal(restored.calls.length, 0); assert.ok(restored.button('Check continuation')); restored.ui.setBuild(OTHER_BUILD); assert.equal(restored.calls.length, 0); await restored.button('Check continuation').fire('click'); await settle(); assert.equal(restored.calls.length, 1); assert.equal(restored.calls[0].path, 'continuations/' + ID); assert.equal(restored.calls[0].options.method, undefined); assert.match(restored.container.textContent, /Working/); assert.ok(restored.button('Open work')); assert.equal(restored.opened.length, 0); assert.deepEqual(JSON.parse(storage.get(KEY)), []); } finally { restored.close(); }
});

test('only an explicit GET confirming ready before acceptance releases uncertainty for a deliberate same-ID Continue', async () => {
  const storage = new Map([[KEY, JSON.stringify([ID])]]), f = fixture({ storage });
  try {
    await f.load(); assert.equal(f.button('Continue original request'), undefined); assert.deepEqual(JSON.parse(storage.get(KEY)), [ID]); await f.ui.refresh(); assert.ok(f.button('Check continuation')); assert.equal(f.button('Continue original request'), undefined); assert.equal(f.calls.some(call => call.options.method), false);
    await f.button('Check continuation').fire('click'); await settle(); assert.equal(f.button('Check continuation'), undefined); assert.ok(f.button('Continue original request')); assert.deepEqual(JSON.parse(storage.get(KEY)), []); assert.equal(f.calls.some(call => call.options.method), false);
    await f.button('Continue original request').fire('click'); await settle(); const posts=f.calls.filter(call=>call.options.method==='POST'); assert.equal(posts.length,1); assert.equal(posts[0].path,'continuations/'+ID+'/continue'); assert.equal(posts[0].options.body,'{}');
  } finally { f.close(); }
});

test('late acceptance and old list responses cannot navigate, retarget or regress a newly accepted continuation', async () => {
  const f = fixture(), late = deferred();
  try {
    await f.load(); f.setIntercept(call => call.path.endsWith('/continue') ? late.promise : undefined); await f.button('Continue original request').fire('click'); await until(() => f.calls.some(call => call.path.endsWith('/continue'))); f.ui.setBuild(OTHER_BUILD); await f.ui.refresh(); late.resolve({ continuation: record({ status: 'running', workJob: { id: WORK, status: 'running' } }) }); await settle(); assert.equal(f.opened.length, 0); assert.equal(f.card(ID).textContent.includes('different build'), true); assert.equal(f.button('Continue original request'), undefined);
    f.ui.setBuild(BUILD); await f.ui.refresh(); assert.match(f.card(ID).textContent, /Working/); assert.equal(f.button('Continue original request'), undefined);
  } finally { f.close(); }
});

test('a GET begun before Continue cannot overwrite its actual queued response', async () => {
  const f = fixture(), old = deferred();
  try { await f.load(); f.setIntercept(call => call.path.includes('?') ? old.promise : undefined); const poll = f.ui.refresh(); await until(() => f.calls.filter(call => call.path.includes('?')).length === 2); await f.button('Continue original request').fire('click'); await settle(); old.resolve({ continuations: [record()], total: 1, offset: 0, limit: 20, hasMore: false, nextOffset: null }); await poll; assert.match(f.card(ID).textContent, /Queued/); assert.equal(f.button('Continue original request'), undefined); assert.equal(f.calls.filter(call => call.path.endsWith('/continue')).length, 1); } finally { f.close(); }
});

test('cancellation is explicit and retains actual uncertain status until GET confirms; completed results never restart', async () => {
  const f = fixture();
  try { await f.load(); f.setIntercept(call => { if (call.path.endsWith('/cancel')) { f.records.get(ID).status = 'cancelled'; throw new Error('Synthetic cancelled acknowledgement lost'); } }); await f.button('Cancel continuation').fire('click'); await settle(); assert.ok(f.button('Check continuation')); assert.deepEqual(JSON.parse(f.storage.get(KEY)), [ID]); await f.button('Check continuation').fire('click'); await settle(); assert.match(f.card(ID).textContent, /Cancelled/); assert.equal(f.button('Continue original request'), undefined); assert.equal(f.button('Cancel continuation'), undefined); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); } finally { f.close(); }
  const completed = fixture({ rows: [record({ status: 'completed', workJob: { id: WORK, status: 'completed' } })] }); try { await completed.load(); assert.match(completed.card(ID).textContent, /Result ready/); assert.ok(completed.button('Open work')); assert.equal(completed.button('Continue original request'), undefined); } finally { completed.close(); }
});

test('strict envelopes and mismatched continuation identity cannot produce accepted success', async () => {
  for (const bad of [record({ status: 'queued' }), { continuation: record({ id: OTHER_ID, status: 'queued' }) }, { continuation: record({ buildId: OTHER_BUILD, status: 'queued' }) }]) {
    const f = fixture({ intercept: call => call.path.endsWith('/continue') ? bad : undefined }); try { await f.load(); await f.button('Continue original request').fire('click'); await settle(); assert.ok(f.button('Check continuation')); assert.equal(f.button('Open work'), undefined); assert.match(f.container.textContent, /could not be matched/); assert.deepEqual(JSON.parse(f.storage.get(KEY)), [ID]); } finally { f.close(); }
  }
});

test('paging is explicit and stale build list results do not replace a newer selected build', async () => {
  const rows = Array.from({ length: 22 }, (_, index) => record({ id: (index + 1).toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })), f = fixture({ rows }), late = deferred();
  try { await f.load(); assert.equal(all(f.container).filter(node => node.attributes['data-continuation-id']).length, 20); assert.equal(f.button('Load more requests').hidden, false); await f.button('Load more requests').fire('click'); await settle(); assert.equal(all(f.container).filter(node => node.attributes['data-continuation-id']).length, 22); assert.equal(f.button('Load more requests').hidden, true); assert.equal(new URL('http://fixture/' + f.calls[1].path).searchParams.get('offset'), '20');
    f.setIntercept(call => call.path.includes('?') ? late.promise : undefined); const pending = f.ui.refresh(); f.ui.setBuild(OTHER_BUILD); late.resolve({ continuations: rows, total: rows.length, offset: 0, limit: 20, hasMore: false, nextOffset: null }); await pending; assert.equal(all(f.container).filter(node => node.attributes['data-continuation-id']).length, 0);
  } finally { f.close(); }
});

test('close aborts UI I/O, keeps an uncertain original ID, and never cancels accepted work or removes sibling content', async () => {
  const f = fixture(), late = deferred(); await f.load(); f.setIntercept(call => call.path.endsWith('/continue') ? late.promise : undefined); await f.button('Continue original request').fire('click'); await until(() => f.calls.some(call => call.path.endsWith('/continue'))); const post = f.calls.find(call => call.path.endsWith('/continue')); f.close(); assert.equal(post.options.signal.aborted, true); assert.equal(f.container.children.includes(f.sibling), true); assert.equal(f.container.children.length, 1); late.resolve({ continuation: record({ status: 'queued', workJob: { id: WORK, status: 'queued' } }) }); await settle(); assert.deepEqual(JSON.parse(f.storage.get(KEY)), [ID]); assert.equal(f.calls.some(call => call.path.endsWith('/cancel')), false); assert.equal(f.opened.length, 0);
});


test('reserved work IDs and failed-before-acceptance states never invent a Work link; actual cancelled child receipts remain inspectable', async () => {
  for (const status of ['starting', 'failed', 'interrupted', 'cancelled']) { const f = fixture({ rows: [record({ status, readiness: { ready: false }, reason: 'The original work was not accepted.' })] }); try { await f.load(); assert.equal(f.button('Open work'), undefined); assert.equal(f.button('Continue original request'), undefined); assert.match(f.card(ID).textContent, /not accepted/); } finally { f.close(); } }
  const f = fixture({ rows: [record({ status: 'cancelled', workJob: { id: WORK, status: 'cancelled' } })] }); try { await f.load(); assert.ok(f.button('Open work')); await f.button('Open work').fire('click'); assert.deepEqual(f.opened, [WORK]); assert.equal(f.calls.some(call => call.options.method), false); } finally { f.close(); }
});

test('double activation is coalesced and a long single-line original request cannot become an unbounded heading', async () => {
  const original = 'Exact original criteria '.repeat(600), f = fixture({ rows: [record({ origin: { ...record().origin, message: original } })] }), late = deferred();
  try { await f.load(); assert.ok(f.card(ID).children[0].children[0].textContent.length <= 84); assert.equal(f.disclosure('Your request').children[1].textContent, original); f.setIntercept(call => call.path.endsWith('/continue') ? late.promise : undefined); const trigger = f.button('Continue original request'); await trigger.fire('click'); await trigger.fire('click'); await settle(); assert.equal(f.calls.filter(call => call.path.endsWith('/continue')).length, 1); late.resolve({ continuation: record({ status: 'running', workJob: { id: WORK, status: 'running' }, origin: { ...record().origin, message: original } }) }); await settle(); assert.ok(f.button('Open work')); } finally { f.close(); }
});


test('the voice entry point requires the exact selected build and one ready confirmed row, then reuses ordinary uncertainty checks', async()=>{
  const f=fixture(), late=deferred();
  try { assert.throws(()=>f.ui.continueOriginal(BUILD),/selected build changed/); await f.load(); assert.throws(()=>f.ui.continueOriginal(OTHER_BUILD),/selected build changed/); f.setIntercept(call=>call.path.endsWith('/continue')?late.promise:undefined); const accepted=f.ui.continueOriginal(BUILD); assert.throws(()=>f.ui.continueOriginal(BUILD),/unconfirmed|already/); late.reject(new Error('Synthetic lost voice acknowledgement')); await accepted; assert.ok(f.button('Check continuation')); assert.throws(()=>f.ui.continueOriginal(BUILD),/unconfirmed/); assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1); } finally { f.close(); }
  const ambiguous=fixture({rows:[record(),record({id:OTHER_ID})]});try{await ambiguous.load();assert.throws(()=>ambiguous.ui.continueOriginal(BUILD),/Choose the intended/);assert.equal(ambiguous.calls.some(call=>call.options.method),false);}finally{ambiguous.close();}
  const blocked=fixture({rows:[record({status:'blocked',reason:'Original source is unavailable.',readiness:{ready:false}})]});try{await blocked.load();assert.throws(()=>blocked.ui.continueOriginal(BUILD),/Original source is unavailable/);assert.equal(blocked.calls.some(call=>call.options.method),false);}finally{blocked.close();}
  const ready=fixture();try{await ready.load();const result=await ready.ui.continueOriginal(BUILD);assert.equal(result.id,ID);assert.equal(result.workJob.id,WORK);assert.equal(ready.opened.length,0);assert.equal(ready.calls.filter(call=>call.options.method==='POST').length,1);}finally{ready.close();}
});
