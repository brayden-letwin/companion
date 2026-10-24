export const PEOPLE = [
  { id: 'you', name: 'You', initials: 'YO' },
  { id: 'rowan', name: 'Rowan', initials: 'RO' },
  { id: 'mina', name: 'Mina', initials: 'MI' },
];
export const PAPER = 'A first look at fixed points';
export const PASSAGES = [
  { id: 'idea', number: '01', label: 'The idea', text: 'A contraction brings any two points closer together. Repeatedly applying it produces iterates xₙ₊₁ = T(xₙ). A fixed point is a point that survives its own rule: T(x*) = x*.' },
  { id: 'theorem', number: '02', label: 'The contraction principle', text: 'Let (X, d) be a nonempty complete metric space. Suppose T : X → X satisfies d(Tx, Ty) ≤ q d(x, y), with 0 ≤ q < 1. Then T has a unique fixed point, and the iterates from any starting point converge to it.' },
  { id: 'bound', number: '03', label: 'The remaining journey', text: 'For m > n, the triangle inequality and a geometric sum give d(xₘ, xₙ) ≤ qⁿ d(x₁, x₀) / (1 − q). The entire remaining journey becomes small, so the iterates form a Cauchy sequence.' },
  { id: 'complete', number: '04', label: 'Where the limit lives', text: 'Completeness ensures the Cauchy sequence has a limit x* inside X. Since a contraction is continuous, passing to the limit gives T(x*) = x*. Two fixed points would satisfy d(x*, y*) ≤ q d(x*, y*), forcing them to be the same.' },
];
const TYPES = new Set(['Explanation', 'Proof detail', 'Counterexample', 'Follow-up']);
const person = id => PEOPLE.some(p => p.id === id);
const trimmed = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must contain 1–${max} characters.`);
  return value.trim();
};
const date = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
function actorCheck(actor) { if (!person(actor)) throw new Error('Choose a demo participant.'); }
function threadFor(state, threadId) { const thread = state.threads.find(t => t.id === threadId); if (!thread) throw new Error('Question not found.'); return thread; }
function contributionFor(thread, contributionId) { const contribution = thread.contributions.find(c => c.id === contributionId); if (!contribution) throw new Error('Contribution not found.'); return contribution; }
function copy(state) { return structuredClone(state); }
function event(thread, actor, action) {
  if (thread.events.length >= 1000) throw new Error('This local demo has reached its history limit.');
  thread.events.push({ id: id(), actor, action, at: date() });
}

export function createDemo() {
  const at = '2026-10-24T12:00:00Z';
  return { version: 1, threads: [
    { id: 'q-tail', passageId: 'bound', author: 'you', question: 'Why do shrinking steps imply convergence?', status: 'unresolved', reviewRequested: false, resolutions: [], createdAt: at, contributions: [
      { id: 'c-tail', author: 'rowan', kind: 'Proof detail', ai: false, revision: 1, text: 'Shrinking consecutive steps alone is not enough. For m > n, add the consecutive distances from n to m − 1. They are bounded by qⁿ d(x₁, x₀), qⁿ⁺¹ d(x₁, x₀), and so on. Their sum is at most qⁿ d(x₁, x₀)/(1 − q), which tends to zero independently of m. This proves the Cauchy condition; completeness supplies convergence.', createdAt: at, revisions: [], reviews: [], helped: [] },
      { id: 'c-picture', author: 'mina', kind: 'Explanation', ai: false, revision: 1, text: 'Think of a shrinking budget for all the steps still to come. The geometric tail controls the whole budget, rather than just the size of the next step. That is the bridge from smaller steps to a Cauchy sequence.', createdAt: at, revisions: [], reviews: [], helped: [] },
    ], events: [{ id: 'e-1', actor: 'you', action: 'Asked this question', at }] },
    { id: 'q-space', passageId: 'complete', author: 'mina', question: 'What work is completeness doing here?', status: 'unresolved', reviewRequested: true, resolutions: [], createdAt: at, contributions: [
      { id: 'c-space', author: 'ai', kind: 'Explanation', ai: true, revision: 1, text: 'The Cauchy condition says late terms become close to one another. Completeness guarantees that their limit is actually a point of X. Without that assumption, a limit could be missing from the space.', createdAt: at, revisions: [], reviews: [], helped: [] },
    ], events: [{ id: 'e-2', actor: 'mina', action: 'Asked this question', at }, { id: 'e-3', actor: 'mina', action: 'Requested mathematical review', at }] },
  ] };
}

// This validates local prototype data; participant switching is a simulation,
// not an authentication or authorization boundary.
export function restoreState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.threads) || value.threads.length > 40) return null;
  const validId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
  const validText = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
  const validTime = v => typeof v === 'string' && v.length < 40 && Number.isFinite(Date.parse(v));
  const seen = new Set();
  for (const thread of value.threads) {
    if (!thread || !validId(thread.id) || seen.has(thread.id) || !PASSAGES.some(p => p.id === thread.passageId)
      || !person(thread.author) || !validText(thread.question, 1200) || !['unresolved', 'resolved', 'reopened'].includes(thread.status)
      || typeof thread.reviewRequested !== 'boolean' || !validTime(thread.createdAt) || !Array.isArray(thread.contributions)
      || thread.contributions.length > 80 || !Array.isArray(thread.events) || thread.events.length > 1000
      || !Array.isArray(thread.resolutions) || thread.resolutions.length > 100) return null;
    seen.add(thread.id);
    for (const contribution of thread.contributions) {
      if (!contribution || !validId(contribution.id) || seen.has(contribution.id) || !['ai', ...PEOPLE.map(p => p.id)].includes(contribution.author)
        || !TYPES.has(contribution.kind) || typeof contribution.ai !== 'boolean' || contribution.ai !== (contribution.author === 'ai')
        || !Number.isInteger(contribution.revision) || contribution.revision < 1 || !validText(contribution.text, 4000)
        || !validTime(contribution.createdAt) || !Array.isArray(contribution.reviews) || contribution.reviews.length > 300
        || !Array.isArray(contribution.revisions) || contribution.revisions.length > 100 || !Array.isArray(contribution.helped)
        || contribution.helped.length > PEOPLE.length || contribution.helped.some(p => !person(p))) return null;
      seen.add(contribution.id);
      for (const review of contribution.reviews) if (!review || !person(review.actor) || review.actor === contribution.author
        || !['reviewed', 'correction'].includes(review.status) || !Number.isInteger(review.revision) || review.revision < 1
        || review.revision > contribution.revision || typeof review.note !== 'string' || review.note.length > 1400 || !validTime(review.at)) return null;
      for (const revision of contribution.revisions) if (!revision || !Number.isInteger(revision.revision) || revision.revision < 1
        || revision.revision >= contribution.revision || !validText(revision.text, 4000) || !validTime(revision.at)) return null;
    }
    for (const entry of thread.events) if (!entry || !validId(entry.id) || !person(entry.actor) || !validText(entry.action, 300) || !validTime(entry.at)) return null;
    for (const resolution of thread.resolutions) if (!resolution || resolution.actor !== thread.author || !validText(resolution.summary, 600)
      || !validId(resolution.contributionId) || !thread.contributions.some(c => c.id === resolution.contributionId && resolution.contributionRevision >= 1 && resolution.contributionRevision <= c.revision)
      || !Number.isInteger(resolution.contributionRevision) || !validTime(resolution.at)) return null;
  }
  return copy(value);
}

export function reviewStatus(contribution) {
  const reviews = contribution.reviews.filter(r => r.revision === contribution.revision);
  return reviews.some(r => r.status === 'correction') ? 'correction' : reviews.some(r => r.status === 'reviewed') ? 'reviewed' : 'unreviewed';
}
export function addQuestion(state, { actor, passageId, question }) {
  actorCheck(actor);
  if (!PASSAGES.some(p => p.id === passageId)) throw new Error('Choose a passage first.');
  question = trimmed(question, 1200, 'Question');
  if (state.threads.length >= 40) throw new Error('This local demo holds up to 40 questions.');
  const next = copy(state);
  const thread = { id: id(), passageId, author: actor, question, status: 'unresolved', reviewRequested: false, resolutions: [], createdAt: date(), contributions: [], events: [] };
  event(thread, actor, 'Asked this question'); next.threads.push(thread); return { state: next, threadId: thread.id };
}
export function addContribution(state, threadId, { actor, kind, text }) {
  actorCheck(actor); text = trimmed(text, 4000, 'Contribution');
  if (!TYPES.has(kind)) throw new Error('Choose a contribution type.');
  const next = copy(state), thread = threadFor(next, threadId);
  if (thread.contributions.length >= 80) throw new Error('This demo question holds up to 80 contributions.');
  thread.contributions.push({ id: id(), author: actor, kind, text, ai: false, revision: 1, createdAt: date(), revisions: [], reviews: [], helped: [] });
  event(thread, actor, `Added ${kind.toLowerCase()}`); return next;
}
export function editContribution(state, threadId, contributionId, actor, text) {
  actorCheck(actor); text = trimmed(text, 4000, 'Contribution');
  const next = copy(state), thread = threadFor(next, threadId), contribution = contributionFor(thread, contributionId);
  if (contribution.author !== actor || contribution.ai) throw new Error('Switch to the contribution’s demo author to edit it.');
  if (contribution.revisions.length >= 100) throw new Error('This demo contribution has reached its revision limit.');
  if (contribution.text === text) return next;
  contribution.revisions.push({ revision: contribution.revision, text: contribution.text, at: date() });
  contribution.revision += 1; contribution.text = text; contribution.helped = [];
  event(thread, actor, `Edited contribution to revision ${contribution.revision}; earlier reviews refer to earlier text`); return next;
}
export function reviewContribution(state, threadId, contributionId, { actor, status, note = '' }) {
  actorCheck(actor);
  if (!['reviewed', 'correction'].includes(status)) throw new Error('Choose a review result.');
  if (typeof note !== 'string' || note.length > 1400 || !note.trim()) throw new Error(status === 'correction' ? 'Explain the correction you are requesting.' : 'Describe what you checked for this review.');
  const next = copy(state), thread = threadFor(next, threadId), contribution = contributionFor(thread, contributionId);
  if (contribution.author === actor) throw new Error('Choose a different demo participant to review this contribution.');
  if (contribution.reviews.length >= 300) throw new Error('This demo contribution has reached its review limit.');
  contribution.reviews.push({ actor, status, note: note.trim(), revision: contribution.revision, at: date() });
  event(thread, actor, `${status === 'reviewed' ? 'Reviewed' : 'Requested a correction to'} a contribution (revision ${contribution.revision})`); return next;
}
export function markHelped(state, threadId, contributionId, actor) {
  actorCheck(actor); const next = copy(state), thread = threadFor(next, threadId), contribution = contributionFor(thread, contributionId);
  if (actor !== thread.author) throw new Error('Only the question’s demo author can mark what helped them.');
  contribution.helped = contribution.helped.includes(actor) ? contribution.helped.filter(p => p !== actor) : [...contribution.helped, actor]; return next;
}
export function requestReview(state, threadId, actor) {
  actorCheck(actor); const next = copy(state), thread = threadFor(next, threadId);
  if (!thread.reviewRequested) { thread.reviewRequested = true; event(thread, actor, 'Requested mathematical review'); }
  return next;
}
export function setThreadStatus(state, threadId, actor, status, details = {}) {
  actorCheck(actor); const next = copy(state), thread = threadFor(next, threadId);
  if (actor !== thread.author) throw new Error('Switch to the question’s demo author to change its resolution.');
  const expected = thread.status === 'resolved' ? 'reopened' : 'resolved';
  if (status !== expected) throw new Error('That question status change is not available.');
  if (status === 'resolved') {
    const summary = trimmed(details.summary, 600, 'Resolution summary');
    const contribution = contributionFor(thread, details.contributionId);
    if (thread.resolutions.length >= 100) throw new Error('This local demo has reached its resolution history limit.');
    thread.resolutions.push({ actor, summary, contributionId: contribution.id, contributionRevision: contribution.revision, at: date() });
    thread.status = status; event(thread, actor, 'Marked their question resolved, with a linked explanation and summary');
  } else {
    const reason = trimmed(details.reason, 240, 'Reopening reason');
    thread.status = status; event(thread, actor, `Reopened their question: ${reason}`);
  }
  return next;
}
