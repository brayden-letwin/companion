import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession } from '../src/voice-session.mjs';

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t, overrides = {}) {
  let at = 0, amplitude = 0, nextId = 1, permission = overrides.permission || 'granted', optIn = overrides.optIn === true;
  const frames = new Map(), timers = new Map(), states = [], errors = [], requests = [], streams = [], recorders = [], segments = [], writes = [], queries = [];
  class Track extends EventTarget { stops = 0; stop() { this.stops += 1; } }
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/webm'; }
    constructor(stream, options = {}) { super(); this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    event(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type), fields)); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.event('dataavailable', { data: new Blob(['synthetic-audio'], { type: this.mimeType }) }); this.event('stop'); }); }
  }
  class Audio {
    constructor() { this.closed = false; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(samples) { samples.fill(amplitude); } }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  const session = createVoiceSession({
    mediaDevices: { async getUserMedia(options) { requests.push(options); if (overrides.getUserMedia) await overrides.getUserMedia(requests.length); const track = new Track(), stream = { track, getTracks: () => [track] }; streams.push(stream); return stream; } },
    permissions: { async query(value) { queries.push(value); if (overrides.query) return overrides.query(); return { state: permission }; } },
    MediaRecorder: Recorder, AudioContext: Audio, now: () => at,
    requestFrame(callback) { const id = nextId++; frames.set(id, callback); return id; }, cancelFrame: id => frames.delete(id),
    setTimer(callback, ms) { const id = nextId++; timers.set(id, { callback, due: at + ms }); return id; }, clearTimer: id => timers.delete(id),
    readOptIn: () => optIn, writeOptIn(value) { optIn = value; writes.push(value); }, captureContext: overrides.captureContext || (() => ({ conversationId: 'synthetic' })),
    async onSegment(segment) { segments.push(segment); if (overrides.onSegment) await overrides.onSegment(segment); },
    onState: value => states.push(value), onError: error => errors.push(error), limits: overrides.limits,
  });
  t.after(() => session.destroy());
  async function advance(ms, value = amplitude, runFrames = true) {
    amplitude = value; const target = at + ms;
    for (;;) { const due = [...timers.entries()].filter(([, entry]) => entry.due <= target).sort((a, b) => a[1].due - b[1].due)[0]; if (!due) break; at = due[1].due; timers.delete(due[0]); due[1].callback(); await settle(); }
    at = target; if (runFrames) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); } await settle();
  }
  async function speech() { await advance(100, .08); await advance(150, .08); await advance(150, .08); }
  return { session, states, errors, requests, streams, recorders, segments, writes, queries, advance, speech, permission: value => { permission = value; }, optedIn: () => optIn };
}

test('voice never opens on a cold visit, and remembered opt-in cannot cause a new permission prompt', async t => {
  const cold = fixture(t); await cold.session.restore(); assert.equal(cold.requests.length, 0); assert.equal(cold.queries.length, 0); assert.equal(cold.session.getState().status, 'off');
  const remembered = fixture(t, { optIn: true, permission: 'prompt' }); await remembered.session.restore();
  assert.equal(remembered.requests.length, 0); assert.equal(remembered.session.getState().status, 'permission-required'); assert.deepEqual(remembered.queries, [{ name: 'microphone' }]);
  await remembered.session.enable(); assert.equal(remembered.requests.length, 1); assert.equal(remembered.session.getState().status, 'listening'); assert.equal(remembered.optedIn(), true);
  assert.deepEqual(remembered.requests[0], { audio: { echoCancellation: true, noiseSuppression: true }, video: false });
});

test('already-granted remembered voice resumes, while unsupported permission queries remain gesture-only', async t => {
  const granted = fixture(t, { optIn: true }); await granted.session.restore(); assert.equal(granted.requests.length, 1); assert.equal(granted.session.getState().status, 'listening');
  const unknown = fixture(t, { optIn: true, query: () => { throw new TypeError('Synthetic unsupported permission query.'); } }); await unknown.session.restore();
  assert.equal(unknown.requests.length, 0); assert.equal(unknown.session.getState().status, 'permission-required'); await unknown.session.enable(); assert.equal(unknown.requests.length, 1);
});

