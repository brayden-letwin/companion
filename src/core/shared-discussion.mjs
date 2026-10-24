// Authoritative operations for a real, invited reading group. The caller must
// authenticate the session and enforce the database's room-revision compare.
// Members and paper come from the server, never from an operation payload.

export const SHARED_LIMITS = Object.freeze({
  threads: 40, contributions: 80, reviews: 300, revisions: 100,
  events: 1000, resolutions: 100, stateBytes: 2 * 1024 * 1024,
});

const KINDS = new Set(['Explanation', 'Proof detail', 'Counterexample', 'Follow-up']);
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMON = ['type', 'operationId', 'expectedRevision'];
const FIELDS = {
  addQuestion: ['passageId', 'question'],
  addContribution: ['threadId', 'kind', 'text'],
  editContribution: ['threadId', 'contributionId', 'contributionRevision', 'text'],
  reviewContribution: ['threadId', 'contributionId', 'contributionRevision', 'status', 'note'],
  markHelped: ['threadId', 'contributionId'],
  requestReview: ['threadId'],
  resolveQuestion: ['threadId', 'contributionId', 'contributionRevision', 'summary'],
  reopenQuestion: ['threadId', 'reason'],
};

function problem(message, statusCode = 400, code = 'validation_error') {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; return error;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(`${label} must be an object.`);
}
function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw problem(`${label} must contain 1–${maximum} characters.`);
  }
  return value.trim();
}
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw problem(`${label} is invalid.`);
  return value;
}
function actorFor(actor, members) {
  if (!Array.isArray(members)) throw problem('Group membership is unavailable.', 403, 'forbidden');
  const member = actor && members.find(candidate => candidate?.id === actor.id);
  if (!member || typeof member.id !== 'string' || !ID.test(member.id) || !['admin', 'member'].includes(member.role)) {
    throw problem('You are not a member of this group.', 403, 'forbidden');
  }
  // In particular, a caller's actor.role cannot turn an ordinary member into
  // an administrator. Permission comes from the server membership registry.
  return member;
}
function envelope(operation) {
  object(operation, 'Operation');
  if (typeof operation.type !== 'string' || !Object.hasOwn(FIELDS, operation.type)) throw problem('That operation is not supported.');
  const allowed = new Set([...COMMON, ...FIELDS[operation.type]]);
  if (Object.keys(operation).some(key => !allowed.has(key))) throw problem('The operation contains unsupported fields.');
  if (typeof operation.operationId !== 'string' || !UUID.test(operation.operationId)) throw problem('Operation ID must be a UUID.');
  if (!Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0) throw problem('Expected room revision is invalid.');
}
function threadFor(state, threadId) {
  identifier(threadId, 'Question ID');
  const thread = state.threads.find(candidate => candidate.id === threadId);
  if (!thread) throw problem('Question not found.', 404, 'not_found');
  return thread;
}
function contributionFor(thread, contributionId) {
  identifier(contributionId, 'Contribution ID');
  const contribution = thread.contributions.find(candidate => candidate.id === contributionId);
  if (!contribution) throw problem('Contribution not found.', 404, 'not_found');
  return contribution;
}
function sameRevision(contribution, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw problem('Contribution revision is invalid.');
  if (contribution.revision !== revision) throw problem('The contribution changed. Read its current revision before continuing.', 409, 'contribution_conflict');
}
function capacity(items, maximum, label) {
  if (items.length >= maximum) throw problem(`This pilot has reached its ${label} limit.`);
}
function newId() { return globalThis.crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function record(thread, actor, action, at) {
  capacity(thread.events, SHARED_LIMITS.events, 'question history');
  thread.events.push({ id: newId(), actor, action, at });
}
function result(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > SHARED_LIMITS.stateBytes) throw problem('This pilot has reached its saved discussion size limit.');
  return state;
}

export function createSharedState() { return { version: 1, threads: [] }; }

