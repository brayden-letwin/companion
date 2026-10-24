const $ = id => document.getElementById(id);
let user = null, room = null, csrfToken = null, setupRequired = false;
let authMode = 'login', inviteToken = null, modalTarget = null;
let selectedPassage = null, selectedThread = null, filter = 'all';
let busy = false, pendingOperation = null, connected = false;
let pollTimer = null, pollPending = false, sessionGeneration = 0, toastTimer;
let renderedDraftKey = null, lastScrolledPassage = null, questionDraft = null;
const drafts = new Map(), controllers = new Set();
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('companion-room-account') : null;
function readInviteFragment() {
  try { const token = new URLSearchParams(location.hash.slice(1)).get('invite'); return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null; }
  catch { return null; }
}
inviteToken = readInviteFragment();

function el(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text, className, action, write = false) {
  const result = el('button', className, text); result.type = 'button';
  result.addEventListener('click', () => {
    if (write && (busy || pendingOperation)) { toast('Finish the pending request before making another change.'); return; }
    action();
  });
  return result;
}
function member(id) { return room?.members.find(p => p.id === id) || { name: 'Former member', role: 'member' }; }
function initials(name) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(); }
function avatar(id) { return el('span', 'avatar', initials(member(id).name)); }
function dateLabel(value) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function activeThread() { return room?.threads.find(t => t.id === selectedThread); }
function draftKey(threadId) { return `${user.id}:${threadId}`; }
function toast(message) { $('room-toast').textContent = message; $('room-toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('room-toast').hidden = true; }, 6000); }
function connection(message, warning = false) { $('connection-status').textContent = message; $('connection-status').classList.toggle('connection-warning', warning); }
function setBusy(value) {
  busy = value;
  const locked = value || Boolean(pendingOperation);
  document.querySelectorAll('#room-view form input,#room-view form select,#room-view form textarea,#room-view form button[type="submit"],dialog form input,dialog form select,dialog form textarea,dialog form button[type="submit"]').forEach(control => { control.disabled = locked; });
  for (const id of ['new-question', 'create-invite']) $(id).disabled = locked;
  $('retry-operation').hidden = !pendingOperation || value;
  checkModalRevision();
}

async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const controller = new AbortController(); controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    let response;
    try { response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal }); }
    catch { const error = new Error(controller.signal.aborted ? 'The local server did not answer in time.' : 'The local server is unavailable.'); error.transport = true; throw error; }
    let data;
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error();
      data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { const error = new Error('The shared room returned an unreadable response. Reconnect to confirm its response.'); error.transport = true; throw error; }
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'The request could not be completed.');
      error.status = response.status; error.code = data.error?.code; error.room = data.room; throw error;
    }
    return data;
  } finally { clearTimeout(timer); controllers.delete(controller); }
}