test('quiet periods roll local recordings without sending audio, opening more devices or reporting errors', async t => {
  const f = fixture(t, { limits: { quietRolloverMs: 1000 } }); await f.session.enable();
  for (let index = 0; index < 10; index++) await f.advance(500, 0);
  assert.ok(f.recorders.length >= 5); assert.equal(f.requests.length, 1); assert.equal(f.segments.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.streams[0].track.stops, 0); assert.equal(f.session.getState().status, 'listening');
  f.session.disable(); assert.equal(f.streams[0].track.stops, 1); assert.equal(f.optedIn(), false);
});

test('brief clicks and quiet manual finishes never become blank requests', async t => {
  const f = fixture(t); await f.session.enable(); assert.equal(f.session.finish(), false);
  await f.advance(30, .08); await f.advance(40, 0); await f.advance(2000, 0);
  assert.equal(f.segments.length, 0); assert.equal(f.session.finish(), false); assert.equal(f.session.getState().status, 'listening');
});

test('speech followed by silence submits once, closes the microphone, and pauses through the complete async reply', async t => {
  const reply = deferred(); const f = fixture(t, { onSegment: () => reply.promise }); await f.session.enable(); await f.speech();
  assert.equal(f.session.getState().status, 'speech'); await f.advance(999, 0); assert.equal(f.segments.length, 0); await f.advance(1, 0);
  assert.equal(f.segments.length, 1); assert.equal(f.streams[0].track.stops, 1); assert.equal(f.session.getState().status, 'processing'); assert.ok(f.segments[0].blob.size > 0);
  await f.advance(30000, 0); assert.equal(f.requests.length, 1);
  reply.resolve(); await settle(); assert.equal(f.requests.length, 2); assert.equal(f.session.getState().status, 'listening');
});

test('provider, conversation and approval context is detached before permission and refreshed for the next segment', async t => {
  const permission = deferred(), reply = deferred(); const context = { providerId: 'first', conversation: { id: 'original' }, approval: { id: 'review-original', signature: 'old-preview' } };
  const f = fixture(t, { captureContext: () => context, getUserMedia: count => count === 1 ? permission.promise : undefined, onSegment: () => reply.promise });
  const enabling = f.session.enable(); await settle(); context.providerId = 'second'; context.conversation.id = 'other'; context.approval.id = 'review-other'; permission.resolve(); await enabling;
  await f.speech(); await f.advance(1000, 0);
  assert.deepEqual(f.segments[0].context, { providerId: 'first', conversation: { id: 'original' }, approval: { id: 'review-original', signature: 'old-preview' } });
  reply.resolve(); await settle(); await f.speech(); await f.advance(1000, 0);
  assert.equal(f.segments[1].context.providerId, 'second'); assert.equal(f.segments[1].context.approval.id, 'review-other');
});

test('disable while a permission request is opening stops the late stream and never resurrects listening', async t => {
  const pending = deferred(); const f = fixture(t, { getUserMedia: () => pending.promise }); const opening = f.session.enable(); await settle();
  f.session.disable(); pending.resolve(); await opening;
  assert.equal(f.streams[0].track.stops, 1); assert.equal(f.session.getState().status, 'off'); assert.equal(f.optedIn(), false); assert.equal(f.segments.length, 0);
});

test('busy pause closes capture, and a resume during an outstanding permission request safely opens one replacement', async t => {
  const pending = deferred(); const f = fixture(t, { getUserMedia: count => count === 1 ? pending.promise : undefined }); const opening = f.session.enable(); await settle();
  f.session.pause('busy'); void f.session.resume(); pending.resolve(); await opening; await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.streams[0].track.stops, 1); assert.equal(f.streams[1].track.stops, 0); assert.equal(f.session.getState().status, 'listening');
  f.session.pause('speaking'); assert.equal(f.streams[1].track.stops, 1); assert.equal(f.session.getState().status, 'paused');
});

test('hidden and global Stop abort a submitted turn and keep the microphone closed until permitted', async t => {
  const held = deferred(); const f = fixture(t, { onSegment: () => held.promise }); await f.session.enable(); await f.speech(); await f.advance(1000, 0);
  await f.session.setVisible(false); assert.equal(f.segments[0].signal.aborted, true); assert.equal(f.session.getState().status, 'paused');
  f.session.disable({ remember: false }); assert.equal(f.optedIn(), true); held.resolve(); await settle(); await f.session.setVisible(true); await f.session.restore(); await f.session.resume();
  assert.equal(f.requests.length, 1); assert.equal(f.session.getState().status, 'off');
  await f.session.enable(); assert.equal(f.requests.length, 2);
});

