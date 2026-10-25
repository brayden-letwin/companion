const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/i;
const STATUSES = new Set(['running', 'interrupted', 'completed', 'cancelled', 'failed']);
const LABELS = { running: 'Running', interrupted: 'Interrupted', completed: 'Finished', cancelled: 'Cancelled', failed: 'Could not finish' };
const clone = value => JSON.parse(JSON.stringify(value));
const labelTime = value => value ? new Date(value).toLocaleString() : 'Time not recorded';
const truncated = (value, depth = 0) => depth < 20 && !!value && typeof value === 'object' && (value.detailsTruncated === true || value.nestedDetailsTruncated === true || Object.values(value).some(item => truncated(item, depth + 1)));

function metadata(value, expected) {
  if (!value || !UUID.test(value.id) || !UUID.test(value.workflowId) || typeof value.name !== 'string' || !STATUSES.has(value.status) || !Number.isSafeInteger(value.stepCount) || value.stepCount < 0 || !Number.isSafeInteger(value.completedStepCount) || value.completedStepCount < 0 || typeof value.timestampsAvailable !== 'boolean' || !HASH.test(value.runRevision) || ['startedAt', 'updatedAt', 'finishedAt'].some(key => value[key] !== null && !Number.isFinite(Date.parse(value[key])))) throw new Error('The saved run identity could not be read. Refresh its history.');
  if (expected && (value.workflowId !== expected.workflowId || expected.runId && value.id !== expected.runId)) throw new Error('The saved run did not match the selected identity.');
  return value;
}
function section(packet, name) {
  const text = packet[name + 'Text'], offset = packet[name + 'Offset'], length = packet[name + 'Length'], more = packet[name + 'HasMore'], next = packet['next' + name[0].toUpperCase() + name.slice(1) + 'Offset'];
  if (typeof text !== 'string' || text.length > 4000 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || typeof more !== 'boolean' || offset + text.length > length || more && (!Number.isSafeInteger(next) || next <= offset || next !== offset + text.length) || !more && offset + text.length !== length) throw new Error('The saved run page could not be matched. Refresh it before loading more.');
  return { text, offset, length, hasMore: more, nextOffset: more ? next : null, complete: !more, parsed: false, value: null };
}
function parseComplete(value) { if (value.complete && !value.parsed) { value.value = JSON.parse(value.text); value.parsed = true; } return value; }