function showAuth() {
  $('auth-view').hidden = false; $('room-view').hidden = true;
  authMode = setupRequired ? 'setup' : inviteToken ? 'join' : 'login';
  renderAuth();
}
function renderAuth() {
  const setup = authMode === 'setup', join = authMode === 'join';
  $('auth-heading').textContent = setup ? 'Start your reading room.' : join ? 'Join the reading room.' : 'Welcome back.';
  $('auth-description').textContent = setup ? 'Create the group and your facilitator account. You can invite members once you are inside.' : join ? 'Your invitation creates one member account. Choose the name and password you will use to sign in.' : 'Sign in with the member name and password you chose for this local room.';
  $('group-name-field').hidden = !setup; $('group-name').required = setup;
  $('account-password').minLength = setup || join ? 12 : 1;
  $('account-password').autocomplete = setup || join ? 'new-password' : 'current-password';
  $('password-note').textContent = setup || join ? 'Use at least 12 characters.' : '';
  $('auth-submit').textContent = setup ? 'Create reading room ↗' : join ? 'Join reading room ↗' : 'Sign in ↗';
  $('auth-fields').hidden = false; $('auth-switch').hidden = setup || !inviteToken;
  $('auth-switch').textContent = join ? 'Use an existing account instead' : 'Join with this invitation instead';
  $('retry-session').hidden = true;
}
function clearSession(message = '') {
  sessionGeneration += 1; clearTimeout(pollTimer); pollTimer = null;
  controllers.forEach(controller => controller.abort());
  user = null; room = null; csrfToken = null; connected = false; pendingOperation = null; busy = false;
  drafts.clear(); questionDraft = null; renderedDraftKey = null; selectedThread = null; selectedPassage = null; lastScrolledPassage = null;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); modalTarget = null;
  $('invite-link').value = ''; $('invite-result').hidden = true; $('account-password').value = '';
  $('new-question-text').value = ''; $('contribution-text').value = ''; $('review-note').value = ''; $('edit-text').value = ''; $('resolution-summary').value = '';
  $('thread-content').replaceChildren(); $('question-list').replaceChildren(); $('paper-passages').replaceChildren();
  $('account-name').textContent = ''; $('account-role').textContent = ''; $('account-avatar').textContent = '';
  $('auth-error').textContent = message; showAuth();
}
async function beginSession(data) {
  user = data.user; csrfToken = data.csrfToken; setupRequired = false; sessionGeneration += 1;
  $('account-password').value = ''; $('auth-error').textContent = '';
  if (inviteToken) { inviteToken = null; history.replaceState(null, '', location.pathname + location.search); }
  const nextRoom = data.room || await api('/api/room');
  $('auth-view').hidden = true; $('room-view').hidden = false;
  applyRoom(nextRoom);
  connected = true; connection('Connected · saved to this local reading room'); schedulePoll();
}
async function loadSession() {
  $('retry-session').hidden = true; $('auth-error').textContent = '';
  try {
    const data = await api('/api/session'); setupRequired = Boolean(data.setupRequired);
    if (data.user) await beginSession(data); else showAuth();
  } catch (error) {
    $('auth-view').hidden = false; $('room-view').hidden = true; $('auth-fields').hidden = true;
    $('auth-heading').textContent = 'Connect to your reading room.';
    $('auth-description').textContent = 'This page needs the local shared-room server. Start it on this computer, then reconnect.';
    $('auth-error').textContent = error.message; $('retry-session').hidden = false;
  }
}
function schedulePoll() { clearTimeout(pollTimer); if (user) pollTimer = setTimeout(() => pollRoom(), 2000); }
async function pollRoom(force = false) {
  if (!user || pollPending || busy || (!force && document.visibilityState === 'hidden')) { schedulePoll(); return; }
  pollPending = true; const generation = sessionGeneration;
  try {
    const session = await api('/api/session');
    if (generation !== sessionGeneration) return;
    if (!session.user) { clearSession('Your session ended in another tab. Sign in again to continue.'); return; }
    if (session.user.id !== user.id) {
      clearSession(); await beginSession(session);
      toast('The signed-in member changed in another tab. Earlier private drafts have been cleared.'); return;
    }
    user = session.user; csrfToken = session.csrfToken;
    const next = await api('/api/room');
    if (generation !== sessionGeneration) return;
    applyRoom(next); connected = true;
    connection(pendingOperation ? 'The room is refreshed. Retry sending to confirm the pending change.' : 'Connected · saved to this local reading room');
  } catch (error) {
    if (generation !== sessionGeneration) return;
    if (error.status === 401) clearSession('Your session ended. Sign in again to continue.');
    else { connected = false; connection('Connection lost · your unsent drafts stay in this tab. Reconnecting…', true); }
  } finally { pollPending = false; schedulePoll(); }
}
function applyRoom(next) {
  if (!user || !next || !Number.isInteger(next.revision) || !Array.isArray(next.threads) || !next.paper?.passages || !Array.isArray(next.members)) throw new Error('The room data is invalid.');
  if (room && next.revision < room.revision) return;
  const changed = !room || room.revision !== next.revision;
  room = next;
  $('member-count').textContent = `${room.members.length} ${room.members.length === 1 ? 'member' : 'members'}`;
  if (changed) renderRoom(); else checkModalRevision();
}

