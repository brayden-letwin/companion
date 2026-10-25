import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createFeatureBuilder } from '../server/feature-builder.mjs';
import { GENERATION_BUDGETS } from '../server/build-correction.mjs';

const OWNER = 'synthetic-editor-context-owner';
const EDITOR = 'src/workflow-editor.mjs';
const SUPPORT = 'tests/support/assistant-ui-fixture.mjs';
const REGRESSION = 'src/features/editor-context-regression.test.mjs';
const EXPECTED = 'Choose an action for this step';
const REGRESSION_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import {createUI} from '../../tests/support/assistant-ui-fixture.mjs';
test('requested empty action choice appears in the actual routine editor',async()=>{
  const app=await createUI();
  try{app.ui.openWorkflow();const select=app.nodes.get('workflow-steps').children[0].children[0].children[1];assert.equal(select.children[0].textContent,${JSON.stringify(EXPECTED)});}
  finally{app.close();}
});
`;

const usage = messages => ({
  messages: messages.length,
  maxMessageBytes: Math.max(...messages.map(message => Buffer.byteLength(message.content))),
  contentBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0),
  serializedBytes: Buffer.byteLength(JSON.stringify(messages)),
});

function assertWithinBudgets(messages) {
  const actual = usage(messages);
  for (const [name, limit] of Object.entries({ messages: GENERATION_BUDGETS.maxMessages, maxMessageBytes: GENERATION_BUDGETS.maxMessageBytes, contentBytes: GENERATION_BUDGETS.maxContentBytes, serializedBytes: GENERATION_BUDGETS.maxSerializedBytes })) {
    assert.ok(actual[name] <= limit, `${name} exceeds its unchanged complete-context limit`);
  }
  return actual;
}

async function settled(builder, id) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const job = await builder.get(id, OWNER);
    if (['ready', 'review_required', 'failed', 'conflict', 'cancelled', 'interrupted'].includes(job.status)) return job;
    assert.ok(Date.now() < deadline, 'Observe the original builder job before deciding how to recover.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// This integration runs from the normal repository suite, not from inside the
// guarded trusted baseline: it owns a disposable full-source copy and builder.
test('the complete routine editor and shared fixture fit generation and one actual verified correction', { timeout: 150000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-editor-context-'));
  const root = path.join(temporary, 'source');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  let builder, reader;
  t.after(async () => {
    await builder?.close();
    await reader?.close();
    assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep + 'companion-editor-context-'));
    await rm(temporary, { recursive: true, force: true });
  });
  // Reuse the production source whitelist; never copy node_modules, Git, private
  // databases, credentials or other runtime files into a candidate or prompt.
  reader = await createFeatureBuilder({ root: repository, dataDirectory: path.join(temporary, 'reader'), complete: async () => { throw Error('Source inspection cannot call a model.'); } });
  const baseline = await reader.source(OWNER, { includeContent: true });
  await reader.close();
  reader = null;
  assert.ok(baseline.files.length > 100, 'Exercise the real application inventory and required contracts.');
  for (const file of baseline.files) {
    const destination = path.join(root, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const editor = baseline.files.find(file => file.path === EDITOR)?.content;
  const support = baseline.files.find(file => file.path === SUPPORT)?.content;
  assert.equal(typeof editor, 'string');
  assert.equal(typeof support, 'string');
  assert.ok(editor.includes("'Choose an action'"));
  const calls = [];
  let generated = 0;
  builder = await createFeatureBuilder({ root, dataDirectory: path.join(temporary, 'private'), complete: async input => {
    calls.push(input);
    assertWithinBudgets(input.messages);
    if (input.schema.properties.paths) return { paths: [EDITOR, SUPPORT], reason: 'Edit the complete isolated routine editor and use the shared real-interface fixture for a new behavior regression.' };
    generated++;
    return { summary: 'Clarify the empty action choice in the routine editor.', files: [
      { path: EDITOR, content: editor.replace("'Choose an action'", JSON.stringify(generated === 1 ? 'Unfinished candidate choice' : EXPECTED)) },
      { path: REGRESSION, content: REGRESSION_SOURCE },
    ], tests: ['Open the real routine editor and verify its empty action option.'] };
  } });
  const prompt = `In the routine editor, change the empty action option to exactly ${JSON.stringify(EXPECTED)}. Preserve all existing actions, pins, drafts and save behavior. Add an actual UI regression. Do not edit the main interface or shared fixture.`;
  const queued = await builder.request({ prompt, providerId: 'synthetic', autoApply: true }, OWNER);
  const job = await settled(builder, queued.id);
  assert.equal(job.status, 'review_required', job.error);
  assert.equal(job.reviewRequired, true);
  assert.equal(job.generationAttempt, 2);
  assert.equal(calls.length, 3, 'One planning call, initial generation and one bounded correction.');
  assert.equal(generated, 2);
  assert.equal(job.contextPlans.length, 1);
  assert.deepEqual(job.contextPlans[0].paths, [EDITOR, SUPPORT]);
  assert.deepEqual(job.contextPlans[0].overruns, []);
  assert.equal(job.contextPlans[0].usage.contentBytes, usage(calls[1].messages).contentBytes);
  assert.equal(job.contextPlans[0].usage.serializedBytes, usage(calls[1].messages).serializedBytes);
  const initial = calls[1].messages.map(message => JSON.parse(message.content));
  for (const [file, original] of [[EDITOR, editor], [SUPPORT, support]]) assert.equal(initial.filter(part => part.source_file === file).map(part => part.content).join(''), original, 'Complete original source must be supplied without clipping.');
  assert.ok(!initial.some(part => ['src/assistant.mjs', 'tests/productivity-conversations-ui.test.mjs'].includes(part.source_file)), 'The narrow edit must not need the large main interface or full test file.');
  const correction = calls[2].messages.map(message => JSON.parse(message.content));
  assert.equal(correction.find(part => part.correction)?.correction.originalRequest, prompt);
  assert.equal(correction.filter(part => part.failed_candidate_file === EDITOR).map(part => part.content).join(''), editor.replace("'Choose an action'", JSON.stringify('Unfinished candidate choice')));
  assert.equal(correction.filter(part => part.failed_candidate_file === REGRESSION).map(part => part.content).join(''), REGRESSION_SOURCE);
  const first = await builder.getAttempt(job.id, 1, OWNER);
  const second = await builder.getAttempt(job.id, 2, OWNER);
  assert.equal(first.verification.passed, false);
  assert.equal(first.verification.checks.find(check => check.name === 'Existing trusted regression tests')?.passed, true);
  assert.equal(first.verification.checks.find(check => check.name === 'Feature-specific tests')?.passed, false, 'The first candidate must fail the actual new UI assertion.');
  assert.equal(second.verification.passed, true);
  assert.equal(second.verification.checks.find(check => check.name === 'Feature-specific tests')?.passed, true);
  assert.equal(await readFile(path.join(root, EDITOR), 'utf8'), editor, 'Protected source must stay unchanged until concrete review.');
  const candidate = path.join(temporary, 'private', job.id, 'candidate');
  assert.equal(await readFile(path.join(candidate, REGRESSION), 'utf8'), REGRESSION_SOURCE, 'The original acceptance test survives correction unchanged.');
  assert.equal(await readFile(path.join(candidate, 'trusted-regression-tests/support/assistant-ui-fixture.mjs'), 'utf8'), support, 'Trusted checks use the original fixture.');
  // Exercise the actual original 131-test UI suite with a hostile replacement
  // of its candidate helper. It must load the frozen original helper, observe
  // the broken real editor, and fail for that behavior rather than the decoy.
  const nameAssignment = "$('workflow-name').value=flow?.name||''";
  assert.ok(editor.includes(nameAssignment));
  const attackFiles = [
    { path: EDITOR, content: editor.replace(nameAssignment, "$('workflow-name').value='BROKEN_ACTUAL_UI_STATE'") },
    { path: SUPPORT, content: "throw Error('MUTABLE_CANDIDATE_FIXTURE_IMPORTED');\nexport async function createUI(){throw Error('Forged helper');}\n" },
  ];
  const attack = await builder.submitPatch({ summary: 'Reject a changed helper attempting to hide a broken real editor.', files: attackFiles, baseHashes: Object.fromEntries(attackFiles.map(file => [file.path, baseline.files.find(original => original.path === file.path).hash])), autoApply: false }, OWNER);
  const rejected = await settled(builder, attack.id);
  assert.equal(rejected.status, 'failed');
  assert.equal(calls.length, 3, 'An external patch must never trigger model correction.');
  const trustedFailure = rejected.verification.checks.find(check => check.name === 'Existing trusted regression tests');
  assert.equal(trustedFailure?.passed, false);
  assert.match(trustedFailure.output, /BROKEN_ACTUAL_UI_STATE/);
  assert.ok(!trustedFailure.output.includes('MUTABLE_CANDIDATE_FIXTURE_IMPORTED'), 'Original tests must never import the mutable helper.');
  await assert.rejects(builder.apply(rejected.id, OWNER), { code: 'feature_not_ready' });
  assert.equal(await readFile(path.join(root, EDITOR), 'utf8'), editor);
  assert.equal(await readFile(path.join(root, SUPPORT), 'utf8'), support);
  t.diagnostic(JSON.stringify({ sourceFiles: baseline.files.length, sourceBytes: baseline.files.reduce((sum, file) => sum + file.bytes, 0), editorBytes: Buffer.byteLength(editor), fixtureBytes: Buffer.byteLength(support), generation: usage(calls[1].messages), correction: usage(calls[2].messages), firstAttemptPassed: first.verification.passed, secondAttemptPassed: second.verification.passed, frozenOriginalSuiteRejectedChangedHelperAndBrokenUI: true, activated: false }));
});