export function applySharedOperation(state, actor, members, paper, operation) {
  const member = actorFor(actor, members);
  envelope(operation);
  object(state, 'Discussion');
  if (state.version !== 1 || !Array.isArray(state.threads) || state.threads.length > SHARED_LIMITS.threads) {
    throw problem('The saved discussion format is invalid.');
  }
  const next = structuredClone(state), at = now();

  if (operation.type === 'addQuestion') {
    identifier(operation.passageId, 'Passage ID');
    const passage = paper?.passages?.find(candidate => candidate.id === operation.passageId);
    if (!passage) throw problem('Choose a passage from this paper.');
    const question = text(operation.question, 1200, 'Question');
    capacity(next.threads, SHARED_LIMITS.threads, 'questions per paper');
    const thread = {
      id: newId(), passageId: passage.id, author: member.id, question,
      status: 'unresolved', reviewRequested: false, resolutions: [],
      createdAt: at, contributions: [], events: [],
      source: {
        paperId: paper.id, paperVersion: paper.version, page: passage.page || 1,
        text: passage.text, label: passage.label, number: passage.number,
      },
    };
    record(thread, member.id, 'Asked this question', at); next.threads.push(thread);
    return result(next);
  }

  const thread = threadFor(next, operation.threadId);
  if (operation.type === 'addContribution') {
    if (!KINDS.has(operation.kind)) throw problem('Choose a contribution type.');
    const contributionText = text(operation.text, 4000, 'Contribution');
    capacity(thread.contributions, SHARED_LIMITS.contributions, 'contributions per question');
    thread.contributions.push({
      id: newId(), author: member.id, kind: operation.kind, text: contributionText,
      ai: false, revision: 1, createdAt: at, revisions: [], reviews: [], helped: [],
    });
    record(thread, member.id, `Added ${operation.kind.toLowerCase()}`, at);
  } else if (operation.type === 'requestReview') {
    if (!thread.reviewRequested) {
      thread.reviewRequested = true; record(thread, member.id, 'Requested mathematical review', at);
    }
  } else if (operation.type === 'reopenQuestion') {
    if (thread.status !== 'resolved') throw problem('This question is already open.', 409, 'question_conflict');
    const reason = text(operation.reason, 240, 'Reopening reason');
    thread.status = 'reopened'; record(thread, member.id, `Reopened question: ${reason}`, at);
  } else {
    const contribution = contributionFor(thread, operation.contributionId);
    if (operation.type === 'editContribution') {
      if (contribution.author !== member.id) throw problem('Only the contribution author can edit it.', 403, 'forbidden');
      sameRevision(contribution, operation.contributionRevision);
      const revisedText = text(operation.text, 4000, 'Contribution');
      if (revisedText !== contribution.text) {
        capacity(contribution.revisions, SHARED_LIMITS.revisions, 'contribution revisions');
        contribution.revisions.push({ revision: contribution.revision, text: contribution.text, helped: [...contribution.helped], at });
        contribution.text = revisedText; contribution.revision += 1; contribution.helped = [];
        record(thread, member.id, `Edited contribution to revision ${contribution.revision}; earlier reviews refer to earlier text`, at);
      }
    } else if (operation.type === 'reviewContribution') {
      if (contribution.author === member.id) throw problem('Choose another member’s contribution to review.', 403, 'self_review');
      sameRevision(contribution, operation.contributionRevision);
      if (!['reviewed', 'correction'].includes(operation.status)) throw problem('Choose a review result.');
      const note = text(operation.note, 1400, 'Review scope or correction');
      capacity(contribution.reviews, SHARED_LIMITS.reviews, 'reviews per contribution');
      contribution.reviews.push({ actor: member.id, status: operation.status, note, revision: contribution.revision, at });
      record(thread, member.id, `${operation.status === 'reviewed' ? 'Reviewed' : 'Requested a correction to'} a contribution (revision ${contribution.revision})`, at);
    } else if (operation.type === 'markHelped') {
      if (thread.author !== member.id) throw problem('Only the question author can mark what helped them.', 403, 'forbidden');
      const marked = contribution.helped.includes(member.id);
      contribution.helped = marked ? contribution.helped.filter(value => value !== member.id) : [...contribution.helped, member.id];
      record(thread, member.id, marked ? 'Removed their understanding mark from a contribution' : 'Marked a contribution as helpful to their understanding', at);
    } else if (operation.type === 'resolveQuestion') {
      if (thread.author !== member.id && member.role !== 'admin') throw problem('Only the question author or group administrator can resolve it.', 403, 'forbidden');
      if (thread.status === 'resolved') throw problem('This question is already resolved.', 409, 'question_conflict');
      sameRevision(contribution, operation.contributionRevision);
      const summary = text(operation.summary, 600, 'Resolution summary');
      capacity(thread.resolutions, SHARED_LIMITS.resolutions, 'resolution history');
      thread.resolutions.push({ actor: member.id, summary, contributionId: contribution.id, contributionRevision: contribution.revision, at });
      thread.status = 'resolved'; record(thread, member.id, 'Resolved the question with a linked explanation and summary', at);
    }
  }
  return result(next);
}