async function sendOperation(operation, onSuccess) {
  if (!user || !room) throw new Error('Sign in before contributing.');
  if (pendingOperation || busy) throw new Error('Finish the pending request before making another change.');
  pendingOperation = { payload: { operationId: crypto.randomUUID(), expectedRevision: room.revision, ...operation }, userId: user.id, onSuccess };
  return executePending();
}
async function executePending() {
  const pending = pendingOperation;
  if (!pending || busy || !user || user.id !== pending.userId) return;
  setBusy(true); const generation = sessionGeneration;
  try {
    const result = await api('/api/operations', { method: 'POST', body: pending.payload });
    if (generation !== sessionGeneration || pendingOperation !== pending) return;
    pendingOperation = null; applyRoom(result.room || result); connected = true;
    pending.onSuccess?.(result.room || result);
    connection('Connected · your change is saved');
  } catch (error) {
    if (generation !== sessionGeneration) return;
    if (error.status === 401) { clearSession('Your session ended. Sign in again to continue.'); return; }
    if (error.transport || error.status >= 500) {
      connected = false; connection('Sending was interrupted. Retry to confirm this exact change; it will not be posted twice.', true);
      // Retain this exact ID and payload until the server confirms its receipt.
    } else {
      pendingOperation = null;
      if (error.room) applyRoom(error.room);
      if (error.status === 409) error.message = 'The room changed. Your draft is still here. Review the latest discussion, then send again.';
      connection(error.message, true);
    }
    throw error;
  } finally { setBusy(false); schedulePoll(); }
}

