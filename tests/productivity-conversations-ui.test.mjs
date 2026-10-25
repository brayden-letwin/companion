import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalDeadline } from '../src/core/productivity-deadlines.mjs';
import { taskDeadlineView } from '../server/task-deadline-view.mjs';
import { createUI, Element, createLocks, response, deferred, copy, blank, until, historyRecord, historyPage, html, A, B, C, D, E, F, descendants, serviceFixture, freshService, delayTurn } from './support/assistant-ui-fixture.mjs';

test('explicit New survives a late initial history response and first send creates exactly one saved conversation', async () => {
  const listing = deferred();
  const app = await createUI({ saved: [blank(A, 'Earlier')], waitForConversations: false, intercept: (url, options) => url.endsWith('/conversations') && !options.method ? listing.promise : null });
  try {
    await app.ui.selectConversation(null); listing.resolve(response({ conversations: [{ ...blank(A, 'Earlier'), turnCount: 0 }] }));
    await until(() => !app.ui.get().listPending);
    assert.equal(app.ui.get().id, null);
    app.setIntercept(null); app.nodes.get('question').value = 'Remember this request.';
    await app.ui.runCommand('Remember this request.');
    const posts = app.requests.filter(item => item.url.endsWith('/conversations') && item.method === 'POST');
    assert.equal(posts.length, 1);
    const chats = app.requests.filter(item => item.url.endsWith('/chat'));
    assert.equal(chats.length, 1); const body = JSON.parse(chats[0].body);
    assert.equal(body.conversationId, app.ui.get().id); assert.equal(body.expectedRevision, 0); assert.equal('history' in body, false);
    assert.equal(app.ui.get().detail.turns.length, 1); assert.equal(app.nodes.get('question').value, '');
    assert.equal(JSON.parse(app.storage.get('companion.workspace.ui.v1.conversationId')), body.conversationId);
    assert.ok([...app.storage.values()].every(value => !value.includes('Remember this request.')));
  } finally { app.close(); }
});

test('drafts stay with their conversation and a late old detail cannot replace the selected transcript', async () => {
  const a = blank(A, 'First'), b = blank(B, 'Second');
  const app = await createUI({ saved: [a, b], selected: A });
  try {
    app.nodes.get('question').value = 'Draft A'; await app.nodes.get('question').dispatch('input');
    await app.ui.selectConversation(B); app.nodes.get('question').value = 'Draft B'; await app.nodes.get('question').dispatch('input');
    await app.ui.selectConversation(A); assert.equal(app.nodes.get('question').value, 'Draft A');
    const late = deferred(); app.setIntercept(url => url.endsWith('/conversations/' + A) ? late.promise : null);
    const oldFetch = app.ui.refreshConversation(); await app.ui.selectConversation(B);
    late.resolve(response({ ...a, revision: 7, turns: [{ id: 'old', status: 'completed', message: 'Old transcript', reply: { text: 'Late old response', actions: [] } }] })); await oldFetch;
    assert.equal(app.ui.get().id, B); assert.equal(app.nodes.get('question').value, 'Draft B');
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Late old response/);
  } finally { app.close(); }
});

test('a lost response reconciles an accepted turn without resending and a reload restores it', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const body = JSON.parse(options.body), record = records.get(A);
      record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'running', startedAt: '2026-10-24T12:00:01Z' }); record.activeRequestId = body.id; record.revision++;
      throw new Error('Synthetic lost response');
    });
    app.nodes.get('question').value = 'A durable request'; await app.ui.runCommand('A durable request');
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
    assert.equal(app.ui.get().detail.turns[0].status, 'running'); assert.match(app.nodes.get('messages').textContent, /saved and running/);
    const record = app.records.get(A); record.turns[0].status = 'interrupted'; record.turns[0].error = { code: 'request_interrupted', message: 'Interrupted on restart', actions: [] }; record.activeRequestId = null; record.revision++;
    await app.ui.refreshConversation(); assert.match(app.nodes.get('messages').textContent, /Interrupted on restart/);
    const reload = await createUI({ saved: [copy(record)], selected: A });
    try { assert.equal(reload.ui.get().detail.turns[0].message, 'A durable request'); assert.match(reload.nodes.get('messages').textContent, /Interrupted/); assert.equal(reload.requests.filter(item => item.url.endsWith('/chat')).length, 0); } finally { reload.close(); }
  } finally { app.close(); }
});

test('active selection is locked; cancellation and a late completed response cannot retarget another conversation', async () => {
  const pending = deferred(); const app = await createUI({ saved: [blank(A), blank(B)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const body = JSON.parse(options.body), record = records.get(A); record.turns.push({ id: body.id, message: body.message, providerId: body.providerId, status: 'running', startedAt: '2026-10-24T12:00:00Z' }); record.activeRequestId = body.id; record.revision++;
      return pending.promise;
    });
    app.nodes.get('question').value = 'Request A'; const turn = app.ui.runCommand('Request A');
    await until(() => app.requests.some(item => item.url.endsWith('/chat')));
    assert.equal(app.nodes.get('conversation-select').disabled, true); assert.equal(await app.ui.selectConversation(B), false); assert.equal(app.ui.get().id, A);
    app.ui.cancelTurn(false); await app.ui.selectConversation(B);
    const record = app.records.get(A), savedTurn = record.turns[0]; savedTurn.status = 'completed'; savedTurn.reply = { id: savedTurn.id, text: 'Completed only in A', actions: [], providerId: 'codex' }; record.activeRequestId = null; record.revision++;
    pending.resolve(response({ ...savedTurn.reply, conversationId: A, conversationRevision: record.revision })); await turn;
    assert.equal(app.ui.get().id, B); assert.doesNotMatch(app.nodes.get('messages').textContent, /Completed only in A/);
    await app.ui.selectConversation(A); assert.match(app.nodes.get('messages').textContent, /Completed only in A/);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('voice captures its conversation before microphone permission and rejects that context after a switch', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], selected: A });
  try {
    const opening = app.ui.startRecording(); assert.equal(app.nodes.get('conversation-select').disabled, true); assert.equal(await app.ui.selectConversation(B), false);
    await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening; const item = app.ui.get().recording; assert.equal(item.conversationContext.id, A);
    app.ui.cancelTurn(false); assert.equal(app.stoppedTracks, 1); await app.ui.selectConversation(B);
    await app.ui.runCommand('Old voice words', { voice: true, providerId: item.providerId, conversationContext: item.conversationContext, approvalContext: null });
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.match(app.nodes.get('question-error').textContent, /conversation changed/);
  } finally { app.close(); }
});

test('historical desktop receipts do not revive an action that is already completed', async () => {
  const action = { id: B, status: 'pending', summary: 'Synthetic input', createdAt: '2026-10-24T12:00:00Z', expiresAt: new Date(Date.now() + 60000).toISOString(), requiresApproval: true, target: { windowId: 'fixture', title: 'Fixture', elementId: 'field' }, preview: { action: 'setText', text: 'Synthetic' } };
  const detail = blank(A); detail.revision = 2; detail.turns.push({ id: 'saved', message: 'Prepare text', providerId: 'codex', status: 'completed', reply: { text: 'Please review.', actions: [{ tool: 'desktop_propose_action', status: 'pending', result: { desktopAction: action } }] } });
  const app = await createUI({ saved: [detail], selected: A });
  try {
    app.ui.rememberDesktopAction({ ...action, status: 'completed' }); app.ui.renderSavedConversation();
    assert.equal(app.ui.get().desktop.find(item => item.id === B).status, 'completed');
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Needs your review|Prepared desktop action/);
    assert.match(app.nodes.get('messages').textContent, /Completed/);
  } finally { app.close(); }
});

test('a revision conflict preserves the draft and reconciles the actual accepted request', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null;
      const current = records.get(A); current.revision = 2;
      current.turns.push({ id: 'other-window', message: 'Other window request', providerId: 'codex', status: 'completed', reply: { text: 'Other window result', actions: [] } });
      return response({ error: { code: 'revision_conflict', message: 'The conversation changed. Review and send again.' }, conversation: current }, 409);
    });
    app.nodes.get('question').value = 'Keep my exact draft'; await app.ui.runCommand('Keep my exact draft');
    assert.equal(app.nodes.get('question').value, 'Keep my exact draft');
    assert.match(app.nodes.get('messages').textContent, /Other window result/);
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Keep my exact draft/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('loading an older page preserves current revision, active state and draft and rejects a late page after switching', async () => {
  const older = { id: 'older-turn', message: 'An earlier message', status: 'completed', reply: { text: 'An earlier reply', actions: [] } };
  const latest = { ...blank(A), revision: 8, totalTurns: 2, hasMore: true, olderThan: 'latest-turn', turns: [{ id: 'latest-turn', message: 'Latest message', status: 'completed', reply: { text: 'Latest reply', actions: [] } }] };
  const app = await createUI({ saved: [latest, blank(B)], selected: A });
  try {
    app.nodes.get('question').value = 'Unsent current draft';
    app.setIntercept(url => url.includes('/conversations/' + A + '?before=') ? response({ ...blank(A), revision: 1, activeRequestId: 'obsolete', hasMore: false, turns: [older], olderThan: older.id }) : null);
    await app.ui.loadEarlierConversation();
    assert.equal(app.ui.get().detail.revision, 8); assert.equal(app.ui.get().detail.activeRequestId, null);
    assert.equal(app.nodes.get('question').value, 'Unsent current draft');
    assert.match(app.nodes.get('messages').textContent, /An earlier reply/); assert.match(app.nodes.get('messages').textContent, /Latest reply/);
    await app.ui.selectConversation(B); await app.ui.selectConversation(A);
    const pending = deferred(); app.setIntercept(url => url.includes('/conversations/' + A + '?before=') ? pending.promise : null);
    const oldPage = app.ui.loadEarlierConversation(); await app.ui.selectConversation(B);
    pending.resolve(response({ ...blank(A), hasMore: false, turns: [older] })); await oldPage;
    assert.equal(app.ui.get().id, B); assert.doesNotMatch(app.nodes.get('messages').textContent, /An earlier reply/);
  } finally { app.close(); }
});

test('voice stops when hidden and reacquires its capture owner with granted permission on return', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    assert.equal(app.ui.get().voiceState.status, 'listening');
    await app.ui.setVoiceVisible(false); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.get().ownsVoice, false);
    const showing = app.ui.setVoiceVisible(true); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await showing;
    assert.equal(app.ui.get().voiceState.status, 'listening'); assert.equal(app.ui.get().ownsVoice, true);
  } finally { app.close(); }
});

test('a paused dialog microphone explicitly resumes with freshly frozen review context', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const action = { id: A, status: 'pending', summary: 'Synthetic prepared text', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), requiresApproval: true, target: { windowId: 'fixture-window', title: 'Fixture editor', elementId: 'fixture-field' }, preview: { action: 'setText', text: 'Exact synthetic text' } };
    app.setIntercept(url => url.endsWith('/desktop/actions') ? response({ actions: [action] }) : null);
    await app.ui.openDesktopReview(A); assert.equal(app.ui.get().recording, null); assert.equal(app.ui.get().voiceState.status, 'paused');
    const restarting = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await restarting;
    assert.equal(app.ui.get().voiceState.status, 'listening'); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.get().recording.approvalContext.id, A);
  } finally { app.close(); }
});

test('closing the actual review dialog resumes after its cleanup listeners with no retained approval context', async () => {
  const app = await createUI();
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    app.ui.showDialog('desktop-review-dialog'); assert.equal(app.ui.get().voiceState.status, 'paused');
    const dialog = app.nodes.get('desktop-review-dialog'); dialog.close(); await dialog.dispatch('close');
    await until(() => app.waitingForMicrophone); app.grantMicrophone(); await until(() => app.ui.get().voiceState.status === 'listening');
    assert.equal(app.ui.get().recording.approvalContext, null); assert.equal(app.stoppedTracks, 1);
  } finally { app.close(); }
});

test('only one Companion window can capture voice at a time, without requiring operating-system focus', async () => {
  const locks = createLocks(), first = await createUI({ locks }), second = await createUI({ locks });
  try {
    const opening = first.ui.startRecording(); await until(() => first.waitingForMicrophone); first.grantMicrophone(); await opening;
    await second.ui.startRecording(); assert.equal(second.waitingForMicrophone, false); assert.equal(first.ui.get().voiceState.status, 'listening');
    assert.match(second.nodes.get('question-error').textContent, /another Companion window/);
    await first.ui.setVoiceVisible(false);
    const handoff = second.ui.startRecording(); await until(() => second.waitingForMicrophone); second.grantMicrophone(); await handoff;
    assert.equal(second.ui.get().voiceState.status, 'listening'); assert.equal(first.ui.get().ownsVoice, false);
  } finally { first.close(); second.close(); }
});

test('the default canvas keeps chat closed and only actual human voice commands navigate', async () => {
  const app = await createUI();
  try {
    assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'show tasks'); assert.equal(app.ui.get().currentView, 'today');
    const options = { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null };
    await app.ui.runCommand('show tasks', options); assert.equal(app.ui.get().currentView, 'tasks');
    await app.ui.runCommand('show chat', options); assert.equal(app.ui.get().chatOpen, true); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('hide chat', options); assert.equal(app.ui.get().chatOpen, false);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('a failed voice chat inhibits automatic listening instead of repeating an uncertain request', async () => {
  const app = await createUI({ saved: [blank(A)], selected: A });
  try {
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const voiceContext = copy(app.ui.get().recording);
    app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'provider_failed', message: 'Synthetic provider failure' } }, 502) : null);
    app.nodes.get('question').value = 'A failing voice request';
    await app.ui.runCommand('A failing voice request', { voice: true, providerId: voiceContext.providerId, conversationContext: voiceContext.conversationContext, approvalContext: null });
    assert.equal(app.ui.get().voiceState.enabled, false); assert.equal(app.ui.get().ownsVoice, false); assert.equal(app.waitingForMicrophone, false);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('Memory shows actual saved preferences and Forget and Remember again use reversible tools', async () => {
  const preference = { id: A, key: 'reply_style', label: 'Reply style', value: 'Keep replies concise.', archived: false };
  const app = await createUI({ workspacePreferences: [preference] });
  try {
    const calls = [];
    app.setIntercept((url, options, { workspace }) => {
      if (!url.endsWith('/tools/run')) return null;
      const body = JSON.parse(options.body); calls.push(body);
      if (body.tool === 'forget_preference') { assert.equal(body.arguments.preferenceId, A); workspace.preferences[0].archived = true; }
      else { assert.equal(body.tool, 'remember_preference'); assert.equal(body.arguments.key, 'reply_style'); assert.equal(body.arguments.value, preference.value); workspace.preferences[0].archived = false; }
      workspace.revision++; return response({ result: { preference: workspace.preferences[0] }, workspace });
    });
    assert.match(app.nodes.get('memory-list').textContent, /Keep replies concise/);
    await app.nodes.get('memory-list').children[0].children.at(-1).dispatch('click'); await until(() => /No preferences/.test(app.nodes.get('memory-list').textContent));
    app.nodes.get('memory-show-forgotten').checked = true; await app.nodes.get('memory-show-forgotten').dispatch('change');
    assert.match(app.nodes.get('memory-list').textContent, /Remember again/);
    await app.nodes.get('memory-list').children[0].children.at(-1).dispatch('click'); await until(() => /Forget/.test(app.nodes.get('memory-list').textContent));
    assert.equal(calls.length, 2); assert.notEqual(calls[0].operationId, calls[1].operationId);
  } finally { app.close(); }
});

const feature = (id, title, aliases = []) => ({ id, title, aliases, module: './features/' + id + '.mjs' });
const argumentField = (app, name) => descendants(app.nodes.get('workflow-steps')).find(node => node.dataset.argument === name);
const customAction = (overrides = {}) => ({ name: 'cap_scale', title: 'Scale values', description: 'Scale a small list of values.', kind: 'capability', capabilityId: 'scale', featureId: 'scale-panel', version: '1', hash: 'a'.repeat(64), workflowAllowed: true, effectPolicy: 'pure', parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 40 }, count: { type: 'integer', minimum: 1, maximum: 5 }, rate: { type: 'number', minimum: 0, maximum: 1 }, rounded: { type: 'boolean' }, unit: { type: 'string', enum: ['meters', 'feet'] }, values: { type: 'array', items: { type: 'number' }, maxItems: 3 }, options: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false } }, required: ['name', 'count', 'rate', 'rounded', 'unit', 'values', 'options'] }, ...overrides });

test('an installed panel opens through its normalized voice alias and assistant text never opens it', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async () => ({ mount: ({ container }) => { container.textContent = 'A real mounted fixture'; } }));
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('time-zones', 'Time zones', ['Zone converter'])] });
    app.ui.addMessage('assistant', 'open zone converter'); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('show ＺＯＮＥ ＣＯＮＶＥＲＴＥＲ', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.equal(app.ui.get().currentView, 'extension-time-zones');
    assert.match(app.nodes.get('extension-nav').textContent, /Say “open Time zones”/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('ambiguous, failed, duplicate and removed panel names open Tools without choosing a different feature', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async url => { if (url.includes('broken')) throw new Error('Synthetic missing module'); return { mount() {} }; });
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('first', 'First', ['converter']), feature('second', 'Second', ['converter']), feature('broken', 'Broken')] });
    app.ui.openFeatureByName('converter'); assert.equal(app.nodes.get('tools-menu').open, true); assert.match(app.nodes.get('tools-message').textContent, /More than one/); assert.equal(app.ui.get().currentView, 'today');
    app.ui.openFeatureByName('Broken'); assert.match(app.nodes.get('tools-message').textContent, /could not open/); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.applyExtensionManifest({ version: 1, features: [feature('same', 'Duplicate one'), feature('same', 'Duplicate two')] });
    assert.equal(app.ui.get().extensions.length, 0); assert.match(app.nodes.get('extension-nav').textContent, /duplicate installation ID/);
    await app.ui.applyExtensionManifest({ version: 1, features: [] });
    await app.ui.runCommand('open First', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.match(app.nodes.get('tools-message').textContent, /not available/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
  } finally { app.close(); }
});

test('capability-only tools remain discoverable and an unavailable registry is not labeled uninstalled', async () => {
  const app = await createUI({ catalog: [customAction()] });
  try {
    await app.ui.refreshToolCatalog();
    assert.match(app.nodes.get('extension-nav').textContent, /Scale valuesAvailable by voice/);
    await app.ui.runCommand('open Scale values', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.match(app.nodes.get('tools-message').textContent, /available by voice/); assert.equal(app.ui.get().currentView, 'today');
    app.ui.applyToolCatalog({ tools: [], capabilityStatus: { ready: false, message: 'Installed action registry needs attention.' } });
    assert.match(app.nodes.get('extension-nav').textContent, /needs attention/); assert.doesNotMatch(app.nodes.get('extension-nav').textContent, /No installed tools yet/);
  } finally { app.close(); }
});

test('workflow fields come from the catalog and preserve typed values and invalid structured drafts', async () => {
  const meta = customAction(), forbidden = customAction({ name: 'desktop_forbidden', title: 'External input', workflowAllowed: false });
  const app = await createUI({ catalog: [meta, forbidden] });
  try {
    await app.ui.refreshToolCatalog(); app.ui.openWorkflow();
    const choose = app.nodes.get('workflow-steps').children[0].children[0].children[1];
    assert.ok(choose.children.some(node => node.value === 'cap_scale')); assert.equal(choose.children.some(node => node.value === 'desktop_forbidden'), false);
    choose.value = 'cap_scale'; await choose.dispatch('change');
    for (const [name, value, event] of [['name', 'Fixture', 'input'], ['count', '3', 'input'], ['rate', '0.5', 'input'], ['rounded', 'false', 'change'], ['unit', '1', 'change'], ['values', '[1,2]', 'input'], ['options', '{"tag":"test"}', 'input']]) { const input = argumentField(app, name); input.value = value; await input.dispatch(event); }
    let step = app.ui.get().workflowDraft[0]; assert.equal(step.arguments.count, 3); assert.equal(step.arguments.rate, 0.5); assert.equal(step.arguments.rounded, false); assert.equal(step.arguments.unit, 'feet');
    app.ui.validateWorkflowSteps(app.ui.get().workflowDraft);
    const list = argumentField(app, 'values'); list.value = '['; await list.dispatch('input'); assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /valid list/);
    app.ui.renderWorkflowSteps(); assert.equal(argumentField(app, 'values').value, '['); assert.equal(app.ui.get().workflowDraft[0].arguments.values.length, 2);
    const fixed = argumentField(app, 'values'); fixed.value = '[1,2,3,4]'; await fixed.dispatch('input'); assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /number of items/);
  } finally { app.close(); }
});

