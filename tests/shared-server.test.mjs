import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSharedServer } from '../server/shared-server.mjs';

const SECRET = 'Synthetic testing password 2026!';

async function fixture(options = {}) {
  const app = await createSharedServer({ dbPath: ':memory:', port: 0, ...options });
  const address = await app.listen();
  const origin = address.url.replace('/room.html', '');
  async function request(method, route, body, user, extraHeaders = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
    });
    const value = await response.json();
    return { status: response.status, value, setCookie: response.headers.get('set-cookie'), headers: response.headers };
  }
  function authenticated(result) {
    assert.ok(result.setCookie, 'Authentication must return a session cookie');
    return { ...result.value.user, cookie: result.setCookie.split(';')[0], csrfToken: result.value.csrfToken };
  }
  async function setup() {
    const result = await request('POST', '/api/setup', { groupName: 'Synthetic reading group', displayName: 'First reader', password: SECRET });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return authenticated(result);
  }
  async function invite(admin, displayName = 'Second reader') {
    const link = await request('POST', '/api/invites', {}, admin);
    assert.equal(link.status, 201, JSON.stringify(link.value));
    assert.ok(link.value.inviteUrl.endsWith(`#invite=${link.value.inviteToken}`));
    const joined = await request('POST', '/api/join', { inviteToken: link.value.inviteToken, displayName, password: SECRET });
    assert.equal(joined.status, 201, JSON.stringify(joined.value));
    return { user: authenticated(joined), inviteToken: link.value.inviteToken };
  }
  async function room(user) { const response = await request('GET', '/api/room', undefined, user); assert.equal(response.status, 200); return response.value; }
  async function operation(user, type, values = {}, overrides = {}) {
    const current = await room(user);
    const body = { operationId: randomUUID(), expectedRevision: current.revision, type, ...values, ...overrides };
    return { ...await request('POST', '/api/operations', body, user), operation: body };
  }
  return { app, origin, cookieName: `companion_shared_session_v1_${address.port}`, request, authenticated, setup, invite, room, operation };
}

test('first setup, authenticated sessions, login and logout use real server identity', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const initial = await f.request('GET', '/api/session');
  assert.deepEqual(initial.value, { setupRequired: true, user: null });
  assert.equal((await f.request('GET', '/api/room')).status, 401);
  const setup = await f.request('POST', '/api/setup', { groupName: 'A real local room', displayName: 'Casey', password: SECRET });
  assert.equal(setup.status, 201); assert.match(setup.setCookie, /HttpOnly/); assert.match(setup.setCookie, /SameSite=Strict/); assert.match(setup.setCookie, /Path=\/api/);
  const user = f.authenticated(setup);
  assert.equal(user.role, 'admin'); assert.notEqual(user.id, 'you');
  assert.equal(setup.value.room.members.length, 1); assert.deepEqual(setup.value.room.threads, []);
  assert.equal((await f.request('GET', '/api/health')).value.setupRequired, false);
  assert.equal((await f.request('POST', '/api/setup', { groupName: 'Other', displayName: 'Other reader', password: SECRET })).status, 409);
  assert.equal((await f.request('POST', '/api/login', { displayName: 'Casey', password: 'An incorrect password 99!' })).status, 401);
  const signed = await f.request('POST', '/api/login', { displayName: 'CASEY', password: SECRET });
  assert.equal(signed.status, 200); assert.equal(signed.value.user.id, user.id);
  const active = f.authenticated(signed);
  assert.equal((await f.request('POST', '/api/logout', {}, active)).status, 200);
  assert.equal((await f.request('GET', '/api/room', undefined, active)).status, 401);
  assert.equal((await f.request('GET', '/api/room', undefined, user)).status, 200, 'Logging out one session does not log out another');
});

test('only an administrator creates single-use invitations and expired invitations fail', async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock }); t.after(() => f.app.close());
  const admin = await f.setup(), invited = await f.invite(admin);
  assert.equal(invited.user.role, 'member');
  assert.equal((await f.request('POST', '/api/invites', {}, invited.user)).status, 403);
  const duplicate = await f.request('POST', '/api/join', { inviteToken: invited.inviteToken, displayName: 'Third reader', password: SECRET });
  assert.equal(duplicate.status, 400); assert.equal(duplicate.value.error.code, 'invalid_invite');
  const pending = await f.request('POST', '/api/invites', {}, admin);
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await f.request('POST', '/api/join', { inviteToken: pending.value.inviteToken, displayName: 'Late reader', password: SECRET })).status, 400);
  assert.deepEqual((await f.request('GET', '/api/session', undefined, admin)).value, { setupRequired: false, user: null });
});

