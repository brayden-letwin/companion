import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applySharedOperation, createSharedState, SHARED_LIMITS } from '../src/core/shared-discussion.mjs';

const members = [
  { id: 'member-one', name: 'Ada', role: 'member' },
  { id: 'member-two', name: 'Emmy', role: 'member' },
  { id: 'member-admin', name: 'Sofia', role: 'admin' },
];
const paper = { id: 'paper-1', title: 'Original sample', version: 'v1', passages: [{ id: 'p1', label: 'Completeness', number: '01', page: 2, text: 'Every Cauchy sequence in X has a limit in X.' }] };
const op = (type, fields = {}) => ({ type, operationId: randomUUID(), expectedRevision: 0, ...fields });
const apply = (state, member, operation) => applySharedOperation(state, member, members, paper, operation);
const error = (statusCode, code) => value => value.statusCode === statusCode && value.code === code;
function question() { return apply(createSharedState(), members[0], op('addQuestion', { passageId: 'p1', question: 'Why is completeness needed?' })); }
function answer() {
  const state = question();
  return apply(state, members[1], op('addContribution', { threadId: state.threads[0].id, kind: 'Explanation', text: 'It supplies the limit as a point of X.' }));
}
const ids = state => ({ threadId: state.threads[0].id, contributionId: state.threads[0].contributions[0].id });

test('real members own questions, and the exact server passage is preserved without mutating inputs', () => {
  const original = createSharedState();
  const next = apply(original, members[0], op('addQuestion', { passageId: 'p1', question: '  Why completeness?  ' }));
  assert.deepEqual(original, { version: 1, threads: [] });
  assert.equal(next.threads[0].author, members[0].id);
  assert.equal(next.threads[0].question, 'Why completeness?');
  assert.deepEqual(next.threads[0].source, { paperId: 'paper-1', paperVersion: 'v1', page: 2, text: paper.passages[0].text, label: 'Completeness', number: '01' });
  assert.equal(next.threads[0].contributions.length, 0);
});

test('unsupported identity/provenance fields and malformed operation envelopes are rejected', () => {
  for (const field of ['actor', 'author', 'ai', 'role', '__proto__']) {
    const operation = JSON.parse(JSON.stringify(op('addQuestion', { passageId: 'p1', question: 'Why?' })).replace(/}$/, `,"${field}":"forged"}`));
    assert.throws(() => apply(createSharedState(), members[0], operation), error(400, 'validation_error'));
  }
  assert.throws(() => apply(createSharedState(), members[0], { type: 'addQuestion', passageId: 'p1', question: 'Why?' }), error(400, 'validation_error'));
  assert.throws(() => apply(createSharedState(), members[0], op('constructor')), error(400, 'validation_error'));
  assert.throws(() => apply(createSharedState(), members[0], op({ toString: null })), error(400, 'validation_error'));
  assert.throws(() => apply(createSharedState(), { id: 'outsider', role: 'admin' }, op('addQuestion', { passageId: 'p1', question: 'Why?' })), error(403, 'forbidden'));
});

test('authors alone edit; real membership role prevents an actor from claiming administrator permission', () => {
  const state = answer(), target = ids(state);
  assert.throws(() => apply(state, members[0], op('editContribution', { ...target, contributionRevision: 1, text: 'Forged edit' })), error(403, 'forbidden'));
  const fakeAdmin = { ...members[1], role: 'admin' };
  assert.throws(() => apply(state, fakeAdmin, op('resolveQuestion', { ...target, contributionRevision: 1, summary: 'Looks good.' })), error(403, 'forbidden'));
  const resolved = apply(state, members[2], op('resolveQuestion', { ...target, contributionRevision: 1, summary: 'Completeness supplies the limit in X.' }));
  assert.equal(resolved.threads[0].resolutions[0].actor, members[2].id);
});

