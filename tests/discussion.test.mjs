import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, restoreState, reviewStatus, addQuestion, addContribution, editContribution, reviewContribution, markHelped, requestReview, setThreadStatus } from '../src/core/discussion.mjs';

test('a question keeps its exact passage and personal resolution does not create a mathematical review', () => {
  const initial = createDemo();
  const { state, threadId } = addQuestion(initial, { actor: 'you', passageId: 'theorem', question: 'Where is nonemptiness used?' });
  const withAnswer = addContribution(state, threadId, { actor: 'rowan', kind: 'Explanation', text: 'It supplies a starting point for the iteration.' });
  const thread = withAnswer.threads.find(t => t.id === threadId), contribution = thread.contributions[0];
  const resolved = setThreadStatus(withAnswer, threadId, 'you', 'resolved', { summary: 'We need an initial point to start iterating.', contributionId: contribution.id });
  const saved = resolved.threads.find(t => t.id === threadId);
  assert.equal(saved.passageId, 'theorem'); assert.equal(saved.status, 'resolved');
  assert.equal(saved.resolutions[0].contributionRevision, 1); assert.equal(reviewStatus(saved.contributions[0]), 'unreviewed');
  assert.equal(initial.threads.length, 2); assert.ok(restoreState(resolved));
});

test('revision changes invalidate current reviews and helped marks while retaining prior reviewed text', () => {
  let state = markHelped(createDemo(), 'q-tail', 'c-tail', 'you');
  state = reviewContribution(state, 'q-tail', 'c-tail', { actor: 'you', status: 'reviewed', note: 'Checked the geometric tail bound.' });
  assert.equal(reviewStatus(state.threads[0].contributions[0]), 'reviewed');
  const edited = editContribution(state, 'q-tail', 'c-tail', 'rowan', 'The triangle inequality bounds a finite tail by the infinite geometric tail.');
  const contribution = edited.threads[0].contributions[0];
  assert.equal(contribution.revision, 2); assert.equal(reviewStatus(contribution), 'unreviewed'); assert.deepEqual(contribution.helped, []);
  assert.equal(contribution.reviews[0].revision, 1); assert.equal(contribution.revisions[0].text, state.threads[0].contributions[0].text);
  assert.ok(restoreState(edited));
});

test('only question author resolves and marks understanding; reopening preserves resolution and reason', () => {
  const base = createDemo();
  assert.throws(() => markHelped(base, 'q-tail', 'c-tail', 'rowan'), /question/);
  assert.throws(() => setThreadStatus(base, 'q-tail', 'rowan', 'resolved', { summary: 'Understood', contributionId: 'c-tail' }), /author/);
  assert.throws(() => setThreadStatus(base, 'q-tail', 'you', 'resolved', { summary: '', contributionId: 'c-tail' }), /summary/);
  const resolved = setThreadStatus(base, 'q-tail', 'you', 'resolved', { summary: 'The whole tail is controlled.', contributionId: 'c-tail' });
  assert.throws(() => setThreadStatus(resolved, 'q-tail', 'you', 'reopened', { reason: ' ' }), /reason/);
  const reopened = setThreadStatus(resolved, 'q-tail', 'you', 'reopened', { reason: 'I still need to check the q = 0 case.' });
  assert.equal(reopened.threads[0].status, 'reopened'); assert.equal(reopened.threads[0].resolutions.length, 1);
  assert.match(reopened.threads[0].events.at(-1).action, /q = 0/); assert.ok(restoreState(reopened));
});

test('review requests do not review contributions, self-reviews are refused, corrections require reasons', () => {
  const state = requestReview(createDemo(), 'q-tail', 'you');
  assert.equal(state.threads[0].reviewRequested, true); assert.equal(reviewStatus(state.threads[0].contributions[0]), 'unreviewed');
  assert.throws(() => reviewContribution(state, 'q-tail', 'c-tail', { actor: 'rowan', status: 'reviewed', note: 'I checked my own explanation.' }), /different/);
  assert.throws(() => reviewContribution(state, 'q-tail', 'c-tail', { actor: 'you', status: 'reviewed', note: '' }), /checked/);
  assert.throws(() => reviewContribution(state, 'q-tail', 'c-tail', { actor: 'mina', status: 'correction', note: '' }), /correction/);
  const correction = reviewContribution(state, 'q-tail', 'c-tail', { actor: 'mina', status: 'correction', note: 'Please show the geometric sum explicitly.' });
  assert.equal(reviewStatus(correction.threads[0].contributions[0]), 'correction');
});

test('event limits refuse changes before making persisted state unrestorable', () => {
  const state = createDemo();
  state.threads[0].events = Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}`, actor: 'you', action: 'A prior demo event', at: '2026-10-24T12:00:00Z' }));
  assert.ok(restoreState(state));
  assert.throws(() => addContribution(state, 'q-tail', { actor: 'rowan', kind: 'Explanation', text: 'Another explanation.' }), /history limit/);
  assert.equal(state.threads[0].contributions.length, 2); assert.ok(restoreState(state));
});

test('restoration rejects malformed local data and false AI provenance', () => {
  assert.equal(restoreState(null), null);
  const state = createDemo(); state.threads[1].contributions[0].ai = false;
  assert.equal(restoreState(state), null);
  const other = createDemo(); other.threads[0].contributions[0].reviews.push({ actor: 'rowan', status: 'reviewed', revision: 1, note: 'self', at: '2026-10-24T12:00:00Z' });
  assert.equal(restoreState(other), null);
});
