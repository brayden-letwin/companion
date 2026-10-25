const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/i;
const copy = value => JSON.parse(JSON.stringify(value));
const validBinding = value => value && UUID.test(value.projectId) && Number.isSafeInteger(value.grantEpoch) && value.grantEpoch > 0;
const same = (left, right) => !!left && !!right && left.projectId === right.projectId && left.grantEpoch === right.grantEpoch;
const keys = { scanned: ['directories', 'entries', 'files', 'bytes'], skipped: ['protected', 'unavailable', 'binary', 'oversized'] };
const safeCounts = (value, names) => value && names.every(name => Number.isSafeInteger(value[name]) && value[name] >= 0);
const timeLabel = value => new Date(value).toLocaleString();

/** Literal, explicit folder reads. The host supplies consented bindings and file opening. */
export function createProjectFileSearchUI({ container, api, onOpen, notify = () => {} }) {
  if (!container || typeof api !== 'function' || typeof onOpen !== 'function') throw new TypeError('A search container, API and pinned-file opener are required.');
  const doc = container.ownerDocument || globalThis.document;
  const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
  const button = (text, action, className = 'quiet-button') => { const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', () => Promise.resolve().then(action).catch(() => {})); return value; };
  let closed = false, selection = null, generation = 0, session = null, matches = [], busy = false, stopped = false, error = '', active = null, openRequest = null, openTicket = 0, unavailable = false;
  const seen = new Set();
  const root = node('section', 'project-editor project-file-search'); root.hidden = true;
  const heading = node('h2', '', 'Find in folder'), hint = node('p', 'project-hint', 'Find literal text in the chosen folder. This reads files only when you search; it does not change them.');
  const form = node('form', 'project-new-file'), queryLabel = node('label', 'field-label', 'Text to find'), query = node('input'), search = node('button', 'secondary-button', 'Search'); query.maxLength = 200; query.required = true; query.setAttribute('aria-label', 'Find text in project folder'); query.placeholder = 'An exact word or phrase'; queryLabel.append(query); search.type = 'submit'; form.append(queryLabel, search);
  const options = node('details', 'workflow-optional'), scopeLabel = node('label', 'field-label', 'Subfolder (optional)'), scope = node('input'), caseLabel = node('label', 'check-label'), caseSensitive = node('input'); scope.maxLength = 240; scope.placeholder = 'Leave blank for the chosen folder'; scope.setAttribute('aria-label', 'Search within subfolder'); scopeLabel.append(scope); caseSensitive.type = 'checkbox'; caseSensitive.setAttribute('aria-label', 'Match case in folder search'); caseLabel.append(caseSensitive, node('span', '', 'Match case')); options.append(node('summary', '', 'Search options'), scopeLabel, caseLabel);
  const actions = node('div', 'project-actions'), more = button('Load more search results', () => readPage(true)), stopButton = button('Stop search', stop); actions.append(more, stopButton);
  const status = node('p', 'project-hint'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const skipped = node('p', 'project-hint'), results = node('div', 'project-file-list'), errors = node('p', 'inline-error'); errors.setAttribute('role', 'alert');
  root.append(heading, hint, form, options, status, skipped, results, actions, errors); container.append(root);

  function alive(binding, stamp) { return !closed && stamp === generation && same(binding, selection); }
  function closeSession(value) {
    if (!value || !validBinding(value) || !UUID.test(value.searchId)) return;
    void Promise.resolve().then(() => api('projects/' + value.projectId + '/search/' + value.searchId + '/close', { method: 'POST', body: JSON.stringify({ grantEpoch: value.grantEpoch }) }, 5000)).catch(() => {});
  }
  function abortReads() { active?.controller.abort(); active = null; openRequest?.controller.abort(); openRequest = null; openTicket++; busy = false; }
  function invalidate({ clearInputs = false, keepResults = false } = {}) {
    const previous = session; generation++; abortReads(); closeSession(previous); session = keepResults && previous ? { ...previous, nextCursor: null, scanHasMore: false } : null; if (!keepResults) { matches = []; seen.clear(); } if (keepResults) matches = matches.map(hit => ({ ...hit, selectionGeneration: generation })); stopped = keepResults; error = '';
    if (clearInputs) { query.value = ''; scope.value = ''; caseSensitive.checked = false; options.open = false; }
  }
  function selectionChanged(value) {
    if (closed) return; if (value !== null && !validBinding(value)) throw new TypeError('Use an actual project selection for search.');
    if (value && same(value, selection)) { selection = { projectId: value.projectId, grantEpoch: value.grantEpoch, label: value.label || 'Project folder' }; render(); return; }
    invalidate({ clearInputs: true }); unavailable = false; selection = value ? { projectId: value.projectId, grantEpoch: value.grantEpoch, label: value.label || 'Project folder' } : null; render();
  }
  function draftChanged() { if (session || active || matches.length || openRequest) invalidate(); else { error = ''; stopped = false; } render(); }
  query.addEventListener('input', draftChanged); scope.addEventListener('input', draftChanged); caseSensitive.addEventListener('change', draftChanged);
  form.addEventListener('submit', event => { event.preventDefault(); void readPage(false); });
  function validate(packet, target, continuation) {
    if (!packet || !same(packet, target) || !UUID.test(packet.searchId) || typeof packet.pageId !== 'string' || !packet.pageId || packet.path !== target.path || packet.query !== target.query || packet.caseSensitive !== target.caseSensitive || packet.sourceTrust !== 'untrusted_project_search' || packet.snapshot !== false || !Number.isFinite(Date.parse(packet.startedAt)) || !Number.isFinite(Date.parse(packet.observedAt)) || !Array.isArray(packet.matches) || packet.matches.length > 20 || packet.returned !== packet.matches.length || typeof packet.scanHasMore !== 'boolean' || typeof packet.complete !== 'boolean' || packet.scanHasMore && !UUID.test(packet.nextCursor) || !safeCounts(packet.scanned, keys.scanned) || !safeCounts(packet.skipped, keys.skipped)) throw new Error('The folder search page could not be matched. Search again explicitly.');
    if (continuation && (packet.searchId !== session.searchId || keys.scanned.some(key => packet.scanned[key] < session.scanned[key]) || keys.skipped.some(key => packet.skipped[key] < session.skipped[key]))) throw new Error('This search changed. Start a fresh search rather than mixing its pages.');
    if (packet.matches.some(hit => !hit || typeof hit.path !== 'string' || !HASH.test(hit.hash) || !Number.isFinite(Date.parse(hit.readAt)) || !Number.isSafeInteger(hit.line) || hit.line < 1 || !Number.isSafeInteger(hit.column) || hit.column < 1 || !Number.isSafeInteger(hit.matchOffset) || hit.matchOffset < 0 || !Number.isSafeInteger(hit.matchLength) || hit.matchLength < 1 || typeof hit.snippet !== 'string' || !Number.isSafeInteger(hit.snippetOffset) || hit.snippetOffset < 0 || typeof hit.snippetTruncated !== 'boolean')) throw new Error('A search result could not be matched to its file. Search again.');
    return packet;
  }
  function accessChanged(failure) { return failure.status === 403 || ['project_grant_changed','project_root_changed','project_binding_changed'].includes(failure.code); }
  function loseAccess() { invalidate({ clearInputs: true }); unavailable = true; error = 'Folder access changed or is unavailable. Leave and choose the folder again before searching.'; render(); }
  function render() {
    if (closed) return; root.hidden = !selection; search.disabled = busy || !selection || unavailable; search.textContent = busy ? 'Reading…' : 'Search'; more.hidden = !session?.scanHasMore || !session?.nextCursor || stopped; more.disabled = busy; stopButton.hidden = !busy && (!session?.scanHasMore || stopped); errors.textContent = error;
    if (busy) status.textContent = matches.length ? 'Reading the next part of this search… ' + matches.length + ' matches already shown.' : 'Reading the chosen folder for this literal text…';
    else if (!session) status.textContent = stopped ? 'Search stopped before a page was returned. No more reading is requested here.' : 'No search has run here. Enter text, then choose Search.';
    else {
      const scan = session.scanned, skips = Object.values(session.skipped).reduce((sum, value) => sum + value, 0);
      const ending = stopped ? 'Stopped here; returned results are kept.' : session.scanHasMore ? 'More of the folder remains. Load more to continue.' : session.complete ? skips ? 'The permitted scan finished; some files were skipped.' : 'The permitted scan finished.' : 'The scan is incomplete' + (session.stopReason ? ': ' + String(session.stopReason).replaceAll('_', ' ') : '.') + '.';
      status.textContent = matches.length + ' matching results shown · ' + scan.files + ' files examined · ' + scan.directories + ' folders · ' + scan.entries + ' entries · ' + scan.bytes + ' bytes. ' + ending + ' Results are live reads, not a folder snapshot.';
    }
    skipped.textContent = session ? 'Skipped: ' + session.skipped.protected + ' protected · ' + session.skipped.unavailable + ' unavailable · ' + session.skipped.binary + ' binary · ' + session.skipped.oversized + ' oversized. Read through ' + timeLabel(session.observedAt) + '.' : ''; skipped.hidden = !session;
    results.replaceChildren();
    for (const hit of matches) {
      const row = node('article', 'project-file-row'), body = node('div'), open = button(hit.path + ' · line ' + hit.line + ', column ' + hit.column, () => openHit(hit)); open.setAttribute('aria-label', 'Open search result: ' + hit.path + ' at line ' + hit.line + ', column ' + hit.column); body.append(open, node('p', 'project-hint', hit.snippet)); if (hit.snippetTruncated) body.append(node('small', 'project-hint', 'Snippet shortened; open the hash-checked file to read more.')); row.append(body); results.append(row);
    }
    if (session && !matches.length && !busy) results.append(node('p', 'project-hint', stopped || !session.complete || Object.values(session.skipped).some(count => count > 0) ? 'No matches in the text read so far. This does not establish that the whole project has no matches.' : 'No matches in the permitted readable text.'));
  }
  async function readPage(continuation) {
    if (closed || !selection || unavailable || busy) return;
    if (continuation && (!session?.scanHasMore || !session.nextCursor || stopped)) return;
    if (!continuation) { if (!query.value.trim()) { error = 'Enter literal text to find.'; render(); return; } if (query.value.length > 200 || scope.value.length > 240) { error = 'Use at most 200 characters of text and a 240-character relative subfolder path.'; render(); return; } invalidate(); }
    const binding = copy(selection), stamp = generation, frozen = continuation ? { projectId: binding.projectId, grantEpoch: binding.grantEpoch, path: session.path, query: session.query, caseSensitive: session.caseSensitive } : { projectId: binding.projectId, grantEpoch: binding.grantEpoch, path: scope.value, query: query.value, caseSensitive: caseSensitive.checked === true };
    const controller = new AbortController(), entry = { controller }; active = entry; busy = true; stopped = false; error = ''; render();
    const params = new URLSearchParams(continuation ? { grantEpoch: String(binding.grantEpoch), searchId: session.searchId, cursor: session.nextCursor } : { grantEpoch: String(binding.grantEpoch), path: frozen.path, query: frozen.query, caseSensitive: String(frozen.caseSensitive) });
    try {
      const packet = await api('projects/' + binding.projectId + '/search?' + params, { signal: controller.signal }, 30000);
      if (!alive(binding, stamp) || active !== entry || controller.signal.aborted) { if (packet && same(packet, binding) && UUID.test(packet.searchId)) closeSession(packet); return; }
      validate(packet, frozen, continuation); if (!seen.has(packet.pageId)) { matches.push(...packet.matches.map(hit => ({ ...copy(hit), projectId: binding.projectId, grantEpoch: binding.grantEpoch, searchId: packet.searchId, selectionGeneration: stamp }))); seen.add(packet.pageId); } session = copy(packet);
    } catch (failure) {
      if (alive(binding, stamp) && active === entry && !controller.signal.aborted) { if (accessChanged(failure)) { loseAccess(); return; } error = [404, 410].includes(failure.status) ? 'This search is no longer available. Start a new search; it was not restarted automatically.' : failure.message; if ([403, 404, 409, 410].includes(failure.status) && session) { closeSession(session); session.nextCursor = null; session.scanHasMore = false; stopped = true; } }
    } finally { if (alive(binding, stamp) && active === entry) { active = null; busy = false; render(); } }
  }
  function stop() { if (closed) return; invalidate({ keepResults: true }); render(); }
  async function openHit(hit) {
    if (closed || unavailable || !same(hit, selection) || hit.selectionGeneration !== generation) return; openRequest?.controller.abort(); const controller = new AbortController(), ticket = ++openTicket, stamp = generation, binding = copy(selection), entry = { controller }; openRequest = entry; error = '';
    try { const opened = await onOpen({ projectId: binding.projectId, grantEpoch: binding.grantEpoch, path: hit.path, hash: hit.hash, searchId: hit.searchId, line: hit.line, column: hit.column }, { signal: controller.signal }); if (alive(binding, stamp) && ticket === openTicket && !controller.signal.aborted) notify(opened?.draft ? 'Your unsaved file draft was kept. This result refers to the saved text.' : 'Opened the hash-checked file. A long file may need more preview pages.'); }
    catch (failure) { if (alive(binding, stamp) && ticket === openTicket && !controller.signal.aborted) { if (accessChanged(failure)) { loseAccess(); return; } error = failure.status === 409 ? 'The file changed since this result was read. Search again or open it normally; this result was not opened without its original hash.' : failure.message; render(); } }
    finally { if (openRequest === entry) openRequest = null; }
  }
  render();
  return { selectionChanged, close() { if (closed) return; invalidate({ clearInputs: true }); closed = true; selection = null; matches = []; session = null; root.remove(); } };
}
