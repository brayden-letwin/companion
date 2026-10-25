import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowHistoryUI } from '../src/workflow-history.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const REV = 'a'.repeat(64), NEXT_REV = 'b'.repeat(64);
const copy = value => structuredClone(value), all = node => [node, ...node.children.flatMap(all)];
const failure = (status, message = 'Synthetic saved-run read failure') => Object.assign(new Error(message), { status });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Workflow history did not settle'); }
function record({ id = C, workflowId = A, name = 'Original routine', status = 'completed', definition = null, outcome = null, revision = REV, operationId = D, times = true } = {}) {
  definition ||= { id: workflowId, name, enabled: true, steps: [{ tool: 'save_note', arguments: { title: 'Original saved title', text: 'Original text' } }] };
  outcome ||= { id: workflowId, status, steps: [{ tool: 'save_note', result: { note: { id: B, title: 'Actual saved note' } } }] };
  return { run: { id, workflowId, name, status, stepCount: definition.steps?.length || 0, completedStepCount: outcome.steps?.length || 0, startedAt: times ? '2026-10-25T12:00:00Z' : null, updatedAt: times ? '2026-10-25T12:00:01Z' : null, finishedAt: times && status !== 'running' ? '2026-10-25T12:00:01Z' : null, timestampsAvailable: times, runRevision: revision }, definitionText: JSON.stringify(definition), outcomeText: JSON.stringify(outcome), operationId };
}
function packet(value, query = new URLSearchParams()) {
  const page = (name, offset) => { const text = value[name + 'Text']; let end = Math.min(offset + 4000, text.length); if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--; return { [name + 'Text']: text.slice(offset, end), [name + 'Offset']: offset, [name + 'Length']: text.length, [name + 'HasMore']: end < text.length, ['next' + name[0].toUpperCase() + name.slice(1) + 'Offset']: end < text.length ? end : null }; };
  return { run: copy(value.run), ...page('definition', Number(query.get('definitionOffset') || 0)), ...page('outcome', Number(query.get('outcomeOffset') || 0)) };
}
class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.listeners = {}; this.attributes = {}; this.text = ''; this.hidden = false; this.disabled = false; this.open = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Saved history text must stay literal'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ??= new Set()).add(callback); }
  async fire(type) { if (type === 'click' && this.disabled) return; for (const callback of this.listeners[type] || []) await callback({ preventDefault() {}, target: this }); }
}
function fixture({ records = [record()], intercept = null } = {}) {
  const doc = { createElement: tag => new Element(tag, doc) }, container = doc.createElement('div'), sibling = doc.createElement('aside'); container.append(sibling);
  const calls = [], receipts = [], notices = [], saved = new Map(records.map(value => [value.run.id, copy(value)])); let custom = intercept;
  async function api(path, options = {}) {
    assert.equal(options.method, undefined, 'history must never dispatch a mutation'); assert.equal(options.body, undefined); const call = { path, options }; calls.push(call); if (custom) { const result = await custom(call); if (result !== undefined) return result; }
    const url = new URL('http://fixture/' + path), parts = url.pathname.slice(1).split('/');
    if (parts[0] === 'workflow-runs') { const filter = url.searchParams.get('workflowId'), offset = Number(url.searchParams.get('before') || 0), values = [...saved.values()].filter(value => !filter || value.run.workflowId === filter), rows = values.slice(offset, offset + 20).map(value => value.run); return { runs: rows, returned: rows.length, scanned: rows.length, scanHasMore: offset + 20 < values.length, hasMore: offset + 20 < values.length, nextCursor: offset + 20 < values.length ? String(offset + 20) : null }; }
    const [, , workflowId, kind, id] = parts, value = [...saved.values()].find(value => value.run.workflowId === workflowId && (kind === 'runs' ? value.run.id === id : value.operationId === id)); if (!value) throw failure(404); if (url.searchParams.has('expectedRunRevision') && url.searchParams.get('expectedRunRevision') !== value.run.runRevision) throw failure(409, 'The retained live run changed.'); return packet(value, url.searchParams);
  }
  const ui = createWorkflowHistoryUI({ container, api, renderReceipts: (target, actions) => { receipts.push(copy(actions)); for (const action of actions) { const text = doc.createElement('p'); text.textContent = JSON.stringify(action); target.append(text); } }, notify: value => notices.push(value) });
  const find = text => all(container).find(node => node.tagName === 'button' && node.textContent === text), disclosure = title => all(container).find(node => node.tagName === 'details' && node.children[0]?.textContent === title);
  return { ui, container, sibling, calls, receipts, saved, find, disclosure, setIntercept: value => { custom = value; }, close: () => ui.close() };
}