test('missing or changed saved capability steps retain their pin and values until explicit reselection', async () => {
  const meta = customAction({ parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const app = await createUI({ catalog: [meta] });
  try {
    await app.ui.refreshToolCatalog();
    app.ui.openWorkflow({ id: A, name: 'Saved', steps: [{ tool: 'cap_scale', arguments: { text: 'Preserve this' }, capability: { id: 'scale', version: '0', hash: 'b'.repeat(64) } }] });
    assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /tool changed/);
    assert.equal(app.ui.get().workflowDraft[0].arguments.text, 'Preserve this'); assert.equal(app.ui.get().workflowDraft[0].capability.version, '0');
    const update = descendants(app.nodes.get('workflow-steps')).find(node => node.textContent === 'Use updated action'); await update.dispatch('click');
    assert.deepEqual(copy(app.ui.get().workflowDraft[0].capability),{id:meta.capabilityId,version:meta.version,hash:meta.hash}); assert.equal(app.ui.get().workflowDraft[0].arguments.text, 'Preserve this'); app.ui.validateWorkflowSteps(app.ui.get().workflowDraft);
    app.ui.openWorkflow({ id: A, name: 'Missing', steps: [{ tool: 'cap_removed', arguments: { text: 'Retained value' }, capability: { id: 'removed', version: '1', hash: 'c'.repeat(64) } }] });
    assert.match(app.nodes.get('workflow-steps').textContent, /not installed/); assert.match(app.nodes.get('workflow-steps').textContent, /Retained value/);
    assert.throws(() => app.ui.validateWorkflowSteps(app.ui.get().workflowDraft), /not installed/); assert.equal(app.ui.get().workflowDraft[0].tool, 'cap_removed');
  } finally { app.close(); }
});

test('a ready installed feature gets an explicit Open action and failed panels are never labeled ready', async () => {
  const app = await createUI();
  try {
    app.ui.setExtensionLoader(async () => ({ mount() {} })); await app.ui.applyExtensionManifest({ version: 1, features: [feature('ready-panel', 'Ready panel')] });
    const container = new Element(); app.ui.appendInstalledFeatureReady(container, { status: 'applied', providedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.match(container.textContent, /Ready panel ready/); await container.children[0].children[1].dispatch('click'); assert.equal(app.ui.get().currentView, 'extension-ready-panel');
    app.ui.setExtensionLoader(async () => { throw new Error('Synthetic mount failure'); }); await app.ui.applyExtensionManifest({ version: 1, features: [feature('ready-panel', 'Ready panel')] });
    const failed = new Element(); app.ui.appendInstalledFeatureReady(failed, { status: 'applied', installedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.doesNotMatch(failed.textContent, /ready\./); assert.match(failed.textContent, /could not open/);
    await app.ui.applyExtensionManifest({ version: 1, features: [] }); const removed = new Element(); app.ui.appendInstalledFeatureReady(removed, { status: 'applied', providedFeatures: [{ id: 'ready-panel', title: 'Ready panel' }] });
    assert.match(removed.textContent, /not currently available/); assert.doesNotMatch(removed.textContent, /is installed|ready\./);
  } finally { app.close(); }
});

test('panel action helpers use real tool receipts and retain partial error receipts without retrying', async () => {
  const app = await createUI({ catalog: [customAction()] });
  try {
    let api, calls = 0; app.ui.setExtensionLoader(async () => ({ mount: value => { api = value.api; } })); await app.ui.applyExtensionManifest({ version: 1, features: [feature('scale-panel', 'Scale values')] });
    app.setIntercept((url, options, { workspace }) => {
      if (!url.endsWith('/tools/run')) return null;
      const body = JSON.parse(options.body); assert.equal(body.tool, 'cap_scale'); assert.equal(body.arguments.count, 2); calls++;
      if (calls === 1) { workspace.revision++; workspace.tasks.push({ id: A, title: 'Actual server task', status: 'todo' }); return response({ tool: body.tool, result: { capability: { id: 'scale', name: 'cap_scale' }, value: { total: 8 }, hostActions: [] }, workspace }); }
      return response({ error: { code: 'capability_failed', message: 'Synthetic partial failure' }, capability: { id: 'scale', name: 'cap_scale' }, hostActions: [{ tool: 'create_task', status: 'completed', result: { task: { title: 'Actual server task' } } }] }, 500);
    });
    const value = await api.runTool('cap_scale', { count: 2 }); assert.equal(value.result.value.total, 8); assert.equal(app.ui.get().workspace.tasks.length, 1);
    await assert.rejects(api.runTool('cap_scale', { count: 2 }), error => error.code === 'capability_failed' && error.hostActions.length === 1 && error.capability.id === 'scale'); assert.equal(calls, 2);
    const receipt = new Element(); app.ui.renderActionReceipts(receipt, [{ tool: 'run_capability', arguments: { name: 'cap_scale' }, status: 'failed', result: { error: 'Synthetic partial failure', hostActions: [{ tool: 'create_task', status: 'completed', result: { task: { title: 'Actual server task' } } }] } }]);
    assert.match(receipt.textContent, /could not finish/); assert.match(receipt.textContent, /Actual server task/); assert.doesNotMatch(receipt.textContent, /Scale values · completed/);
  } finally { app.close(); }
});

test('saving edited workflows preserves existing pins and explicitly pins newly selected custom actions', async () => {
  const meta = customAction({ parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const app = await createUI({ catalog: [meta] });
  try {
    await app.ui.refreshToolCatalog(); const pin = { id: meta.capabilityId, version: meta.version, hash: meta.hash };
    app.ui.openWorkflow({ id: A, name: 'Saved', steps: [{ tool: 'cap_scale', arguments: { text: 'Existing value' }, capability: pin }] });
    await app.nodes.get('add-workflow-step').dispatch('click'); const row = app.nodes.get('workflow-steps').children[1], choose = row.children[0].children[1]; choose.value = 'cap_scale'; await choose.dispatch('change');
    const inputs = descendants(app.nodes.get('workflow-steps')).filter(node => node.dataset.argument === 'text'); inputs[1].value = 'New value'; await inputs[1].dispatch('input');
    let saved;
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace/operations')) return null; saved = JSON.parse(options.body); workspace.revision++; workspace.workflows = [{ id: A, name: saved.name, steps: saved.steps }]; return response({ workspace, replayed: false }); });
    await app.nodes.get('workflow-form').dispatch('submit', { preventDefault() {} });
    assert.equal(saved.type, 'saveWorkflow'); assert.deepEqual(saved.steps[0].capability, pin); assert.equal(saved.steps[0].arguments.text, 'Existing value'); assert.equal(saved.steps[1].arguments.text, 'New value'); assert.deepEqual(saved.steps[1].capability,pin);
  } finally { app.close(); }
});

test('an uncertain workflow run checks its exact saved identity through GET and only a later explicit Run creates new effects',async()=>{
  const meta=customAction({parameters:{type:'object',properties:{},additionalProperties:false}}),flow={id:A,name:'Receipt fixture',enabled:true,steps:[{tool:meta.name,arguments:{},capability:{id:meta.capabilityId,version:meta.version,hash:meta.hash}}]},app=await createUI({catalog:[meta],workspaceWorkflows:[flow]});
  try{const posts=[],reads=[];let effects=0;app.setIntercept((url,options,{workspace})=>{if(url.endsWith('/workflows/'+A+'/run')){posts.push(JSON.parse(options.body));effects++;if(posts.length===1){workspace.tasks.push({id:B,title:'One actual effect',status:'todo'});throw new Error('Synthetic response lost after acceptance');}return response({id:A,runId:C,status:'completed',steps:[],workspace});}if(url.includes('/workflows/'+A+'/operations/')){reads.push(url);assert.equal(options.method,undefined);assert.equal(options.body,undefined);assert.ok(url.endsWith('/operations/'+posts[0].operationId));const status=reads.length===1?'running':'completed';return response(historyPage(historyRecord(flow,{id:A,status,steps:[]},{operationId:posts[0].operationId})));}return null;});await app.ui.runWorkflow(flow);assert.equal(posts.length,1);assert.match(app.nodes.get('workflow-list').textContent,/Check last run/);const pending=JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns'));assert.deepEqual(pending,[{workflowId:A,operationId:posts[0].operationId}]);app.ui.applyToolCatalog({tools:[],capabilityStatus:{ready:false,message:'Current tool changed'}});await app.ui.runWorkflow({...flow,enabled:false,steps:[{tool:'cap_removed',arguments:{}}]});assert.equal(posts.length,1);assert.equal(reads.length,1);assert.match(app.nodes.get('workflow-list').textContent,/still running/);await app.ui.runWorkflow(flow);assert.equal(posts.length,1);assert.equal(reads.length,2);assert.equal(effects,1);assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')),[]);await app.ui.runWorkflow(flow);assert.equal(posts.length,2);assert.notEqual(posts[1].operationId,posts[0].operationId);assert.equal(effects,2);}finally{app.close();}
});

test('reload retains only workflow identities and an explicit pending Check is GET-only even for an unavailable saved definition',async()=>{
  const flow={id:A,name:'Saved pending workflow',enabled:false,steps:[{tool:'cap_removed',arguments:{text:'Original values remain on server'}}]},record=historyRecord(flow,{id:A,status:'cancelled',error:'Stopped after its recorded steps.',steps:[]},{operationId:B}),app=await createUI({workspaceWorkflows:[flow],savedWorkflowHistory:[record],storedWorkflowRuns:[{workflowId:A,operationId:B}]});
  try{assert.equal(app.requests.some(call=>call.url.includes('/operations/'+B)),false);const check=descendants(app.nodes.get('workflow-list')).find(node=>node.tagName==='button'&&node.textContent==='Check last run');assert.ok(check);assert.equal(check.disabled,false);await check.dispatch('click');await until(()=>/Workflow stopped:/.test(app.nodes.get('workflow-list').textContent));const calls=app.requests.filter(call=>/\/workflows\//.test(call.url));assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/operations/'+B));assert.equal(calls[0].method,'GET');assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')),[]);assert.ok([...app.storage.values()].every(value=>!value.includes('Original values remain on server')));}finally{app.close();}
});

test('long build instructions and summaries stay out of headings while exact criteria remain in a collapsed disclosure', async () => {
  const app = await createUI();
  try {
    const prompt = 'Build a duration formatter with a clear input and result. ' + 'Keep all requested behavior and verify every boundary case. '.repeat(200) + '\nExact final criterion: preserve this entire request.';
    const job = { id: A, prompt, summary: '', status: 'generating', createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:01Z', files: [], events: [{ at: '2026-10-24T12:00:01Z', type: 'generation', message: 'Generating the actual source.' }] };
    app.setIntercept(url => url.endsWith('/features') ? response({ jobs: [{ ...job, files: undefined }] }) : url.endsWith('/features/' + A) ? response(job) : null);
    await app.ui.refreshJobs(); await until(() => descendants(app.nodes.get('job-detail')).some(node => node.className?.includes('job-original-request')));
    const heading = descendants(app.nodes.get('job-detail')).find(node => node.tagName === 'h2');
    const card = descendants(app.nodes.get('job-list')).find(node => node.className === 'job-name');
    const original = descendants(app.nodes.get('job-detail')).find(node => node.className?.includes('job-original-request'));
    assert.ok(heading.textContent.length <= 84); assert.ok(card.textContent.length <= 64); assert.doesNotMatch(heading.textContent, /Exact final criterion/);
    assert.equal(original.open, false); assert.equal(original.children[0].textContent, 'Build instructions'); assert.equal(original.children[1].textContent, prompt);
    assert.match(app.nodes.get('job-detail').textContent, /Cancel build/); assert.match(app.nodes.get('job-detail').textContent, /Generating the actual source/);
    job.summary = 'Implemented a duration formatter. ' + 'Detailed implementation notes. '.repeat(65); job.status = 'review_required'; job.reviewRequired = true; job.updatedAt = '2026-10-24T12:00:02Z'; job.verification = { passed: true, checks: [{ name: 'Behavior check', passed: true, output: 'Boundary cases verified.' }] };
    await app.ui.refreshJobs(); await until(() => /Boundary cases verified/.test(app.nodes.get('job-detail').textContent));
    const updatedHeading = descendants(app.nodes.get('job-detail')).find(node => node.tagName === 'h2'); assert.ok(updatedHeading.textContent.length <= 84); assert.notEqual(updatedHeading.textContent, job.summary);
    assert.match(app.nodes.get('job-detail').textContent, /Activate feature/); assert.equal(descendants(app.nodes.get('job-detail')).find(node => node.className?.includes('job-original-request')).children[1].textContent, prompt);
  } finally { app.close(); }
});

const taskId = number => '00000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
const taskFixture = (number, overrides = {}) => ({ id: taskId(number), title: 'Task ' + number, details: '', project: '', status: 'todo', priority: 'normal', dueAt: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(), ...overrides });
const visibleTaskIds = app => app.nodes.get('task-list').children.filter(node => node.className?.includes('task-row')).map(node => node.dataset.taskId);

test('task search covers all saved title, details and project text beyond the first hundred displayed matches', async () => {
  const old = taskFixture(1, { title: 'Old research task', details: 'Legacy integration marker', project: 'Archive research', createdAt: '2020-01-01T00:00:00Z' });
  const tasks = [old, ...Array.from({ length: 124 }, (_, index) => taskFixture(index + 2, { priority: 'high' }))];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    assert.equal(visibleTaskIds(app).length, 50); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 50 of 125 matching tasks.');
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change');
    assert.equal(visibleTaskIds(app).includes(old.id), false);
    for (const query of ['old research', 'legacy marker', 'archive research']) { app.nodes.get('tasks-search').value = query; await app.nodes.get('tasks-search').dispatch('input'); assert.deepEqual(visibleTaskIds(app), [old.id]); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 1 of 1 matching task.'); }
    app.nodes.get('tasks-search').value = ''; await app.nodes.get('tasks-search').dispatch('input');
    await app.nodes.get('tasks-show-more').dispatch('click'); assert.equal(visibleTaskIds(app).length, 100); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 100 of 125 matching tasks.');
    assert.equal(app.nodes.get('tasks-show-more').textContent, 'Show 25 more'); await app.nodes.get('tasks-show-more').dispatch('click'); assert.equal(visibleTaskIds(app).length, 125); assert.equal(app.nodes.get('tasks-show-more').hidden, true);
    app.nodes.get('tasks-sort').value = 'created'; await app.nodes.get('tasks-sort').dispatch('change'); assert.equal(visibleTaskIds(app).length, 50);
  } finally { app.close(); }
});

test('project filters distinguish literal Unassigned and reserved-looking names from tasks with no project', async () => {
  const tasks = [taskFixture(1), taskFixture(2, { project: null }), taskFixture(3, { project: 'Unassigned' }), taskFixture(4, { project: 'No project' }), taskFixture(5, { project: 'All projects' }), taskFixture(6, { project: '__proto__' })];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    const project = app.nodes.get('tasks-project');
    project.value = 'none'; await project.dispatch('change'); assert.deepEqual(visibleTaskIds(app), [tasks[0].id, tasks[1].id]);
    for (const name of ['Unassigned', 'No project', 'All projects', '__proto__']) { project.value = 'project:' + name; await project.dispatch('change'); assert.deepEqual(visibleTaskIds(app), [tasks.find(task => task.project === name).id]); }
    assert.ok(project.children.some(option => option.value === 'none' && option.textContent === 'No project'));
    assert.ok(project.children.some(option => option.value === 'project:No project' && option.textContent === 'No project (project)'));
  } finally { app.close(); }
});

test('task sorts use creation order, high priority and due dates with undated tasks last', async () => {
  const tasks = [taskFixture(5, { priority: 'high', dueAt: '2026-05-01T12:00:00Z' }), taskFixture(1), taskFixture(6, { createdAt: '2025-12-31T00:00:00Z' }), taskFixture(3, { priority: 'high', dueAt: '2026-05-01T12:00:00Z' }), taskFixture(2, { dueAt: '2026-05-10T12:00:00Z' }), taskFixture(4, { dueAt: 'invalid' })];
  const app = await createUI({ workspaceTasks: tasks });
  try {
    assert.deepEqual(visibleTaskIds(app), [6, 1, 2, 3, 4, 5].map(taskId));
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change'); assert.deepEqual(visibleTaskIds(app), [3, 5, 6, 1, 2, 4].map(taskId));
    app.nodes.get('tasks-sort').value = 'due'; await app.nodes.get('tasks-sort').dispatch('change'); assert.deepEqual(visibleTaskIds(app), [3, 5, 2, 6, 1, 4].map(taskId));
  } finally { app.close(); }
});

test('task filters and page size survive workspace updates and retain a project that no longer has tasks', async () => {
  const tasks = Array.from({ length: 130 }, (_, index) => taskFixture(index + 1, { title: 'Shared task ' + index, project: 'Retained project', priority: 'high' }));
  const app = await createUI({ workspaceTasks: tasks });
  try {
    app.nodes.get('tasks-project').value = 'project:Retained project'; await app.nodes.get('tasks-project').dispatch('change');
    app.nodes.get('tasks-sort').value = 'priority'; await app.nodes.get('tasks-sort').dispatch('change'); app.nodes.get('tasks-search').value = 'shared'; await app.nodes.get('tasks-search').dispatch('input'); await app.nodes.get('tasks-show-more').dispatch('click');
    app.nodes.get('new-task').value = 'An unsent task draft'; await app.nodes.get('task-list').children[0].children.at(-1).dispatch('click'); app.nodes.get('edit-text').value = 'An unsent edit draft';
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; workspace.tasks = [taskFixture(500, { project: 'Other project' })]; return response(workspace); });
    await app.ui.refreshWorkspace(); assert.equal(app.nodes.get('tasks-project').value, 'project:Retained project'); assert.equal(app.nodes.get('tasks-search').value, 'shared'); assert.equal(app.nodes.get('tasks-sort').value, 'priority'); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 0 of 0 matching tasks.');
    assert.ok(app.nodes.get('tasks-project').children.some(option => option.value === 'project:Retained project' && /no tasks/.test(option.textContent)));
    assert.equal(app.nodes.get('new-task').value, 'An unsent task draft'); assert.equal(app.nodes.get('edit-text').value, 'An unsent edit draft');
    await app.nodes.get('edit-form').dispatch('submit', { preventDefault() {} }); assert.match(app.nodes.get('edit-error').textContent, /workspace changed/);
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; workspace.tasks = tasks.slice(0, 120); return response(workspace); });
    await app.ui.refreshWorkspace(); assert.equal(visibleTaskIds(app).length, 100); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 100 of 120 matching tasks.');
  } finally { app.close(); }
});

test('filtered task completion and reopening still send actual workspace operations and update matching counts', async () => {
  const task = taskFixture(1, { title: 'Focused task', project: 'Focus' }), app = await createUI({ workspaceTasks: [task] });
  try {
    const operations = [];
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace/operations')) return null; const body = JSON.parse(options.body); operations.push(body); workspace.tasks[0].status = body.type === 'completeTask' ? 'done' : body.status; workspace.revision++; return response({ workspace, replayed: false }); });
    app.nodes.get('tasks-project').value = 'project:Focus'; await app.nodes.get('tasks-project').dispatch('change'); app.nodes.get('tasks-search').value = 'focused'; await app.nodes.get('tasks-search').dispatch('input');
    await app.nodes.get('task-list').children[0].children[0].dispatch('click'); assert.equal(operations[0].type, 'completeTask'); assert.equal(operations[0].taskId, task.id); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 0 of 0 matching tasks.');
    await app.nodes.get('toggle-completed').dispatch('click'); assert.deepEqual(visibleTaskIds(app), [task.id]); const reopen = app.nodes.get('task-list').children[0].children[0]; assert.match(reopen.attributes['aria-label'], /^Reopen task:/);
    await reopen.dispatch('click'); assert.equal(operations[1].type, 'updateTask'); assert.equal(operations[1].status, 'todo'); assert.equal(app.nodes.get('tasks-project').value, 'project:Focus'); assert.equal(app.nodes.get('tasks-search').value, 'focused'); assert.equal(app.nodes.get('tasks-results-count').textContent, 'Showing 1 of 1 matching task.');
  } finally { app.close(); }
});

test('long task details use a short preview and exact full-text disclosure that survives refresh and remains searchable and editable', async () => {
  const full = '<script>literal text</script>\n' + 'Detailed requirements and spaces  '.repeat(160) + '\nTail-only marker: final-criteria-742.';
  const task = taskFixture(1, { title: 'Long task', details: full }), app = await createUI({ workspaceTasks: [task, taskFixture(2)] });
  try {
    const row = app.nodes.get('task-list').children[0], preview = descendants(row).find(node => node.className === 'task-details'), disclosure = descendants(row).find(node => node.className === 'task-details-disclosure');
    assert.ok(preview.textContent.length <= 240); assert.match(preview.textContent, /…$/); assert.doesNotMatch(preview.textContent, /final-criteria-742/);
    assert.equal(disclosure.open, false); assert.equal(disclosure.children[0].textContent, 'Read all details'); assert.equal(disclosure.children[0].attributes['aria-label'], 'Read all details for task: Long task'); assert.equal(disclosure.children[1].textContent, full);
    assert.equal(descendants(row).some(node => node.tagName === 'script'), false);
    disclosure.open = true;
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/workspace')) return null; workspace.revision++; return response(workspace); });
    await app.ui.refreshWorkspace(); let current = descendants(app.nodes.get('task-list')).find(node => node.className === 'task-details-disclosure'); assert.equal(current.open, true); assert.equal(current.children[1].textContent, full);
    current.open = false; await current.dispatch('toggle'); app.nodes.get('tasks-search').value = 'final-criteria-742'; await app.nodes.get('tasks-search').dispatch('input');
    assert.deepEqual(visibleTaskIds(app), [task.id]); current = descendants(app.nodes.get('task-list')).find(node => node.className === 'task-details-disclosure'); assert.equal(current.open, false);
    await app.nodes.get('task-list').children[0].children.at(-1).dispatch('click'); assert.equal(app.nodes.get('edit-text').value, full);
    assert.equal(app.requests.filter(request => request.method === 'POST' && request.url.endsWith('/workspace/operations')).length, 0);
  } finally { app.close(); }
});

const sourceWindowA = { id: 'window-a', title: 'Paper A', appName: 'Fixture reader', pid: 71 };
const sourceWindowB = { id: 'window-b', title: 'Paper B', appName: 'Fixture editor', pid: 72 };
const pinPacket = (id, window) => ({ id, window, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 28800000).toISOString() });

test('window context starts absent, is selected only explicitly, and stores no pin or title in browser storage', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    assert.equal(app.ui.get().selectedWindowContext, null); assert.equal(app.nodes.get('selected-window-context').hidden, true);
    app.ui.addMessage('assistant', 'Use Paper A as context'); assert.equal(app.ui.get().selectedWindowContext, null);
    await app.ui.selectWindowContext(sourceWindowA); const pin = app.ui.get().selectedWindowContext;
    assert.equal(pin.status, 'ready'); assert.equal(pin.window.title, 'Paper A'); assert.equal(app.nodes.get('selected-window-context').hidden, false); assert.match(app.nodes.get('window-context-status').textContent, /chosen AI with each question/);
    assert.deepEqual(JSON.parse(app.requests.find(request => request.url.endsWith('/context')).body), { windowId: 'window-a' });
    assert.equal(app.requests.filter(request => request.url.endsWith('/tools/run')).length, 0); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
    assert.ok([...app.storage.values()].every(value => !value.includes(pin.id) && !value.includes('Paper A')));
  } finally { app.close(); }
});

test('actual window-list context buttons name their individual window and select only the clicked row', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    app.setIntercept((url, options, { workspace }) => { if (!url.endsWith('/tools/run')) return null; const body = JSON.parse(options.body); assert.equal(body.tool, 'desktop_list_windows'); return response({ tool: body.tool, result: { windows: [sourceWindowA, sourceWindowB], truncated: false }, workspace }); });
    await app.nodes.get('desktop-window-list').dispatch('click');
    const controls = descendants(app.nodes.get('desktop-window-results')).filter(node => node.tagName === 'button' && node.textContent === 'Use as context');
    assert.deepEqual(controls.map(node => node.attributes['aria-label']), ['Use as context: Paper A', 'Use as context: Paper B']);
    await controls[0].dispatch('click'); await until(() => app.ui.get().selectedWindowContext?.status === 'ready');
    assert.equal(app.ui.get().selectedWindowContext.window.id, sourceWindowA.id); assert.equal(app.requests.filter(request => request.url.endsWith('/context')).length, 1);
  } finally { app.close(); }
});

test('voice freezes its selected source before permission and an old source cannot retarget a new question', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const firstId = app.ui.get().selectedWindowContext.id;
    const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); assert.equal(app.ui.get().voiceCaptureContext.windowContext.id, firstId);
    app.grantMicrophone(); await opening; const recorded = copy(app.ui.get().recording);
    await app.ui.selectWindowContext(sourceWindowB); assert.equal(app.stoppedTracks, 1);
    await app.ui.runCommand('Explain the old source', { voice: true, providerId: recorded.providerId, conversationContext: recorded.conversationContext, windowContext: recorded.windowContext, approvalContext: null });
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.match(app.nodes.get('question-error').textContent, /context changed or is unavailable/);
    await app.ui.runCommand('Explain Paper B'); const question = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body);
    assert.equal(question.contextId, app.ui.get().selectedWindowContext.id); assert.notEqual(question.contextId, firstId); assert.equal('windowText' in question, false);
  } finally { app.close(); }
});