test('operation authorship, independent review and revision history are enforced by sessions', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const admin = await f.setup(), { user: member } = await f.invite(admin);
  const asked = await f.operation(admin, 'addQuestion', { passageId: 'complete', question: 'Where is completeness used?' });
  assert.equal(asked.status, 200); const question = asked.value.room.threads[0];
  assert.equal(question.author, admin.id); assert.equal(question.source.paperVersion, 'original-v1');
  const spoofed = await f.operation(member, 'addContribution', { threadId: question.id, kind: 'Explanation', text: 'A claimed author.', actor: admin.id });
  assert.equal(spoofed.status, 400);
  const answer = await f.operation(member, 'addContribution', { threadId: question.id, kind: 'Explanation', text: 'Completeness supplies a limit inside the space.' });
  assert.equal(answer.status, 200); const contribution = answer.value.room.threads[0].contributions[0];
  assert.equal(contribution.author, member.id);
  assert.equal((await f.operation(admin, 'editContribution', { threadId: question.id, contributionId: contribution.id, contributionRevision: 1, text: 'Overwriting another member.' })).status, 403);
  assert.equal((await f.operation(member, 'reviewContribution', { threadId: question.id, contributionId: contribution.id, contributionRevision: 1, status: 'reviewed', note: 'Self review.' })).status, 403);
  assert.equal((await f.operation(admin, 'reviewContribution', { threadId: question.id, contributionId: contribution.id, contributionRevision: 1, status: 'reviewed', note: 'Checked the definition of completeness.' })).status, 200);
  assert.equal((await f.operation(member, 'editContribution', { threadId: question.id, contributionId: contribution.id, contributionRevision: 1, text: 'The Cauchy condition comes first; completeness then supplies a limit in X.' })).status, 200);
  const stale = await f.operation(admin, 'reviewContribution', { threadId: question.id, contributionId: contribution.id, contributionRevision: 1, status: 'reviewed', note: 'A stale review.' });
  assert.equal(stale.status, 409); assert.equal(stale.value.error.code, 'contribution_conflict'); assert.ok(stale.value.room);
  const resolved = await f.operation(admin, 'resolveQuestion', { threadId: question.id, contributionId: contribution.id, contributionRevision: 2, summary: 'Completeness supplies the point after the Cauchy argument.' });
  assert.equal(resolved.status, 200);
  const reopened = await f.operation(member, 'reopenQuestion', { threadId: question.id, reason: 'We should explain why Cauchy alone is insufficient.' });
  assert.equal(reopened.status, 200); const thread = reopened.value.room.threads[0];
  assert.equal(thread.status, 'reopened'); assert.equal(thread.resolutions.length, 1);
  assert.equal(thread.contributions[0].reviews[0].revision, 1); assert.equal(thread.contributions[0].revisions[0].revision, 1);
});

test('room compare-and-swap prevents lost updates and receipts prevent duplicate submission', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const admin = await f.setup(), { user: member } = await f.invite(admin);
  const revision = (await f.room(admin)).revision;
  const operation = { operationId: randomUUID(), expectedRevision: revision, type: 'addQuestion', passageId: 'bound', question: 'Why bound the entire tail?' };
  const other = { ...operation, operationId: randomUUID(), question: 'Where is the contraction factor used?' };
  const results = await Promise.all([f.request('POST', '/api/operations', operation, admin), f.request('POST', '/api/operations', other, member)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const successful = results[0].status === 200 ? { user: admin, operation } : { user: member, operation: other };
  const replay = await f.request('POST', '/api/operations', successful.operation, successful.user);
  assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true); assert.equal(replay.value.room.threads.length, 1);
  const changed = await f.request('POST', '/api/operations', { ...successful.operation, question: 'A changed operation with the same ID.' }, successful.user);
  assert.equal(changed.status, 409); assert.equal(changed.value.error.code, 'operation_conflict');
  const newQuestion = await f.operation(admin, 'addQuestion', { passageId: 'idea', question: 'What is a fixed point?' });
  const laterReplay = await f.request('POST', '/api/operations', successful.operation, successful.user);
  assert.equal(laterReplay.value.room.revision, newQuestion.value.room.revision, 'A replay returns the latest room rather than stale state');
});

test('members, sessions, invitations, discussion and idempotency survive a server restart', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'companion-shared-test-'));
  const absoluteTemporary = path.resolve(temporary);
  assert.ok(absoluteTemporary.startsWith(path.resolve(tmpdir()) + path.sep + 'companion-shared-test-'));
  let current;
  t.after(async () => { if (current) await current.app.close(); await rm(absoluteTemporary, { recursive: true, force: true }); });
  const dbPath = path.join(absoluteTemporary, 'room.sqlite');
  const f = await fixture({ dbPath });
  current = f;
  const admin = await f.setup();
  const pending = await f.request('POST', '/api/invites', {}, admin);
  const asked = await f.operation(admin, 'addQuestion', { passageId: 'theorem', question: 'Why require a nonempty space?' });
  await f.app.close();
  current = null;
  const restarted = await fixture({ dbPath, port: Number(new URL(f.origin).port) }); current = restarted;
  const saved = await restarted.room(admin);
  assert.equal(saved.threads[0].question, 'Why require a nonempty space?'); assert.equal(saved.members[0].id, admin.id);
  const replay = await restarted.request('POST', '/api/operations', asked.operation, admin);
  assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true);
  assert.equal((await restarted.request('POST', '/api/join', { inviteToken: pending.value.inviteToken, displayName: 'After restart', password: SECRET })).status, 201);
  const binary = await readFile(dbPath);
  assert.equal(binary.includes(Buffer.from(SECRET)), false, 'Plaintext passwords must not be stored');
  assert.equal(binary.includes(Buffer.from(admin.cookie.split('=')[1])), false, 'Raw session tokens must not be stored');
  assert.equal(binary.includes(Buffer.from(pending.value.inviteToken)), false, 'Raw invitation tokens must not be stored');
});