test('construction and workflow selection are passive; only explicit history inspection uses bounded GET pages', async () => {
  const f = fixture(); try { assert.equal(f.calls.length, 0); assert.equal(f.container.children[0], f.sibling); assert.equal(f.container.children[1].hidden, true); f.ui.setWorkflow(A); assert.equal(f.calls.length, 0); await f.ui.refresh(); assert.equal(f.calls.length, 1); const url = new URL('http://fixture/' + f.calls[0].path); assert.equal(url.searchParams.get('workflowId'), A); assert.equal(url.searchParams.get('limit'), '20'); assert.equal(f.container.children[1].hidden, false); assert.match(f.container.textContent, /does not run, retry or resume/); assert.equal(all(f.container).some(node => node.tagName === 'button' && /^(Run workflow|Run again|Resume|Retry)/.test(node.textContent)), false); } finally { f.close(); }
});

test('saved original name, definition and times remain independent of current workflow editing or availability', async () => {
  const original = record({ name: 'Original <script>literal name</script>', times: false }), f = fixture({ records: [original] });
  try { await f.ui.openRun(A, C); assert.match(f.container.textContent, /Original <script>literal name<\/script>/); assert.match(f.container.textContent, /older run has no saved timestamps/); assert.equal(f.disclosure('Original workflow definition').open, false); assert.equal(f.disclosure('Original workflow definition').children.find(node => node.tagName === 'pre').textContent, original.definitionText); assert.equal(all(f.container).some(node => node.tagName === 'script'), false); assert.equal(f.calls.some(call => /catalog|workspace$|\/run$/.test(call.path)), false); } finally { f.close(); }
});

test('a filtered scan with no matches still offers its actual older cursor rather than claiming history ended', async () => {
  let reads = 0; const f = fixture({ intercept: call => { if (!call.path.startsWith('workflow-runs?')) return; reads++; if (reads === 1) return { runs: [], returned: 0, scanned: 100, scanHasMore: true, hasMore: true, nextCursor: '201' }; assert.equal(new URL('http://fixture/' + call.path).searchParams.get('before'), '201'); return { runs: [record().run], returned: 1, scanned: 25, scanHasMore: false, hasMore: false, nextCursor: null }; } });
  try { f.ui.setWorkflow(A); await f.ui.refresh(); assert.match(f.container.textContent, /Older saved runs may be available/); assert.equal(f.find('Load more runs').hidden, false); await f.find('Load more runs').fire('click'); assert.match(f.container.textContent, /Original routine/); assert.equal(f.find('Load more runs').hidden, true); assert.equal(f.calls.length, 2); } finally { f.close(); }
});

test('large definition and outcome pages pin the same revision and parse action receipts only after complete JSON', async () => {
  const definition = { id: A, name: 'Large original', steps: [{ tool: 'cap_original', arguments: { text: '😀 original criteria '.repeat(600) + 'DEFINITION_TAIL' }, capability: { id: 'original_cap', version: 1, hash: REV } }] }, outcome = { id: A, status: 'failed', steps: [{ tool: 'cap_original', result: { value: 'long recorded value '.repeat(500) + 'OUTCOME_TAIL' } }], failedStep: { index: 1, tool: 'cap_partial', hostActions: [{ id: 'kept-effect', tool: 'save_note', status: 'completed', result: { note: { id: B, title: 'Already created' } } }] } }, saved = record({ definition, outcome, status: 'failed' }), f = fixture({ records: [saved] });
  try { await f.ui.openRun(A, C); assert.equal(f.receipts.length, 0); assert.match(f.container.textContent, /more pages/); assert.doesNotMatch(f.container.textContent, /Completed within failed step/); while (f.find('Load more outcome')) await f.find('Load more outcome').fire('click'); assert.ok(f.receipts.some(actions => actions.some(action => action.id === 'kept-effect'))); assert.match(f.container.textContent, /Completed within failed step/); while (f.find('Load more definition')) await f.find('Load more definition').fire('click'); assert.equal(f.disclosure('Original workflow definition').children.find(node => node.tagName === 'pre').textContent, saved.definitionText); assert.match(f.disclosure('Retained outcome JSON').textContent, /OUTCOME_TAIL/); for (const call of f.calls.slice(1)) assert.equal(new URL('http://fixture/' + call.path).searchParams.get('expectedRunRevision'), REV); assert.match(f.container.textContent, /new run starts from step 1/); } finally { f.close(); }
});

