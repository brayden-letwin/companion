import { PEOPLE, PAPER, PASSAGES, createDemo, restoreState, reviewStatus, addQuestion, addContribution, editContribution, reviewContribution, markHelped, requestReview, setThreadStatus } from './core/discussion.mjs';

const $ = id => document.getElementById(id);
const STORAGE = 'companion.group-discussion.v1';
let model;
let actor = 'you';
let selectedPassage = 'bound';
let selectedThread = 'q-tail';
let filter = 'all';
let modalTarget = null;
let toastTimer;
let persistenceAvailable = true;
const contributionDrafts = new Map();
const draftKey = (actorId, threadId) => `${actorId}:${threadId}`;
let lastScrolledPassage = null;
try { model = restoreState(JSON.parse(localStorage.getItem(STORAGE))) || createDemo(); }
catch { model = createDemo(); persistenceAvailable = false; }

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text, className, action) {
  const result = element('button', className, text); result.type = 'button'; result.addEventListener('click', action); return result;
}
function participant(id) { return PEOPLE.find(p => p.id === id) || { name: 'AI draft', initials: 'AI' }; }
function byline(id) { return `${participant(id).name} · demo`; }
function avatar(id) { return element('span', `avatar${id === 'ai' ? ' ai' : ''}`, participant(id).initials); }
function dateLabel(value) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function toast(message) { $('group-toast').textContent = message; $('group-toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('group-toast').hidden = true; }, 5000); }
function fail(error) { toast(error.message || 'That change could not be made.'); }
function commit(next, message) {
  model = next;
  try { localStorage.setItem(STORAGE, JSON.stringify(model)); persistenceAvailable = true; }
  catch { persistenceAvailable = false; }
  render();
  if (message) toast(persistenceAvailable ? message : 'Changed for this session only. Browser storage is unavailable.');
}
function activeThread() { return model.threads.find(t => t.id === selectedThread); }
function visibleThreads() {
  return model.threads.filter(t => filter === 'open' ? t.status !== 'resolved' : filter === 'passage' ? t.passageId === selectedPassage : true);
}
function openDialog(id) { $('question-error').textContent = ''; $('review-error').textContent = ''; $('edit-error').textContent = ''; $('resolution-error').textContent = ''; $(id).showModal(); }
function choosePassage(id, focusQuestion = true) {
  selectedPassage = id; filter = 'passage';
  if (focusQuestion) selectedThread = model.threads.find(t => t.passageId === id)?.id || null;
  render();
}
function chooseThread(thread) { selectedThread = thread.id; selectedPassage = thread.passageId; render(); }
function scrollPassage(passageId, smooth = false) {
  const container = document.querySelector('.group-paper'), target = $('passage-' + passageId);
  if (!target) return;
  const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12;
  container.scrollTo({ top: Math.max(0, top), behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
}

function renderPaper() {
  const nav = document.createDocumentFragment(), paper = document.createDocumentFragment();
  for (const passage of PASSAGES) {
    const navButton = button('', passage.id === selectedPassage ? 'active' : '', () => choosePassage(passage.id));
    navButton.setAttribute('aria-pressed', String(passage.id === selectedPassage));
    navButton.append(element('span', '', passage.number), document.createTextNode(passage.label)); nav.append(navButton);
    const passageButton = button('', `paper-passage${passage.id === selectedPassage ? ' selected' : ''}`, () => choosePassage(passage.id));
    passageButton.id = `passage-${passage.id}`;
    passageButton.setAttribute('aria-label', `${passage.label}: show passage discussion`);
    passageButton.setAttribute('aria-pressed', String(passage.id === selectedPassage));
    const heading = element('span', 'passage-title'), label = element('span');
    label.append(element('b', '', passage.number), document.createTextNode(passage.label)); heading.append(label);
    const count = model.threads.filter(t => t.passageId === passage.id).length;
    if (count) heading.append(element('span', 'passage-count', `${count} ${count === 1 ? 'question' : 'questions'}`));
    passageButton.append(heading, element('span', 'passage-text', passage.text)); paper.append(passageButton);
  }
  $('passage-nav').replaceChildren(nav); $('paper-passages').replaceChildren(paper);
  if (lastScrolledPassage !== selectedPassage) {
    const smooth = lastScrolledPassage !== null, passageId = selectedPassage;
    lastScrolledPassage = passageId;
    requestAnimationFrame(() => { if (selectedPassage === passageId) scrollPassage(passageId, smooth); });
  }
}
function renderQuestionList() {
  const visible = visibleThreads();
  if (!visible.some(t => t.id === selectedThread)) {
    selectedThread = visible[0]?.id || null;
    if (visible[0]) selectedPassage = visible[0].passageId;
  }
  $('question-count').textContent = model.threads.length;
  $('open-count').textContent = model.threads.filter(t => t.status !== 'resolved').length;
  for (const [id, value] of [['filter-all', 'all'], ['filter-open', 'open'], ['filter-passage', 'passage']]) {
    $(id).classList.toggle('active', filter === value); $(id).setAttribute('aria-pressed', String(filter === value));
  }
  const fragment = document.createDocumentFragment();
  for (const thread of visible) {
    const option = button('', `question-option ${thread.status}${thread.id === selectedThread ? ' active' : ''}`, () => chooseThread(thread));
    option.setAttribute('aria-pressed', String(thread.id === selectedThread));
    option.append(element('span'), element('strong', '', thread.question), element('small', '', thread.status === 'resolved' ? 'Resolved' : `${thread.contributions.length} ${thread.contributions.length === 1 ? 'reply' : 'replies'}`));
    fragment.append(option);
  }
  if (!visible.length) fragment.append(element('p', 'empty-list', filter === 'passage' ? 'No questions on this passage yet. Yours could be the first.' : 'No questions in this view. Start a new thought.'));
  $('question-list').replaceChildren(fragment);
}
function renderContribution(thread, contribution) {
  const card = element('article', 'contribution-card');
  const by = element('div', 'contribution-byline'); by.append(avatar(contribution.author), element('strong', '', participant(contribution.author).name), element('span', '', contribution.ai ? 'Prepared AI-style example' : 'demo'), element('span', 'contribution-kind', contribution.kind));
  const currentReview = reviewStatus(contribution);
  const labels = { reviewed: 'Reviewed · this revision', correction: 'Needs correction', unreviewed: 'Unreviewed' };
  const reviewBadge = element('span', `review-badge ${currentReview}`, contribution.ai ? `AI draft · ${labels[currentReview]}` : labels[currentReview]);
  const actions = element('div', 'contribution-actions');
  if (thread.author === actor) {
    const helped = contribution.helped.includes(actor);
    const helpedButton = button(helped ? '✓ Helped me' : 'Helped me', helped ? 'helped' : '', () => { try { commit(markHelped(model, thread.id, contribution.id, actor), 'Understanding noted. This is separate from mathematical review.'); } catch (error) { fail(error); } });
    helpedButton.setAttribute('aria-pressed', String(helped)); actions.append(helpedButton);
  }
  if (contribution.author !== actor) actions.append(button('Review', '', () => showReview(thread, contribution)));
  if (contribution.author === actor && !contribution.ai) actions.append(button('Edit', '', () => showEdit(thread, contribution)));
  actions.append(button('History', '', () => showHistory(thread, contribution.id)), element('span', 'revision-label', `r${contribution.revision}`));
  card.append(by, reviewBadge, element('p', '', contribution.text), actions);
  const currentReviews = contribution.reviews.filter(r => r.revision === contribution.revision);
  for (const review of currentReviews.slice(-2)) card.append(element('div', 'review-note', `${byline(review.actor)} ${review.status === 'reviewed' ? 'reviewed' : 'requested a correction to'} r${review.revision}${review.note ? `: ${review.note}` : '.'}`));
  if (contribution.helped.length && thread.author !== actor) card.append(element('div', 'review-note', `Helped ${participant(thread.author).name} understand · this is not a mathematical review`));
  return card;
}
function renderThread() {
  const thread = activeThread();
  $('contribution-form').hidden = !thread;
  if (!thread) { $('thread-content').replaceChildren(element('div', 'empty-state', 'Every useful discussion starts with something somebody is wondering.')); return; }
  const fragment = document.createDocumentFragment(), origin = element('div', 'question-origin');
  origin.append(avatar(thread.author), element('span', '', `${byline(thread.author)} asked`), element('span', `state-pill ${thread.status}`, thread.status));
  const source = PASSAGES.find(p => p.id === thread.passageId);
  const sourceButton = button('', 'source-chip', () => {
    selectedPassage = thread.passageId; renderPaper(); scrollPassage(thread.passageId, true);
  });
  sourceButton.append(element('span', '', `§${source.number} ${source.label} · page 1`), element('span', '', '↗'));
  const controls = element('div', 'thread-controls');
  controls.append(button(thread.reviewRequested ? 'Review requested ✓' : 'Request a review', '', () => { try { commit(requestReview(model, thread.id, actor), 'Review requested. No contribution has been marked reviewed.'); } catch (error) { fail(error); } }));
  controls.append(button('History', '', () => showHistory(thread)));
  if (thread.author === actor) {
    const resolution = button(thread.status === 'resolved' ? 'Reopen question' : 'Mark resolved', 'resolution', () => showResolution(thread));
    resolution.disabled = thread.status !== 'resolved' && !thread.contributions.length;
    if (resolution.disabled) resolution.title = 'Add an explanation to link before resolving.';
    controls.append(resolution);
  }
  fragment.append(origin, element('h3', 'thread-question', thread.question), sourceButton, controls);
  if (thread.reviewRequested) fragment.append(element('p', 'review-requested', 'Mathematical review requested · check a contribution below.'));
  if (thread.status === 'resolved' && thread.resolutions.length) {
    const resolution = thread.resolutions.at(-1), contribution = thread.contributions.find(c => c.id === resolution.contributionId);
    fragment.append(element('div', 'review-note', `${thread.author === 'you' ? 'Your resolution' : `${participant(thread.author).name}’s resolution`}: ${resolution.summary}\nLinked to ${participant(contribution.author).name}’s contribution, r${resolution.contributionRevision}${contribution.revision !== resolution.contributionRevision ? ` (current text is r${contribution.revision})` : ''}.`));
  }
  fragment.append(element('p', 'question-caption', '“Helped me” records understanding. A review checks the mathematics. Resolving a question keeps that distinction.'));
  for (const contribution of thread.contributions) fragment.append(renderContribution(thread, contribution));
  if (!thread.contributions.length) fragment.append(element('div', 'empty-state', 'A clear question is already useful. Add the first explanation, example, or missing step.'));
  $('thread-content').replaceChildren(fragment);
  $('contributing-as').textContent = `Posting as ${byline(actor)}`;
  const draft = contributionDrafts.get(draftKey(actor, thread.id));
  $('contribution-text').value = draft?.text || '';
  $('contribution-kind').value = draft?.kind || 'Explanation';
}
function render() { renderQuestionList(); renderPaper(); renderThread(); $('actor-avatar').textContent = participant(actor).initials; }

function showQuestion() {
  modalTarget = { actor, passageId: selectedPassage };
  $('question-passage').value = selectedPassage; $('question-source').textContent = PASSAGES.find(p => p.id === selectedPassage).text;
  $('new-question-text').value = ''; $('question-author').textContent = `As ${byline(actor)}`;
  openDialog('question-dialog'); $('new-question-text').focus();
}
function showReview(thread, contribution) {
  modalTarget = { actor, threadId: thread.id, contributionId: contribution.id, revision: contribution.revision };
  $('review-target').textContent = `${participant(contribution.author).name}’s ${contribution.kind.toLowerCase()}, revision ${contribution.revision} · ${PAPER}`;
  $('review-text').textContent = contribution.text; $('review-result').value = 'reviewed'; $('review-note').value = '';
  $('review-author').textContent = `As ${byline(actor)}`; openDialog('review-dialog');
}
function showEdit(thread, contribution) {
  modalTarget = { actor, threadId: thread.id, contributionId: contribution.id, revision: contribution.revision };
  $('edit-text').value = contribution.text; $('edit-author').textContent = `As ${byline(actor)}`;
  openDialog('edit-dialog'); $('edit-text').focus();
}
function showResolution(thread) {
  const reopening = thread.status === 'resolved';
  modalTarget = { actor, threadId: thread.id, reopening };
  $('resolution-heading').textContent = reopening ? 'What needs another look?' : 'What made it click?';
  $('resolution-link-field').hidden = reopening;
  $('resolution-summary-label').textContent = reopening ? 'Reason for reopening' : 'Your understanding, in a sentence';
  $('resolution-summary').maxLength = reopening ? 240 : 600; $('resolution-summary').value = '';
  $('resolution-note').textContent = reopening ? 'The earlier resolution stays in the history. Say what is unclear, missing, or newly questioned.' : 'Resolution records your understanding of this question. It does not certify the linked contribution’s mathematics.';
  $('resolution-submit').textContent = reopening ? 'Reopen question' : 'Mark resolved';
  $('resolution-link').replaceChildren(...thread.contributions.map(c => { const option = element('option', '', `${participant(c.author).name} · ${c.kind} · r${c.revision}`); option.value = c.id; return option; }));
  const helped = thread.contributions.find(c => c.helped.includes(actor)); if (helped) $('resolution-link').value = helped.id;
  $('resolution-author').textContent = `As ${byline(actor)}`; openDialog('resolution-dialog'); $('resolution-summary').focus();
}
function showHistory(thread, contributionId = null) {
  const content = document.createDocumentFragment();
  if (!contributionId) {
    content.append(element('p', 'form-note', thread.question));
    for (const entry of thread.events.slice().reverse()) {
      const item = element('div', 'history-entry'); item.append(element('strong', '', `${participant(entry.actor).name} · ${entry.action}`), element('small', '', `${dateLabel(entry.at)} · demo`)); content.append(item);
    }
    for (const resolution of thread.resolutions.slice().reverse()) {
      const item = element('div', 'history-entry'); item.append(element('strong', '', `Resolution by ${participant(resolution.actor).name}`), element('p', '', resolution.summary), element('small', '', `Linked contribution ${resolution.contributionId.slice(0, 12)}, revision ${resolution.contributionRevision} · ${dateLabel(resolution.at)}`)); content.append(item);
    }
  } else {
    const contribution = thread.contributions.find(c => c.id === contributionId);
    content.append(element('p', 'form-note', `${participant(contribution.author).name} · ${contribution.kind}. Reviews stay attached to the text they checked.`));
    const revisions = [{ revision: contribution.revision, text: contribution.text, at: contribution.createdAt }, ...contribution.revisions.slice().reverse()];
    for (const revision of revisions) {
      const item = element('div', 'history-entry'); item.append(element('strong', '', `Revision ${revision.revision}${revision.revision === contribution.revision ? ' · current' : ''}`), element('p', '', revision.text));
      for (const review of contribution.reviews.filter(r => r.revision === revision.revision)) item.append(element('div', 'review-note', `${byline(review.actor)} · ${review.status === 'reviewed' ? 'Reviewed' : 'Needs correction'}${review.note ? `: ${review.note}` : ''}`));
      content.append(item);
    }
  }
  $('history-content').replaceChildren(content); openDialog('history-dialog');
}

for (const person of PEOPLE) { const option = element('option', '', `${person.name} · demo`); option.value = person.id; $('demo-person').append(option); }
for (const passage of PASSAGES) { const option = element('option', '', `§${passage.number} ${passage.label}`); option.value = passage.id; $('question-passage').append(option); }
$('demo-person').addEventListener('change', () => {
  actor = $('demo-person').value; document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); modalTarget = null; render(); toast(`Trying the flow as ${byline(actor)}. These are simulated participants.`);
});
for (const [id, value] of [['filter-all', 'all'], ['filter-open', 'open'], ['filter-passage', 'passage']]) $(id).addEventListener('click', () => { filter = value; render(); });
$('new-question').addEventListener('click', showQuestion);
$('question-passage').addEventListener('change', () => { $('question-source').textContent = PASSAGES.find(p => p.id === $('question-passage').value).text; });
$('new-question-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const result = addQuestion(model, { actor: modalTarget.actor, passageId: $('question-passage').value, question: $('new-question-text').value });
    selectedPassage = $('question-passage').value; selectedThread = result.threadId; filter = 'all';
    commit(result.state, 'Question added to this local demo.'); $('question-dialog').close();
  } catch (error) { $('question-error').textContent = error.message; }
});
$('contribution-form').addEventListener('submit', event => {
  event.preventDefault(); const thread = activeThread(); if (!thread) return;
  try { const next = addContribution(model, thread.id, { actor, kind: $('contribution-kind').value, text: $('contribution-text').value }); contributionDrafts.delete(draftKey(actor, thread.id)); commit(next, 'Contribution added. It starts unreviewed.'); $('thread-content').scrollTop = $('thread-content').scrollHeight; } catch (error) { fail(error); }
});
function rememberContributionDraft() {
  const thread = activeThread(); if (!thread) return;
  contributionDrafts.set(draftKey(actor, thread.id), { text: $('contribution-text').value, kind: $('contribution-kind').value });
}
$('contribution-text').addEventListener('input', rememberContributionDraft);
$('contribution-kind').addEventListener('change', rememberContributionDraft);
$('review-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const thread = model.threads.find(t => t.id === modalTarget.threadId), contribution = thread?.contributions.find(c => c.id === modalTarget.contributionId);
    if (!contribution || contribution.revision !== modalTarget.revision) throw new Error('The text changed. Open the current revision to review it.');
    const next = reviewContribution(model, thread.id, contribution.id, { actor: modalTarget.actor, status: $('review-result').value, note: $('review-note').value });
    commit(next, 'Demo review saved for this exact revision.'); $('review-dialog').close();
  } catch (error) { $('review-error').textContent = error.message; }
});
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const thread = model.threads.find(t => t.id === modalTarget.threadId), contribution = thread?.contributions.find(c => c.id === modalTarget.contributionId);
    if (!contribution || contribution.revision !== modalTarget.revision) throw new Error('The text changed. Reopen it before editing.');
    commit(editContribution(model, thread.id, contribution.id, modalTarget.actor, $('edit-text').value), 'New revision saved. Earlier reviews stay with earlier text.'); $('edit-dialog').close();
  } catch (error) { $('edit-error').textContent = error.message; }
});
$('resolution-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const details = modalTarget.reopening ? { reason: $('resolution-summary').value } : { summary: $('resolution-summary').value, contributionId: $('resolution-link').value };
    commit(setThreadStatus(model, modalTarget.threadId, modalTarget.actor, modalTarget.reopening ? 'reopened' : 'resolved', details), modalTarget.reopening ? 'Question reopened. Its earlier resolution stays in the history.' : 'Question resolved with your summary and a linked explanation.'); $('resolution-dialog').close();
  } catch (error) { $('resolution-error').textContent = error.message; }
});
document.querySelectorAll('.close-dialog').forEach(control => control.addEventListener('click', () => control.closest('dialog').close()));
$('reset-demo').addEventListener('click', () => openDialog('reset-dialog'));
$('confirm-reset').addEventListener('click', () => { model = createDemo(); selectedPassage = 'bound'; selectedThread = 'q-tail'; filter = 'all'; actor = 'you'; contributionDrafts.clear(); $('demo-person').value = actor; $('contribution-text').value = ''; commit(model, 'Original local demo restored.'); $('reset-dialog').close(); });
render();
if (!persistenceAvailable) toast('Browser storage is unavailable. You can explore for this session.');