test('clearing while microphone permission is pending cancels capture and releases the original pin', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const id = app.ui.get().selectedWindowContext.id, opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().selectedWindowContext, null); assert.equal(app.nodes.get('selected-window-context').hidden, true);
    app.grantMicrophone(); await opening; await until(() => app.stoppedTracks === 1);
    assert.equal(app.ui.get().recording, null); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.requests.some(request => request.url.endsWith('/context/' + id + '/clear')), true);
    assert.equal(app.requests.filter(request => /\/(?:chat|transcribe)$/.test(request.url)).length, 0);
  } finally { app.close(); }
});

test('clearing context cancels an in-flight transcription and never forwards its late words to chat', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); app.grantMicrophone(); await opening;
    const frozen = copy(app.ui.get().recording), transcript = deferred(); let requestId;
    app.setIntercept((url, options) => { if (!url.endsWith('/transcribe')) return null; requestId = options.headers.get('X-Request-Id'); return transcript.promise; });
    const processing = app.ui.processVoiceSegment({ blob: new Blob(['synthetic audio']), context: frozen, signal: new AbortController().signal }); await until(() => !!requestId);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    transcript.resolve(response({ id: requestId, text: 'Explain this document' })); await processing;
    assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.equal(app.requests.some(request => request.url.endsWith('/cancel') && JSON.parse(request.body).id === requestId), true);
  } finally { app.close(); }
});

test('clearing context cancels its active chat request and ignores a late response from that source', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const contextId = app.ui.get().selectedWindowContext.id, pending = deferred(); let request;
    app.setIntercept((url, options, { records }) => {
      if (!url.endsWith('/chat')) return null; request = JSON.parse(options.body); const record = records.get(request.conversationId);
      record.turns.push({ id: request.id, message: request.message, status: 'running' }); record.activeRequestId = request.id; record.revision++; return pending.promise;
    });
    const asking = app.ui.runCommand('Explain Paper A'); await until(() => !!request); assert.equal(request.contextId, contextId);
    await app.ui.clearWindowContext(); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().selectedWindowContext, null);
    pending.resolve(response({ id: request.id, text: 'Late answer from the cleared source', actions: [], windowContext: { contextId, title: 'Paper A', readAt: new Date().toISOString() } })); await asking;
    assert.doesNotMatch(app.nodes.get('messages').textContent, /Late answer from the cleared source/); assert.equal(app.requests.some(item => item.url.endsWith('/cancel') && JSON.parse(item.body).id === request.id), true);
    assert.equal(app.requests.filter(item => item.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('a late pin response is released instead of replacing a newer explicitly selected window', async () => {
  const first = deferred(), app = await createUI();
  try {
    app.setIntercept((url, options) => { if (!url.endsWith('/context')) return null; return JSON.parse(options.body).windowId === sourceWindowA.id ? first.promise : response({ context: pinPacket('pin-b', sourceWindowB) }); });
    const selectingFirst = app.ui.selectWindowContext(sourceWindowA); await app.ui.selectWindowContext(sourceWindowB);
    first.resolve(response({ context: pinPacket('pin-a', sourceWindowA) })); await selectingFirst;
    assert.equal(app.ui.get().selectedWindowContext.id, 'pin-b'); assert.match(app.nodes.get('window-context-label').textContent, /Paper B/);
    assert.equal(app.requests.some(request => request.url.endsWith('/context/pin-a/clear')), true);
  } finally { app.close(); }
});

test('failed replacement and attachment failure stay unavailable until Clear or reselect without source fallback', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA, sourceWindowB] });
  try {
    await app.ui.selectWindowContext(sourceWindowA);
    app.setIntercept((url, options) => url.endsWith('/context') && JSON.parse(options.body).windowId === sourceWindowB.id ? response({ error: { code: 'window_context_unavailable', message: 'Paper B is no longer available.' } }, 409) : null);
    await app.ui.selectWindowContext(sourceWindowB); assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.equal(app.ui.get().selectedWindowContext.id, null); assert.match(app.nodes.get('window-context-label').textContent, /Paper B/);
    app.nodes.get('question').value = 'Keep this draft'; await app.ui.runCommand('Keep this draft'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0); assert.equal(app.nodes.get('question').value, 'Keep this draft');
    await app.ui.clearWindowContext(); app.setIntercept(null); await app.ui.selectWindowContext(sourceWindowA);
    app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'window_context_empty', message: 'This window has no readable text.' } }, 409) : null);
    await app.ui.runCommand('Explain this source'); assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /no readable text/);
    await app.ui.runCommand('Try another question'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
    await app.ui.clearWindowContext(); app.setIntercept(null); await app.ui.runCommand('A question without window text'); const last = app.requests.filter(request => request.url.endsWith('/chat')).at(-1); assert.equal('contextId' in JSON.parse(last.body), false);
  } finally { app.close(); }
});

test('expiry and worker restart invalidate context including a pin request that resolves after restart', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); app.ui.get().selectedWindowContext.expiresAt = new Date(Date.now() - 1).toISOString(); app.ui.renderWindowContext();
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /expired/); await app.ui.runCommand('Explain'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 0);
    await app.ui.clearWindowContext(); const pending = deferred(); app.setIntercept(url => url.endsWith('/context') ? pending.promise : null);
    const selecting = app.ui.selectWindowContext(sourceWindowA); app.ui.applyRuntime({ managed: true, restarting: false, workerPid: 101 });
    pending.resolve(response({ context: pinPacket('old-worker-pin', sourceWindowA) })); await selecting;
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.equal(app.ui.get().selectedWindowContext.id, null); assert.match(app.nodes.get('window-context-status').textContent, /restarted/); assert.equal(app.requests.some(request => request.url.endsWith('/context/old-worker-pin/clear')), true);
  } finally { app.close(); }
});

test('saved answer provenance shows the actual fresh window title, read time and truncation without persisting the pin in browser storage', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const contextId = app.ui.get().selectedWindowContext.id;
    app.setIntercept((url, options, { records, workspace }) => {
      if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body), record = records.get(body.conversationId);
      const windowContext = { contextId, windowId: sourceWindowA.id, title: 'Paper A — revised title', appName: sourceWindowA.appName, readAt: '2026-10-24T15:30:00Z', sourceTruncated: true, formatterTruncated: false, truncated: true, empty: false };
      const reply = { id: body.id, text: 'An explanation grounded in the fresh read.', actions: [], providerId: body.providerId, windowContext }; record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response({ ...reply, conversationId: record.id, conversationRevision: record.revision, workspace });
    });
    await app.ui.runCommand('Explain the selected window'); const source = descendants(app.nodes.get('messages')).find(node => node.className === 'window-context-source');
    assert.match(source.textContent, /Paper A — revised title/); assert.match(source.textContent, /Read /); assert.match(source.textContent, /Some window text was omitted/); assert.equal(app.ui.get().selectedWindowContext.window.title, 'Paper A — revised title');
    await app.ui.refreshConversation(); assert.equal(descendants(app.nodes.get('messages')).filter(node => node.className === 'window-context-source').length, 1);
    const saved = app.records.get(app.ui.get().id); saved.turns.push({ id: 'interrupted-before-read', message: 'A question interrupted before its read', status: 'interrupted', error: { message: 'Companion restarted before this read completed.', actions: [], windowContext: { contextId, windowId: sourceWindowA.id, title: 'Paper A selected only', appName: sourceWindowA.appName } } }); saved.revision++;
    await app.ui.refreshConversation(); const selectedOnly = descendants(app.nodes.get('messages')).filter(node => node.className === 'window-context-source').at(-1);
    assert.match(selectedOnly.textContent, /^Selected source: Paper A selected only/); assert.match(selectedOnly.textContent, /No completed read recorded\./); assert.doesNotMatch(selectedOnly.textContent, /Read unknown time|Window source:|text was omitted/);
    assert.ok([...app.storage.values()].every(value => !value.includes(contextId) && !value.includes('Paper A')));
  } finally { app.close(); }
});


const workFixture = (id, values = {}) => ({ id, conversationId: id, requestId: 'work_' + id, title: 'Background review', prompt: 'Review the saved tasks without starting another request.', providerId: 'codex', provider: { id: 'codex', label: 'GPT', type: 'codex', model: '' }, status: 'queued', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', progress: { message: 'Queued for a worker', events: [] }, ...values });

test('a handoff freezes its provider and source, stays independent of the live turn, and stores only its pending ID', async () => {
  const app = await createUI({ contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); const sourceId = app.ui.get().selectedWindowContext.id, accepted = deferred();
    app.setIntercept((url, options) => url.endsWith('/work') && options.method === 'POST' ? accepted.promise : null);
    app.nodes.get('work-prompt').value = 'Exact private handoff draft'; const handoff = app.ui.submitWork();
    await until(() => app.requests.some(request => request.url.endsWith('/work')));
    const request = app.requests.find(request => request.url.endsWith('/work')), body = JSON.parse(request.body);
    assert.equal(body.prompt, 'Exact private handoff draft'); assert.equal(body.providerId, 'codex'); assert.equal(body.contextId, sourceId);
    assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkIds')), [body.id]);
    assert.ok([...app.storage.values()].every(value => !value.includes(body.prompt) && !value.includes(sourceId)));
    app.ui.applyProviders({ providers: [{ id: 'other', label: 'Other AI', type: 'compatible', model: 'new-model', ready: true }], activeProviderId: 'other' });
    await app.ui.clearWindowContext(); app.ui.cancelTurn(false); app.nodes.get('work-prompt').value = 'A newer unsent draft';
    accepted.resolve(response({ job: workFixture(body.id, { prompt: body.prompt }) })); await handoff;
    assert.equal(app.ui.get().workJobs[0].provider.id, 'codex'); assert.equal(app.nodes.get('work-prompt').value, 'A newer unsent draft'); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    assert.equal(app.requests.some(request => request.url.includes('/work/') && request.url.endsWith('/cancel')), false);
  } finally { app.close(); }
});

test('an uncertain work submission offers GET-only Check handoff with its original ID and never repeats the POST', async () => {
  const app = await createUI();
  try {
    let acceptedId;
    app.setIntercept((url, options) => { if (!url.endsWith('/work') || options.method !== 'POST') return null; const body = JSON.parse(options.body); acceptedId = body.id; app.workRecords.set(body.id, workFixture(body.id, { prompt: body.prompt, status: 'running' })); throw new Error('Synthetic dropped response'); });
    app.nodes.get('work-prompt').value = 'Keep this handoff exactly once'; await app.ui.submitWork();
    assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    assert.equal(app.nodes.get('work-submit').disabled, true); assert.match(app.nodes.get('work-handoffs').textContent, /Check handoff/);
    await app.ui.submitWork(); assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    app.setIntercept(null); const check = descendants(app.nodes.get('work-handoffs')).find(node => node.textContent === 'Check handoff'); await check.dispatch('click'); await until(() => app.ui.get().pendingWorkIds.length === 0);
    assert.equal(app.ui.get().selectedWorkId, acceptedId); assert.equal(app.ui.get().workJobs[0].status, 'running'); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    assert.equal(app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST').length, 1);
    assert.equal(app.nodes.get('work-prompt').value, 'Keep this handoff exactly once'); assert.match(app.nodes.get('work-detail').textContent, /Working/);
  } finally { app.close(); }
});

test('a reload checks a pending handoff only on explicit request and a missing receipt permits a deliberate new handoff', async () => {
  const app = await createUI({ storedWorkIds: [A] });
  try {
    assert.equal(app.requests.some(request => request.url.startsWith('/api/assistant/work/' + A)), false);
    assert.equal(app.requests.some(request => request.url.endsWith('/work') && request.method === 'POST'), false);
    assert.match(app.nodes.get('work-handoffs').textContent, /Check handoff/); await app.ui.checkWorkHandoff(A);
    assert.match(app.nodes.get('work-error').textContent, /No saved handoff was found/); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    app.nodes.get('work-prompt').value = 'A deliberate new attempt'; await app.ui.submitWork();
    const posts = app.requests.filter(request => request.url.endsWith('/work') && request.method === 'POST'); assert.equal(posts.length, 1); assert.notEqual(JSON.parse(posts[0].body).id, A);
  } finally { app.close(); }
});

test('a real work receipt releases the foreground turn and a second question can continue while work is running', async () => {
  const job = workFixture(B, { status: 'running' }), app = await createUI({ saved: [blank(A)], selected: A });
  try {
    let questions = 0; app.workRecords.set(B, job); app.records.set(B, blank(B, job.title));
    app.setIntercept((url, options, { records }) => { if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body), record = records.get(body.conversationId), reply = { id: body.id, text: ++questions === 1 ? 'Handed off. You can keep talking.' : 'Here is the next reply.', providerId: body.providerId, actions: questions === 1 ? [{ id: 'delegate', tool: 'manage_work', arguments: { action: 'start' }, status: 'completed', result: { workJob: job, message: 'Handed off; not completed yet' } }] : [] }; record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response(reply); });
    await app.ui.runCommand('Work on this in the background'); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().activeRequest, null);
    assert.equal(app.ui.get().workJobs.find(item => item.id === B).status, 'running'); assert.match(app.nodes.get('messages').textContent, /Work handed off/); assert.match(app.nodes.get('messages').textContent, /Open work/);
    await app.ui.runCommand('And answer another question'); assert.equal(questions, 2); assert.equal(app.ui.get().id, A); assert.match(app.nodes.get('messages').textContent, /next reply/);
    app.ui.cancelTurn(false); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + B + '/cancel')), false);
    const open = descendants(app.nodes.get('messages')).find(node => node.textContent === 'Open work'); await open.dispatch('click'); await until(() => app.ui.get().selectedWorkId === B);
    assert.equal(app.ui.get().currentView, 'work'); assert.equal(app.ui.get().chatOpen, false);
  } finally { app.close(); }
});

test('work list and outcome pages remain explicit and preserve complete text and actual action receipts after refresh', async () => {
  const tasks = Array.from({ length: 23 }, (_, index) => workFixture('10000000-0000-4000-8000-' + String(index).padStart(12, '0'), { createdAt: new Date(Date.UTC(2026, 9, 25, 12, index)).toISOString() }));
  const text = 'First paragraph. ' + 'exact result '.repeat(800) + 'Final paragraph.';
  tasks[22] = { ...tasks[22], status: 'failed', outcome: { status: 'failed', text, error: { code: 'partial_failure', message: 'Stopped after the saved actions below.' }, actions: Array.from({ length: 27 }, (_, index) => ({ id: 'receipt-' + index, tool: 'save_note', status: 'completed', result: { note: { title: 'Actual note ' + index } } })) } };
  const app = await createUI({ savedWork: tasks });
  try {
    await app.ui.refreshWork(); assert.equal(app.ui.get().workJobs.length, 20); assert.match(app.nodes.get('work-count').textContent, /20 of 23/);
    await app.nodes.get('work-more').dispatch('click'); await until(() => app.ui.get().workJobs.length === 23); assert.match(app.nodes.get('work-count').textContent, /23 of 23/); assert.equal(app.nodes.get('work-more').hidden, true);
    const id = tasks[22].id; app.ui.selectWork(id); await app.ui.refreshWorkDetail(id);
    assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.text.length, 4000); assert.match(app.nodes.get('work-detail').textContent, /Stopped after the saved actions/);
    while (app.ui.get().workDetails.find(item => item.id === id).outcome.textHasMore) await app.ui.loadWorkOutcome(id, 'text');
    while (app.ui.get().workDetails.find(item => item.id === id).outcome.actionsHasMore) await app.ui.loadWorkOutcome(id, 'actions');
    const outcome = app.ui.get().workDetails.find(item => item.id === id).outcome; assert.equal(outcome.text, text); assert.equal(outcome.actions.length, 27); assert.match(app.nodes.get('work-detail').textContent, /Actual note 26/);
    await app.ui.refreshWorkDetail(id); assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.text, text); assert.equal(app.ui.get().workDetails.find(item => item.id === id).outcome.actions.length, 27);
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 0);
  } finally { app.close(); }
});

test('late work detail and ID-scoped stop never retarget the selected work or another conversation', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], savedWork: [workFixture(A), workFixture(B)] });
  try {
    await app.ui.refreshWork(); const late = deferred(); app.setIntercept(url => url.includes('/work/' + A + '?') ? late.promise : null);
    app.ui.selectWork(A); app.ui.selectWork(B); await app.ui.refreshWorkDetail(B);
    late.resolve(response({ job: workFixture(A, { status: 'completed', outcome: { status: 'completed', text: 'Late A output', actions: [] } }) })); await until(() => app.ui.get().workDetails.some(item => item.id === A && item.status === 'completed'));
    assert.equal(app.ui.get().selectedWorkId, B); assert.doesNotMatch(app.nodes.get('work-detail').textContent, /Late A output/);
    app.setIntercept(null); await app.ui.cancelWork(A); assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.workRecords.get(A).status, 'cancelled'); assert.equal(app.workRecords.get(B).status, 'queued');
    assert.equal(app.requests.filter(request => /work\/[^/]+\/cancel$/.test(request.url)).length, 1);
    const capture = app.ui.startRecording(); await until(() => app.waitingForMicrophone); await app.ui.openWorkConversation(B); assert.notEqual(app.ui.get().id, B); app.ui.cancelTurn(false); if (app.waitingForMicrophone) app.grantMicrophone(); await capture;
    await app.ui.openWorkConversation(B); assert.equal(app.ui.get().id, B); assert.equal(app.ui.get().chatOpen, true);
  } finally { app.close(); }
});

test('Work stays behind Tools and only an actual human voice navigation command opens it', async () => {
  const app = await createUI({ savedWork: [workFixture(A, { status: 'failed', progress: { message: 'Latest saved update', events: [{ at: '2026-10-25T12:00:00Z', type: 'running', message: 'Earlier actual progress' }] }, outcome: { status: 'failed', error: { code: 'provider_changed', message: 'The frozen provider configuration changed.' }, text: '', actions: [] } })] });
  try {
    await app.ui.refreshWork(); assert.equal(app.ui.get().currentView, 'today'); assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'show work'); assert.equal(app.ui.get().currentView, 'today');
    await app.ui.runCommand('Show work.', { voice: true, conversationContext: copy(app.ui.captureConversationContext()), approvalContext: null });
    assert.equal(app.ui.get().currentView, 'work'); assert.match(app.nodes.get('work-detail').textContent, /frozen provider configuration changed/);
    const progress = app.nodes.get('work-detail').querySelectorAll('.work-progress')[0]; assert.equal(progress.tagName, 'details'); assert.equal(progress.open, false); assert.equal(progress.children[0].textContent, 'Progress'); assert.match(app.nodes.get('work-detail').textContent, /Latest saved update/); assert.equal(app.nodes.get('work-detail').querySelectorAll('.work-original')[0].open, false); progress.open = true;
    const job = app.workRecords.get(A); job.status = 'waiting_for_review'; job.updatedAt = '2026-10-25T14:00:00Z'; job.outcome = { status: 'waiting_for_review', text: 'Input is prepared, not executed.', actions: [{ id: 'prepared', tool: 'desktop_propose_action', status: 'completed', result: { desktopAction: { id: 'pending-review', status: 'pending', summary: 'Exact prepared input', expiresAt: new Date(Date.now() + 60000).toISOString() } } }] }; await app.ui.refreshWorkDetail(A);
    assert.equal(app.nodes.get('work-detail').querySelectorAll('.work-progress')[0].open, true); assert.match(app.nodes.get('work-detail').querySelectorAll('.work-progress')[0].textContent, /Earlier actual progress/);
    assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Stop this work'), false); assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Open conversation'), true); assert.equal(descendants(app.nodes.get('work-detail')).some(node => node.textContent === 'Review computer action'), true);
    job.status = 'running'; job.cancelRequested = true; job.updatedAt = '2026-10-25T14:01:00Z'; await app.ui.refreshWorkDetail(A); const stopping = descendants(app.nodes.get('work-detail')).find(node => node.textContent === 'Stop this work'); assert.equal(stopping.disabled, true); assert.match(app.nodes.get('work-detail').textContent, /Stopping…/);
    assert.equal(app.requests.some(request => request.method === 'POST'), false);
    assert.match(html, /id="tools-menu"[^]*id="work-open"/); assert.doesNotMatch(html.split('id="tools-menu"')[0], /id="work-open"/);
  } finally { app.close(); }
});


test('uncertain checks and conversation opening respect a newer work selection, and an unconfirmed stop reads without repeating effects', async () => {
  const app = await createUI({ saved: [blank(A), blank(B)], selected: A, savedWork: [workFixture(A, { status: 'running' }), workFixture(B)], storedWorkIds: [A] });
  try {
    await app.ui.refreshWork(); const checking = deferred(); app.setIntercept(url => url.includes('/work/' + A + '?') ? checking.promise : null);
    const check = app.ui.checkWorkHandoff(A); app.ui.selectWork(B); await app.ui.refreshWorkDetail(B);
    checking.resolve(response({ job: workFixture(A, { status: 'running' }) })); await check;
    assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.ui.get().pendingWorkIds.length, 0);
    const listing = deferred(); app.setIntercept((url, options) => url.endsWith('/conversations') && !options.method ? listing.promise : null);
    const opening = app.ui.openWorkConversation(B); app.ui.selectWork(A); listing.resolve(response({ conversations: [blank(A), blank(B)].map(item => ({ ...item, turnCount: 0 })) })); await opening;
    assert.equal(app.ui.get().id, A); assert.equal(app.ui.get().chatOpen, false); assert.equal(app.ui.get().selectedWorkId, A);
    await app.ui.refreshWorkDetail(A); const confirmation = deferred();
    app.setIntercept((url, options) => { if (url.endsWith('/work/' + A + '/cancel') && options.method === 'POST') { app.workRecords.get(A).status = 'cancelled'; throw new Error('Synthetic stop response lost'); } if (url.includes('/work/' + A + '?')) return confirmation.promise; return null; });
    await app.ui.cancelWork(A); assert.match(app.nodes.get('work-error').textContent, /stop was not confirmed/); assert.equal(app.ui.get().workJobs.find(item => item.id === A).status, 'running');
    app.ui.selectWork(B); await app.ui.refreshWorkDetail(B); confirmation.resolve(response({ job: workFixture(A, { status: 'cancelled', updatedAt: '2026-10-25T15:00:00Z' }) })); await until(() => app.ui.get().workJobs.find(item => item.id === A).status === 'cancelled');
    assert.equal(app.ui.get().selectedWorkId, B); assert.equal(app.requests.filter(request => request.url.endsWith('/work/' + A + '/cancel')).length, 1);
  } finally { app.close(); }
});