test('a changed live revision clears both incomplete records and requires an explicit fresh GET', async () => {
  const definition = { id: A, name: 'Old definition marker', steps: [{ tool: 'save_note', arguments: { text: 'Original details '.repeat(500) } }] }, saved = record({ definition, status: 'running', outcome: { id: A, status: 'running', steps: [], padding: 'old outcome '.repeat(500) } }), f = fixture({ records: [saved] });
  try { await f.ui.openRun(A, C); f.saved.set(C, record({ name: 'New retained state', revision: NEXT_REV })); await f.find('Load more definition').fire('click'); assert.match(f.container.textContent, /earlier pages were cleared/); assert.equal(f.disclosure('Original workflow definition'), undefined); assert.equal(f.disclosure('Retained outcome JSON'), undefined); assert.doesNotMatch(f.container.textContent, /Old definition marker/); assert.equal(f.calls.length, 2); await f.find('Refresh selected run').fire('click'); assert.equal(f.calls.length, 3); assert.equal(new URL('http://fixture/' + f.calls[2].path).searchParams.has('expectedRunRevision'), false); assert.match(f.container.textContent, /New retained state/); } finally { f.close(); }
});

test('late list and detail responses cannot retarget a newly selected workflow or run', async () => {
  const held = deferred(), other = record({ id: D, workflowId: B, name: 'Second routine' }), f = fixture({ records: [record(), other], intercept: call => call.path.includes('workflowId=' + A) ? held.promise : undefined });
  try { f.ui.setWorkflow(A); const listing = f.ui.refresh(); f.ui.setWorkflow(B); await f.ui.refresh(); held.resolve({ runs: [record().run], returned: 1, hasMore: false, nextCursor: null }); await listing; assert.match(f.container.textContent, /Second routine/); assert.doesNotMatch(f.container.textContent, /Original routine/); const detail = deferred(); f.setIntercept(call => call.path === 'workspace/workflows/' + A + '/runs/' + C ? detail.promise : undefined); const reading = f.ui.openRun(A, C); await f.ui.openRun(B, D); detail.resolve(packet(record())); await reading; assert.match(f.container.textContent, /Second routine/); assert.doesNotMatch(f.container.textContent, /Actual saved note.*Original routine/); const heading = all(f.container).find(node => node.className === 'workflow-history-detail').children[0]; assert.equal(heading.textContent, 'Second routine'); } finally { f.close(); }
});

test('a late page from the prior selection cannot replace or clear a new run record', async () => {
  const first = record({ definition: { id: A, name: 'Paged first', steps: [{ tool: 'cap_one', arguments: { text: 'First long source '.repeat(500) } }] } }), second = record({ id: D, workflowId: B, name: 'Current second' }), held = deferred(), f = fixture({ records: [first, second] });
  try { await f.ui.openRun(A, C); f.setIntercept(call => call.path.includes('definitionOffset=') ? held.promise : undefined); const loading = f.find('Load more definition').fire('click'); await until(() => f.calls.some(call => call.path.includes('definitionOffset='))); await f.ui.openRun(B, D); held.reject(failure(409)); await loading; assert.match(f.container.textContent, /Current second/); assert.doesNotMatch(f.container.textContent, /earlier pages were cleared/); assert.ok(f.disclosure('Original workflow definition')); } finally { f.close(); }
});

test('original definition disclosure expansion survives refreshes while each run retains its own setting', async () => {
  const second = record({ id: D, name: 'Other run' }), f = fixture({ records: [record(), second] });
  try { await f.ui.openRun(A, C); f.disclosure('Original workflow definition').open = true; await f.ui.refresh(); assert.equal(f.disclosure('Original workflow definition').open, true); await f.find('Refresh selected run').fire('click'); assert.equal(f.disclosure('Original workflow definition').open, true); await f.ui.openRun(A, D); assert.equal(f.disclosure('Original workflow definition').open, false); await f.ui.openRun(A, C); assert.equal(f.disclosure('Original workflow definition').open, true); } finally { f.close(); }
});

test('exact pending-operation inspection is GET-only and a missing receipt never dispatches a replacement', async () => {
  const f = fixture(); try { await f.ui.openOperation(A, D); assert.equal(f.calls[0].path, 'workspace/workflows/' + A + '/operations/' + D); assert.match(f.container.textContent, /Original routine/); await assert.rejects(f.ui.openOperation(A, B), error => error.status === 404); assert.match(f.container.textContent, /No retained run record was found/); assert.equal(f.calls.length, 2); assert.equal(f.calls.some(call => call.path.endsWith('/run')), false); } finally { f.close(); }
});

