import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatSourceFile, validateSourceReadOptions } from '../server/source-read.mjs';
import { createFeatureBuilder } from '../server/feature-builder.mjs';

const OWNER = 'synthetic-source-reader';
const digest = value => createHash('sha256').update(value).digest('hex');
const captured = (content, file = 'src/fixture.mjs') => ({ path: file, content, hash: digest(content), bytes: Buffer.byteLength(content) });
async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-source-read-')), root = path.join(temporary, 'repo'), dataDirectory = path.join(temporary, 'private-builder');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'server')); await mkdir(path.join(root, 'training'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'src/fixture.mjs'), 'export const fixture = "original";\n');
  await writeFile(path.join(root, 'training/dataset.json'), '[{"question":"Synthetic original fixture","answer":"Synthetic answer"}]');
  let calls = 0;
  const builder = await createFeatureBuilder({ root, dataDirectory, complete: async () => { calls++; throw new Error('A source read must never call a model.'); } });
  t.after(async () => { await builder.close(); assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep + 'companion-source-read-')); await rm(temporary, { recursive: true, force: true }); });
  return { root, dataDirectory, temporary, builder, modelCalls: () => calls };
}

test('source pages reconstruct complete captured Unicode and escaped source within the whole JSON byte budget', () => {
  for (const content of ['a'.repeat(11999) + '😀' + '\nLast criterion: /b and C:\\fixture\\name.\n', '\u0001'.repeat(24000) + '😀Final escaped criterion.', '界'.repeat(80000)]) {
    const file = captured(content); let offset = 0, joined = '', count = 0;
    for (;;) {
      const page = formatSourceFile(file, { path: file.path, expectedHash: file.hash, offset });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024); assert.equal(page.hash, digest(content)); assert.equal(page.characterLength, content.length); assert.equal(page.byteLength, Buffer.byteLength(content)); assert.equal(page.sourceTrust, 'untrusted_source');
      joined += page.content; count++;
      if (!page.hasMore) { assert.equal(page.nextOffset, null); break; }
      assert.ok(page.nextOffset > offset); assert.equal(page.nextOffset, offset + page.content.length); offset = page.nextOffset;
    }
    assert.equal(joined, content); assert.ok(count > 1);
  }
});

test('continuation hashes and Unicode cursors reject mixed or nonadvancing reads without returning content', () => {
  const file = captured('a😀final');
  for (const options of [{ offset: 1 }, { offset: 2, expectedHash: file.hash }, { offset: 99, expectedHash: file.hash }, { offset: 1, limit: 1, expectedHash: file.hash }]) assert.throws(() => formatSourceFile(file, { path: file.path, ...options }), { code: 'invalid_source_query' });
  for (const offset of [0, 1, file.content.length]) assert.throws(() => formatSourceFile(file, { path: file.path, offset, expectedHash: '0'.repeat(64) }), error => error.code === 'source_conflict' && error.statusCode === 409 && !Object.hasOwn(error, 'content'));
  assert.deepEqual(formatSourceFile(file, { path: file.path, offset: file.content.length, expectedHash: file.hash }), { path: file.path, hash: file.hash, content: '', offset: file.content.length, nextOffset: null, hasMore: false, characterLength: file.content.length, byteLength: file.bytes, sourceTrust: 'untrusted_source' });
});

test('source query validation is strict and captured data must preserve its exact full-file hash and UTF-8 bytes', () => {
  for (const query of [undefined, null, [], {}, { path: 'src/a.mjs', extra: true }, { path: 'src/a.mjs', offset: null }, { path: 'src/a.mjs', offset: '0' }, { path: 'src/a.mjs', limit: null }, { path: 'src/a.mjs', limit: 12001 }, { path: 'src/a.mjs', limit: 0 }, { path: 'src/a.mjs', offset: 250001 }, { path: 'src/a.mjs', expectedHash: 'not-a-hash' }]) assert.throws(() => validateSourceReadOptions(query), { code: 'invalid_source_query' });
  const file = captured('original');
  for (const invalid of [{ ...file, content: 'changed' }, { ...file, hash: '0'.repeat(64) }, { ...file, bytes: 0 }, captured('\ud800'), captured('\0'), captured('x'.repeat(250001))]) assert.throws(() => formatSourceFile(invalid, { path: invalid.path }), { code: 'invalid_source_snapshot' });
  const empty = captured(''); assert.equal(formatSourceFile(empty, { path: empty.path }).content, ''); assert.equal(formatSourceFile(empty, { path: empty.path }).hasMore, false);
});