function visibleThreads() { return room.threads.filter(t => filter === 'open' ? t.status !== 'resolved' : filter === 'passage' ? t.passageId === selectedPassage : true); }
function choosePassage(id) { selectedPassage = id; filter = 'passage'; selectedThread = room.threads.find(t => t.passageId === id)?.id || null; renderRoom(); }
function chooseThread(thread) { selectedThread = thread.id; selectedPassage = thread.passageId; renderRoom(); }
function scrollPassage(id) {
  const paper = document.querySelector('.group-paper'), target = $('passage-' + id);
  if (target) paper.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - paper.getBoundingClientRect().top + paper.scrollTop - 12), behavior: 'auto' });
}
function currentReview(contribution) { const reviews = contribution.reviews.filter(r => r.revision === contribution.revision); return reviews.some(r => r.status === 'correction') ? 'correction' : reviews.some(r => r.status === 'reviewed') ? 'reviewed' : 'unreviewed'; }
function renderRoom() {
  if (!room || !user) return;
  if (!selectedPassage || !room.paper.passages.some(p => p.id === selectedPassage)) selectedPassage = room.paper.passages[0]?.id;
  const visible = visibleThreads();
  if (!visible.some(t => t.id === selectedThread)) { selectedThread = visible[0]?.id || null; if (visible[0]) selectedPassage = visible[0].passageId; }
  $('room-group-name').textContent = room.group.name; $('paper-breadcrumb').textContent = room.paper.title;
  $('paper-title').textContent = room.paper.title; $('paper-heading').textContent = room.paper.title;
  $('paper-version').textContent = room.paper.version || 'ORIGINAL SAMPLE';
  $('account-name').textContent = user.name; $('account-role').textContent = user.role === 'admin' ? 'Facilitator' : 'Member'; $('account-avatar').textContent = initials(user.name);
  $('invite-members').hidden = user.role !== 'admin';
  renderPaper(); renderQuestions(visible); renderThread(); checkModalRevision(); setBusy(busy);
}
function renderPaper() {
  const nav = document.createDocumentFragment(), paper = document.createDocumentFragment();
  for (const passage of room.paper.passages) {
    const navButton = button('', passage.id === selectedPassage ? 'active' : '', () => choosePassage(passage.id));
    navButton.setAttribute('aria-pressed', String(passage.id === selectedPassage)); navButton.append(el('span', '', passage.number), document.createTextNode(passage.label)); nav.append(navButton);
    const passageButton = button('', `paper-passage${passage.id === selectedPassage ? ' selected' : ''}`, () => choosePassage(passage.id)); passageButton.id = 'passage-' + passage.id;
    passageButton.setAttribute('aria-label', `${passage.label}: show passage discussion`); passageButton.setAttribute('aria-pressed', String(passage.id === selectedPassage));
    const heading = el('span', 'passage-title'), label = el('span'); label.append(el('b', '', passage.number), document.createTextNode(passage.label)); heading.append(label);
    const count = room.threads.filter(t => t.passageId === passage.id).length; if (count) heading.append(el('span', 'passage-count', `${count} ${count === 1 ? 'question' : 'questions'}`));
    passageButton.append(heading, el('span', 'passage-text', passage.text)); paper.append(passageButton);
  }
  $('passage-nav').replaceChildren(nav); $('paper-passages').replaceChildren(paper);
  if (selectedPassage !== lastScrolledPassage) { lastScrolledPassage = selectedPassage; requestAnimationFrame(() => scrollPassage(selectedPassage)); }
}
function renderQuestions(visible) {
  $('question-count').textContent = room.threads.length; $('open-count').textContent = room.threads.filter(t => t.status !== 'resolved').length;
  for (const [id, value] of [['filter-all', 'all'], ['filter-open', 'open'], ['filter-passage', 'passage']]) { $(id).classList.toggle('active', filter === value); $(id).setAttribute('aria-pressed', String(filter === value)); }
  const fragment = document.createDocumentFragment();
  for (const thread of visible) {
    const option = button('', `question-option ${thread.status}${thread.id === selectedThread ? ' active' : ''}`, () => chooseThread(thread)); option.setAttribute('aria-pressed', String(thread.id === selectedThread));
    const count = thread.contributions.length; option.append(el('span'), el('strong', '', thread.question), el('small', '', thread.status === 'resolved' ? 'Resolved' : `${count} ${count === 1 ? 'reply' : 'replies'}`)); fragment.append(option);
  }
  if (!visible.length) fragment.append(el('p', 'empty-list', filter === 'passage' ? 'No questions on this passage yet. Yours can be the first.' : 'No questions yet. Bring the first thought into the room.'));
  $('question-list').replaceChildren(fragment);
}
function renderContribution(thread, contribution) {
  const card = el('article', 'contribution-card'), by = el('div', 'contribution-byline');
  by.append(avatar(contribution.author), el('strong', '', member(contribution.author).name), el('span', 'contribution-kind', contribution.kind));
  const status = currentReview(contribution), labels = { reviewed: 'Reviewed · this revision', correction: 'Needs correction', unreviewed: 'Unreviewed' };
  const actions = el('div', 'contribution-actions');
  if (thread.author === user.id) {
    const helped = contribution.helped.includes(user.id), action = button(helped ? '✓ Helped me' : 'Helped me', helped ? 'helped' : '', () => {
      sendOperation({ type: 'markHelped', threadId: thread.id, contributionId: contribution.id }, () => toast('Your understanding was noted separately from mathematical review.')).catch(error => toast(error.message));
    }, true); action.setAttribute('aria-pressed', String(helped)); actions.append(action);
  }
  if (contribution.author !== user.id) actions.append(button('Review', '', () => showReview(thread, contribution), true));
  if (contribution.author === user.id) actions.append(button('Edit', '', () => showEdit(thread, contribution), true));
  actions.append(button('History', '', () => showHistory(thread, contribution.id)), el('span', 'revision-label', `r${contribution.revision}`));
  card.append(by, el('span', `review-badge ${status}`, labels[status]), el('p', '', contribution.text), actions);
  for (const review of contribution.reviews.filter(r => r.revision === contribution.revision).slice(-2)) card.append(el('div', 'review-note', `${member(review.actor).name} ${review.status === 'reviewed' ? 'reviewed' : 'requested a correction to'} r${review.revision}: ${review.note}`));
  if (contribution.helped.length && thread.author !== user.id) card.append(el('div', 'review-note', `Helped ${member(thread.author).name} understand · this is separate from mathematical review`));
  return card;
}
function renderThread() {
  const thread = activeThread(), previousTop = $('thread-content').scrollTop;
  $('contribution-form').hidden = !thread;
  if (!thread) { $('thread-content').replaceChildren(el('div', 'empty-state', 'Every useful discussion starts with something somebody is wondering.')); renderedDraftKey = null; return; }
  const fragment = document.createDocumentFragment(), origin = el('div', 'question-origin');
  origin.append(avatar(thread.author), el('span', '', `${member(thread.author).name} asked`), el('span', `state-pill ${thread.status}`, thread.status));
  const source = thread.source || room.paper.passages.find(p => p.id === thread.passageId);
  const sourceButton = button('', 'source-chip', () => { selectedPassage = thread.passageId; renderPaper(); scrollPassage(selectedPassage); });
  sourceButton.append(el('span', '', `§${source.number || ''} ${source.label || 'Source passage'} · page ${source.page || 1}`), el('span', '', '↗'));
  const controls = el('div', 'thread-controls');
  controls.append(button(thread.reviewRequested ? 'Review requested ✓' : 'Request a review', '', () => sendOperation({ type: 'requestReview', threadId: thread.id }, () => toast('Mathematical review requested.')).catch(error => toast(error.message)), true), button('History', '', () => showHistory(thread)));
  if (thread.status === 'resolved') controls.append(button('Reopen question', 'resolution', () => showResolution(thread, true), true));
  else if (thread.author === user.id || user.role === 'admin') { const resolve = button('Mark resolved', 'resolution', () => showResolution(thread, false), true); resolve.disabled = !thread.contributions.length; controls.append(resolve); }
  fragment.append(origin, el('h3', 'thread-question', thread.question), sourceButton, controls);
  if (thread.reviewRequested) fragment.append(el('div', 'review-requested', 'Mathematical review has been requested for this discussion.'));
  if (thread.status === 'resolved' && thread.resolutions?.length) {
    const resolution = thread.resolutions.at(-1), linked = thread.contributions.find(c => c.id === resolution.contributionId), box = el('div', 'resolution-summary');
    box.append(document.createTextNode(`${resolution.actor === user.id ? 'Your' : member(resolution.actor).name + '’s'} resolution: ${resolution.summary}`));
    box.append(el('small', '', `Linked to ${linked ? member(linked.author).name + '’s contribution' : 'an earlier contribution'}, r${resolution.contributionRevision}.${linked && linked.revision !== resolution.contributionRevision ? ` The contribution is now r${linked.revision}; this summary keeps its original reference.` : ''}`)); fragment.append(box);
  }
  fragment.append(el('p', 'question-caption', '“Helped me” records understanding. A review records a mathematical check. Resolving a question keeps the two signals separate.'));
  if (!thread.contributions.length) fragment.append(el('div', 'empty-state', 'A clear question is already useful. Add the first explanation, example, or missing step.'));
  thread.contributions.forEach(contribution => fragment.append(renderContribution(thread, contribution)));
  const key = draftKey(thread.id), changed = renderedDraftKey !== key;
  $('thread-content').replaceChildren(fragment); $('thread-content').scrollTop = changed ? 0 : previousTop;
  if (changed) { const draft = drafts.get(key); $('contribution-text').value = draft?.text || ''; $('contribution-kind').value = draft?.kind || 'Explanation'; renderedDraftKey = key; }
  $('contributing-as').textContent = `Posting as ${user.name}`;
}

