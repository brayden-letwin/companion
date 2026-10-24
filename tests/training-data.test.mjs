import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const data = JSON.parse(await readFile(new URL('../training/dataset.json', import.meta.url), 'utf8'));

test('training pilot has complete original records and independent held-out theorem families', () => {
  assert.equal(data.train.length, 24);
  assert.equal(data.evaluation.length, 8);
  const seen = new Set();
  for (const [split, records] of Object.entries({train:data.train,evaluation:data.evaluation})) {
    for (const row of records) {
      assert.ok(!seen.has(row.id)); seen.add(row.id);
      for (const field of ['id','family','passage','question',split === 'train' ? 'answer' : 'reference']) assert.ok(typeof row[field] === 'string' && row[field].trim());
      assert.ok(row.familiarity && typeof row.familiarity === 'object');
      if (split === 'evaluation') assert.ok(row.rubric.length >= 3);
    }
  }
  const trainFamilies = new Set(data.train.map(row => row.family));
  assert.ok(data.evaluation.every(row => !trainFamilies.has(row.family)));
  assert.match(data.provenance, /synthetic/);
});