test('a ready work result preserves its separately queued feature build and opens the actual build history', async () => {
  const build = { id: '33333333-3333-4333-8333-333333333333', status: 'queued', prompt: 'Build the requested panel', createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', progress: { message: 'Queued' } };
  const job = workFixture(A, { status: 'completed', outcome: { status: 'completed', text: 'The feature build is queued separately.', actions: [{ id: 'build-request', tool: 'build_feature', status: 'completed', result: { featureJob: build } }] } });
  const app = await createUI({ savedWork: [job], intercept: url => url.endsWith('/features/' + build.id) ? response(build) : null });
  try {
    await app.ui.refreshWork(); assert.match(app.nodes.get('work-detail').textContent, /Result ready/); assert.match(app.nodes.get('work-detail').textContent, /Feature build · Queued \(saved status\)/); assert.doesNotMatch(app.nodes.get('work-detail').textContent, /Feature activated|ready to use/);
    const open = descendants(app.nodes.get('work-detail')).find(node => node.textContent === 'View feature build ↗'); assert.ok(open); await open.dispatch('click'); assert.equal(app.ui.get().currentView, 'build');
    assert.equal(app.requests.some(request => request.method === 'POST'), false);
  } finally { app.close(); }
});



test('full service reconnect rejects a new worker under the same host and requires final workspace readiness while preserving drafts and view', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    app.ui.showView('tasks'); app.nodes.get('question').value = 'An unsent chat draft'; app.nodes.get('work-prompt').value = 'An unsent handoff'; app.nodes.get('new-task').value = 'An unsent task';
    let phase = 'worker', observations = 0, failedWorkspace = 0, workspaceReady = false, posted = false;
    app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...freshService(), restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (!posted) return response(baseline); observations++; return response(phase === 'worker' ? serviceFixture({ workerPid: 200, workerInstanceId: E }) : freshService()); } if (url.endsWith('/workspace') && phase === 'fresh' && !workspaceReady) { failedWorkspace++; return response({ error: { code: 'opening', message: 'Workspace is still opening' } }, 503); } return null; });
    const restart = app.ui.restartCompanionService(); await until(() => observations > 0);
    assert.equal(app.ui.get().reconnecting, true); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, A); assert.equal(app.ui.get().runtimeRetry.baseline.workerPid, 100); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready');
    phase = 'fresh'; while (!failedWorkspace) await delayTurn(); assert.equal(app.ui.get().reconnecting, true); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready'); workspaceReady = true;
    const result = await restart; assert.equal(result.confirmed, true); assert.match(app.nodes.get('runtime-message').textContent, /service restarted and reconnected/);
    assert.equal(app.nodes.get('question').value, 'An unsent chat draft'); assert.equal(app.nodes.get('work-prompt').value, 'An unsent handoff'); assert.equal(app.nodes.get('new-task').value, 'An unsent task'); assert.equal(app.ui.get().currentView, 'tasks'); assert.equal(app.ui.get().chatOpen, false);
    const posts = app.requests.filter(request => request.url.endsWith('/runtime/restart')); assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].body), { scope: 'host' }); assert.equal(app.nodes.get('restart-runtime').disabled, false); assert.equal(app.nodes.get('connection-label').textContent, 'GPT selected · Signed in · Completion not tested');
    assert.doesNotMatch(app.nodes.get('runtime-message').textContent, /desktop|Electron|package/i);
  } finally { app.close(); }
});

test('a lost restart acknowledgement observes the frozen baseline, recovers a fresh session and never repeats the restart POST', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    let sessionReads = 0, posted = false; app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; throw new Error('Synthetic acknowledgement lost'); } if (url.endsWith('/session') && posted && ++sessionReads === 1) return response({ error: { code: 'expired', message: 'Old session expired' } }, 401); if (url.endsWith('/runtime')) return response(posted ? freshService() : baseline); return null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, true); assert.ok(sessionReads >= 2); assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 1); assert.equal(app.ui.get().runtimeInfo.hostInstanceId, D);
  } finally { app.close(); }
});

test('host timeout and Check again keep the original scope and identities and only perform reads', async () => {
  const baseline = serviceFixture(), clock = { value: Date.now() }, app = await createUI({ runtimeBaseline: baseline, runtimeClock: clock });
  try {
    let changed = false, posted = false; app.nodes.get('question').value = 'Keep this draft through a failed restart';
    app.setIntercept((url, options) => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...baseline, restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (!posted) return response(baseline); if (!changed) clock.value += 31000; return response(changed ? freshService() : serviceFixture({ workerPid: 200, workerInstanceId: E })); } return null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, false); assert.match(app.nodes.get('runtime-message').textContent, /not confirmed a new service host and worker/); assert.equal(app.ui.get().runtimeRetry.scope, 'host'); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, A); assert.equal(app.nodes.get('runtime-retry').hidden, false);
    const before = app.requests.filter(request => request.method === 'POST').length; changed = true; await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().runtimeNotice.phase === 'ready');
    assert.equal(app.requests.filter(request => request.method === 'POST').length, before); assert.equal(app.ui.get().runtimeRetry, null); assert.equal(app.nodes.get('question').value, 'Keep this draft through a failed restart'); assert.equal(app.ui.get().chatOpen, false);
  } finally { app.close(); }
});

test('legacy worker restart remains compatible and an available worker identity cannot be reused as proof', async () => {
  const app = await createUI({ runtimeBaseline: { managed: true, restarting: false, workerPid: 100 } });
  try {
    let posted = false; app.setIntercept(url => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ managed: true, workerPid: 100, restartScope: 'worker', restartRequested: true }); } return url.endsWith('/runtime') ? response({ managed: true, restarting: false, workerPid: posted ? 101 : 100 }) : null; });
    const result = await app.ui.restartCompanionService(); assert.equal(result.confirmed, true); const post = app.requests.find(request => request.url.endsWith('/runtime/restart')); assert.deepEqual(JSON.parse(post.body), { scope: 'worker' }); assert.match(app.nodes.get('runtime-message').textContent, /worker restarted/);
    assert.equal(app.ui.runtimeRestartConfirmed(serviceFixture({ workerPid: 101 }), serviceFixture(), 'worker'), false); assert.equal(app.ui.runtimeRestartConfirmed(serviceFixture({ workerPid: 101, workerInstanceId: E }), serviceFixture(), 'worker'), true);
  } finally { app.close(); }
});

test('launcher updates stay manual and Check again requires a new supervisor as well as host and worker', async () => {
  const baseline = serviceFixture(), clock = { value: Date.now() }, app = await createUI({ runtimeBaseline: baseline, runtimeClock: clock });
  try {
    const result = await app.ui.reconnectAfterRestart({ ...baseline, restartScope: 'launcher', requiresManualRestart: true }, { baseline }); assert.equal(result.manual, true); assert.match(app.nodes.get('runtime-message').textContent, /owning Companion launcher/); assert.equal(app.requests.some(request => request.method === 'POST'), false);
    let relaunched = false; app.setIntercept(url => { if (!url.endsWith('/runtime')) return null; if (!relaunched) clock.value += 31000; return response(relaunched ? freshServiceWithSupervisor() : freshService()); });
    await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().reconnecting); while (app.ui.get().reconnecting) await delayTurn(); assert.equal(app.ui.get().runtimeNotice.phase, 'failed'); assert.match(app.nodes.get('runtime-message').textContent, /new launcher, service host and worker/);
    relaunched = true; await app.nodes.get('runtime-retry').dispatch('click'); await until(() => app.ui.get().runtimeNotice.phase === 'ready'); assert.match(app.nodes.get('runtime-message').textContent, /launcher restarted/); assert.equal(app.requests.some(request => request.method === 'POST'), false);
    const legacy = { managed: true, workerPid: 100, hostPid: 10 }; assert.equal(app.ui.runtimeRestartConfirmed(freshServiceWithSupervisor(), legacy, 'launcher'), true); assert.equal(app.ui.runtimeRestartConfirmed({ ...freshService(), supervisorInstanceId: undefined }, legacy, 'launcher'), false);
  } finally { app.close(); }
});
function freshServiceWithSupervisor(){return { ...freshService(), supervisorPid: 6, supervisorInstanceId: F };}

test('reconnected rollback is reported as restored source and never as activation', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline });
  try {
    app.setIntercept(url => url.endsWith('/runtime') ? response(freshService()) : url.endsWith('/features/' + C) ? response({ id: C, status: 'rolled_back', prompt: 'Synthetic update', updatedAt: '2026-10-25T12:00:00Z', createdAt: '2026-10-25T12:00:00Z' }) : null);
    const result = await app.ui.reconnectAfterRestart({ ...baseline, restartScope: 'host', restartRequested: true }, { baseline, jobId: C, action: 'apply' }); assert.equal(result.confirmed, true); assert.equal(app.ui.get().runtimeNotice.phase, 'rolled-back'); assert.match(app.nodes.get('runtime-message').textContent, /restored the previous version/); assert.doesNotMatch(app.nodes.get('runtime-message').textContent, /activated|Electron|desktop app/);
  } finally { app.close(); }
});

test('a changed service instance invalidates selected window context even when operating-system PIDs are reused', async () => {
  const baseline = serviceFixture(), app = await createUI({ runtimeBaseline: baseline, contextWindows: [sourceWindowA] });
  try {
    await app.ui.selectWindowContext(sourceWindowA); app.ui.applyRuntime({ ...baseline, hostInstanceId: D, workerInstanceId: E });
    assert.equal(app.ui.get().selectedWindowContext.status, 'unavailable'); assert.match(app.nodes.get('window-context-status').textContent, /restarted/); assert.equal(app.ui.runtimeRestartConfirmed({ ...baseline, hostInstanceId: D, workerInstanceId: E }, baseline, 'host'), false);
  } finally { app.close(); }
});


test('a combined launcher and desktop source update retains manual service proof alongside separate desktop instructions', async () => {
  const baseline = serviceFixture(), job = { id: C, status: 'applied', prompt: 'Synthetic combined update', updatedAt: '2026-10-25T12:00:00Z', createdAt: '2026-10-25T12:00:00Z', files: [{ path: 'server/companion-supervisor.mjs' }, { path: 'electron/productivity-main.cjs' }] }, app = await createUI({ runtimeBaseline: baseline });
  try {
    app.setIntercept(url => url.endsWith('/features/' + C + '/apply') ? response({ ...job, runtime: { ...baseline, restartScope: 'launcher', requiresManualRestart: true, restartRequested: false } }) : url.endsWith('/features/' + C) ? response(job) : null);
    await app.ui.jobAction({ id: C }, 'apply'); assert.equal(app.ui.get().runtimeNotice.phase, 'manual'); assert.match(app.nodes.get('runtime-message').textContent, /owning Companion launcher/); assert.match(app.nodes.get('runtime-message').textContent, /Desktop source changed/); assert.equal(app.ui.get().runtimeRetry.scope, 'launcher'); assert.equal(app.nodes.get('runtime-retry').hidden, false);
    assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 0);
  } finally { app.close(); }
});


test('restart preflight freezes a fresh identity rather than confirming a host that already changed outside this window', async () => {
  const baseline = serviceFixture(), alreadyChanged = freshService(), latest = serviceFixture({ hostPid: 30, workerPid: 300, hostInstanceId: F, workerInstanceId: '77777777-7777-4777-8777-777777777777' }), app = await createUI({ runtimeBaseline: baseline });
  try {
    let posted = false, ready = false, observed = 0;
    app.setIntercept(url => { if (url.endsWith('/runtime/restart')) { posted = true; return response({ ...alreadyChanged, restartScope: 'host', restartRequested: true }); } if (url.endsWith('/runtime')) { if (posted) observed++; return response(ready ? latest : alreadyChanged); } return null; });
    const restart = app.ui.restartCompanionService(); await until(() => observed > 0); assert.equal(app.ui.get().reconnecting, true); assert.equal(app.ui.get().runtimeRetry.baseline.hostInstanceId, D); assert.equal(app.ui.get().runtimeRetry.baseline.workerPid, 200); assert.notEqual(app.ui.get().runtimeNotice.phase, 'ready');
    ready = true; assert.equal((await restart).confirmed, true); assert.equal(app.ui.get().runtimeInfo.hostInstanceId, F); assert.equal(app.requests.filter(request => request.url.endsWith('/runtime/restart')).length, 1);
  } finally { app.close(); }
});


const PROJECT_A = { projectId: '88888888-8888-4888-8888-888888888888', grantEpoch: 1, label: 'Original project', localPath: 'C:/Synthetic/Original', available: true, mode: 'read_write' };
const PROJECT_B = { projectId: '99999999-9999-4999-8999-999999999999', grantEpoch: 4, label: 'Other project', localPath: 'C:/Synthetic/Other', available: true, mode: 'read_write' };
const projectBindingOnly = project => ({ projectId: project.projectId, grantEpoch: project.grantEpoch });
const isProjectFileRequest = request => /\/projects\/[^/?]+\/(?:file|files|history|edit|edits|revoke)(?:[/?]|$)/.test(request.url);

test('project integration starts blank with no file IO and explicit selection retains only an opaque browser binding', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    assert.equal(app.ui.get().selectedProject, null); assert.equal(app.nodes.get('selected-project-context').hidden, true); assert.equal(app.requests.some(request => request.url.includes('/projects')), false); assert.equal(app.ui.get().currentView, 'today'); assert.equal(app.ui.get().chatOpen, false);
    app.ui.addMessage('assistant', 'Choose another project folder'); assert.equal(app.ui.get().selectedProject, null);
    assert.equal(await app.ui.selectProject(PROJECT_A), true); assert.equal(app.ui.get().selectedProject.status, 'ready'); assert.equal(app.nodes.get('selected-project-context').hidden, false); assert.match(app.nodes.get('project-context-label').textContent, /Original project/);
    assert.equal(app.requests.some(isProjectFileRequest), false); assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.selectedProject')), projectBindingOnly(PROJECT_A)); assert.ok([...app.storage.values()].every(value => !value.includes(PROJECT_A.label) && !value.includes(PROJECT_A.localPath)));
    await app.ui.runCommand('Explain the selected project'); const body = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.deepEqual(body.project, projectBindingOnly(PROJECT_A)); assert.equal(JSON.stringify(body).includes(PROJECT_A.localPath), false); assert.equal(app.requests.some(isProjectFileRequest), false);
  } finally { app.close(); }
});

test('voice freezes the project before microphone permission and stale words cannot retarget a newly selected folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const opening = app.ui.startRecording(); await until(() => app.waitingForMicrophone); const frozen = copy(app.ui.get().voiceCaptureContext); assert.deepEqual(frozen.projectContext.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); app.grantMicrophone(); await opening; assert.equal(app.ui.get().recording, null); assert.equal(app.stoppedTracks, 1); assert.equal(app.ui.currentProjectContext(frozen.projectContext), false);
    await app.ui.runCommand('Write these old voice words into a file', { voice: true, providerId: frozen.providerId, conversationContext: frozen.conversationContext, windowContext: frozen.windowContext, projectContext: frozen.projectContext, approvalContext: null });
    assert.equal(app.requests.some(request => request.url.endsWith('/chat')), false); assert.match(app.nodes.get('question-error').textContent, /project folder changed/); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId);
    await app.ui.runCommand('A new explicit question'); const latest = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.deepEqual(latest.project, projectBindingOnly(PROJECT_B));
  } finally { app.close(); }
});

test('switching project folders cancels the old foreground turn and ignores its late reply without changing the new binding', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [blank(A)], selected: A });
  try {
    await app.ui.selectProject(PROJECT_A); const pending = deferred(); let body;
    app.setIntercept((url, options) => { if (!url.endsWith('/chat')) return null; body = JSON.parse(options.body); return pending.promise; });
    const turn = app.ui.runCommand('Read the original folder'); await until(() => !!app.ui.get().activeRequest); const request = app.ui.get().activeRequest; assert.deepEqual(body.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); assert.equal(request.controller.signal.aborted, true); assert.equal(app.ui.get().activeRequest, null); assert.equal(app.ui.get().turnBusy, false); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId);
    pending.resolve(response({ id: body.id, text: 'A late original-folder result', actions: [], projectContext: { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label } })); await turn;
    assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.doesNotMatch(app.nodes.get('messages').textContent, /A late original-folder result/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1); const cancelled = app.requests.find(request => request.url.endsWith('/cancel')); assert.equal(JSON.parse(cancelled.body).id, body.id);
  } finally { app.close(); }
});

test('handoff freezes its original project and accepted Work survives foreground folder switching and Leave', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const ack = deferred(); let body;
    app.setIntercept((url, options) => { if (!url.endsWith('/work') || options.method !== 'POST') return null; body = JSON.parse(options.body); const job = workFixture(body.id, { status: 'running', prompt: body.prompt, project: { ...body.project, label: PROJECT_A.label } }); app.workRecords.set(job.id, job); app.records.set(job.id, blank(job.id)); return ack.promise; });
    app.nodes.get('work-prompt').value = 'Continue requested files work independently'; const handoff = app.ui.submitWork(); await until(() => !!body); assert.deepEqual(body.project, projectBindingOnly(PROJECT_A));
    await app.ui.selectProject(PROJECT_B); ack.resolve(response({ job: app.workRecords.get(body.id) })); await handoff; await app.ui.selectProject(null);
    assert.equal(app.ui.get().selectedProject, null); assert.deepEqual(app.workRecords.get(body.id).project, { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + body.id + '/cancel') || request.url.endsWith('/revoke')), false);
    await app.ui.refreshWork(); app.ui.selectWork(body.id); await app.ui.refreshWorkDetail(body.id); assert.match(app.nodes.get('work-detail').textContent, /Project folder · Original project/); assert.equal(app.workRecords.get(body.id).status, 'running');
  } finally { app.close(); }
});

test('a delegated Work receipt stays bound to the foreground request project after the human chooses another folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [blank(A)], selected: A });
  try {
    await app.ui.selectProject(PROJECT_A);
    app.setIntercept((url, options, { records }) => { if (!url.endsWith('/chat')) return null; const body = JSON.parse(options.body); const job = workFixture(B, { status: 'running', project: { ...body.project, label: PROJECT_A.label } }); app.workRecords.set(B, job); app.records.set(B, blank(B)); const reply = { id: body.id, text: 'Handed off independently.', providerId: body.providerId, projectContext: { ...body.project, label: PROJECT_A.label }, actions: [{ id: 'project-delegate', tool: 'manage_work', arguments: { action: 'start' }, status: 'completed', result: { workJob: job } }] }; const record = records.get(A); record.turns.push({ id: body.id, message: body.message, status: 'completed', reply }); record.revision += 2; return response(reply); });
    await app.ui.runCommand('Work on this project in the background'); await app.ui.selectProject(PROJECT_B); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.deepEqual(app.workRecords.get(B).project, { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }); assert.equal(app.requests.some(request => request.url.endsWith('/work/' + B + '/cancel')), false); assert.match(app.nodes.get('messages').textContent, /Project folder · Original project/);
  } finally { app.close(); }
});

test('restored stale project access fails closed without upgrading the epoch, choosing another folder or reading files', async () => {
  const app = await createUI({ projects: [{ ...PROJECT_A, grantEpoch: 2 }, PROJECT_B], storedProject: projectBindingOnly(PROJECT_A) });
  try {
    assert.equal(app.ui.get().selectedProject.projectId, PROJECT_A.projectId); assert.equal(app.ui.get().selectedProject.grantEpoch, 1); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(app.nodes.get('send-question').disabled, true); assert.equal(app.requests.some(isProjectFileRequest), false);
    await app.ui.runCommand('Edit a file using this stale grant'); await app.ui.startRecording(); assert.equal(app.requests.some(request => request.url.endsWith('/chat')), false); assert.equal(app.waitingForMicrophone, false);
    await app.ui.selectProject(null); await app.ui.runCommand('Continue without a folder'); const body = JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body); assert.equal('project' in body, false);
  } finally { app.close(); }
});

test('access refresh cancels a now-invalid foreground route while a stale refresh cannot invalidate a newer folder', async () => {
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B] });
  try {
    await app.ui.selectProject(PROJECT_A); const oldContext = copy(app.ui.captureProjectContext()), refresh = deferred(); app.setIntercept(url => url.startsWith('/api/assistant/projects/' + PROJECT_A.projectId + '?') ? refresh.promise : null);
    const checking = app.ui.refreshProjectAccess(); await app.ui.selectProject(PROJECT_B); refresh.resolve(response({ error: { code: 'project_grant_changed', message: 'Old access changed' } }, 409)); await checking; assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.equal(app.ui.get().selectedProject.status, 'ready'); assert.equal(app.ui.currentProjectContext(oldContext), false);
    app.setIntercept(null); const pending = deferred(); let requestBody; app.setIntercept((url, options) => { if (!url.endsWith('/chat')) return null; requestBody = JSON.parse(options.body); return pending.promise; }); const running = app.ui.runCommand('Read the current project'); await until(() => !!app.ui.get().activeRequest); const request = app.ui.get().activeRequest; app.projectRecords.get(PROJECT_B.projectId).grantEpoch++;
    await app.ui.refreshProjectAccess(); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(request.controller.signal.aborted, true); assert.equal(app.ui.get().turnBusy, false); pending.resolve(response({ id: requestBody.id, text: 'Late stale-grant result', actions: [], projectContext: { ...requestBody.project, label: PROJECT_B.label } })); await running; assert.doesNotMatch(app.nodes.get('messages').textContent, /Late stale-grant result/); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1);
  } finally { app.close(); }
});

test('project tool failures mark the selected grant unavailable and never retry or drop its binding', async () => {
  const app = await createUI({ projects: [PROJECT_A] });
  try {
    await app.ui.selectProject(PROJECT_A); app.setIntercept(url => url.endsWith('/chat') ? response({ error: { code: 'project_binding_changed', message: 'The original project root changed.' } }, 409) : null);
    app.nodes.get('question').value = 'Keep my exact file-edit request'; await app.ui.runCommand(app.nodes.get('question').value); assert.equal(app.ui.get().selectedProject.status, 'unavailable'); assert.equal(app.nodes.get('question').value, 'Keep my exact file-edit request'); await app.ui.runCommand('Try another edit'); assert.equal(app.requests.filter(request => request.url.endsWith('/chat')).length, 1); assert.deepEqual(JSON.parse(app.requests.find(request => request.url.endsWith('/chat')).body).project, projectBindingOnly(PROJECT_A));
  } finally { app.close(); }
});