test('review and helpfulness are separate, edits invalidate the current marks while retaining revision evidence', () => {
  let state = answer(); const target = ids(state);
  state = apply(state, members[0], op('reviewContribution', { ...target, contributionRevision: 1, status: 'reviewed', note: 'Checked the use of completeness.' }));
  assert.deepEqual(state.threads[0].contributions[0].helped, []);
  state = apply(state, members[0], op('markHelped', target));
  const original = structuredClone(state);
  state = apply(state, members[1], op('editContribution', { ...target, contributionRevision: 1, text: 'The Cauchy condition plus completeness supplies a point of X as the limit.' }));
  const contribution = state.threads[0].contributions[0];
  assert.equal(contribution.revision, 2);
  assert.deepEqual(contribution.helped, []);
  assert.equal(contribution.reviews[0].revision, 1);
  assert.deepEqual(contribution.revisions[0].helped, [members[0].id]);
  assert.equal(original.threads[0].contributions[0].revision, 1);
});

test('reviews, edits, and resolutions cannot silently target an old contribution revision', () => {
  let state = answer(); const target = ids(state);
  state = apply(state, members[1], op('editContribution', { ...target, contributionRevision: 1, text: 'A revised explanation.' }));
  for (const operation of [
    op('editContribution', { ...target, contributionRevision: 1, text: 'A stale edit.' }),
    op('reviewContribution', { ...target, contributionRevision: 1, status: 'reviewed', note: 'A stale review.' }),
    op('resolveQuestion', { ...target, contributionRevision: 1, summary: 'A stale resolution.' }),
  ]) assert.throws(() => apply(state, operation.type === 'editContribution' ? members[1] : members[0], operation), error(409, 'contribution_conflict'));
});

test('self-review and blank review scopes are rejected; review requests never claim correctness', () => {
  const state = answer(), target = ids(state);
  assert.throws(() => apply(state, members[1], op('reviewContribution', { ...target, contributionRevision: 1, status: 'reviewed', note: 'Self-review' })), error(403, 'self_review'));
  for (const status of ['reviewed', 'correction']) assert.throws(() => apply(state, members[0], op('reviewContribution', { ...target, contributionRevision: 1, status, note: '  ' })), error(400, 'validation_error'));
  const requested = apply(state, members[1], op('requestReview', { threadId: target.threadId }));
  assert.equal(requested.threads[0].reviewRequested, true);
  assert.deepEqual(requested.threads[0].contributions[0].reviews, []);
});

test('resolution records the exact supporting revision, and another member can reopen with a reason', () => {
  let state = answer(); const target = ids(state);
  state = apply(state, members[0], op('resolveQuestion', { ...target, contributionRevision: 1, summary: 'A Cauchy sequence has a limit in the complete space.' }));
  assert.equal(state.threads[0].status, 'resolved');
  assert.equal(state.threads[0].resolutions[0].contributionRevision, 1);
  assert.deepEqual(state.threads[0].contributions[0].reviews, []);
  assert.throws(() => apply(state, members[1], op('reopenQuestion', { threadId: target.threadId, reason: '' })), error(400, 'validation_error'));
  state = apply(state, members[1], op('reopenQuestion', { threadId: target.threadId, reason: 'The explanation should identify the metric used.' }));
  assert.equal(state.threads[0].status, 'reopened');
  assert.equal(state.threads[0].resolutions.length, 1);
  assert.match(state.threads[0].events.at(-1).action, /metric used/);
  assert.equal(state.threads[0].events.at(-1).actor, members[1].id);
});

test('history and aggregate-size limits reject the whole change without partial mutation', () => {
  const state = answer(), target = ids(state);
  state.threads[0].events = Array.from({ length: SHARED_LIMITS.events }, () => ({ id: randomUUID(), actor: members[0].id, action: 'Earlier event', at: new Date().toISOString() }));
  const original = structuredClone(state);
  assert.throws(() => apply(state, members[1], op('addContribution', { threadId: target.threadId, kind: 'Explanation', text: 'Another explanation.' })), /history limit/);
  assert.deepEqual(state, original);
  const large = answer(); large.padding = 'x'.repeat(SHARED_LIMITS.stateBytes);
  assert.throws(() => apply(large, members[1], op('requestReview', { threadId: large.threads[0].id })), /discussion size limit/);
  assert.equal(large.threads[0].reviewRequested, false);
});
