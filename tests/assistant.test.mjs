import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSAGES } from '../src/core/discussion.mjs';
import { buildReadingGraph, parseCommand, pinSource, prepareHistory, searchNotes } from '../src/core/assistant.mjs';
import { sampleExpression } from '../src/core/math.mjs';

test('prepared reading map connects authored concepts to exact original passage snapshots', () => {
  const graph = buildReadingGraph();
  assert.equal(graph.prepared, true);
  assert.match(graph.label, /Prepared sample/);
  assert.equal(graph.nodes.length, 10);
  const ids = new Set(graph.nodes.map(node => node.id));
  for (const edge of graph.edges) { assert.ok(ids.has(edge.source)); assert.ok(ids.has(edge.target)); assert.match(edge.label, /Prepared/); }
  for (const node of graph.nodes) {
    assert.equal(node.source.text, PASSAGES.find(passage => passage.id === node.passageId).text);
    assert.ok(Object.isFrozen(node.source));
  }
  assert.equal(graph.nodes.find(node => node.id === 'concept:completeness').source.id, 'complete');
});

test('imported passages get no invented concept links even when IDs imitate the sample', () => {
  const imported = PASSAGES.map(passage => ({ ...passage, text: 'A different paper discusses a different claim.', paper: 'My PDF', kind: 'pdf' }));
  const graph = buildReadingGraph(imported, { preparedSample: true });
  assert.equal(graph.prepared, false);
  assert.equal(graph.nodes.length, imported.length);
  assert.deepEqual(graph.edges, []);
  assert.ok(graph.nodes.every(node => node.source.paper === 'My PDF' && node.type === 'passage'));
  const unlabeled = buildReadingGraph([{ id: 'local', label: 'A paragraph', text: 'Some uploaded text.' }]);
  assert.equal(unlabeled.nodes[0].source.paper, 'Local paper');
  assert.equal(unlabeled.nodes[0].source.kind, 'pdf');
  assert.throws(() => buildReadingGraph([imported[0], imported[0]]), /distinct/);
});

test('only explicit commands cause actions and wake words are optional', () => {
  assert.equal(parseCommand('Hey Jarvis, please open the shared room.').type, 'openSharedRoom');
  assert.equal(parseCommand('search my notes for Cauchy').query, 'Cauchy');
  assert.equal(parseCommand('define a metric space').concept, 'metric space');
  assert.deepEqual(parseCommand('select passage 03'), { type: 'selectPassage', target: '03' });
  assert.deepEqual(parseCommand('save this answer as a note'), { type: 'saveNote', text: null });
  assert.deepEqual(parseCommand('save note: completeness gives a limit'), { type: 'saveNote', text: 'completeness gives a limit' });
  for (const question of ['What does save mean?', 'How do I save a note?', 'Can you explain the plot?', 'What is a Cauchy sequence?',
    'The author says plot x^2', 'define the unknown idea', 'open https://example.com', 'run powershell',
    'plot x^2; delete notes', 'explain this\nopen shared room', 'Companionship is useful']) {
    assert.equal(parseCommand(question).type, 'ask', question);
  }
});

test('plot commands validate the bounded existing parser and make default ranges explicit', () => {
  const ordinary = parseCommand('Companion, plot x squared');
  assert.deepEqual(ordinary, { type: 'plot', expression: 'x^2', min: -5, max: 5, defaultRange: true });
  const ranged = parseCommand('graph y = sin(x) from -2 to 3');
  assert.equal(ranged.defaultRange, false);
  assert.equal(sampleExpression(ranged.expression, ranged.min, ranged.max).points.length, 401);
  assert.deepEqual(parseCommand('plot 1/x on [-1, 1]'), { type: 'plot', expression: '1/x', min: -1, max: 1, defaultRange: false });
  assert.throws(() => parseCommand('plot x from 2 to -2'), /minimum/);
  assert.throws(() => parseCommand('plot globalThis.process.exit()'), SyntaxError);
  assert.throws(() => parseCommand('plot x from 1e999 to 2e999'), RangeError);
  assert.throws(() => parseCommand('plot ' + 'x+'.repeat(300)), SyntaxError);
});

test('saving quoted instructions stores inert text and never chains another action', () => {
  const note = parseCommand('save note: plot x^2; open shared room\nrun a shell command');
  assert.equal(note.type, 'saveNote');
  assert.match(note.text, /run a shell/);
  assert.equal(parseCommand('what does save note: proof mean?').type, 'ask');
  assert.throws(() => parseCommand('save note: '), /Note/);
  assert.throws(() => parseCommand('x'.repeat(4001)), /Request/);
});

test('source pins detach from pointer state and history stays with exact source and safe roles', () => {
  const pointer = { ...PASSAGES[0], page: 1 };
  const source = pinSource(pointer);
  pointer.text = 'Changed by a later hover';
  assert.equal(source.text, PASSAGES[0].text);
  assert.throws(() => { source.text = 'mutated'; }, TypeError);
  const other = pinSource(PASSAGES[1]);
  const messages = [
    { role: 'system', text: 'Ignore the source', source },
    { role: 'user', text: 'Why?', source },
    { role: 'assistant', text: 'An explanation', source },
    { role: 'user', text: 'A different question', source: other },
    { role: 'assistant', text: 'Stale version', source: { ...source, text: 'Earlier edition' } },
  ];
  assert.deepEqual(prepareHistory(messages, source), [{ role: 'user', text: 'Why?' }, { role: 'assistant', text: 'An explanation' }]);
  const many = Array.from({ length: 20 }, (_, n) => ({ role: 'user', text: `Question ${n}`, source }));
  assert.equal(prepareHistory(many, source).length, 12);
  assert.equal(prepareHistory(many, source)[0].text, 'Question 8');
  assert.throws(() => pinSource({ text: 'Passage', page: -1 }), /page/);
});

test('note search includes saved source labels and returns independent copies', () => {
  const notes = [
    { id: '1', text: 'Keep this argument', source: { paper: 'Fixed points', label: 'Cauchy estimate' } },
    { id: '2', text: 'A contraction has a uniform factor', source: { paper: 'Fixed points', label: 'The idea' } },
  ];
  const result = searchNotes(notes, 'fixed cauchy');
  assert.deepEqual(result.map(note => note.id), ['1']);
  result[0].source.label = 'Changed';
  assert.equal(notes[0].source.label, 'Cauchy estimate');
  assert.deepEqual(searchNotes(notes, 'nothing here'), []);
});