test('saved project receipts retain original provenance and open their recorded folder rather than the current one', async () => {
  const edit = { id: C, ...projectBindingOnly(PROJECT_A), path: 'notes.md', status: 'applied', receiptPending: true, undoAvailable: true }, record = { ...blank(A), revision: 2, turns: [{ id: 'project-saved-turn', message: 'Requested original folder edit', status: 'completed', reply: { text: 'Inspect the actual recorded edit.', projectContext: { ...projectBindingOnly(PROJECT_A), label: PROJECT_A.label }, actions: [{ id: 'original-edit', tool: 'run_capability', status: 'completed', result: { projectFileEdit: edit } }, { id: 'read-original', tool: 'run_capability', status: 'completed', result: { projectFileRead: { ...projectBindingOnly(PROJECT_A), path: 'notes.md', hasMore: true } } }] } }] };
  const app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [record], selected: A });
  try {
    await app.ui.selectProject(PROJECT_B); assert.match(app.nodes.get('messages').textContent, /Project folder · Original project/); assert.match(app.nodes.get('messages').textContent, /File changed · receipt needs checking/); assert.match(app.nodes.get('messages').textContent, /File read · notes.md · partial page · saved read/); assert.doesNotMatch(app.nodes.get('messages').textContent, /File saved · notes.md/); assert.equal(app.requests.some(isProjectFileRequest), false);
    const open = descendants(app.nodes.get('messages')).find(item => item.tagName === 'button' && item.textContent === 'Open this project ↗'); await open.dispatch('click'); await until(() => app.ui.get().currentView === 'files'); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_A.projectId); assert.equal(app.ui.get().selectedProject.status, 'ready');
  } finally { app.close(); }
});

test('a late original-project receipt click cannot navigate to Files for a newer selection', async () => {
  const record = { ...blank(A), revision: 2, turns: [{ id: 'saved-file', message: 'An earlier edit', status: 'completed', reply: { text: 'Original edit receipt', actions: [{ id: 'edit', tool: 'run_capability', status: 'completed', result: { projectFileEdit: { id: C, ...projectBindingOnly(PROJECT_A), path: 'original.md', status: 'applied', undoAvailable: false } } }] } }] }, app = await createUI({ projects: [PROJECT_A, PROJECT_B], saved: [record], selected: A });
  try {
    const waiting = deferred(); app.setIntercept(url => url.startsWith('/api/assistant/projects/' + PROJECT_A.projectId + '?') ? waiting.promise : null); const open = descendants(app.nodes.get('messages')).find(item => item.tagName === 'button' && item.textContent === 'Open this project ↗'); await open.dispatch('click'); await until(() => app.ui.get().selectedProject?.projectId === PROJECT_A.projectId);
    await app.ui.selectProject(PROJECT_B); waiting.resolve(response({ project: PROJECT_A })); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.ui.get().selectedProject.projectId, PROJECT_B.projectId); assert.equal(app.ui.get().currentView, 'today');
  } finally { app.close(); }
});

const FOLLOW_WORK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const followBuild = (id=C,status='applied') => ({ id,status,prompt:'Build the original requested report tool.',summary:'Report tool',createdAt:'2026-10-25T12:00:00Z',updatedAt:'2026-10-25T12:00:00Z',files:[],verification:{passed:true,checks:[]} });
const followRecord = (buildId=C,id=E,patch={}) => ({ id,buildId,workId:FOLLOW_WORK,status:'ready',origin:{requestId:'original-human-turn',conversationId:A,message:'Write the original report using the original project.',provider:{id:'codex',label:'GPT',type:'codex',model:''}},buildSpec:'Implement the bounded report tool. Keep the human outcome separate.',readiness:{ready:true},...patch });
const continuationControl = (app,text) => descendants(app.nodes.get('build-continuation-container')).find(node=>node.tagName==='button'&&node.textContent===text);
async function openFollowBuild(app,id=C){app.ui.selectBuild(id);app.ui.showView('build');await until(()=>!!continuationControl(app,'Continue original request'),'continuation panel');}

test('linked continuations stay out of the blank canvas and applied builds or service reconnect never resume them automatically',async()=>{
  const baseline=serviceFixture(),app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()],runtimeBaseline:baseline});
  try{
    app.nodes.get('question').value='An unsent foreground draft';assert.equal(app.ui.get().chatOpen,false);assert.equal(app.requests.some(request=>request.url.includes('/continuations')),false);
    await openFollowBuild(app);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.ui.get().id,A);assert.equal(app.nodes.get('question').value,'An unsent foreground draft');assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);
    await app.ui.refreshJobs();app.setIntercept(url=>url.endsWith('/runtime')?response(freshService()):null);const result=await app.ui.reconnectAfterRestart({managed:true,restartRequested:true,restartScope:'host',baseline},{baseline});assert.equal(result.confirmed,true);await app.ui.get().buildContinuationUI.refresh();
    assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.nodes.get('question').value,'An unsent foreground draft');
  }finally{app.close();}
});

test('voice freezes the selected build before microphone permission and a changed build cannot receive the old Continue command',async()=>{
  const app=await createUI({savedBuilds:[followBuild(C),followBuild(D)],savedContinuations:[followRecord(C,E),followRecord(D,F)]});
  try{
    await openFollowBuild(app,C);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const frozen=copy(app.ui.get().voiceCaptureContext);assert.ok(frozen.buildContinuationContext);assert.equal(app.ui.currentBuildContinuationContext(frozen.buildContinuationContext),true);
    app.ui.selectBuild(D);await until(()=>app.ui.get().selectedJobId===D);app.grantMicrophone();await opening;assert.equal(app.ui.currentBuildContinuationContext(frozen.buildContinuationContext),false);
    await app.ui.runCommand('continue original request',{voice:true,...frozen});assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);assert.equal(app.ui.get().selectedJobId,D);assert.equal(app.ui.get().chatOpen,false);
  }finally{app.close();}
});

test('a real human voice Continue uses its captured build only and preserves foreground chat until an explicit matching Work link',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()],savedWork:[workFixture(B)]});
  try{
    await openFollowBuild(app);const context=copy(app.ui.captureBuildContinuationContext());await app.ui.addMessage('assistant','continue original request');assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);
    await app.ui.runCommand('continue original request',{voice:true,buildContinuationContext:context});const posts=app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/assistant/continuations/'+E+'/continue');assert.equal(posts[0].body,'{}');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.ui.get().currentView,'build');assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);
    await app.ui.get().buildContinuationUI.refresh();await until(()=>!!continuationControl(app,'Open work'));await continuationControl(app,'Open work').dispatch('click');await until(()=>app.ui.get().selectedWorkId===FOLLOW_WORK);assert.equal(app.ui.get().currentView,'work');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.workRecords.get(FOLLOW_WORK).prompt,followRecord().origin.message);
  }finally{app.close();}
});


test('a build selected during the voice readiness GET cannot receive the previous original-request command',async()=>{
  const app=await createUI({savedBuilds:[followBuild(C),followBuild(D)],savedContinuations:[followRecord(C,E),followRecord(D,F)]});const pending=deferred();
  try{await openFollowBuild(app,C);const context=copy(app.ui.captureBuildContinuationContext());app.setIntercept(url=>url.startsWith('/api/assistant/continuations?')?pending.promise:null);const command=app.ui.runCommand('continue original request',{voice:true,buildContinuationContext:context});await until(()=>app.requests.filter(request=>request.url.startsWith('/api/assistant/continuations?')).length>=2);app.ui.selectBuild(D);pending.resolve(response({continuations:[followRecord(C,E)],total:1,offset:0,limit:20,hasMore:false,nextOffset:null}));await command;assert.equal(app.ui.get().selectedJobId,D);assert.equal(app.requests.some(request=>request.url.includes('/continuations/')&&request.method==='POST'),false);assert.match(app.nodes.get('question-error').textContent,/selected build changed/);assert.equal(app.ui.get().chatOpen,false);}finally{app.close();}
});

test('an uncertain voice Continue stops capture, retains Check continuation and never repeats the saved original request',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,savedBuilds:[followBuild()],savedContinuations:[followRecord()]});
  try{
    await openFollowBuild(app);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);app.grantMicrophone();await opening;const frozen=copy(app.ui.get().voiceCaptureContext);assert.equal(app.ui.get().voiceState.enabled,true);assert.equal(app.ui.get().ownsVoice,true);
    app.setIntercept((url,options)=>{if(url==='/api/assistant/continuations/'+E+'/continue'&&options.method==='POST'){const accepted=app.continuationRecords.get(E);accepted.status='queued';accepted.workJob={id:FOLLOW_WORK,status:'queued'};throw new Error('Synthetic lost continuation acknowledgement');}return null;});
    await app.ui.runCommand('continue original request',{voice:true,...frozen});assert.equal(app.ui.get().voiceState.enabled,false);assert.equal(app.ui.get().ownsVoice,false);assert.equal(app.waitingForMicrophone,false);assert.ok(app.stoppedTracks>0);assert.match(app.nodes.get('question-error').textContent,/not confirmed|unconfirmed|Check continuation/i);assert.ok(continuationControl(app,'Check continuation'));assert.equal(continuationControl(app,'Continue original request'),undefined);assert.deepEqual(JSON.parse(app.storage.get('companion.build.continuations.pending.v1')),[E]);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);
    const posts=app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body,'{}');const before=app.requests.length;await continuationControl(app,'Check continuation').dispatch('click');await until(()=>!!continuationControl(app,'Open work'));const checks=app.requests.slice(before).filter(request=>request.url.includes('/continuations/'));assert.equal(checks.length,1);assert.equal(checks[0].url,'/api/assistant/continuations/'+E);assert.equal(checks[0].method,'GET');assert.equal(app.requests.filter(request=>request.url.includes('/continuations/')&&request.method==='POST').length,1);assert.equal(app.ui.get().voiceState.enabled,false);assert.equal(app.ui.get().ownsVoice,false);
  }finally{app.close();}
});

test('live and saved continuation receipts mark reused note and nested task effects as already completed earlier',async()=>{
  const reuse={requestId:'original-human-request',actionId:'original-action'},actions=[{id:'reused-note',tool:'save_note',status:'completed',result:{note:{id:E,title:'Earlier note'},replayed:true,historical:true,continuationReuse:reuse}},{id:'new-capability',tool:'run_capability',arguments:{name:'cap_report'},status:'completed',result:{capability:{id:'report',name:'cap_report',version:1,hash:'a'.repeat(64)},value:{count:1},hostActions:[{id:'reused-task',tool:'create_task',status:'completed',result:{task:{id:F,title:'Earlier task'},replayed:true,historical:true,continuationReuse:reuse}}]}}];
  const saved=blank(A,'Follow-through result');saved.turns=[{id:'continued-work-turn',message:'Continue the original report',providerId:'codex',status:'completed',startedAt:'2026-10-25T12:00:00Z',finishedAt:'2026-10-25T12:00:01Z',reply:{id:'continued-work-turn',text:'The installed tool returned its result.',providerId:'codex',actions}}];saved.revision=2;
  const app=await createUI({saved:[saved],selected:A});
  try{
    const labels=()=>descendants(app.nodes.get('messages')).filter(node=>node.className?.split(/\s+/).includes('action-receipt')).map(node=>node.textContent);assert.ok(labels().some(text=>text==='Already completed earlier · Earlier note'));assert.ok(labels().some(text=>text==='Already completed earlier · Earlier task'));assert.equal(labels().some(text=>text.startsWith('Note saved · Earlier note')||text.startsWith('Task saved · Earlier task')),false);
    const live=new Element();app.ui.renderActionReceipts(live,actions);const liveLabels=descendants(live).filter(node=>node.className?.split(/\s+/).includes('action-receipt')).map(node=>node.textContent);assert.ok(liveLabels.includes('Already completed earlier · Earlier note'));assert.ok(liveLabels.includes('Already completed earlier · Earlier task'));
    await app.ui.refreshConversation();assert.equal(labels().filter(text=>text==='Already completed earlier · Earlier note').length,1);assert.equal(labels().filter(text=>text==='Already completed earlier · Earlier task').length,1);assert.equal(app.requests.some(request=>request.method==='POST'),false);assert.equal(app.ui.get().workspace.tasks.length,0);
  }finally{app.close();}
});

const candidateAttempt=(number,passed=false)=>({number,status:passed?'passed':'failed',startedAt:'2026-10-25T12:00:00Z',finishedAt:'2026-10-25T12:00:01Z',summary:'Candidate '+number,reviewRequired:true,fileCount:1,verification:{passed,totalChecks:4,failedChecks:passed?[]:['Original regression '+number]}});
const attemptBuild=(patch={})=>({...followBuild(),generationAttempt:1,generationAttemptLimit:2,status:'generating',verification:null,attempts:[],...patch});
const buildDetailButton=(app,text)=>descendants(app.nodes.get('job-detail')).find(node=>node.tagName==='button'&&node.textContent===text);
const settleBuild=app=>until(()=>!app.ui.get().buildJobsPending&&!app.ui.get().buildDetailsPending,'build reads');
const attemptSection=(app,number)=>descendants(app.nodes.get('job-detail')).find(node=>node.attributes['data-attempt-number']===String(number));

test('Build progress reports the host-owned candidate attempt and remains cancellable without new repair or continuation requests',async()=>{
  const app=await createUI({savedBuilds:[attemptBuild()]});
  try{
    assert.equal(app.ui.get().currentView,'today');assert.equal(app.ui.get().chatOpen,false);assert.equal(app.requests.some(request=>request.url.includes('/attempts/')),false);app.ui.showView('build');await until(()=>/Attempt 1 of 2 · Preparing changes/.test(app.nodes.get('job-detail').textContent));await settleBuild(app);
    app.buildRecords.set(C,attemptBuild({generationAttempt:2,attempts:[candidateAttempt(1)],updatedAt:'2026-10-25T12:00:01Z'}));await app.ui.refreshJobs();await until(()=>/Attempt 2 of 2 · Correcting check failures/.test(app.nodes.get('job-detail').textContent));await settleBuild(app);assert.ok(buildDetailButton(app,'Cancel build'));assert.equal(buildDetailButton(app,'Activate feature ↗'),undefined);assert.equal(app.nodes.get('job-list').children.length,1);assert.match(app.nodes.get('job-detail').textContent,/Original regression 1/);assert.equal(app.requests.some(request=>request.url.includes('/attempts/')),false);
    app.buildRecords.set(C,attemptBuild({generationAttempt:2,status:'validating',attempts:[candidateAttempt(1)],updatedAt:'2026-10-25T12:00:02Z'}));await app.ui.refreshJobs();await until(()=>/Attempt 2 of 2 · Checking changes/.test(app.nodes.get('job-detail').textContent));await settleBuild(app);
    app.setIntercept((url,options)=>{if(url==='/api/assistant/features/'+C+'/cancel'&&options.method==='POST'){const stopped={...app.buildRecords.get(C),status:'cancelled',updatedAt:'2026-10-25T12:00:03Z'};app.buildRecords.set(C,stopped);return response({job:stopped});}return null;});await buildDetailButton(app,'Cancel build').dispatch('click');await until(()=>/Cancelled/.test(app.nodes.get('job-detail').textContent));const posts=app.requests.filter(request=>request.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].url,'/api/assistant/features/'+C+'/cancel');assert.equal(attemptSection(app,1).open,false);assert.equal(app.requests.some(request=>request.url.includes('/attempts/')),false);assert.equal(app.ui.get().selectedJobId,C);
  }finally{app.close();}
});

test('same-timestamp cached passing checks from attempt 1 cannot activate attempt 2 and historical failure remains separate after correction',async()=>{
  const first=attemptBuild({status:'review_required',reviewRequired:true,verification:{passed:true,checks:[{name:'Earlier passing check',passed:true,output:'Old candidate only'}]},attempts:[candidateAttempt(1,true)]}),app=await createUI({savedBuilds:[first]}),held=deferred();
  try{
    app.ui.showView('build');await until(()=>!!buildDetailButton(app,'Activate feature ↗'));assert.equal(buildDetailButton(app,'Activate feature ↗').disabled,false);await settleBuild(app);const second=attemptBuild({generationAttempt:2,status:'validating',attempts:[candidateAttempt(1)]});app.buildRecords.set(C,second);app.setIntercept(url=>url==='/api/assistant/features/'+C?held.promise:null);await app.ui.refreshJobs();assert.match(app.nodes.get('job-detail').textContent,/Attempt 2 of 2 · Checking changes/);assert.equal(buildDetailButton(app,'Activate feature ↗'),undefined);assert.doesNotMatch(app.nodes.get('job-detail').textContent,/Old candidate only/);held.resolve(response({job:second}));await until(()=>/Attempt history/.test(app.nodes.get('job-detail').textContent));
    const corrected=attemptBuild({generationAttempt:2,status:'review_required',reviewRequired:true,updatedAt:'2026-10-25T12:00:04Z',attempts:[candidateAttempt(1),candidateAttempt(2,true)],files:[{path:'server/capabilities/example.mjs',added:1,removed:0,diff:'Actual final candidate diff'}],verification:{passed:true,checks:[{name:'Corrected regression',passed:true,output:'Current candidate passed'}]}});app.buildRecords.set(C,corrected);app.setIntercept(url=>url==='/api/assistant/features/'+C+'/attempts/1'?response({buildId:C,number:1,status:'failed',summary:'Retained failed candidate',reviewRequired:true,files:[{path:'src/old.mjs',diff:'Old failure diff',added:1,removed:0}],verification:{passed:false,checks:[{name:'Original regression 1',passed:false,output:'RETAINED_FAILURE_OUTPUT'}]}}):null);await app.ui.refreshJobs();await until(()=>!!buildDetailButton(app,'Activate feature ↗')&&!buildDetailButton(app,'Activate feature ↗').disabled&&/Current candidate passed/.test(app.nodes.get('job-detail').textContent));assert.equal(attemptSection(app,1).open,false);assert.equal(attemptSection(app,2).open,false);assert.equal(app.requests.some(request=>request.url.includes('/attempts/')),false);
    const firstReport=attemptSection(app,1);firstReport.open=true;await firstReport.dispatch('toggle');await until(()=>/RETAINED_FAILURE_OUTPUT/.test(app.nodes.get('job-detail').textContent));assert.match(app.nodes.get('job-detail').textContent,/Current candidate passed/);assert.match(app.nodes.get('job-detail').textContent,/Review and activation use the current candidate above/);assert.equal(buildDetailButton(app,'Activate feature ↗').disabled,false);await app.ui.refreshJobs();assert.equal(attemptSection(app,1).open,true);assert.equal(app.requests.filter(request=>request.url.includes('/attempts/')).length,1);assert.equal(app.requests.some(request=>request.method==='POST'),false);
  }finally{app.close();}
});

test('exhausted attempts show retained failure guidance while interruption and legacy jobs never invent automatic repair',async()=>{
  const failed=attemptBuild({generationAttempt:2,status:'failed',summary:'Candidate still needs work',error:'Original checks failed.',attempts:[candidateAttempt(1),candidateAttempt(2)],verification:{passed:false,checks:[{name:'Original regression 2',passed:false,output:'Actual second failure'}]}}),app=await createUI({savedBuilds:[failed]});
  try{app.ui.showView('build');await until(()=>/Both attempts failed checks/.test(app.nodes.get('job-detail').textContent));await settleBuild(app);assert.match(app.nodes.get('job-detail').textContent,/review the failures before requesting another build/);assert.match(app.nodes.get('job-detail').textContent,/Original regression 1/);assert.match(app.nodes.get('job-detail').textContent,/Original regression 2/);assert.equal(buildDetailButton(app,'Activate feature ↗'),undefined);assert.equal(buildDetailButton(app,'Cancel build'),undefined);assert.equal(app.nodes.get('job-list').children.length,1);assert.equal(app.requests.some(request=>request.url.includes('/attempts/')),false);
    app.buildRecords.set(C,{...failed,status:'interrupted',updatedAt:'2026-10-25T12:00:05Z'});await app.ui.refreshJobs();await until(()=>/Interrupted/.test(app.nodes.get('job-detail').textContent));assert.doesNotMatch(app.nodes.get('job-detail').textContent,/Both attempts failed checks/);assert.ok(attemptSection(app,1));assert.equal(app.requests.some(request=>request.method==='POST'),false);
  }finally{app.close();}
  const legacy=await createUI({savedBuilds:[followBuild(C,'review_required')]});try{legacy.ui.showView('build');await until(()=>!!buildDetailButton(legacy,'Activate feature ↗'));assert.equal(descendants(legacy.nodes.get('job-detail')).some(node=>node.className==='build-attempt-progress'),false);assert.equal(legacy.requests.some(request=>request.url.includes('/attempts/')),false);assert.equal(legacy.requests.some(request=>request.method==='POST'),false);}finally{legacy.close();}
});

const API_PROVIDER={id:'api-fixture',type:'openai',label:'API fixture',model:'synthetic-model',baseUrl:'https://provider.invalid/v1',revision:B,ready:true,availability:'configured',hasKey:true,verified:false,connectionCheck:null};
const providerCheckControl=(app,label)=>descendants(app.nodes.get('provider-list')).find(node=>node.tagName==='button'&&(node.attributes['aria-label']===label||node.textContent===label));

test('Settings shows availability without completion proof and Save/select never send a connection-test request',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A});
  try{assert.equal(app.requests.some(request=>request.url.includes('/provider-checks')),false);assert.match(app.nodes.get('connection-label').textContent,/GPT selected · Signed in · Completion not tested/);app.nodes.get('question').value='Keep my unsent draft';app.ui.showView('settings');assert.equal(app.ui.get().chatOpen,false);assert.match(app.nodes.get('provider-list').textContent,/Sends a small test message/);assert.doesNotMatch(app.nodes.get('provider-list').textContent,/Ready to use/);
    app.nodes.get('provider-type').value='openai';app.nodes.get('provider-model').value='saved-test-model';app.nodes.get('provider-label').value='Saved connection';await app.nodes.get('provider-form').dispatch('submit',{preventDefault(){}});await until(()=>app.ui.get().providers.some(provider=>provider.label==='Saved connection'));assert.equal(app.requests.some(request=>request.url.includes('/provider-checks')),false);assert.equal(app.ui.get().activeProviderId,'codex');const saved=app.ui.get().providers.find(provider=>provider.label==='Saved connection');app.nodes.get('provider-select').value=saved.id;await app.nodes.get('provider-select').dispatch('change',{target:{value:saved.id}});await until(()=>app.ui.get().activeProviderId===saved.id);assert.equal(app.requests.some(request=>request.url.includes('/provider-checks')),false);assert.equal(app.nodes.get('question').value,'Keep my unsent draft');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.match(app.nodes.get('connection-label').textContent,/Configured · Completion not tested/);
  }finally{app.close();}
});