test('cross-origin changes, CSRF violations, hidden files, bad input and spoofed hosts are rejected', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const admin = await f.setup();
  const invalidOrigin = await f.request('POST', '/api/invites', {}, admin, { Origin: 'https://example.invalid' });
  assert.equal(invalidOrigin.status, 403);
  assert.equal((await f.request('POST', '/api/invites', {}, admin, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const nonJSON = await fetch(f.origin + '/api/invites', { method: 'POST', headers: { Origin: f.origin, Cookie: admin.cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(nonJSON.status, 415);
  const oversized = await fetch(f.origin + '/api/setup', { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(33 * 1024) });
  assert.equal(oversized.status, 413);
  for (const resource of ['/.env', '/server/shared-server.mjs', '/room.sqlite', '/src/core/shared-discussion.mjs', '/%2e%2e/server/shared-server.mjs']) {
    const response = await fetch(f.origin + resource); assert.ok([403, 404].includes(response.status), resource);
  }
  const options = await fetch(f.origin + '/api/room', { method: 'OPTIONS' }); assert.equal(options.status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/api/session', { headers: { Host: 'other.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  const state = await f.room(admin);
  assert.equal(Object.hasOwn(state.members[0], 'password_hash'), false); assert.equal(Object.hasOwn(state.members[0], 'salt'), false);
});

test('authentication is rate-limited and account setup rejects noncanonical overlong names', async t => {
  const f = await fixture({ authLimit: 2 }); t.after(() => f.app.close());
  await f.setup();
  assert.equal((await f.request('POST', '/api/login', { displayName: 'Unknown reader', password: SECRET })).status, 401);
  assert.equal((await f.request('POST', '/api/login', { displayName: 'Unknown reader', password: SECRET })).status, 429);
  const other = await fixture(); t.after(() => other.app.close());
  const invalid = await other.request('POST', '/api/setup', { groupName: 'Group', displayName: '\ufb03'.repeat(25), password: SECRET });
  assert.equal(invalid.status, 400);
  const forged = { cookie: `${other.cookieName}=${randomBytes(32).toString('base64url')}`, csrfToken: randomBytes(32).toString('base64url') };
  assert.equal((await other.request('GET', '/api/room', undefined, forged)).status, 401);
});

test('separate local pilot ports use independent browser cookie names', async t => {
  const first = await fixture(), second = await fixture();
  t.after(async () => { await first.app.close(); await second.app.close(); });
  const memberA = await first.setup(), memberB = await second.setup();
  assert.notEqual(first.cookieName, second.cookieName);
  const browserCookies = `${memberA.cookie}; ${memberB.cookie}`;
  const a = await first.request('GET', '/api/session', undefined, undefined, { Cookie: browserCookies });
  const b = await second.request('GET', '/api/session', undefined, undefined, { Cookie: browserCookies });
  assert.equal(a.value.user.id, memberA.id); assert.equal(b.value.user.id, memberB.id);
});

test('a failed registration preserves its invite and concurrent redemption creates only one member', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const admin = await f.setup();
  const firstInvite = await f.request('POST', '/api/invites', {}, admin);
  const duplicateName = await f.request('POST', '/api/join', { inviteToken: firstInvite.value.inviteToken, displayName: admin.name, password: SECRET });
  assert.equal(duplicateName.status, 409);
  const succeeds = await f.request('POST', '/api/join', { inviteToken: firstInvite.value.inviteToken, displayName: 'A different reader', password: SECRET });
  assert.equal(succeeds.status, 201);
  const raceInvite = await f.request('POST', '/api/invites', {}, admin);
  const race = await Promise.all(['Reader one', 'Reader two'].map(displayName => f.request('POST', '/api/join', { inviteToken: raceInvite.value.inviteToken, displayName, password: SECRET })));
  assert.deepEqual(race.map(result => result.status).sort(), [201, 400]);
  assert.equal((await f.room(admin)).members.length, 3);
});

test('malformed name objects are validation errors rather than server errors', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const malformed = await f.request('POST', '/api/setup', { groupName: 'Group', displayName: { toString: null }, password: SECRET });
  assert.equal(malformed.status, 400); assert.equal(malformed.value.error.code, 'validation_error');
  assert.equal((await f.request('GET', '/api/session')).value.setupRequired, true);
});