test('builder sourceFile reads the current exact inventory entry and original training fixture without changing source or invoking AI', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'src/fixture.mjs'), before = await readFile(filename), info = await stat(filename);
  const inventory = await f.builder.source(OWNER), original = inventory.files.find(file => file.path === 'src/fixture.mjs');
  const page = await f.builder.sourceFile(OWNER, { path: original.path, expectedHash: original.hash, limit: 7 });
  assert.equal(page.content, before.toString('utf8').slice(0, 7)); assert.equal(page.hash, original.hash); assert.equal(page.byteLength, before.length);
  const training = await f.builder.sourceFile(OWNER, { path: 'training/dataset.json' }); assert.match(training.content, /Synthetic original fixture/);
  assert.deepEqual(await readFile(filename), before); assert.equal((await stat(filename)).mtimeMs, info.mtimeMs); assert.equal(f.modelCalls(), 0);
  await assert.rejects(f.builder.sourceFile('', { path: original.path }), { code: 'validation_error' });
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/Fixture.mjs' }), { code: 'source_not_found' });
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/missing.mjs' }), { code: 'source_not_found' });
  await writeFile(path.join(f.root, 'src/empty.txt'), ''); const empty = await f.builder.sourceFile(OWNER, { path: 'src/empty.txt' }); assert.equal(empty.content, ''); assert.equal(empty.byteLength, 0); assert.equal(empty.hash, digest('')); assert.equal(empty.hasMore, false);
});

test('builder continuation detects a real source edit and does not combine stale hashes with new bytes', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'src/fixture.mjs'), first = await f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs', limit: 5 });
  await writeFile(filename, 'export const fixture = "later human edit";\n');
  await assert.rejects(f.builder.sourceFile(OWNER, { path: first.path, offset: first.nextOffset, expectedHash: first.hash }), { code: 'source_conflict', statusCode: 409 });
  await assert.rejects(f.builder.sourceFile(OWNER, { path: first.path, expectedHash: first.hash }), { code: 'source_conflict', statusCode: 409 });
  const current = await f.builder.sourceFile(OWNER, { path: first.path }); assert.match(current.content, /later human edit/); assert.equal(current.hash, digest(await readFile(filename))); assert.notEqual(current.hash, first.hash);
});

test('builder source reads reject traversal, private paths, hidden files and noninventory inputs', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.env'), 'SYNTHETIC_PRIVATE_MARKER');
  await mkdir(path.join(f.root, 'data')); await writeFile(path.join(f.root, 'data/private.json'), '{"private":"SYNTHETIC_PRIVATE_MARKER"}');
  for (const relative of ['../outside.txt', 'src/../package.json', '/package.json', 'C:/private.txt', 'src\\fixture.mjs', '.env', '.git/config', 'data/private.json', 'node_modules/private.mjs', 'server/secrets/private.mjs', 'training/private.json']) await assert.rejects(f.builder.sourceFile(OWNER, { path: relative }), { code: 'invalid_source_path' });
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs', includeContent: true }), { code: 'invalid_source_query' });
});

test('sourceFile retains the existing snapshot file/count/byte and UTF-8 bounds', async t => {
  const f = await fixture(t), target = path.join(f.root, 'src/oversized.txt');
  await writeFile(target, 'x'.repeat(250001)); await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'source_limit' });
  await writeFile(target, Buffer.from([0xff])); await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'invalid_source_text' });
  await writeFile(target, Buffer.from([0])); await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'source_limit' });
  await writeFile(target, '');
  for (let index = 0; index < 16; index++) await writeFile(path.join(f.root, 'src', `bounded-${index}.txt`), 'x'.repeat(250000));
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'source_limit' });
  await Promise.all(Array.from({ length: 16 }, (_, index) => rm(path.join(f.root, 'src', `bounded-${index}.txt`))));
  await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(path.join(f.root, 'src', `count-${index}.txt`), '')));
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'source_limit' });
});

test('sourceFile refuses a static source junction instead of reading its private target', async t => {
  const f = await fixture(t), outside = path.join(f.temporary, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.mjs'), 'PRIVATE_TARGET_MUST_NOT_BE_RETURNED');
  try { await symlink(outside, path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ERR_ACCESS_DENIED'].includes(error.code)) { t.skip('This host or restricted verification process cannot create the synthetic junction.'); return; } throw error; }
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/linked/private.mjs' }), { code: 'unsafe_source_path' });
  await assert.rejects(f.builder.sourceFile(OWNER, { path: 'src/fixture.mjs' }), { code: 'unsafe_source_path' });
});