/** Read retained execution evidence. Every request made by this module is GET. */
export function createWorkflowHistoryUI({ container, api, renderReceipts = null, notify = () => {} }) {
  if (!container || typeof api !== 'function') throw new TypeError('A workflow history container and API are required.');
  const doc = container.ownerDocument || globalThis.document;
  const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
  const button = (text, action) => { const value = node('button', 'quiet-button', text); value.type = 'button'; value.addEventListener('click', () => Promise.resolve().then(action).catch(() => {})); return value; };
  const requests = new Set(), expansion = new Map(), disclosures = new Map();
  let closed = false, workflowId = null, generation = 0, detailGeneration = 0, listBusy = false, detailBusy = false, loadingPart = null, runs = [], nextCursor = null, hasMore = false, selection = null, run = null, definition = null, outcome = null, stale = false, error = '';
  const root = node('section', 'workflow-history'); root.setAttribute('aria-label', 'Saved workflow run history'); root.hidden = true;
  const heading = node('div', 'workflow-history-heading'), title = node('h2', '', 'Run history'), controls = node('div', 'workflow-history-actions');
  const refreshButton = button('Refresh history', () => refresh()), hideButton = button('Close history', hide); controls.append(refreshButton, hideButton); heading.append(title, controls);
  const scope = node('p', 'form-hint', 'Saved results only. Opening history does not run, retry or resume a workflow.');
  const list = node('div', 'workflow-history-list'), moreButton = button('Load more runs', () => refresh({ more: true })), detail = node('article', 'workflow-history-detail'), errorArea = node('p', 'inline-error'); errorArea.setAttribute('role', 'alert');
  root.append(heading, scope, list, moreButton, detail, errorArea); container.append(root);

  async function get(path) { const controller = new AbortController(); requests.add(controller); try { return await api(path, { signal: controller.signal }); } finally { requests.delete(controller); } }
  function visible() { root.hidden = false; container.hidden = false; }
  function abortRequests() { for (const controller of requests) controller.abort(); requests.clear(); }
  function hide() { generation++; detailGeneration++; abortRequests(); listBusy = false; detailBusy = false; loadingPart = null; root.hidden = true; container.hidden = true; }
  function setWorkflow(id = null) {
    if (closed) return; if (id !== null && !UUID.test(id)) throw new Error('Choose a saved workflow identity.');
    generation++; detailGeneration++; abortRequests(); workflowId = id; listBusy = false; detailBusy = false; loadingPart = null; runs = []; hasMore = false; nextCursor = null; selection = null; run = null; definition = null; outcome = null; stale = false; error = ''; render();
  }
  function renderList() {
    list.replaceChildren(); refreshButton.disabled = listBusy; moreButton.hidden = !hasMore; moreButton.disabled = listBusy;
    title.textContent = workflowId ? 'History for this workflow' : 'Run history';
    if (!runs.length) list.append(node('p', 'form-hint', listBusy ? 'Reading saved runs…' : hasMore ? 'No matching runs in this scanned page. Older saved runs may be available.' : 'No saved runs in this history page.'));
    for (const item of runs) { const row = button('', () => openRun(item.workflowId, item.id)); row.className = 'workflow-history-row' + (run?.id === item.id ? ' active' : ''); row.setAttribute('aria-label', 'Open saved run: ' + item.name + ' · ' + LABELS[item.status]); row.append(node('strong', '', item.name || '(Unnamed workflow)'), node('span', '', LABELS[item.status] + ' · ' + item.completedStepCount + ' of ' + item.stepCount + ' steps recorded'), node('small', '', item.timestampsAvailable ? labelTime(item.startedAt) : 'Time not recorded for this older run')); list.append(row); }
  }
  function disclosure(name, label, value) {
    const key = run.id + ':' + name, record = node('details', 'workflow-history-record'); record.open = expansion.get(key) === true; record.append(node('summary', '', label)); record.addEventListener('toggle', () => expansion.set(key, record.open)); disclosures.set(key, record);
    if (!value) record.append(node('p', 'form-hint', 'No retained page loaded.'));
    else { if (value.complete && truncated(value.value)) record.append(node('p', 'workflow-history-warning', 'Some details were shortened when this record was saved. This is the retained record.')); if (!value.complete) record.append(node('p', 'form-hint', 'Partial saved JSON: ' + value.text.length + ' of ' + value.length + ' characters loaded. Load the remaining pages before interpreting the full record.')); record.append(node('pre', 'workflow-history-json', value.text)); if (value.hasMore) { const load = button('Load more ' + name, () => loadPart(name)); load.disabled = !!loadingPart || detailBusy; record.append(load); } }
    return record;
  }
  function receipts(target, actions) { if (!actions.length) return; if (renderReceipts) renderReceipts(target, actions); else for (const action of actions) target.append(node('pre', 'workflow-history-json', JSON.stringify(action, null, 2))); }
  function nestedReceipts(target, values, stage) { const actions = Array.isArray(values) ? values : [], completed = actions.filter(action => action.status === 'completed' && !action.error && !action.result?.error), other = actions.filter(action => !completed.includes(action)); if (completed.length) { target.append(node('h4', '', 'Completed within ' + stage + ' step')); receipts(target, completed); } if (other.length) { target.append(node('h4', '', 'Other recorded actions within ' + stage + ' step')); receipts(target, other); } }
  function renderOutcome(value) {
    if (!value || typeof value !== 'object') { detail.append(node('p', 'form-hint', 'No outcome details were retained.')); return; }
    if (truncated(value)) detail.append(node('p', 'workflow-history-warning', 'Some details were shortened when this receipt was saved. The retained record is shown below.'));
    if (value.outcomeUnknown) detail.append(node('p', 'workflow-history-warning', 'The final outcome is uncertain. Inspect the recorded effects before making another request.'));
    if (value.error || value.message) detail.append(node('p', 'workflow-history-message', typeof (value.error || value.message) === 'string' ? value.error || value.message : JSON.stringify(value.error || value.message)));
    if (value.activeStep) { const active = value.activeStep, row = node('section', 'workflow-history-step'); row.append(node('p', 'form-hint', 'A step was in progress: ' + (Number.isInteger(active.index) ? active.index + 1 : '') + ' ' + (active.tool || '') + '. No completion is inferred.')); if (active.nestedReceiptState) row.append(node('p', 'form-hint', active.nestedReceiptState === 'not_recorded' ? 'Nested action evidence is unavailable. The step’s final outcome remains unknown.' : 'Saved nested receipt state: ' + active.nestedReceiptState + '. The parent step has no confirmed completion.')); nestedReceipts(row, active.hostActions, 'in-progress'); detail.append(row); }
    const steps = Array.isArray(value.steps) ? value.steps : [];
    for (const [index, step] of steps.entries()) { const row = node('section', 'workflow-history-step'); row.append(node('h3', '', 'Recorded step ' + (index + 1) + ' · ' + (step.tool || 'Action'))); receipts(row, [step]); detail.append(row); }
    if (!steps.length) detail.append(node('p', 'form-hint', 'No completed-step details are retained in this record.'));
    if (value.failedStep) {
      const failed = value.failedStep, row = node('section', 'workflow-history-step'); row.append(node('h3', '', (Number.isInteger(failed.index) ? 'Step ' + (failed.index + 1) : 'A step') + ' · ' + (failed.tool || 'Action') + ' · could not finish'));
      nestedReceipts(row, failed.hostActions, 'failed');
      detail.append(row);
    }
  }
  function renderDetail() {
    for (const [key, record] of disclosures) expansion.set(key, record.open); disclosures.clear(); detail.replaceChildren(); if (!selection) { detail.hidden = true; return; } detail.hidden = false;
    if (!run) { detail.append(node('p', 'form-hint', detailBusy ? 'Reading the selected saved run…' : 'The selected run could not be read. Its request was not retried.')); return; }
    detail.append(node('h3', '', run.name || '(Unnamed original workflow)'), node('p', 'workflow-history-status', LABELS[run.status] + ' · ' + run.completedStepCount + ' of ' + run.stepCount + ' steps recorded'), node('p', 'form-hint', run.timestampsAvailable ? 'Started ' + labelTime(run.startedAt) + (run.finishedAt ? ' · finished ' + labelTime(run.finishedAt) : '') : 'This older run has no saved timestamps. No time is inferred.'));
    const refreshRun = button('Refresh selected run', () => openSelection(selection)); refreshRun.disabled = detailBusy || !!loadingPart; detail.append(refreshRun);
    if (stale) { detail.append(node('p', 'workflow-history-warning', 'This run changed while its pages were loading. Refresh the selected run to start again; earlier pages were cleared.')); return; }
    if (definition) detail.append(disclosure('definition', 'Original workflow definition', definition));
    if (outcome?.complete) renderOutcome(outcome.value);
    else if (outcome) { detail.append(node('p', 'form-hint', 'The saved outcome has more pages. Load them before reading its full action receipts.')); const load = button('Load more outcome', () => loadPart('outcome')); load.disabled = !!loadingPart || detailBusy; detail.append(load); }
    if (outcome) detail.append(disclosure('outcome', 'Retained outcome JSON', { ...outcome, hasMore: false }));
    if (['failed', 'cancelled', 'interrupted'].includes(run.status)) detail.append(node('p', 'workflow-history-warning', 'This run will not resume. A separate new run starts from step 1; actions already completed may repeat.'));
  }
  function render() { if (closed) return; renderList(); renderDetail(); errorArea.textContent = error; }
  async function refresh({ more = false } = {}) {
    if (closed || listBusy || more && (!hasMore || !nextCursor)) return; visible(); const stamp = generation, filter = workflowId, cursor = more ? nextCursor : null; listBusy = true; error = ''; render();
    try { const query = new URLSearchParams({ limit: '20', ...(filter ? { workflowId: filter } : {}), ...(cursor ? { before: cursor } : {}) }), packet = await get('workflow-runs?' + query); if (closed || stamp !== generation) return; if (!Array.isArray(packet.runs) || packet.runs.length > 20 || typeof packet.hasMore !== 'boolean' || packet.hasMore && (typeof packet.nextCursor !== 'string' || !/^\d+$/.test(packet.nextCursor))) throw new Error('Saved run history could not be read.'); const values = packet.runs.map(item => metadata(item)); if (filter && values.some(item => item.workflowId !== filter)) throw new Error('This history page belongs to a different workflow.'); const existing = more ? runs : []; runs = [...new Map([...existing, ...values].map(item => [item.id, item])).values()]; hasMore = packet.hasMore; nextCursor = packet.nextCursor || null; }
    catch (failure) { if (!closed && stamp === generation) error = failure.message; }
    finally { if (stamp === generation) { listBusy = false; render(); } }
  }
  async function openSelection(target) {
    if (closed) return null; if (!UUID.test(target.workflowId) || target.runId && !UUID.test(target.runId) || target.operationId && !UUID.test(target.operationId)) throw new Error('Choose an exact saved run identity.');
    visible(); const stamp = ++detailGeneration; selection = clone(target); run = null; definition = null; outcome = null; stale = false; detailBusy = true; loadingPart = null; error = ''; render();
    const path = 'workspace/workflows/' + target.workflowId + (target.operationId ? '/operations/' + target.operationId : '/runs/' + target.runId);
    try { const packet = await get(path); const value = metadata(packet.run, target), firstDefinition = parseComplete(section(packet, 'definition')), firstOutcome = parseComplete(section(packet, 'outcome')); if (firstDefinition.offset !== 0 || firstOutcome.offset !== 0) throw new Error('The saved run did not start at its first retained page.'); if (!closed && stamp === detailGeneration) { run = value; selection = { workflowId: value.workflowId, runId: value.id }; definition = firstDefinition; outcome = firstOutcome; const index = runs.findIndex(item => item.id === value.id); if (index >= 0) runs[index] = value; } return packet; }
    catch (failure) { if (!closed && stamp === detailGeneration) error = failure.status === 404 ? 'No retained run record was found for that exact identity. This check did not start another run.' : failure.message; throw failure; }
    finally { if (stamp === detailGeneration) { detailBusy = false; render(); } }
  }
  function openRun(workflow, id) { return openSelection({ workflowId: workflow, runId: id }); }
  function openOperation(workflow, id) { return openSelection({ workflowId: workflow, operationId: id }); }
  async function loadPart(name) {
    if (closed || !run || stale || detailBusy || loadingPart || !['definition', 'outcome'].includes(name)) return; const current = name === 'definition' ? definition : outcome; if (!current?.hasMore) return;
    const stamp = detailGeneration, target = { workflowId: run.workflowId, runId: run.id }, revision = run.runRevision, offset = current.nextOffset; loadingPart = name; error = ''; render();
    try { const query = new URLSearchParams({ [name + 'Offset']: String(offset), expectedRunRevision: revision }), packet = await get('workspace/workflows/' + target.workflowId + '/runs/' + target.runId + '?' + query); if (closed || stamp !== detailGeneration) return; const value = metadata(packet.run, target); if (value.runRevision !== revision) throw Object.assign(new Error('This run changed while its saved pages were loading.'), { status: 409 }); const page = section(packet, name); if (page.offset !== offset || page.length !== current.length) throw new Error('The next saved page did not match its original run.'); const combined = parseComplete({ ...page, offset: 0, text: current.text + page.text }); if (name === 'definition') definition = combined; else outcome = combined; run = value; }
    catch (failure) { if (!closed && stamp === detailGeneration) { error = failure.message; if (failure.status === 409) { detailGeneration++; definition = null; outcome = null; stale = true; } } }
    finally { if (stamp === detailGeneration || stale && selection?.runId === target.runId) { loadingPart = null; render(); } }
  }
  render();
  return { setWorkflow, refresh, openRun, openOperation, close() { if (closed) return; closed = true; generation++; detailGeneration++; abortRequests(); root.remove(); } };
}