test('testing another AI freezes its saved revision and leaves the live voice provider, selected chat and drafts unchanged',async()=>{
  const codex={id:'codex',type:'codex',label:'GPT',model:'',revision:A,ready:true,availability:'signed_in',connectionCheck:null},app=await createUI({saved:[blank(A,'Foreground chat')],selected:A,providerDescriptors:[codex,API_PROVIDER]});
  try{const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);app.grantMicrophone();await opening;const frozen=copy(app.ui.get().voiceCaptureContext);app.nodes.get('question').value='A draft unrelated to the test';app.ui.showView('settings');await providerCheckControl(app,'Test connection for API fixture').dispatch('click');await until(()=>app.providerCheckRecords.size===1&&!!providerCheckControl(app,'Cancel connection test for API fixture'));const request=app.requests.find(item=>item.url==='/api/assistant/provider-checks'&&item.method==='POST'),body=JSON.parse(request.body);assert.deepEqual(Object.keys(body).sort(),['id','providerId','revision']);assert.equal(body.providerId,API_PROVIDER.id);assert.equal(body.revision,B);assert.equal(app.ui.get().activeProviderId,'codex');assert.equal(app.ui.get().voiceCaptureContext.providerId,frozen.providerId);assert.equal(app.ui.get().voiceState.enabled,true);assert.equal(app.nodes.get('question').value,'A draft unrelated to the test');assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);
    const check=app.providerCheckRecords.get(body.id);check.status='passed';check.finishedAt='2026-10-25T12:00:01Z';check.text='RAW_COMPLETION_MUST_NOT_RENDER';await app.ui.get().providerChecksUI.refreshActive();assert.match(app.nodes.get('provider-list').textContent,/Completion test passed/);assert.doesNotMatch(app.nodes.get('provider-list').textContent,/RAW_COMPLETION_MUST_NOT_RENDER/);assert.match(app.nodes.get('connection-label').textContent,/GPT selected · Signed in · Completion not tested/);assert.equal(app.ui.get().activeProviderId,'codex');assert.equal(app.ui.get().voiceState.enabled,true);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(JSON.stringify([...app.storage]).includes('RAW_COMPLETION'),false);
  }finally{app.close();}
});

test('global Stop reaches an accepted connection test and the UI waits for its actual cancelled receipt',async()=>{
  const app=await createUI();try{app.ui.showView('settings');await providerCheckControl(app,'Test connection for GPT').dispatch('click');await until(()=>app.providerCheckRecords.size===1&&!!providerCheckControl(app,'Cancel connection test for GPT'));const id=[...app.providerCheckRecords.keys()][0];assert.equal(app.providerCheckRecords.get(id).status,'queued');app.ui.stopAllActivity(false,{global:true});await until(()=>app.requests.some(request=>request.url==='/api/assistant/stop'));await until(()=>app.providerCheckRecords.get(id).status==='cancelled');await app.ui.get().providerChecksUI.refreshActive();assert.match(app.nodes.get('provider-list').textContent,/Test cancelled/);assert.equal(app.requests.filter(request=>request.url==='/api/assistant/provider-checks'&&request.method==='POST').length,1);assert.equal(app.requests.some(request=>request.url==='/api/assistant/provider-checks/'+id+'/cancel'),false);assert.equal(app.ui.get().currentView,'settings');assert.equal(app.ui.get().chatOpen,false);}finally{app.close();}
});

const checkPacketForUI=(id,provider,status='queued')=>({id,providerId:provider.id,revision:provider.revision,provider:{id:provider.id,type:provider.type,label:provider.label,model:provider.model,...(provider.baseUrl?{baseUrl:provider.baseUrl}:{}),revision:provider.revision},status,createdAt:'2026-10-25T12:00:00Z',configurationMatches:true,observedThisSession:true,completionOnly:true,scope:'app_configuration'});

test('voice captures its Settings-only connection revision before permission and refuses a changed selection or configuration',async()=>{
  for(const changed of ['selection','revision']){
    const codex={id:'codex',type:'codex',label:'GPT',model:'',revision:A,ready:true,availability:'signed_in',connectionCheck:null},app=await createUI({providerDescriptors:[codex,API_PROVIDER]});
    try{const outside=copy(app.ui.captureProviderCheckContext());assert.equal(outside.providerId,null);app.ui.showView('settings');const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const frozen=copy(app.ui.get().voiceCaptureContext);assert.equal(frozen.providerCheckContext.providerId,'codex');assert.equal(frozen.providerCheckContext.revision,A);app.ui.applyProviders({providers:[changed==='revision'?{...codex,revision:C}:codex,API_PROVIDER],activeProviderId:changed==='selection'?API_PROVIDER.id:'codex',connectionChecksAvailable:true});app.grantMicrophone();await opening;assert.equal(app.ui.currentProviderCheckContext(frozen.providerCheckContext),false);await app.ui.runCommand('test connection',{voice:true,...frozen});assert.equal(app.requests.some(request=>request.url==='/api/assistant/provider-checks'&&request.method==='POST'),false);assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);assert.equal(app.ui.get().voiceState.enabled,false);assert.match(app.nodes.get('question-error').textContent,/intended AI selected/);assert.equal(app.ui.get().currentView,'settings');}finally{app.close();}
  }
});

test('only human voice from the captured Settings route starts one context-free connection check',async()=>{
  const app=await createUI({saved:[blank(A,'Foreground chat')],selected:A});
  try{await app.ui.addMessage('assistant','test connection');assert.equal(app.requests.some(request=>request.url==='/api/assistant/provider-checks'),false);const outside=copy(app.ui.captureProviderCheckContext());await app.ui.runCommand('test connection',{voice:true,providerCheckContext:outside});assert.equal(app.requests.some(request=>request.url==='/api/assistant/provider-checks'),false);app.ui.showView('settings');const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const frozen=copy(app.ui.get().voiceCaptureContext);app.grantMicrophone();await opening;await app.ui.runCommand('test connection',{voice:true,...frozen});await until(()=>app.providerCheckRecords.size===1);const posts=app.requests.filter(request=>request.url==='/api/assistant/provider-checks'&&request.method==='POST');assert.equal(posts.length,1);const body=JSON.parse(posts[0].body);assert.deepEqual(Object.keys(body).sort(),['id','providerId','revision']);assert.equal(body.providerId,'codex');assert.equal(body.revision,A);assert.equal(app.requests.some(request=>request.url.endsWith('/chat')),false);assert.equal(app.ui.get().id,A);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.ui.get().currentView,'settings');assert.equal(app.ui.get().activeProviderId,'codex');await app.ui.runCommand('test connection',{voice:true,...frozen});assert.equal(app.requests.filter(request=>request.url==='/api/assistant/provider-checks'&&request.method==='POST').length,1);assert.deepEqual(JSON.parse(app.storage.get('companion.provider.checks.pending.v1')),[]);assert.equal(app.ui.get().voiceState.enabled,true);}finally{app.close();}
});

test('an uncertain spoken connection test stops voice and leaves only GET Check for its original ID',async()=>{
  const app=await createUI();
  try{app.ui.showView('settings');const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);app.grantMicrophone();await opening;const frozen=copy(app.ui.get().voiceCaptureContext);app.setIntercept((url,options)=>{if(url==='/api/assistant/provider-checks'&&options.method==='POST'){const body=JSON.parse(options.body),provider=app.ui.get().providers.find(item=>item.id===body.providerId);app.providerCheckRecords.set(body.id,checkPacketForUI(body.id,provider));throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC');}return null;});await app.ui.runCommand('test connection',{voice:true,...frozen});assert.equal(app.ui.get().voiceState.enabled,false);assert.equal(app.ui.get().ownsVoice,false);assert.match(app.nodes.get('question-error').textContent,/Use Check test/);assert.doesNotMatch(app.nodes.get('provider-list').textContent,/PRIVATE_PROVIDER_DIAGNOSTIC/);const ids=JSON.parse(app.storage.get('companion.provider.checks.pending.v1'));assert.equal(ids.length,1);const before=app.requests.length;await app.ui.get().providerChecksUI.refreshActive();assert.equal(app.requests.length,before);await providerCheckControl(app,'Check connection test '+ids[0]).dispatch('click');await until(()=>JSON.parse(app.storage.get('companion.provider.checks.pending.v1')).length===0);const checked=app.requests.slice(before).filter(request=>request.url.includes('/provider-checks'));assert.equal(checked.length,1);assert.equal(checked[0].url,'/api/assistant/provider-checks/'+ids[0]);assert.equal(checked[0].method,'GET');assert.equal(app.requests.filter(request=>request.url==='/api/assistant/provider-checks'&&request.method==='POST').length,1);assert.equal(app.ui.get().voiceState.enabled,false);}finally{app.close();}
});

test('late old-session provider metadata cannot make the Settings card or active footer current again',async()=>{
  const provider={id:'codex',type:'codex',label:'GPT',model:'',revision:A,ready:true,availability:'signed_in'},check=checkPacketForUI(C,provider,'passed');check.observedThisSession=false;const app=await createUI({providerDescriptors:[{...provider,verified:false,connectionCheck:check}]});
  try{assert.match(app.nodes.get('connection-label').textContent,/earlier session/i);app.ui.applyProviders({providers:[{...provider,verified:true,connectionCheck:{...check,observedThisSession:true}}],activeProviderId:'codex',connectionChecksAvailable:true});assert.match(app.nodes.get('connection-label').textContent,/earlier session/i);assert.match(app.nodes.get('provider-list').textContent,/Earlier session/);assert.equal(app.ui.get().providers[0].verified,false);assert.equal(app.ui.get().providers[0].connectionCheck.observedThisSession,false);assert.equal(app.requests.some(request=>request.url.includes('/provider-checks')),false);assert.equal(app.requests.some(request=>request.method==='POST'),false);}finally{app.close();}
});

const routineFixture=(id=A,enabled=false,extra={})=>({id,name:id===A?'Morning routine':'Other routine',description:'A saved routine',enabled,steps:[{tool:'save_note',arguments:{text:'Original note'}}],createdAt:'2026-10-25T12:00:00Z',updatedAt:'2026-10-25T12:00:00Z',...extra});
const routineCatalog=[{name:'save_note',title:'Save note',kind:'builtin',workflowAllowed:true,effectPolicy:'workspace',version:1,parameters:{type:'object',properties:{text:{type:'string',minLength:1}},required:['text'],additionalProperties:false}}];
const routineControl=(app,label)=>descendants(app.nodes.get('workflow-list')).find(node=>node.tagName==='button'&&(node.attributes['aria-label']===label||node.textContent===label));

test('editing a disabled routine preserves its enabled flag, exact ID and stale original pins without silently enabling or repinning',async()=>{
  const pin={id:'old-action',version:1,hash:'b'.repeat(64)},flow=routineFixture(A,false,{steps:[{tool:'cap_old',arguments:{text:'Keep original step'},capability:pin}]}),app=await createUI({workspaceWorkflows:[flow]});
  try{app.ui.openWorkflow(flow);assert.equal(app.nodes.get('workflow-enabled').checked,false);app.nodes.get('workflow-name').value='Renamed disabled routine';await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});const posts=app.requests.filter(request=>request.url.endsWith('/workspace/operations'));assert.equal(posts.length,1);const body=JSON.parse(posts[0].body);assert.equal(body.type,'saveWorkflow');assert.equal(body.workflowId,A);assert.equal(body.expectedRevision,0);assert.equal(body.enabled,false);assert.equal('steps'in body,false);assert.equal(app.ui.get().workspace.workflows.length,1);assert.equal(app.ui.get().workspace.workflows[0].enabled,false);assert.match(app.nodes.get('workflow-list').textContent,/1 steps · Disabled/);assert.equal(app.nodes.get('workflow-dialog').open,false);app.ui.openWorkflow();assert.equal(app.nodes.get('workflow-enabled').checked,true);}finally{app.close();}
});

test('Enable and Disable are explicit metadata-only operations and cannot target a stale rendered revision',async()=>{
  const flow=routineFixture(A,true,{steps:[{tool:'cap_removed',arguments:{text:'Preserve unavailable action'},capability:{id:'removed',version:1,hash:'a'.repeat(64)}}]}),app=await createUI({workspaceWorkflows:[flow,routineFixture(B,true)]});
  try{await app.ui.refreshToolCatalog();const stale=routineControl(app,'Disable workflow: Morning routine');await stale.dispatch('click');await until(()=>app.ui.get().workspace.workflows[0].enabled===false);let calls=app.requests.filter(request=>request.url.endsWith('/workspace/operations')),body=JSON.parse(calls[0].body);assert.equal(body.type,'setWorkflowEnabled');assert.equal(body.workflowId,A);assert.equal(body.enabled,false);assert.equal('steps'in body,false);assert.equal('name'in body,false);assert.equal(app.ui.get().workspace.workflows[1].enabled,true);assert.deepEqual(copy(app.ui.get().workspace.workflows[0].steps),flow.steps);assert.ok(routineControl(app,'Enable workflow: Morning routine'));await stale.dispatch('click');assert.equal(app.requests.filter(request=>request.url.endsWith('/workspace/operations')).length,1);assert.match(app.nodes.get('workflow-error').textContent,/workspace changed/);await routineControl(app,'Enable workflow: Morning routine').dispatch('click');await until(()=>app.ui.get().workspace.workflows[0].enabled===true);calls=app.requests.filter(request=>request.url.endsWith('/workspace/operations'));body=JSON.parse(calls[1].body);assert.equal(body.enabled,true);assert.equal(body.expectedRevision,1);assert.deepEqual(copy(app.ui.get().workspace.workflows[0].steps),flow.steps);assert.match(app.nodes.get('workflow-list').textContent,/1 steps · Enabled/);assert.equal(app.ui.get().workspace.workflows.length,2);}finally{app.close();}
});

test('routine revision conflicts retain name, steps and disabled draft for an explicit same-ID review and save',async()=>{
  const flow=routineFixture(),app=await createUI({workspaceWorkflows:[flow]});
  try{app.ui.openWorkflow(flow);app.nodes.get('workflow-name').value='My revised morning';app.nodes.get('workflow-description').value='Preserve this unsent description';app.nodes.get('workflow-enabled').checked=false;app.setIntercept((url,_options,{workspace})=>{if(url.endsWith('/workspace')){workspace.revision=1;return response(workspace);}return null;});await app.ui.refreshWorkspace();await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(app.requests.some(request=>request.url.endsWith('/workspace/operations')),false);assert.match(app.nodes.get('workflow-form-error').textContent,/workspace changed/);assert.equal(app.nodes.get('workflow-dialog').open,true);assert.equal(app.nodes.get('workflow-name').value,'My revised morning');assert.equal(app.nodes.get('workflow-description').value,'Preserve this unsent description');assert.equal(app.nodes.get('workflow-enabled').checked,false);assert.deepEqual(copy(app.ui.get().workflowDraft),flow.steps);await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});const body=JSON.parse(app.requests.find(request=>request.url.endsWith('/workspace/operations')).body);assert.equal(body.workflowId,A);assert.equal(body.expectedRevision,1);assert.equal(body.enabled,false);assert.equal(body.name,'My revised morning');assert.equal('steps'in body,false);assert.equal(app.ui.get().workspace.workflows.length,1);}finally{app.close();}
});

test('a Save waiting for the action catalog cannot retarget a newly opened routine editor',async()=>{
  const a=routineFixture(A,false),b=routineFixture(B,true),app=await createUI({workspaceWorkflows:[a,b]}),held=deferred();
  try{app.setIntercept(url=>url.endsWith('/integrations')?held.promise:null);app.ui.openWorkflow(a);app.nodes.get('workflow-name').value='Unsent first routine';const saving=app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});app.ui.openWorkflow(b);held.resolve(response({tools:[],capabilityStatus:{ready:true}}));await saving;assert.equal(app.requests.some(request=>request.url.endsWith('/workspace/operations')),false);assert.equal(app.nodes.get('workflow-name').value,b.name);assert.equal(app.nodes.get('workflow-enabled').checked,true);assert.equal(app.nodes.get('workflow-dialog').open,true);assert.equal(app.nodes.get('workflow-save').disabled,false);}finally{app.close();}
});

test('typing during a routine save keeps the newer draft open while only the clicked snapshot is committed',async()=>{
  const flow=routineFixture(),app=await createUI({workspaceWorkflows:[flow]}),held=deferred();let saved;
  try{app.ui.openWorkflow(flow);app.nodes.get('workflow-name').value='Clicked version';app.setIntercept((url,options)=>{if(!url.endsWith('/workspace/operations'))return null;saved=JSON.parse(options.body);return held.promise;});const saving=app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});await until(()=>!!saved);app.nodes.get('workflow-name').value='A newer unsaved version';held.resolve(response({workspace:{...app.ui.get().workspace,revision:1,workflows:[{...flow,name:saved.name,enabled:saved.enabled}]},replayed:false}));await saving;assert.equal(saved.workflowId,A);assert.equal(saved.name,'Clicked version');assert.equal(saved.enabled,false);assert.equal(app.ui.get().workspace.workflows[0].name,'Clicked version');assert.equal(app.nodes.get('workflow-name').value,'A newer unsaved version');assert.equal(app.nodes.get('workflow-dialog').open,true);assert.match(app.nodes.get('workflow-form-error').textContent,/newer draft is still here/);assert.equal(app.requests.filter(request=>request.url.endsWith('/workspace/operations')).length,1);}finally{app.close();}
});

test('failed routine runs retain partial host receipts and whole-run retry guidance after editing or disabling the same routine',async()=>{
  const flow=routineFixture(A,true),app=await createUI({workspaceWorkflows:[flow],catalog:routineCatalog});
  try{app.setIntercept((url,_options,{workspace})=>url.endsWith('/workflows/'+A+'/run')?response({id:A,status:'failed',error:'A later action failed',steps:[{tool:'save_note',result:{note:{id:C,title:'First saved note'}}}],failedStep:{index:1,tool:'cap_partial',hostActions:[{id:'actual-partial',tool:'save_note',status:'completed',result:{note:{id:D,title:'Actual note inside failed step'}}},{id:'failed-action',tool:'create_task',status:'failed',result:{error:'No task was created'}}]},workspace}):null);await app.ui.runWorkflow(flow);assert.match(app.nodes.get('workflow-list').textContent,/Completed within failed step/);assert.match(app.nodes.get('workflow-list').textContent,/Actual note inside failed step/);assert.match(app.nodes.get('workflow-list').textContent,/Other recorded actions within failed step/);assert.match(app.nodes.get('workflow-list').textContent,/No task was created/);assert.match(app.nodes.get('workflow-list').textContent,/new run starts from step 1/);assert.ok(routineControl(app,'Run again ↗'));app.setIntercept(null);await routineControl(app,'Disable workflow: Morning routine').dispatch('click');await until(()=>app.ui.get().workspace.workflows[0].enabled===false);app.ui.openWorkflow(app.ui.get().workspace.workflows[0]);app.nodes.get('workflow-name').value='Updated routine title';await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.match(app.nodes.get('workflow-list').textContent,/Actual note inside failed step/);assert.match(app.nodes.get('workflow-list').textContent,/new run starts from step 1/);assert.equal(app.requests.filter(request=>request.url.endsWith('/workflows/'+A+'/run')).length,1);assert.equal(routineControl(app,'Run again ↗').disabled,true);assert.equal(app.ui.get().workspace.workflows.length,1);}finally{app.close();}
});

test('a server-side routine CAS conflict keeps the disabled draft and requires a new explicit receipt at the current revision',async()=>{
  const flow=routineFixture(),app=await createUI({workspaceWorkflows:[flow]});const bodies=[];
  try{app.ui.openWorkflow(flow);app.nodes.get('workflow-name').value='Keep this edited name';app.nodes.get('workflow-enabled').checked=false;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);bodies.push(body);if(bodies.length===1){workspace.revision=1;workspace.workflows[0].description='Changed elsewhere';return response({error:{code:'revision_conflict',message:'Workflow changed'},workspace},409);}return null;});await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,1);assert.equal(bodies[0].workflowId,A);assert.equal(bodies[0].expectedRevision,0);assert.match(app.nodes.get('workflow-form-error').textContent,/workspace changed/);assert.equal(app.nodes.get('workflow-name').value,'Keep this edited name');assert.equal(app.nodes.get('workflow-enabled').checked,false);assert.deepEqual(copy(app.ui.get().workflowDraft),flow.steps);assert.equal(app.nodes.get('workflow-dialog').open,true);await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,2);assert.equal(bodies[1].workflowId,A);assert.equal(bodies[1].expectedRevision,1);assert.notEqual(bodies[1].operationId,bodies[0].operationId);assert.equal(bodies[1].enabled,false);assert.equal(app.ui.get().workspace.workflows[0].name,'Keep this edited name');assert.equal(app.ui.get().workspace.workflows.length,1);}finally{app.close();}
});

test('metadata-only edits omit a definition over 90k and retain every original unavailable capability pin',async()=>{
  const steps=Array.from({length:10},(_,index)=>({tool:'cap_unavailable',arguments:{text:'x'.repeat(9100)+index},capability:{id:'original-action',version:1,hash:'a'.repeat(64)}})),flow=routineFixture(A,false,{steps}),app=await createUI({workspaceWorkflows:[flow]});
  try{assert.ok(JSON.stringify(steps).length>90000);app.ui.openWorkflow(flow);app.nodes.get('workflow-description').value='Only this description changes';await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});const posted=app.requests.filter(request=>request.url.endsWith('/workspace/operations'));assert.equal(posted.length,1);const body=JSON.parse(posted[0].body);assert.equal(body.workflowId,A);assert.equal(body.enabled,false);assert.equal(body.description,'Only this description changes');assert.equal('steps'in body,false);assert.ok(posted[0].body.length<1000);assert.deepEqual(copy(app.ui.get().workspace.workflows[0].steps),steps);assert.equal(app.ui.get().workspace.workflows.length,1);assert.equal(app.requests.some(request=>request.url.includes('/workflows/')&&request.url.endsWith('/run')),false);}finally{app.close();}
});

test('a confirmed create binds a newer retained draft to the exact returned routine ID and omits unchanged steps on its next save',async()=>{
  const app=await createUI({catalog:routineCatalog}),held=deferred();let firstBody,created;
  try{app.ui.openWorkflow();await app.ui.refreshToolCatalog();const select=app.nodes.get('workflow-steps').children[0].children[0].children[1];select.value='save_note';await select.dispatch('change');argumentField(app,'text').value='Actual saved routine instruction';await argumentField(app,'text').dispatch('input');app.nodes.get('workflow-name').value='Clicked new routine';app.nodes.get('workflow-enabled').checked=false;
    app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations')||firstBody)return null;firstBody=JSON.parse(options.body);created={id:firstBody.operationId,name:firstBody.name,description:firstBody.description,enabled:firstBody.enabled,steps:structuredClone(firstBody.steps)};workspace.revision=1;workspace.workflows=[created];return held.promise;});const saving=app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});await until(()=>!!firstBody);assert.equal('workflowId'in firstBody,false);assert.ok(Array.isArray(firstBody.steps));app.nodes.get('workflow-name').value='A newer retained draft';held.resolve(response({workspace:{...app.ui.get().workspace,revision:1,workflows:[created]},workflow:created,appliedRevision:1,replayed:false}));await saving;assert.equal(app.nodes.get('workflow-dialog').open,true);assert.equal(app.nodes.get('workflow-name').value,'A newer retained draft');assert.match(app.nodes.get('workflow-form-error').textContent,/newer draft/);
    await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});const bodies=app.requests.filter(request=>request.url.endsWith('/workspace/operations')).map(request=>JSON.parse(request.body));assert.equal(bodies.length,2);assert.equal(bodies[1].workflowId,created.id);assert.equal(bodies[1].expectedRevision,1);assert.equal('steps'in bodies[1],false);assert.equal(bodies[1].name,'A newer retained draft');assert.equal(bodies[1].enabled,false);assert.equal(app.ui.get().workspace.workflows.length,1);assert.equal(app.ui.get().workspace.workflows[0].id,created.id);assert.deepEqual(copy(app.ui.get().workspace.workflows[0].steps),firstBody.steps);
  }finally{app.close();}
});