test('failed-step nested effects stay separated from failure and shortening is disclosed for actual retained records', async () => {
  const outcome = { id: A, status: 'failed', steps: [{ tool: 'save_note', result: { note: { id: B, title: 'First committed effect' } } }], detailsTruncated: true, failedStep: { index: 1, tool: 'cap_partial', hostActions: [{ id: 'done', status: 'completed', tool: 'create_task', result: { task: { id: D, title: 'Committed inside failed step' } } }, { id: 'unknown', status: 'failed', tool: 'save_note', result: { error: 'Final state needs inspection', outcomeUnknown: true } }] } }, definition = { id: A, name: 'Retained shortened original', detailsTruncated: true, steps: [] }, f = fixture({ records: [record({ status: 'failed', outcome, definition })] });
  try { await f.ui.openRun(A, C); assert.match(f.container.textContent, /Completed within failed step/); assert.match(f.container.textContent, /Other recorded actions within failed step/); assert.match(f.container.textContent, /Some details were shortened when this receipt was saved/); assert.match(f.disclosure('Original workflow definition').textContent, /Some details were shortened when this record was saved/); assert.ok(f.receipts.some(actions => actions.length === 1 && actions[0].id === 'done')); assert.ok(f.receipts.some(actions => actions.length === 1 && actions[0].id === 'unknown')); assert.match(f.container.textContent, /actions already completed may repeat/); } finally { f.close(); }
});

test('running and interrupted outcomes show only retained checkpoints and never infer a completed active step', async () => {
  const f = fixture({ records: [record({ status: 'interrupted', outcome: { id: A, status: 'interrupted', checkpointAvailable: true, outcomeUnknown: true, steps: [], activeStep: { index: 0, tool: 'cap_pending' }, message: 'Inspect the recorded actions.' } })] });
  try { await f.ui.openRun(A, C); assert.match(f.container.textContent, /Interrupted/); assert.match(f.container.textContent, /A step was in progress: 1 cap_pending/); assert.match(f.container.textContent, /No completion is inferred/); assert.match(f.container.textContent, /final outcome is uncertain/); assert.equal(f.receipts.length, 0); } finally { f.close(); }
});

test('mismatched run identities and incomplete JSON are never shown as a complete successful record', async () => {
  const f = fixture({ intercept: call => call.path.includes('/runs/') ? packet(record({ workflowId: B })) : undefined });
  try { await assert.rejects(f.ui.openRun(A, C), /did not match/); assert.equal(f.receipts.length, 0); assert.match(f.container.textContent, /could not be read/); f.setIntercept(() => ({ ...packet(record()), outcomeText: '{', outcomeLength: 1, outcomeOffset: 0, outcomeHasMore: false, nextOutcomeOffset: null })); await assert.rejects(f.ui.openRun(A, C)); assert.equal(f.receipts.length, 0); assert.equal(f.disclosure('Retained outcome JSON'), undefined); } finally { f.close(); }
});

test('closing history aborts reads without calling cancellation, resume or execution endpoints', async () => {
  const held = deferred(); let signal; const f = fixture({ intercept: call => { signal = call.options.signal; return held.promise; } }); const reading = f.ui.openRun(A, C); await until(() => signal); f.close(); assert.equal(signal.aborted, true); held.resolve(packet(record())); await reading; assert.equal(f.calls.length, 1); assert.equal(f.calls.some(call => /cancel|stop|\/run$/.test(call.path)), false); assert.equal(f.container.children.length, 1); assert.equal(f.container.children[0], f.sibling);
});

test('interrupted in-progress custom steps expose actual nested completed effects without inferring parent completion',async()=>{
  const activeStep={index:0,tool:'cap_nested',nestedReceiptState:'interrupted',nestedDetailsTruncated:true,hostActions:[{id:'nested-done',tool:'save_note',status:'completed',result:{note:{id:B,title:'Actual durable nested note'}}},{id:'nested-other',tool:'create_task',status:'failed',result:{error:'Final effect is unknown',outcomeUnknown:true}}]},f=fixture({records:[record({status:'interrupted',outcome:{id:A,status:'interrupted',steps:[],activeStep,outcomeUnknown:true}})]});try{await f.ui.openRun(A,C);assert.match(f.container.textContent,/Completed within in-progress step/);assert.match(f.container.textContent,/Other recorded actions within in-progress step/);assert.match(f.container.textContent,/parent step has no confirmed completion/);assert.match(f.container.textContent,/Some details were shortened/);assert.ok(f.receipts.some(actions=>actions.length===1&&actions[0].id==='nested-done'));assert.ok(f.receipts.some(actions=>actions.length===1&&actions[0].id==='nested-other'));assert.equal(f.calls.length,1);}finally{f.close();}
});

test('missing nested receipts leave an interrupted step unknown without claiming no effects or restoration',async()=>{
  const f=fixture({records:[record({status:'interrupted',outcome:{id:A,status:'interrupted',steps:[],activeStep:{index:0,tool:'cap_missing',nestedReceiptState:'not_recorded',outcomeUnknown:true},outcomeUnknown:true}})]});try{await f.ui.openRun(A,C);assert.match(f.container.textContent,/Nested action evidence is unavailable/);assert.match(f.container.textContent,/final outcome remains unknown/);assert.doesNotMatch(f.container.textContent,/no actions occurred|reverted|undone/i);assert.equal(f.receipts.length,0);}finally{f.close();}
});