test('hiding stops capture, with a visible remembered session resuming only after prior grant', async t => {
  const f = fixture(t); await f.session.enable(); await f.session.setVisible(false); assert.equal(f.streams[0].track.stops, 1); assert.equal(f.requests.length, 1);
  await f.session.setVisible(true); assert.equal(f.requests.length, 2); assert.equal(f.session.getState().status, 'listening');
});

test('continuous speech is capped at sixty seconds, while a quiet deadline only rotates local audio', async t => {
  const held = deferred(); const f = fixture(t, { onSegment: () => held.promise }); await f.session.enable(); await f.speech(); await f.advance(59600, .08, false);
  assert.equal(f.segments.length, 1); assert.equal(f.segments[0].durationMs, 60000); assert.equal(f.streams[0].track.stops, 1); held.resolve(); await settle();
  const quiet = fixture(t); await quiet.session.enable(); await quiet.advance(60000, 0, false); assert.equal(quiet.segments.length, 0); assert.equal(quiet.requests.length, 1); assert.equal(quiet.recorders.length, 2);
});

test('permission failure and disconnected devices report once and never enter an automatic error loop', async t => {
  const denied = fixture(t, { optIn: true, getUserMedia: () => { throw Object.assign(new Error('Synthetic denied'), { name: 'NotAllowedError' }); } }); await denied.session.enable();
  assert.equal(denied.errors.length, 1); assert.equal(denied.errors[0].code, 'microphone_denied'); await denied.session.restore(); await denied.session.setVisible(false); await denied.session.setVisible(true); await denied.session.resume(); assert.equal(denied.requests.length, 1);
  const disconnected = fixture(t); await disconnected.session.enable(); disconnected.streams[0].track.dispatchEvent(new Event('ended')); await settle();
  assert.equal(disconnected.errors[0].code, 'microphone_disconnected'); assert.equal(disconnected.requests.length, 1); assert.equal(disconnected.streams[0].track.stops, 1);
});

test('revoked or unknown permission blocks automatic reopening after processing and visibility changes', async t => {
  const held = deferred(); const f = fixture(t, { onSegment: () => held.promise }); await f.session.enable(); await f.speech(); await f.advance(1000, 0);
  f.permission('prompt'); held.resolve(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.session.getState().status, 'permission-required'); assert.equal(f.session.getState().enabled, false);
  await f.session.enable(); assert.equal(f.requests.length, 2); await f.session.setVisible(false); f.permission('denied'); await f.session.setVisible(true);
  assert.equal(f.requests.length, 2); assert.equal(f.session.getState().status, 'permission-required');
});

test('audio overflow and processing failures stop the session without an implicit retry', async t => {
  const bounded = fixture(t, { limits: { maxBytes: 4 } }); await bounded.session.enable(); bounded.recorders[0].event('dataavailable', { data: new Blob(['too-large']) }); await settle();
  assert.equal(bounded.errors[0].code, 'audio_limit'); assert.equal(bounded.streams[0].track.stops, 1); assert.equal(bounded.segments.length, 0);
  const failed = fixture(t, { onSegment: () => { throw new Error('Synthetic failed reply'); } }); await failed.session.enable(); await failed.speech(); await failed.advance(1000, 0);
  assert.equal(failed.errors[0].code, 'segment_failed'); assert.equal(failed.requests.length, 1); assert.equal(failed.session.getState().status, 'error');
});

test('destroy cancels local resources and submitted work without erasing the remembered choice', async t => {
  const held = deferred(); const f = fixture(t, { onSegment: () => held.promise }); await f.session.enable(); await f.speech(); assert.equal(f.session.finish(), true); await settle(); assert.equal(f.segments.length, 1);
  f.session.destroy(); assert.equal(f.segments[0].signal.aborted, true); held.resolve(); await settle(); await f.session.enable(); await f.session.restore();
  assert.equal(f.requests.length, 1); assert.equal(f.optedIn(), true); assert.equal(f.session.getState().reason, 'destroyed');
});