function clearErrors() { for (const id of ['question-error', 'review-error', 'edit-error', 'resolution-error', 'invite-error']) $(id).textContent = ''; }
function openDialog(id, target) { if (busy || pendingOperation) { toast('Finish the pending request first.'); return false; } clearErrors(); modalTarget = { ...target, userId: user.id }; setBusy(false); $(id).showModal(); return true; }
function closeTargetDialog(id, target) { if (modalTarget === target) { $(id).close(); modalTarget = null; } }
function checkModalRevision() {
  if (!modalTarget || !user || !room) return;
  if (modalTarget.userId !== user.id) { document.querySelectorAll('dialog[open]').forEach(d => d.close()); modalTarget = null; return; }
  if (!modalTarget.contributionId || !modalTarget.revision) return;
  const contribution = room.threads.find(t => t.id === modalTarget.threadId)?.contributions.find(c => c.id === modalTarget.contributionId);
  if (!contribution || contribution.revision !== modalTarget.revision) {
    const errorId = modalTarget.mode === 'edit' ? 'edit-error' : modalTarget.mode === 'review' ? 'review-error' : 'resolution-error';
    $(errorId).textContent = 'This contribution changed while you were writing. Your draft is still here. Close and reopen the current revision before sending.';
    $(modalTarget.dialogId).querySelector('button[type="submit"]').disabled = true;
  }
}
function assertTarget(target) {
  if (!target || !user || target.userId !== user.id) throw new Error('The signed-in member changed. Open this form again.');
  const thread = room.threads.find(t => t.id === target.threadId);
  if (target.threadId && !thread) throw new Error('This question is no longer available.');
  if (target.contributionId) { const contribution = thread.contributions.find(c => c.id === target.contributionId); if (!contribution || contribution.revision !== target.revision) throw new Error('This contribution changed. Your draft is still here; close and reopen the current revision.'); }
  return thread;
}
function showQuestion() {
  const passage = questionDraft?.passageId || selectedPassage || room.paper.passages[0]?.id;
  $('question-passage').replaceChildren(...room.paper.passages.map(p => { const option = el('option', '', `§${p.number} ${p.label}`); option.value = p.id; return option; }));
  $('question-passage').value = passage; $('question-source').textContent = room.paper.passages.find(p => p.id === passage)?.text || '';
  $('new-question-text').value = questionDraft?.text || ''; $('question-author').textContent = `As ${user.name}`;
  if (openDialog('question-dialog', { mode: 'question', dialogId: 'question-dialog' })) $('new-question-text').focus();
}
function showReview(thread, contribution) {
  $('review-target').textContent = `${member(contribution.author).name}’s ${contribution.kind.toLowerCase()}, revision ${contribution.revision}`;
  $('review-text').textContent = contribution.text; $('review-result').value = 'reviewed'; $('review-note').value = ''; $('review-author').textContent = `As ${user.name}`;
  openDialog('review-dialog', { mode: 'review', dialogId: 'review-dialog', threadId: thread.id, contributionId: contribution.id, revision: contribution.revision });
}
function showEdit(thread, contribution) {
  $('edit-text').value = contribution.text; $('edit-author').textContent = `As ${user.name}`;
  openDialog('edit-dialog', { mode: 'edit', dialogId: 'edit-dialog', threadId: thread.id, contributionId: contribution.id, revision: contribution.revision });
}
function showResolution(thread, reopening) {
  $('resolution-heading').textContent = reopening ? 'What needs another look?' : 'What made it click?'; $('resolution-link-field').hidden = reopening;
  $('resolution-summary-label').textContent = reopening ? 'Reason for reopening' : 'Your understanding, in a sentence'; $('resolution-summary').maxLength = reopening ? 240 : 600; $('resolution-summary').value = '';
  $('resolution-submit').textContent = reopening ? 'Reopen question' : 'Mark resolved'; $('resolution-author').textContent = `As ${user.name}`;
  $('resolution-note').textContent = reopening ? 'The earlier resolution stays in history. Say what is unclear, missing, or newly questioned.' : 'A resolution records the understanding reached, with a link to one contribution revision.';
  $('resolution-link').replaceChildren(...thread.contributions.map(c => { const option = el('option', '', `${member(c.author).name} · ${c.kind} · r${c.revision}`); option.value = c.id; return option; }));
  const contribution = thread.contributions[0];
  openDialog('resolution-dialog', { mode: 'resolution', dialogId: 'resolution-dialog', threadId: thread.id, reopening, ...(reopening ? {} : { contributionId: contribution?.id, revision: contribution?.revision }) });
}
function showHistory(thread, contributionId = null) {
  const fragment = document.createDocumentFragment();
  if (!contributionId) {
    fragment.append(el('p', 'form-note', thread.question));
    for (const event of thread.events.slice().reverse()) { const item = el('div', 'history-entry'); item.append(el('strong', '', `${member(event.actor).name} · ${event.action}`), el('small', '', dateLabel(event.at))); fragment.append(item); }
    for (const resolution of (thread.resolutions || []).slice().reverse()) { const item = el('div', 'history-entry'); item.append(el('strong', '', `Resolution by ${member(resolution.actor).name}`), el('p', '', resolution.summary), el('small', '', `Linked contribution ${resolution.contributionId.slice(0, 12)}, revision ${resolution.contributionRevision} · ${dateLabel(resolution.at)}`)); fragment.append(item); }
  } else {
    const contribution = thread.contributions.find(c => c.id === contributionId);
    fragment.append(el('p', 'form-note', `${member(contribution.author).name} · ${contribution.kind}. Reviews stay with the text they checked.`));
    for (const revision of [{ revision: contribution.revision, text: contribution.text }, ...contribution.revisions.slice().reverse()]) { const item = el('div', 'history-entry'); item.append(el('strong', '', `Revision ${revision.revision}${revision.revision === contribution.revision ? ' · current' : ''}`), el('p', '', revision.text)); for (const review of contribution.reviews.filter(r => r.revision === revision.revision)) item.append(el('div', 'review-note', `${member(review.actor).name} · ${review.status === 'reviewed' ? 'Reviewed' : 'Needs correction'}: ${review.note}`)); fragment.append(item); }
  }
  $('history-content').replaceChildren(fragment); openDialog('history-dialog', { mode: 'history', dialogId: 'history-dialog' });
}