async function fillNewRoutine(app,name){app.ui.openWorkflow();await app.ui.refreshToolCatalog();const select=app.nodes.get('workflow-steps').children[0].children[0].children[1];select.value='save_note';await select.dispatch('change');argumentField(app,'text').value='Original routine instruction';await argumentField(app,'text').dispatch('input');app.nodes.get('workflow-name').value=name;app.nodes.get('workflow-enabled').checked=false;}

test('a lost create acknowledgement followed by explicit Confirm binds the retained draft to the original operation and creates no duplicate',async()=>{
  const app=await createUI({catalog:routineCatalog});let accepted,created;const bodies=[];
  try{await fillNewRoutine(app,'Initial create');app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);bodies.push(body);if(!accepted){accepted=body;created={id:body.operationId,name:body.name,description:body.description,enabled:body.enabled,steps:structuredClone(body.steps)};workspace.revision=1;workspace.workflows=[created];throw new Error('Synthetic create committed before lost response');}if(body.operationId===accepted.operationId)return response({workspace,workflow:created,appliedRevision:1,replayed:true});return null;});
    await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,1);assert.equal(app.nodes.get('workspace-retry').hidden,false);assert.equal(app.nodes.get('workflow-dialog').open,true);app.nodes.get('workflow-name').value='A newer retained routine draft';app.nodes.get('workflow-description').value='Keep this newer text';await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0]);assert.equal(app.nodes.get('workspace-retry').hidden,true);assert.equal(app.nodes.get('workflow-name').value,'A newer retained routine draft');assert.equal(app.nodes.get('workflow-description').value,'Keep this newer text');assert.equal(app.nodes.get('workflow-enabled').checked,false);assert.equal(app.nodes.get('workflow-dialog').open,true);assert.match(app.nodes.get('workflow-form-error').textContent,/saved version is confirmed/);
    await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,3);assert.equal(bodies[2].workflowId,created.id);assert.notEqual(bodies[2].operationId,accepted.operationId);assert.equal(bodies[2].expectedRevision,1);assert.equal('steps'in bodies[2],false);assert.equal(bodies[2].enabled,false);assert.equal(app.ui.get().workspace.workflows.length,1);assert.equal(app.ui.get().workspace.workflows[0].id,created.id);assert.equal(app.ui.get().workspace.workflows[0].name,'A newer retained routine draft');assert.deepEqual(copy(app.ui.get().workspace.workflows[0].steps),accepted.steps);assert.doesNotMatch(JSON.stringify([...app.storage]),/Initial create|newer retained routine|Original routine instruction/);
  }finally{app.close();}
});

test('confirming an uncertain create never binds a different editor generation even when its name is identical',async()=>{
  const existing=routineFixture(B,true),app=await createUI({catalog:routineCatalog,workspaceWorkflows:[existing]});let accepted,created;const bodies=[];
  try{await fillNewRoutine(app,'Same title');app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);bodies.push(body);if(!accepted){accepted=body;created={id:body.operationId,name:body.name,description:body.description,enabled:body.enabled,steps:structuredClone(body.steps)};workspace.revision=1;workspace.workflows.push(created);throw new Error('Synthetic lost create acknowledgement');}if(body.operationId===accepted.operationId)return response({workspace,workflow:created,appliedRevision:1,replayed:true});return null;});await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});app.ui.openWorkflow(existing);app.nodes.get('workflow-name').value='Same title';app.nodes.get('workflow-description').value='Different editor draft';await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.nodes.get('workflow-name').value,'Same title');assert.equal(app.nodes.get('workflow-description').value,'Different editor draft');assert.equal(app.nodes.get('workflow-enabled').checked,true);await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,2);assert.match(app.nodes.get('workflow-form-error').textContent,/workspace changed/);await app.nodes.get('workflow-form').dispatch('submit',{preventDefault(){}});assert.equal(bodies.length,3);assert.equal(bodies[2].workflowId,B);assert.notEqual(bodies[2].workflowId,created.id);assert.equal('steps'in bodies[2],false);assert.equal(app.ui.get().workspace.workflows.length,2);assert.equal(app.ui.get().workspace.workflows.find(flow=>flow.id===created.id).enabled,false);assert.equal(app.ui.get().workspace.workflows.find(flow=>flow.id===B).description,'Different editor draft');
  }finally{app.close();}
});
async function openTaskDates(app,task){app.ui.showView('tasks');await app.ui.refreshDeadlineContext();if(task){app.ui.openEditor('task',task);await app.ui.refreshDeadlineContext();await until(()=>!app.ui.get().editorDeadline.original.dueAt||app.nodes.get('edit-due-at').value||app.nodes.get('edit-deadline-status').textContent.includes('could not'),'task date editor');}}
async function chooseDeadline(app,kind,value){app.nodes.get('edit-deadline-kind').value=kind;await app.nodes.get('edit-deadline-kind').dispatch('change');if(kind==='date'||kind==='instant'){const input=app.nodes.get(kind==='date'?'edit-due-date':'edit-due-at');input.value=value;await input.dispatch('input');await input.dispatch('change');}}
const taskChanges=app=>app.requests.filter(item=>item.url.endsWith('/workspace/operations')&&item.method==='POST').map(item=>JSON.parse(item.body));

test('deadline data is lazy and calendar-only tasks display their exact civil day without a UTC shift',async()=>{
  const clock={value:Date.parse('2026-10-25T07:05:00Z')},task=taskFixture(1,{dueDate:'2026-10-25',dueAt:null}),app=await createUI({runtimeClock:clock,workspaceTasks:[task]});
  try{assert.equal(app.requests.some(item=>/deadline-context|task-deadlines|deadline-resolve/.test(item.url)),false);assert.equal(app.ui.get().chatOpen,false);await openTaskDates(app);assert.match(app.nodes.get('task-list').textContent,/Due Oct 25, 2026/);assert.doesNotMatch(app.nodes.get('task-list').textContent,/Oct 24/);assert.match(app.nodes.get('tasks-deadline-status').textContent,/America\/Vancouver/);assert.equal(app.nodes.get('tasks-deadline').value,'all');assert.equal(taskChanges(app).length,0);}finally{app.close();}
});

test('deadline filters compose with full-list project and search filters and keep truthful pages and completed semantics',async()=>{
  const clock={value:Date.parse('2026-10-25T19:00:00Z')},tasks=[...Array.from({length:125},(_,index)=>taskFixture(index+1,{title:'Calendar project '+index,project:'Unassigned',dueDate:'2026-10-25'})),taskFixture(200,{dueDate:'2026-10-24'}),taskFixture(201,{dueDate:'2026-10-26'}),taskFixture(202,{dueAt:'2026-10-25T20:00:00Z'}),taskFixture(203,{dueAt:'2026-10-25T18:00:00Z'}),taskFixture(204),taskFixture(205,{dueAt:'legacy invalid'}),taskFixture(206,{status:'done',dueDate:'2026-10-24'})],app=await createUI({runtimeClock:clock,workspaceTasks:tasks});
  try{await openTaskDates(app);const filter=app.nodes.get('tasks-deadline');for(const[value,ids]of[['overdue',[200,203]],['upcoming',[201]],['none',[204]]]){filter.value=value;await filter.dispatch('change');assert.deepEqual(visibleTaskIds(app),ids.map(taskId));}filter.value='today';await filter.dispatch('change');assert.equal(app.nodes.get('tasks-results-count').textContent,'Showing 50 of 127 matching tasks.');await app.nodes.get('tasks-show-more').dispatch('click');assert.equal(visibleTaskIds(app).length,100);app.nodes.get('tasks-project').value='project:Unassigned';await app.nodes.get('tasks-project').dispatch('change');assert.equal(app.nodes.get('tasks-results-count').textContent,'Showing 50 of 125 matching tasks.');app.nodes.get('tasks-search').value='124';await app.nodes.get('tasks-search').dispatch('input');assert.deepEqual(visibleTaskIds(app),[taskId(125)]);app.nodes.get('tasks-search').value='';await app.nodes.get('tasks-search').dispatch('input');app.nodes.get('tasks-project').value='all';await app.nodes.get('tasks-project').dispatch('change');await app.nodes.get('toggle-completed').dispatch('click');filter.value='overdue';await filter.dispatch('change');assert.deepEqual(visibleTaskIds(app),[taskId(200),taskId(203)]);assert.equal(taskChanges(app).length,0);}finally{app.close();}
});

test('due sorting uses server civil parts with exact times before date-only and none or invalid last',async()=>{
  const tasks=[taskFixture(1,{dueDate:'2026-10-25'}),taskFixture(2,{dueAt:'2026-10-25T07:01:00Z'}),taskFixture(3,{dueAt:'2026-10-25T23:00:00Z'}),taskFixture(4,{dueDate:'2026-10-24'}),taskFixture(5),taskFixture(6,{dueAt:'invalid'})],app=await createUI({workspaceTasks:tasks});
  try{await openTaskDates(app);app.nodes.get('tasks-sort').value='due';await app.nodes.get('tasks-sort').dispatch('change');assert.deepEqual(visibleTaskIds(app),[4,2,3,1,5,6].map(taskId));assert.match(app.nodes.get('task-list').textContent,/00:01:00\.000 UTC-07:00 · America\/Vancouver/);}finally{app.close();}
});

test('visible task date refresh crosses civil midnight and exact overdue boundaries without resetting filters or drafts',async()=>{
  const clock={value:Date.parse('2026-10-25T06:59:58Z')},task=taskFixture(1,{dueDate:'2026-10-25',project:'Kept'}),exact=taskFixture(2,{dueAt:'2026-10-25T06:59:59Z',project:'Kept'}),app=await createUI({runtimeClock:clock,workspaceTasks:[task,exact]});
  try{await openTaskDates(app);app.nodes.get('tasks-project').value='project:Kept';await app.nodes.get('tasks-project').dispatch('change');app.nodes.get('tasks-deadline').value='overdue';await app.nodes.get('tasks-deadline').dispatch('change');assert.deepEqual(visibleTaskIds(app),[]);clock.value+=1500;app.ui.refreshTaskClock();assert.deepEqual(visibleTaskIds(app),[exact.id]);app.nodes.get('tasks-deadline').value='today';await app.nodes.get('tasks-deadline').dispatch('change');assert.deepEqual(visibleTaskIds(app),[exact.id]);app.nodes.get('new-task').value='An unsent date-boundary draft';clock.value+=11000;app.ui.refreshTaskClock();await until(()=>app.ui.get().deadlineContext.today==='2026-10-25','server civil midnight refresh');assert.deepEqual(visibleTaskIds(app),[task.id]);assert.equal(app.nodes.get('tasks-project').value,'project:Kept');assert.equal(app.nodes.get('new-task').value,'An unsent date-boundary draft');assert.equal(taskChanges(app).length,0);}finally{app.close();}
});

test('unconfirmed deadline metadata shows unavailable filters while title-only editing preserves an existing exact deadline',async()=>{
  const task=taskFixture(1,{dueAt:'2026-11-01T09:30:00.123Z'}),app=await createUI({workspaceTasks:[task],intercept:url=>url.endsWith('/deadline-context')?response({error:{code:'unavailable',message:'Synthetic date service failure'}},503):null});
  try{await openTaskDates(app);app.nodes.get('tasks-deadline').value='today';await app.nodes.get('tasks-deadline').dispatch('change');assert.match(app.nodes.get('tasks-results-count').textContent,/filter unavailable/);assert.match(app.nodes.get('task-list').textContent,/Task dates are unavailable/);app.ui.openEditor('task',task);app.nodes.get('edit-name').value='A safe metadata edit';await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(body.taskId,task.id);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(Object.hasOwn(body,'dueDate'),false);assert.equal(app.ui.get().workspace.tasks[0].dueAt,task.dueAt);}finally{app.close();}
});

test('existing millisecond exact deadlines use server formatting and are omitted entirely from a metadata-only save',async()=>{
  const task=taskFixture(1,{dueAt:'2026-11-01T09:30:00.123Z'}),app=await createUI({workspaceTasks:[task],deadlineTimezone:'America/Los_Angeles'});
  try{await openTaskDates(app,task);assert.equal(app.nodes.get('edit-due-at').value,'2026-11-01T01:30:00.123');assert.match(app.nodes.get('edit-deadline-zone').textContent,/America\/Los_Angeles/);app.nodes.get('edit-name').value='Title without changing the instant';await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(Object.hasOwn(body,'dueDate'),false);assert.equal(app.ui.get().workspace.tasks[0].dueAt,task.dueAt);assert.equal(app.nodes.get('edit-dialog').open,false);}finally{app.close();}
});

test('task date controls require nonempty valid dates, write a floating date, and clear only after explicit None',async()=>{
  const task=taskFixture(1,{dueAt:'2026-10-25T19:00:00.123Z'}),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);await chooseDeadline(app,'date','');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).length,0);assert.match(app.nodes.get('edit-error').textContent,/Choose a deadline date/);await chooseDeadline(app,'date','2026-02-30');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).length,0);await chooseDeadline(app,'date','2026-10-25');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});let body=taskChanges(app).at(-1);assert.equal(body.dueDate,'2026-10-25');assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(app.ui.get().workspace.tasks[0].dueAt,null);app.ui.openEditor('task',app.ui.get().workspace.tasks[0]);await chooseDeadline(app,'none');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});body=taskChanges(app).at(-1);assert.equal(body.dueDate,null);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(app.ui.get().workspace.tasks[0].dueDate,null);}finally{app.close();}
});

test('a daylight-saving fold requires an explicit server offset and preserves the chosen exact millisecond instant',async()=>{
  const task=taskFixture(1),app=await createUI({workspaceTasks:[task],deadlineTimezone:'America/Los_Angeles'});
  try{await openTaskDates(app,task);await chooseDeadline(app,'instant','2026-11-01T01:30:00.321');assert.equal(app.nodes.get('edit-deadline-choice-label').hidden,false);assert.equal(app.nodes.get('edit-deadline-choice').value,'');assert.equal(app.nodes.get('edit-deadline-choice').children.length,3);assert.match(app.nodes.get('edit-deadline-status').textContent,/occurs twice/);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).length,0);const choice=app.nodes.get('edit-deadline-choice');assert.match(choice.children[1].textContent,/UTC-07:00/);assert.match(choice.children[2].textContent,/UTC-08:00/);choice.value=choice.children[2].value;await choice.dispatch('change');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(body.dueAt,'2026-11-01T09:30:00.321Z');assert.equal(Object.hasOwn(body,'dueDate'),false);}finally{app.close();}
});

test('a daylight-saving gap never rolls forward or sends a task mutation',async()=>{
  const task=taskFixture(1),app=await createUI({workspaceTasks:[task],deadlineTimezone:'America/Los_Angeles'});
  try{await openTaskDates(app,task);await chooseDeadline(app,'instant','2026-03-08T02:30');assert.match(app.nodes.get('edit-deadline-status').textContent,/does not exist/);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).length,0);assert.equal(app.nodes.get('edit-due-at').value,'2026-03-08T02:30');assert.match(app.nodes.get('edit-error').textContent,/does not exist/);}finally{app.close();}
});

test('a unique exact time uses the server candidate and never the browser timezone guess',async()=>{
  const task=taskFixture(1),app=await createUI({workspaceTasks:[task],deadlineTimezone:'America/Vancouver'});
  try{await openTaskDates(app,task);await chooseDeadline(app,'instant','2026-11-01T01:30:00.007');assert.equal(app.ui.get().editorDeadline.resolution.status,'unique');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).at(-1).dueAt,'2026-11-01T08:30:00.007Z');assert.equal(app.nodes.get('edit-deadline-choice-label').hidden,true);}finally{app.close();}
});

test('a late exact-time resolution cannot write into a newer task or note editor',async()=>{
  const first=taskFixture(1),second={id:B,title:'Second note',text:'Original note'},held=deferred(),app=await createUI({workspaceTasks:[first],workspaceNotes:[second]});
  try{await openTaskDates(app,first);app.setIntercept(url=>url.includes('deadline-resolve?localDateTime=')?held.promise:null);app.nodes.get('edit-deadline-kind').value='instant';await app.nodes.get('edit-deadline-kind').dispatch('change');app.nodes.get('edit-due-at').value='2026-10-25T09:00';const resolving=app.nodes.get('edit-due-at').dispatch('change');await until(()=>app.requests.some(item=>item.url.includes('localDateTime=')));app.ui.openEditor('note',second);app.nodes.get('edit-text').value='Newer note draft';held.resolve(response(resolveLocalDeadline({timezone:'America/Vancouver',localDateTime:'2026-10-25T09:00'})));await resolving;assert.equal(app.nodes.get('edit-name').value,'Second note');assert.equal(app.nodes.get('edit-text').value,'Newer note draft');assert.equal(app.nodes.get('task-deadline-fields').hidden,true);assert.equal(app.nodes.get('edit-deadline-choice').children.length,1);assert.equal(taskChanges(app).length,0);}finally{app.close();}
});

test('typing during the exact-time save check keeps the newer draft and sends no stale snapshot',async()=>{
  const task=taskFixture(1),held=deferred(),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);app.nodes.get('edit-deadline-kind').value='instant';await app.nodes.get('edit-deadline-kind').dispatch('change');app.nodes.get('edit-due-at').value='2026-10-25T09:00';await app.nodes.get('edit-due-at').dispatch('input');app.setIntercept(url=>url.includes('deadline-resolve?localDateTime=')?held.promise:null);const saving=app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});await until(()=>app.requests.some(item=>item.url.includes('localDateTime=')));app.nodes.get('edit-name').value='A newer title';held.resolve(response(resolveLocalDeadline({timezone:'America/Vancouver',localDateTime:'2026-10-25T09:00'})));await saving;assert.equal(taskChanges(app).length,0);assert.equal(app.nodes.get('edit-name').value,'A newer title');assert.equal(app.nodes.get('edit-dialog').open,true);assert.match(app.nodes.get('edit-error').textContent,/draft changed/);}finally{app.close();}
});

test('late task and note save acknowledgements never close or retarget a newly opened editor',async()=>{
  const task=taskFixture(1),note={id:B,title:'Current note',text:'Kept'},held=deferred(),app=await createUI({workspaceTasks:[task],workspaceNotes:[note]});
  try{await openTaskDates(app,task);app.nodes.get('edit-name').value='First saved snapshot';let captured;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;captured=JSON.parse(options.body);workspace.tasks[0].title=captured.title;workspace.revision++;return held.promise;});const saving=app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});await until(()=>captured);app.ui.openEditor('note',note);app.nodes.get('edit-text').value='A new independent note draft';held.resolve(response({workspace:{...app.ui.get().workspace,revision:1,tasks:[{...task,title:captured.title}]},task:{...task,title:captured.title},appliedRevision:1,replayed:false}));await saving;assert.equal(captured.taskId,task.id);assert.equal(app.nodes.get('edit-dialog').open,true);assert.equal(app.nodes.get('edit-name').value,note.title);assert.equal(app.nodes.get('edit-text').value,'A new independent note draft');assert.equal(app.ui.get().editingTarget.id,note.id);assert.equal(app.nodes.get('edit-save').disabled,false);}finally{app.close();}
});

test('typing during a note save retains its newer draft and a second explicit Save updates that same note',async()=>{
  const note={id:A,title:'Note',text:'Original'},held=deferred(),app=await createUI({workspaceNotes:[note]});
  try{app.ui.openEditor('note',note);app.nodes.get('edit-text').value='Submitted note';let accepted;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;accepted=JSON.parse(options.body);workspace.notes[0].text=accepted.text;workspace.revision++;return held.promise;});const saving=app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});await until(()=>accepted);app.nodes.get('edit-text').value='Newer note';held.resolve(response({workspace:{...app.ui.get().workspace,revision:1,notes:[{...note,text:'Submitted note'}]},appliedRevision:1,replayed:false}));await saving;assert.equal(app.nodes.get('edit-dialog').open,true);assert.equal(app.nodes.get('edit-text').value,'Newer note');assert.match(app.nodes.get('edit-error').textContent,/newer draft/);app.setIntercept(null);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).at(-1).noteId,note.id);assert.equal(app.ui.get().workspace.notes[0].text,'Newer note');}finally{app.close();}
});

test('lost task save acknowledgement confirms only the original operation and preserves newer editor draft and deadline',async()=>{
  const task=taskFixture(1,{dueAt:'2026-10-25T19:00:00.123Z'}),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);app.nodes.get('edit-name').value='Submitted exact target';let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;workspace.tasks[0].title=body.title;workspace.revision++;saved=structuredClone(workspace.tasks[0]);throw new Error('Synthetic lost task acknowledgement');}if(body.operationId===accepted.operationId){assert.deepEqual(body,accepted);return response({workspace,task:saved,appliedRevision:1,replayed:true});}return null;});await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(app.nodes.get('workspace-retry').hidden,false);app.nodes.get('edit-name').value='Newer retained title';await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.nodes.get('edit-name').value,'Newer retained title');assert.equal(app.nodes.get('edit-dialog').open,true);assert.match(app.nodes.get('edit-error').textContent,/saved version is confirmed/);assert.equal(app.ui.get().workspace.tasks.length,1);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const last=taskChanges(app).at(-1);assert.equal(last.taskId,task.id);assert.notEqual(last.operationId,accepted.operationId);assert.equal(last.expectedRevision,1);assert.equal(Object.hasOwn(last,'dueAt'),false);assert.equal(Object.hasOwn(last,'dueDate'),false);assert.equal(app.ui.get().workspace.tasks[0].dueAt,task.dueAt);assert.equal(app.ui.get().workspace.tasks[0].title,'Newer retained title');}finally{app.close();}
});

test('confirming a lost task save cannot associate another editor generation even with an identical title',async()=>{
  const first=taskFixture(1),second=taskFixture(2),app=await createUI({workspaceTasks:[first,second]});
  try{await openTaskDates(app,first);app.nodes.get('edit-name').value='Same title';let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;workspace.tasks[0].title=body.title;workspace.revision++;saved=structuredClone(workspace.tasks[0]);throw new Error('Lost acknowledgement');}if(body.operationId===accepted.operationId)return response({workspace,task:saved,appliedRevision:1,replayed:true});return null;});await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});app.ui.openEditor('task',second);app.nodes.get('edit-name').value='Same title';app.nodes.get('edit-text').value='Separate draft';await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.ui.get().editingTarget.id,second.id);assert.equal(app.nodes.get('edit-text').value,'Separate draft');assert.equal(app.nodes.get('edit-dialog').open,true);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.match(app.nodes.get('edit-error').textContent,/workspace changed/);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).at(-1).taskId,second.id);assert.equal(app.ui.get().workspace.tasks[0].title,'Same title');assert.equal(app.ui.get().workspace.tasks[1].details,'Separate draft');}finally{app.close();}
});

