const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const STORAGE_KEY = 'companion.build.continuations.pending.v1';
const STATUSES = new Set(['waiting_for_build', 'waiting_for_activation', 'waiting_for_runtime', 'ready', 'starting', 'queued', 'running', 'waiting_for_review', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const LABELS = { waiting_for_build: 'Waiting for build', waiting_for_activation: 'Waiting for activation', waiting_for_runtime: 'Waiting for restart', ready: 'Ready to continue', starting: 'Starting work', queued: 'Queued', running: 'Working', waiting_for_review: 'Needs computer review', completed: 'Result ready', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', blocked: 'Cannot continue yet' };
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const short = value => { const line = String(value || '').trim().split(/[\r\n]/)[0]; return line.length > 84 ? line.slice(0, 81) + '…' : line || 'Original request'; };
const valid = value => !!value && UUID.test(value.id) && UUID.test(value.buildId) && UUID.test(value.workId) && STATUSES.has(value.status) && value.origin && typeof value.origin.message === 'string' && typeof value.buildSpec === 'string' && value.origin.provider && typeof value.origin.provider.id === 'string' && typeof value.readiness?.ready === 'boolean' && (!value.workJob || value.workJob.id === value.workId);
const hasWork = value => !!value && value.workJob?.id === value.workId;

/** A passive Build-details panel. The host owns authentication, routing and refresh timing. */
export function createBuildContinuationUI({ container, api, openWork = () => {}, notify = () => {} }) {
  if (!container || typeof api !== 'function') throw new TypeError('A continuation container and API function are required.');
  const doc = container.ownerDocument || globalThis.document;
  const node = (tag, className, text) => { const result = doc.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = String(text); return result; };
  const root = node('section', 'build-continuations'); root.setAttribute('aria-label', 'Continue your original request');
  const heading = node('h3', '', 'Continue your request'), description = node('p', 'continuation-hint', 'After the build is ready, continue the original request as separate work.');
  const status = node('p', 'continuation-hint'); status.setAttribute('role', 'status');
  const errors = node('p', 'inline-error'); errors.setAttribute('role', 'alert');
  const list = node('div', 'continuation-list'), more = node('button', 'quiet-button', 'Load more requests'), checks = node('div', 'continuation-checks'); more.type = 'button';
  root.append(heading, description, status, errors, list, more, checks); container.append(root);
  const records = new Map(), pending = new Map(), checked = new Set(), versions = new Map(), busy = new Map(), expanded = new Map(), requests = new Set();
  let closed = false, buildId = null, generation = 0, listTicket = 0, refreshing = false, page = null, ids = [], error = '', storage = null;
  try { storage = globalThis.localStorage; const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(saved)) for (const id of saved.slice(0, 200)) if (typeof id === 'string' && UUID.test(id)) pending.set(id, 'unknown'); } catch { /* Browser storage is optional; no request text is stored. */ }
  function persist(removeId) {
    if (!storage) return;
    try { const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(saved)) for (const id of saved.slice(0, 200)) if (typeof id === 'string' && UUID.test(id) && id !== removeId && !pending.has(id)) pending.set(id, 'unknown'); if (removeId) pending.delete(removeId); storage.setItem(STORAGE_KEY, JSON.stringify([...pending.keys()].slice(0, 200))); } catch { /* The in-memory check remains available. */ }
  }
  function forget(id) { pending.delete(id); persist(id); }
  const version = id => versions.get(id) || 0;
  function bump(id) { const next = version(id) + 1; versions.set(id, next); return next; }
  async function request(path, options = {}) { const controller = new AbortController(); requests.add(controller); try { return await api(path, { ...options, signal: controller.signal }, 20000); } finally { requests.delete(controller); } }
  function accepted(value, expectedId, expectedBuild) { if (!valid(value) || expectedId && value.id !== expectedId || expectedBuild && value.buildId !== expectedBuild) throw new Error('The continuation could not be matched to its original request.'); return clone(value); }
  function remember(value, { fromList = false } = {}) {
    const old = records.get(value.id);
    if (fromList && old && (hasWork(old) && !hasWork(value) || TERMINAL.has(old.status) && !TERMINAL.has(value.status))) return old;
    records.set(value.id, value); return value;
  }
  function reconcile(value, { explicit = false } = {}) {
    const action = pending.get(value.id); if (!action) return;
    if (explicit && value.status === 'ready' && value.readiness.ready && !hasWork(value) || TERMINAL.has(value.status) || value.status === 'blocked' || action !== 'cancel' && hasWork(value) || action === 'cancel' && value.cancelRequested === true) forget(value.id);
  }
  function button(text, callback, className = 'quiet-button') { const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', callback); return result; }
  function disclosure(id, key, title, text) { const details = node('details', 'continuation-disclosure'), summary = node('summary', '', title), body = node('div', 'continuation-text', text); details.open = expanded.get(id + ':' + key) === true; details.addEventListener('toggle', () => expanded.set(id + ':' + key, details.open)); details.append(summary, body); return details; }
  function sourceLabels(value, card) {
    const origin = value.origin, provider = origin.provider;
    card.append(node('p', 'continuation-origin', 'Original AI: ' + (provider.label || provider.id) + (provider.model ? ' · ' + provider.model : '')));
    if (origin.project) card.append(node('p', 'continuation-origin', 'Project: ' + (origin.project.label || 'Selected project') + (Number.isSafeInteger(origin.project.grantEpoch) ? ' · access ' + origin.project.grantEpoch : '')));
    if (origin.windowContext) card.append(node('p', 'continuation-origin', 'Window source: ' + (origin.windowContext.title || origin.windowContext.window?.title || 'Selected window') + '. The same source must still be available.'));
  }
  function renderCard(value, checking = false) {
    const card = node('article', 'continuation-card'); card.setAttribute('data-continuation-id', value.id);
    const top = node('div', 'continuation-card-heading'); top.append(node('h4', '', short(value.origin.message)), node('span', 'continuation-state', LABELS[value.status])); card.append(top); sourceLabels(value, card);
    const reason = value.reason || value.readiness.reason;
    if (reason) card.append(node('p', value.status === 'blocked' ? 'continuation-reason' : 'continuation-hint', reason));
    else if (value.status === 'blocked') card.append(node('p', 'continuation-reason', 'The original request is not currently available to continue. Check its saved sources and build readiness.'));
    if (value.cancelRequested && !TERMINAL.has(value.status)) card.append(node('p', 'continuation-hint', 'Stop requested. Waiting for the actual outcome.'));
    card.append(disclosure(value.id, 'request', 'Your request', value.origin.message), disclosure(value.id, 'spec', 'Build instructions', value.buildSpec));
    const actions = node('div', 'continuation-actions'), action = busy.get(value.id), uncertain = pending.has(value.id);
    if (uncertain) { card.append(node('p', 'continuation-hint', 'The last response was not confirmed. Check the saved continuation; this does not send the request again.')); const check = button(action === 'check' ? 'Checking…' : 'Check continuation', () => { void checkContinuation(value.id); }); check.disabled = !!action; actions.append(check); }
    if (value.status === 'ready' && value.readiness.ready && !uncertain) { const start = button(action === 'continue' ? 'Starting…' : 'Continue original request', () => { void mutate(value.id, 'continue'); }, 'secondary-button'); start.disabled = !!action; actions.append(start); }
    if (hasWork(value)) { const work = button('Open work', () => { if (!closed) openWork(value.workId); }); work.setAttribute('aria-label', 'Open work for: ' + short(value.origin.message)); actions.append(work); }
    if (!TERMINAL.has(value.status) && value.status !== 'waiting_for_review' && !value.cancelRequested) { const cancel = button(action === 'cancel' ? 'Stopping…' : hasWork(value) ? 'Stop work' : 'Cancel continuation', () => { void mutate(value.id, 'cancel'); }); cancel.disabled = !!action; actions.append(cancel); }
    if (checking) card.append(node('p', 'continuation-hint', 'This check belongs to a different build.'));
    if (actions.children.length) card.append(actions);
    return card;
  }
  function render() {
    if (closed) return;
    root.hidden = !buildId && !pending.size && !checked.size;
    heading.hidden = description.hidden = !buildId;
    errors.textContent = error; errors.hidden = !error;
    status.textContent = refreshing ? 'Checking saved requests…' : buildId && !ids.length ? 'No original request is linked to this build.' : '';
    status.hidden = !status.textContent; list.replaceChildren(); for (const id of ids) { const value = records.get(id); if (value) list.append(renderCard(value)); }
    more.hidden = !page?.hasMore; more.disabled = refreshing;
    checks.replaceChildren(); const others = [...new Set([...pending.keys(), ...checked])].filter(id => !ids.includes(id));
    if (others.length) checks.append(node('h4', '', 'Saved continuation checks'));
    for (const id of others) {
      const value = records.get(id); if (value) { checks.append(renderCard(value, value.buildId !== buildId)); continue; }
      const row = node('div', 'continuation-pending'); row.append(node('p', 'continuation-hint', 'An earlier continuation response needs checking.'));
      const check = button(busy.has(id) ? 'Checking…' : 'Check continuation', () => { void checkContinuation(id); }); check.disabled = busy.has(id); check.setAttribute('aria-label', 'Check continuation ' + id); row.append(check); checks.append(row);
    }
    checks.hidden = !others.length;
  }
  function setBuild(value) {
    if (closed) return;
    if (value !== null && (typeof value !== 'string' || !UUID.test(value))) throw new TypeError('Use an actual build ID.');
    if (buildId === value) return;
    generation++; listTicket++; buildId = value; page = null; ids = value ? [...records.values()].filter(item => item.buildId === value).map(item => item.id) : []; refreshing = false; error = ''; render();
  }
  async function refresh(loadMore = false) {
    if (closed || !buildId || refreshing) return;
    const selected = buildId, stamp = generation, ticket = ++listTicket, offset = loadMore ? page?.nextOffset : 0, captured = new Map(versions);
    if (loadMore && (!page?.hasMore || !Number.isSafeInteger(offset))) return;
    refreshing = true; error = ''; render();
    try {
      const params = new URLSearchParams({ buildId: selected, offset: String(offset), limit: '20' }), result = await request('continuations?' + params);
      if (closed || stamp !== generation || ticket !== listTicket) return;
      if (!result || !Array.isArray(result.continuations) || result.continuations.length > 20 || result.offset !== offset || typeof result.hasMore !== 'boolean' || !Number.isSafeInteger(result.total) || result.total < 0 || result.hasMore && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset)) throw new Error('The saved continuation list could not be read.');
      const values = result.continuations.map(item => accepted(item, null, selected));
      for (const item of values) if (!busy.has(item.id) && version(item.id) === (captured.get(item.id) || 0)) { const kept = remember(item, { fromList: true }); reconcile(kept); }
      ids = [...new Set([...(loadMore ? ids : []), ...values.map(item => item.id)])]; page = { ...result, continuations: undefined };
    } catch (failure) { if (!closed && stamp === generation && ticket === listTicket) error = failure.message || 'Could not check saved continuations.'; }
    finally { if (!closed && stamp === generation && ticket === listTicket) { refreshing = false; render(); } }
  }
  async function checkContinuation(id) {
    if (closed || !UUID.test(id) || busy.has(id)) return;
    const ticket = bump(id); busy.set(id, 'check'); error = ''; render();
    try { const result = await request('continuations/' + encodeURIComponent(id)), value = accepted(result?.continuation, id); if (closed || version(id) !== ticket) return; remember(value); checked.add(id); reconcile(value, { explicit: true }); if (buildId === value.buildId && !ids.includes(id)) ids.push(id); notify('Continuation checked: ' + LABELS[value.status] + '.'); }
    catch (failure) { if (!closed && version(id) === ticket) error = failure.message || 'The continuation is still unconfirmed. Check again before sending anything new.'; }
    finally { if (!closed && version(id) === ticket) { busy.delete(id); render(); } }
  }
  async function mutate(id, action) {
    if (closed || busy.has(id)) return;
    const original = records.get(id); if (!original) return;
    if (action === 'continue' && (pending.has(id) || original.status !== 'ready' || !original.readiness.ready)) return;
    if (action === 'cancel' && (TERMINAL.has(original.status) || original.status === 'waiting_for_review' || original.cancelRequested)) return;
    const ticket = bump(id); busy.set(id, action); pending.set(id, action); persist(); error = ''; render();
    try {
      const result = await request('continuations/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' });
      const value = accepted(result?.continuation, id, original.buildId);
      if (closed || version(id) !== ticket) return;
      remember(value); bump(id); forget(id); checked.add(id);
      notify(action === 'continue' ? 'Original request: ' + LABELS[value.status] + '.' : value.status === 'cancelled' ? 'Continuation cancelled.' : value.cancelRequested ? 'Stop requested. Check the actual outcome.' : 'Continuation: ' + LABELS[value.status] + '.');
      return clone(value);
    } catch (failure) {
      if (!closed && version(id) === ticket) error = (failure.message ? failure.message + ' ' : '') + 'The response is unconfirmed. Use Check continuation; the request will not be sent again.';
    } finally { if (!closed && (version(id) === ticket || busy.get(id) === action)) { busy.delete(id); render(); } }
  }
  function continueOriginal(expectedBuildId) {
    if (closed) throw new Error('Open the build details before continuing.');
    if (expectedBuildId !== buildId || !buildId) throw new Error('The selected build changed. Open the intended build before continuing.');
    if (refreshing) throw new Error('Wait for the saved request check to finish before continuing.');
    const linked = ids.map(id => records.get(id)).filter(value => value?.buildId === expectedBuildId);
    if (linked.length !== 1) throw new Error(linked.length ? 'Choose the intended original request in this build.' : 'No original request is linked to this build.');
    const value = linked[0];
    if (pending.has(value.id)) throw new Error('Check the unconfirmed continuation before sending anything new.');
    if (busy.has(value.id)) throw new Error('The original request is already being checked or started.');
    if (value.status !== 'ready' || !value.readiness.ready) throw new Error(value.reason || value.readiness.reason || 'The original request is not ready to continue.');
    return mutate(value.id, 'continue');
  }
  more.addEventListener('click', () => { void refresh(true); });
  function close() { if (closed) return; closed = true; generation++; listTicket++; for (const controller of requests) controller.abort(); requests.clear(); root.remove(); }
  render();
  return { setBuild, refresh, continueOriginal, close };
}
