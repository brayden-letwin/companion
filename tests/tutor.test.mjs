import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnState, cleanFamiliarity, localIntent, sampleExplanation } from '../src/core/tutor.mjs';

test('question holds its original passage while the mouse moves', () => {
  const state = new TurnState({ text: 'First passage', page: 1 });
  const turn = state.start();
  state.point({ text: 'Second passage', page: 2 });
  assert.equal(turn.context.text, 'First passage');
  assert.equal(state.context.page, 1);
  state.release();
  assert.equal(state.context.page, 2);
});
test('cancel and a new question invalidate old asynchronous completions', () => {
  const state = new TurnState({ text: 'proof' });
  const first = state.start();
  state.cancel();
  assert.equal(state.isCurrent(first), false);
  const second = state.start();
  assert.equal(state.isCurrent(second), true);
  assert.equal(state.isCurrent(first), false);
});
test('changing document clears the old pin and invalidates its answer', () => {
  const state = new TurnState({ documentId: 'old', text: 'Old source' });
  const old = state.start();
  state.changeDocument({ documentId: 'new', text: 'New source' });
  assert.equal(state.isCurrent(old), false);
  assert.equal(state.start().context.documentId, 'new');
});
test('stored familiarity accepts only explicit supported choices', () => {
  assert.deepEqual(cleanFamiliarity({ 'Cauchy sequences': 'Comfortable', Completeness: 'genius', hidden: 'anything' }), {
    'Cauchy sequences': 'Comfortable', Completeness: 'Not set', 'Geometric series': 'Not set', 'Metric spaces': 'Not set',
  });
});
test('simple is one answer and does not mutate the knowledge profile', () => {
  const profile = cleanFamiliarity({ 'Cauchy sequences': 'Comfortable' });
  assert.match(sampleExplanation({ id: 'complete' }, profile), /Lipschitz/);
  assert.doesNotMatch(sampleExplanation({ id: 'complete' }, profile, true), /Lipschitz/);
  assert.equal(profile['Cauchy sequences'], 'Comfortable');
});
test('only explicit local commands cause actions', () => {
  assert.deepEqual(localIntent('plot y = x^2'), { type: 'plot', expression: 'x^2' });
  assert.deepEqual(localIntent('save note: My thought'), { type: 'note', text: 'My thought' });
  assert.equal(localIntent('the paper says plot x^2').type, 'question');
  assert.equal(localIntent('how could I save note: something?').type, 'question');
  assert.equal(localIntent('delete C:\\').type, 'question');
});