test('lost quick-add acknowledgements confirm the same task once and clear only the unchanged original input',async()=>{
  const app=await createUI();try{let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;saved=taskFixture(1,{id:body.operationId,title:body.title});workspace.tasks.push(saved);workspace.revision++;throw new Error('Lost quick-add acknowledgement');}assert.deepEqual(body,accepted);return response({workspace,task:saved,appliedRevision:1,replayed:true});});app.nodes.get('new-task').value='Only one task';await app.nodes.get('new-task').dispatch('input');await app.nodes.get('task-form').dispatch('submit',{preventDefault(){}});await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.ui.get().workspace.tasks.length,1);assert.equal(app.nodes.get('new-task').value,'');assert.equal(taskChanges(app).length,2);assert.equal(taskChanges(app)[1].operationId,accepted.operationId);assert.equal([...app.storage.values()].some(value=>value.includes('Only one task')),false);}finally{app.close();}
});

test('quick-add confirmation retains newer text and even an explicitly retyped identical draft',async()=>{
  for(const newer of ['A newer task','Original task']){const app=await createUI();try{let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;saved=taskFixture(1,{id:body.operationId,title:body.title});workspace.tasks.push(saved);workspace.revision++;throw new Error('Lost acknowledgement');}return response({workspace,task:saved,appliedRevision:1,replayed:true});});app.nodes.get('new-task').value='Original task';await app.nodes.get('new-task').dispatch('input');await app.nodes.get('task-form').dispatch('submit',{preventDefault(){}});app.nodes.get('new-task').value=newer;await app.nodes.get('new-task').dispatch('input');await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.nodes.get('new-task').value,newer);assert.equal(app.ui.get().workspace.tasks.length,1);assert.equal(taskChanges(app)[0].operationId,taskChanges(app)[1].operationId);}finally{app.close();}}
});
test('deadline revision conflicts retain the explicit date and task target until a fresh human Save',async()=>{
  const task=taskFixture(1),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);await chooseDeadline(app,'date','2026-12-10');app.nodes.get('edit-name').value='My retained deadline edit';let rejected=true;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations')||!rejected)return null;rejected=false;workspace.revision++;return response({error:{code:'revision_conflict',message:'Synthetic concurrent edit'},workspace},409);});await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(app.nodes.get('edit-due-date').value,'2026-12-10');assert.equal(app.nodes.get('edit-name').value,'My retained deadline edit');assert.equal(app.nodes.get('edit-dialog').open,true);assert.match(app.nodes.get('edit-error').textContent,/workspace changed/);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const bodies=taskChanges(app);assert.equal(bodies.length,2);assert.equal(bodies[1].taskId,task.id);assert.equal(bodies[1].expectedRevision,1);assert.equal(bodies[1].dueDate,'2026-12-10');assert.notEqual(bodies[1].operationId,bodies[0].operationId);assert.equal(app.ui.get().workspace.tasks[0].dueDate,'2026-12-10');}finally{app.close();}
});

test('task display and editor use authoritative server civil parts even when client Intl would disagree',async()=>{
  const task=taskFixture(1,{dueAt:'2026-11-01T09:30:00.123Z'}),app=await createUI({workspaceTasks:[task],deadlineTimezone:'America/Vancouver'});
  try{app.setIntercept((url,options,{workspace})=>{if(!url.includes('/task-deadlines?'))return null;const packet=taskDeadlineView(workspace,{timezone:'America/Vancouver',expectedRevision:workspace.revision});packet.deadlines[0]={...packet.deadlines[0],date:'2026-11-01',time:'03:30:00',localDateTime:'2026-11-01T03:30:00.123',offsetMinutes:-360,offsetLabel:'UTC-06:00'};return response(packet);});await openTaskDates(app,task);assert.equal(app.nodes.get('edit-due-at').value,'2026-11-01T03:30:00.123');assert.match(app.nodes.get('task-list').textContent,/03:30:00\.123 UTC-06:00 · America\/Vancouver/);assert.doesNotMatch(app.nodes.get('task-list').textContent,/02:30:00/);assert.equal(taskChanges(app).length,0);}finally{app.close();}
});

test('a late older-revision date view cannot certify current tasks and the next refresh preserves active filters',async()=>{
  const task=taskFixture(1,{dueDate:'2026-10-25'}),clock={value:Date.parse('2026-10-25T19:00:00Z')},held=deferred(),app=await createUI({workspaceTasks:[task],runtimeClock:clock});
  try{let oldPacket;app.setIntercept((url,options,{workspace})=>{if(!url.includes('/task-deadlines?'))return null;oldPacket=taskDeadlineView(workspace,{timezone:'America/Vancouver',expectedRevision:workspace.revision},clock.value);return held.promise;});app.ui.showView('tasks');const checking=app.ui.refreshDeadlineContext();await until(()=>oldPacket);app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace'))return null;workspace.revision++;workspace.tasks[0].dueDate='2026-10-26';return response(workspace);});await app.ui.refreshWorkspace();held.resolve(response(oldPacket));await checking;assert.notEqual(app.ui.get().deadlineTasksRevision,app.ui.get().workspace.revision);app.setIntercept(null);app.nodes.get('tasks-deadline').value='today';await app.nodes.get('tasks-deadline').dispatch('change');assert.equal(app.nodes.get('tasks-results-count').textContent,'Showing 0 of 0 matching tasks.');app.nodes.get('tasks-deadline').value='upcoming';await app.nodes.get('tasks-deadline').dispatch('change');assert.deepEqual(visibleTaskIds(app),[task.id]);assert.equal(app.nodes.get('tasks-deadline').value,'upcoming');}finally{app.close();}
});

test('retained invalid legacy deadlines stay explicit and unchanged during unrelated edits',async()=>{
  const task=taskFixture(1,{dueAt:'2024-11-03T01:30 without a zone'}),app=await createUI({workspaceTasks:[task]});
  try{app.ui.openEditor('task',task);await app.ui.refreshDeadlineContext();assert.equal(app.nodes.get('edit-deadline-kind').value,'retained');assert.match(app.nodes.get('edit-deadline-status').textContent,/existing deadline is kept/);app.nodes.get('edit-text').value='Unrelated details';await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(Object.hasOwn(body,'dueDate'),false);assert.equal(app.ui.get().workspace.tasks[0].dueAt,task.dueAt);}finally{app.close();}
});
test('confirming an original task receipt never presents a later different deadline as unchanged',async()=>{
  const task=taskFixture(1,{dueDate:'2026-10-25'}),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);app.nodes.get('edit-name').value='My confirmed original edit';let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;saved={...workspace.tasks[0],title:body.title};workspace.tasks[0]={...saved,dueDate:'2026-12-31'};workspace.revision=2;throw new Error('Original save committed, then another window changed its deadline');}if(body.operationId===accepted.operationId)return response({workspace,task:saved,appliedRevision:1,replayed:true});return null;});await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});app.nodes.get('edit-name').value='My newer retained title';await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.nodes.get('edit-due-date').value,'2026-10-25');assert.equal(app.nodes.get('edit-name').value,'My newer retained title');assert.match(app.nodes.get('edit-deadline-status').textContent,/deadline changed after this save/);assert.equal(app.nodes.get('edit-deadline-current').hidden,false);const before=taskChanges(app).length;await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});assert.equal(taskChanges(app).length,before);await app.nodes.get('edit-deadline-current').dispatch('click');assert.equal(app.nodes.get('edit-due-date').value,'2026-12-31');assert.equal(app.nodes.get('edit-name').value,'My newer retained title');await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(body.taskId,task.id);assert.equal(Object.hasOwn(body,'dueDate'),false);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(app.ui.get().workspace.tasks[0].dueDate,'2026-12-31');assert.equal(app.ui.get().workspace.tasks[0].title,'My newer retained title');}finally{app.close();}
});

test('explicit None after a historical-versus-current deadline conflict clears the exact task without remaining blocked',async()=>{
  const task=taskFixture(1,{dueDate:'2026-10-25'}),app=await createUI({workspaceTasks:[task]});
  try{await openTaskDates(app,task);app.nodes.get('edit-name').value='Keep my title';let accepted,saved;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workspace/operations'))return null;const body=JSON.parse(options.body);if(!accepted){accepted=body;saved={...workspace.tasks[0],title:body.title};workspace.tasks[0]={...saved,dueDate:'2026-12-31'};workspace.revision=2;throw new Error('Original acknowledgement lost before a later date change');}if(body.operationId===accepted.operationId)return response({workspace,task:saved,appliedRevision:1,replayed:true});return null;});await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});await app.nodes.get('retry-workspace-change').dispatch('click');assert.equal(app.ui.get().editorDeadline.concurrent,true);assert.equal(app.nodes.get('edit-deadline-current').hidden,false);await chooseDeadline(app,'none');assert.equal(app.ui.get().editorDeadline.concurrent,false);await app.nodes.get('edit-form').dispatch('submit',{preventDefault(){}});const body=taskChanges(app).at(-1);assert.equal(body.taskId,task.id);assert.equal(body.dueDate,null);assert.equal(Object.hasOwn(body,'dueAt'),false);assert.equal(body.expectedRevision,2);assert.notEqual(body.operationId,accepted.operationId);assert.equal(app.ui.get().workspace.tasks[0].dueDate,null);assert.equal(app.ui.get().workspace.tasks[0].dueAt,null);assert.equal(app.ui.get().workspace.tasks[0].title,'Keep my title');assert.equal(app.nodes.get('edit-dialog').open,false);}finally{app.close();}
});

test('Backup and recovery stays collapsed in Settings and never exports, previews or imports on construction or ordinary navigation',async()=>{
  const app=await createUI({workspaceTasks:[taskFixture(1,{title:'A private saved task'})]});try{const section=descendants(app.nodes.get('workspace-backups-container')).find(node=>node.tagName==='details');assert.ok(section);assert.equal(section.open,false);assert.match(section.textContent,/does not include chats, build history, AI keys, permissions, app source or project files/);assert.equal(app.requests.some(item=>/\/backups|backup-recovery/.test(item.url)),false);app.ui.showView('settings');app.ui.showView('today');assert.equal(section.open,false);assert.equal(app.requests.some(item=>/\/backups|backup-recovery/.test(item.url)),false);assert.equal(app.ui.get().chatOpen,false);assert.equal(app.nodes.get('new-task').value,'');}finally{app.close();}
});

test('workflow History stays passive until a human opens it and shows original names without changing the blank voice route',async()=>{
  const flow={id:A,name:'Current renamed routine',enabled:false,steps:[]},original={...flow,name:'Original saved routine',enabled:true},record=historyRecord(original,{id:A,status:'completed',steps:[]}),app=await createUI({workspaceWorkflows:[flow],savedWorkflowHistory:[record]});try{assert.equal(app.requests.some(call=>call.url.includes('workflow-runs')||/\/runs\/|\/operations\//.test(call.url)),false);assert.equal(app.ui.get().chatOpen,false);assert.equal(descendants(app.nodes.get('workflow-history-container')).find(node=>node.className==='workflow-history').hidden,true);const history=descendants(app.nodes.get('workflow-list')).find(node=>node.tagName==='button'&&node.textContent==='History');await history.dispatch('click');await until(()=>app.nodes.get('workflow-history-container').textContent.includes('Original saved routine'));assert.equal(app.nodes.get('workflow-history-container').hidden,false);assert.equal(app.requests.filter(call=>call.url.includes('/workflow-runs?')).length,1);assert.equal(app.requests.some(call=>call.method==='POST'&&call.url.includes('/workflows/')),false);assert.match(app.nodes.get('workflow-list').textContent,/Current renamed routine/);assert.match(app.nodes.get('workflow-history-container').textContent,/Original saved routine/);assert.equal(app.ui.get().chatOpen,false);}finally{app.close();}
});

test('pending runs remain inspectable outside missing routine cards and interrupted receipt reads release only the exact saved identity',async()=>{
  const original={id:A,name:'Removed original routine',enabled:true,steps:[{tool:'cap_old',arguments:{text:'Original private input'}}]},record=historyRecord(original,{id:A,status:'interrupted',steps:[],activeStep:{index:0,tool:'cap_old'},outcomeUnknown:true},{operationId:B}),app=await createUI({savedWorkflowHistory:[record],storedWorkflowRuns:[{workflowId:A,operationId:B}]});try{assert.equal(app.nodes.get('workflow-pending-checks').hidden,false);const check=descendants(app.nodes.get('workflow-pending-checks')).find(node=>node.tagName==='button'&&node.textContent==='Check saved run');assert.ok(check);await check.dispatch('click');await until(()=>app.nodes.get('workflow-pending-checks').hidden);assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')),[]);assert.match(app.nodes.get('workflow-history-container').textContent,/Removed original routine/);assert.match(app.nodes.get('workflow-history-container').textContent,/Interrupted/);assert.match(app.nodes.get('workflow-history-container').textContent,/new run starts from step 1/);const calls=app.requests.filter(call=>call.url.includes('/workflows/'));assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.ok(calls[0].url.endsWith('/operations/'+B));assert.ok([...app.storage.values()].every(text=>!text.includes('Original private input')));}finally{app.close();}
});

test('a missing pending record keeps its original check identity and cannot silently become a fresh run',async()=>{
  const flow={id:A,name:'Enabled current routine',enabled:true,steps:[]},app=await createUI({workspaceWorkflows:[flow],storedWorkflowRuns:[{workflowId:A,operationId:B}]});try{await app.ui.runWorkflow(flow);await app.ui.runWorkflow({...flow,name:'A later name',steps:[{tool:'new_tool',arguments:{}}]});assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')),[{workflowId:A,operationId:B}]);const calls=app.requests.filter(call=>call.url.includes('/workflows/'));assert.equal(calls.length,2);assert.ok(calls.every(call=>call.method==='GET'&&call.url.endsWith('/operations/'+B)));assert.match(app.nodes.get('workflow-error').textContent,/without starting another/);assert.match(app.nodes.get('workflow-list').textContent,/Check last run/);}finally{app.close();}
});

test('an interrupted run allows only a separate explicit fresh Run after its actual retained receipt has been read',async()=>{
  const meta=customAction({parameters:{type:'object',properties:{},additionalProperties:false}}),flow={id:A,name:'Current enabled routine',enabled:true,steps:[{tool:meta.name,arguments:{},capability:{id:meta.capabilityId,version:meta.version,hash:meta.hash}}]},record=historyRecord(flow,{id:A,status:'interrupted',steps:[],outcomeUnknown:true},{operationId:B}),app=await createUI({catalog:[meta],workspaceWorkflows:[flow],savedWorkflowHistory:[record],storedWorkflowRuns:[{workflowId:A,operationId:B}]});try{let posted;app.setIntercept((url,options,{workspace})=>{if(!url.endsWith('/workflows/'+A+'/run'))return null;posted=JSON.parse(options.body);return response({id:A,runId:D,status:'completed',steps:[],workspace});});await app.ui.runWorkflow(flow);assert.equal(posted,undefined);assert.deepEqual(JSON.parse(app.storage.get('companion.workspace.ui.v1.pendingWorkflowRuns')),[]);assert.match(app.nodes.get('workflow-list').textContent,/new run starts from step 1/);assert.equal(descendants(app.nodes.get('workflow-history-container')).some(node=>node.tagName==='button'&&/^Run again|^Resume/.test(node.textContent)),false);await app.ui.runWorkflow(flow);assert.ok(posted);assert.notEqual(posted.operationId,B);assert.equal(app.requests.filter(call=>call.method==='POST'&&call.url.endsWith('/run')).length,1);}finally{app.close();}
});

test('a pending check with a paged outcome uses metadata without parsing partial JSON or dropping its full retained evidence',async()=>{
  const flow={id:A,name:'Large saved result',enabled:false,steps:[{tool:'save_note',arguments:{text:'Original'}}]},outcome={id:A,status:'failed',steps:[{tool:'save_note',result:{note:{id:B,title:'Actual saved effect',text:'Long saved result '.repeat(500)+'EXACT_FINAL_TAIL'}}}],failedStep:{index:1,tool:'cap_later'}},record=historyRecord(flow,outcome,{operationId:B}),app=await createUI({workspaceWorkflows:[flow],savedWorkflowHistory:[record],storedWorkflowRuns:[{workflowId:A,operationId:B}]});try{await app.ui.runWorkflow(flow);assert.match(app.nodes.get('workflow-list').textContent,/saved outcome has more pages/);assert.match(app.nodes.get('workflow-list').textContent,/1 recorded steps/);assert.equal(descendants(app.nodes.get('workflow-history-container')).some(node=>node.className==='action-receipt'),false);let button;while((button=descendants(app.nodes.get('workflow-history-container')).find(node=>node.tagName==='button'&&node.textContent==='Load more outcome')))await button.dispatch('click');assert.ok(descendants(app.nodes.get('workflow-history-container')).some(node=>node.className==='action-receipt'));assert.match(app.nodes.get('workflow-history-container').textContent,/EXACT_FINAL_TAIL/);const pages=app.requests.filter(call=>call.url.includes('outcomeOffset='));assert.ok(pages.length>=2);assert.ok(pages.every(call=>call.method==='GET'&&new URL('http://fixture'+call.url).searchParams.get('expectedRunRevision')==='a'.repeat(64)));assert.equal(app.requests.some(call=>call.method==='POST'&&call.url.includes('/workflows/')),false);}finally{app.close();}
});

test('a late pending check cannot replace a different selected history run or navigate away from the newer view',async()=>{
  const first={id:A,name:'First original',enabled:false,steps:[]},second={id:B,name:'Second original',enabled:false,steps:[]},firstRecord=historyRecord(first,{id:A,status:'completed',steps:[]},{id:C,operationId:D}),secondRecord=historyRecord(second,{id:B,status:'completed',steps:[]},{id:E,operationId:F}),held=deferred(),app=await createUI({workspaceWorkflows:[first,second],savedWorkflowHistory:[firstRecord,secondRecord],storedWorkflowRuns:[{workflowId:A,operationId:D}]});try{app.setIntercept(url=>url.endsWith('/operations/'+D)?held.promise:null);const checking=app.ui.runWorkflow(first);await until(()=>app.requests.some(call=>call.url.endsWith('/operations/'+D)));await app.ui.get().workflowHistoryUI.openRun(B,E);app.ui.showView('notes');held.resolve(response(historyPage(firstRecord)));await checking;assert.equal(app.ui.get().currentView,'notes');const detail=descendants(app.nodes.get('workflow-history-container')).find(node=>node.className==='workflow-history-detail');assert.equal(detail.children[0].textContent,'Second original');assert.equal(app.requests.some(call=>call.method==='POST'&&call.url.includes('/workflows/')),false);}finally{app.close();}
});

test('actual human speech opens global run history through GET only while assistant text never triggers the route',async()=>{
  for(const phrase of ['show run history','open run history','show workflow history','open workflow history']){const flow={id:A,name:'Current routine',enabled:false,steps:[]},record=historyRecord({...flow,name:'Original saved routine'},{id:A,status:'completed',steps:[]}),app=await createUI({workspaceWorkflows:[flow],savedWorkflowHistory:[record]});try{app.ui.get().workflowHistoryUI.setWorkflow(A);await app.ui.get().workflowHistoryUI.refresh();const before=app.requests.filter(call=>call.url.includes('/workflow-runs?')).length;app.ui.addMessage('assistant',phrase);assert.equal(app.requests.filter(call=>call.url.includes('/workflow-runs?')).length,before);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const context=copy(app.ui.get().voiceCaptureContext);app.grantMicrophone();await opening;app.setIntercept((url,options)=>url.endsWith('/transcribe')?response({id:options.headers.get('X-Request-Id'),text:phrase}):null);await app.ui.processVoiceSegment({blob:new Blob(['synthetic speech'],{type:'audio/webm'}),context,signal:new AbortController().signal});await until(()=>app.requests.filter(call=>call.url.includes('/workflow-runs?')).length===before+1);const last=app.requests.filter(call=>call.url.includes('/workflow-runs?')).at(-1);assert.equal(last.method,'GET');assert.equal(new URL('http://fixture'+last.url).searchParams.has('workflowId'),false);assert.equal(app.ui.get().currentView,'workflows');assert.equal(app.ui.get().chatOpen,false);assert.equal(app.requests.some(call=>call.method==='POST'&&!call.url.endsWith('/transcribe')),false);assert.equal(app.ui.get().workspace.revision,0);assert.equal(app.ui.get().workspace.tasks.length,0);assert.equal(app.storage.has('companion.workspace.ui.v1.pendingWorkflowRuns'),false);assert.equal(app.ui.get().workspace.workflows[0].enabled,false);}finally{app.close();}}
});

test('stale frozen conversation or project speech cannot open run history or fall back to a model request',async()=>{
  for(const changed of ['conversation','project']){const app=await createUI({saved:[blank(A),blank(B)],selected:A,projects:[PROJECT_A]});try{if(changed==='project')await app.ui.selectProject(PROJECT_A);const opening=app.ui.startRecording();await until(()=>app.waitingForMicrophone);const context=copy(app.ui.get().voiceCaptureContext);app.grantMicrophone();await opening;if(changed==='conversation'){app.ui.cancelTurn(false);assert.equal(await app.ui.selectConversation(B),true);}else await app.ui.selectProject(null);app.setIntercept((url,options)=>url.endsWith('/transcribe')?response({id:options.headers.get('X-Request-Id'),text:'show run history'}):null);await app.ui.processVoiceSegment({blob:new Blob(['old synthetic speech'],{type:'audio/webm'}),context,signal:new AbortController().signal});assert.equal(app.requests.some(call=>call.url.includes('/workflow-runs?')),false);assert.equal(app.requests.some(call=>call.url.endsWith('/chat')),false);assert.equal(app.requests.some(call=>call.method==='POST'&&call.url.includes('/workflows/')),false);assert.match(app.nodes.get('question-error').textContent,changed==='conversation'?/conversation changed/i:/project folder changed/i);assert.equal(app.ui.get().voiceState.enabled,false);}finally{app.close();}}
});

test('a run-history voice alias collision with an installed panel retains the normal safe Tools choice',async()=>{
  const app=await createUI();try{app.ui.setExtensionLoader(async()=>({mount:({container})=>{container.textContent='Independent installed history tool';}}));await app.ui.applyExtensionManifest({version:1,features:[feature('other-history','Run history')]});await app.ui.runCommand('show run history',{voice:true,conversationContext:copy(app.ui.captureConversationContext()),approvalContext:null});assert.equal(app.nodes.get('tools-menu').open,true);assert.match(app.nodes.get('tools-message').textContent,/More than one tool matches/);assert.equal(app.requests.some(call=>call.url.includes('/workflow-runs?')),false);assert.equal(app.ui.get().currentView,'today');assert.equal(app.requests.some(call=>call.url.endsWith('/chat')),false);}finally{app.close();}
});