$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('auth-submit').disabled) return;
  $('auth-submit').disabled = true; $('auth-switch').disabled = true; $('auth-error').textContent = '';
  try {
    const body = { displayName: $('display-name').value, password: $('account-password').value };
    if (authMode === 'setup') body.groupName = $('group-name').value;
    if (authMode === 'join') body.inviteToken = inviteToken;
    const result = await api(`/api/${authMode}`, { method: 'POST', body }); await beginSession(result); accountChannel?.postMessage({ type: 'session-changed' });
  } catch (error) { $('auth-error').textContent = error.message; if (error.code === 'setup_complete') { setupRequired = false; authMode = inviteToken ? 'join' : 'login'; renderAuth(); } }
  finally { $('auth-submit').disabled = false; $('auth-switch').disabled = false; }
});
$('auth-switch').addEventListener('click', () => { authMode = authMode === 'join' ? 'login' : 'join'; $('account-password').value = ''; $('auth-error').textContent = ''; renderAuth(); });
$('retry-session').addEventListener('click', loadSession);
$('sign-out').addEventListener('click', async () => { if (busy) return; try { await api('/api/logout', { method: 'POST', body: {} }); clearSession(); accountChannel?.postMessage({ type: 'session-changed' }); } catch (error) { toast(error.message); } });
$('refresh-room').addEventListener('click', () => pollRoom(true));
$('retry-operation').addEventListener('click', () => executePending().catch(error => toast(error.message)));
for (const [id, value] of [['filter-all', 'all'], ['filter-open', 'open'], ['filter-passage', 'passage']]) $(id).addEventListener('click', () => { filter = value; renderRoom(); });
$('new-question').addEventListener('click', showQuestion);
function rememberQuestion() { questionDraft = { text: $('new-question-text').value, passageId: $('question-passage').value }; }
$('new-question-text').addEventListener('input', rememberQuestion);
$('question-passage').addEventListener('change', () => { $('question-source').textContent = room.paper.passages.find(p => p.id === $('question-passage').value)?.text || ''; rememberQuestion(); });
$('new-question-form').addEventListener('submit', async event => {
  event.preventDefault(); const target = modalTarget;
  try {
    assertTarget(target); const question = $('new-question-text').value, passageId = $('question-passage').value, before = new Set(room.threads.map(t => t.id));
    await sendOperation({ type: 'addQuestion', question, passageId }, next => { questionDraft = null; const added = next.threads.find(t => !before.has(t.id) && t.author === user.id && t.question === question.trim()); if (added) { selectedThread = added.id; selectedPassage = added.passageId; filter = 'all'; } closeTargetDialog('question-dialog', target); renderRoom(); toast('Question shared with the reading room.'); });
  } catch (error) { $('question-error').textContent = error.message; }
});
function rememberDraft() { const thread = activeThread(); if (thread && user) drafts.set(draftKey(thread.id), { text: $('contribution-text').value, kind: $('contribution-kind').value }); }
$('contribution-text').addEventListener('input', rememberDraft); $('contribution-kind').addEventListener('change', rememberDraft);
$('contribution-form').addEventListener('submit', async event => {
  event.preventDefault(); const thread = activeThread(); if (!thread) return;
  const key = draftKey(thread.id), text = $('contribution-text').value, kind = $('contribution-kind').value;
  try { await sendOperation({ type: 'addContribution', threadId: thread.id, kind, text }, () => { drafts.delete(key); if (activeThread()?.id === thread.id) { renderedDraftKey = null; renderThread(); $('thread-content').scrollTop = $('thread-content').scrollHeight; } toast('Contribution shared. It starts unreviewed.'); }); } catch (error) { toast(error.message); }
});
$('review-form').addEventListener('submit', async event => {
  event.preventDefault(); const target = modalTarget;
  try { assertTarget(target); await sendOperation({ type: 'reviewContribution', threadId: target.threadId, contributionId: target.contributionId, contributionRevision: target.revision, status: $('review-result').value, note: $('review-note').value }, () => { closeTargetDialog('review-dialog', target); toast('Review saved for that exact revision.'); }); } catch (error) { $('review-error').textContent = error.message; checkModalRevision(); }
});
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault(); const target = modalTarget;
  try { assertTarget(target); await sendOperation({ type: 'editContribution', threadId: target.threadId, contributionId: target.contributionId, contributionRevision: target.revision, text: $('edit-text').value }, () => { closeTargetDialog('edit-dialog', target); toast('New revision saved. Earlier reviews stay in history.'); }); } catch (error) { $('edit-error').textContent = error.message; checkModalRevision(); }
});
$('resolution-link').addEventListener('change', () => { if (!modalTarget || modalTarget.reopening) return; const contribution = room.threads.find(t => t.id === modalTarget.threadId)?.contributions.find(c => c.id === $('resolution-link').value); modalTarget.contributionId = contribution?.id; modalTarget.revision = contribution?.revision; checkModalRevision(); });
$('resolution-form').addEventListener('submit', async event => {
  event.preventDefault(); const target = modalTarget;
  try {
    assertTarget(target); const operation = target.reopening ? { type: 'reopenQuestion', threadId: target.threadId, reason: $('resolution-summary').value } : { type: 'resolveQuestion', threadId: target.threadId, contributionId: target.contributionId, contributionRevision: target.revision, summary: $('resolution-summary').value };
    await sendOperation(operation, () => { closeTargetDialog('resolution-dialog', target); toast(target.reopening ? 'Question reopened. Earlier resolutions stay in history.' : 'Resolution saved with its linked explanation.'); });
  } catch (error) { $('resolution-error').textContent = error.message; checkModalRevision(); }
});
$('invite-members').addEventListener('click', () => { $('invite-result').hidden = true; $('invite-link').value = ''; openDialog('invite-dialog', { mode: 'invite', dialogId: 'invite-dialog' }); });
$('create-invite').addEventListener('click', async () => {
  if (busy || pendingOperation) return; $('create-invite').disabled = true; $('invite-error').textContent = '';
  const generation = sessionGeneration;
  try { const result = await api('/api/invites', { method: 'POST', body: {} }); if (generation !== sessionGeneration) return; $('invite-link').value = result.inviteUrl; $('invite-expires').textContent = `One use · expires ${dateLabel(result.expiresAt)}`; $('invite-result').hidden = false; }
  catch (error) { if (error.status === 401) clearSession('Sign in again to manage invitations.'); else $('invite-error').textContent = error.message; }
  finally { $('create-invite').disabled = false; }
});
$('copy-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('invite-link').value); toast('Invitation copied. Share it yourself; it currently works only on this PC.'); } catch { $('invite-link').focus(); $('invite-link').select(); toast('Select and copy the invitation link.'); } });
document.querySelectorAll('.close-dialog').forEach(control => control.addEventListener('click', () => { control.closest('dialog').close(); }));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { if (modalTarget?.dialogId === dialog.id) modalTarget = null; if (dialog.id === 'invite-dialog') { $('invite-link').value = ''; $('invite-result').hidden = true; } }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && user) pollRoom(true); });
window.addEventListener('hashchange', () => {
  if (user) return;
  inviteToken = readInviteFragment();
  $('account-password').value = ''; $('auth-error').textContent = '';
  if (!$('auth-fields').hidden) { authMode = setupRequired ? 'setup' : inviteToken ? 'join' : 'login'; renderAuth(); }
});
accountChannel?.addEventListener('message', event => { if (event.data?.type === 'session-changed' && user) pollRoom(true); });
window.addEventListener('beforeunload', () => { clearTimeout(pollTimer); controllers.forEach(controller => controller.abort()); accountChannel?.close(); });
await loadSession();
