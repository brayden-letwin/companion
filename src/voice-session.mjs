const defaults = Object.freeze({ threshold: .022, speechStartMs: 120, silenceMs: 1000, minimumSpeechMs: 300, quietRolloverMs: 15000, maxRecordingMs: 60000, maxBytes: 10 * 1024 * 1024 });

/** On-device capture and turn boundaries. Only onSegment can hand audio to an external service. */
export function createVoiceSession({
  mediaDevices = globalThis.navigator?.mediaDevices,
  permissions = globalThis.navigator?.permissions,
  MediaRecorder = globalThis.MediaRecorder,
  AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
  now = () => globalThis.performance.now(),
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = id => globalThis.cancelAnimationFrame(id),
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = id => globalThis.clearTimeout(id),
  readOptIn = () => false,
  writeOptIn = () => {},
  captureContext = () => null,
  onSegment = async () => {},
  onState = () => {},
  onError = () => {},
  limits = {},
} = {}) {
  const options = { ...defaults, ...limits };
  for (const [key, value] of Object.entries(options)) if (!Object.hasOwn(defaults, key) || !Number.isFinite(value) || value <= 0 || value > defaults[key]) throw new TypeError('Use bounded voice-session limits.');
  let optedIn = false; try { optedIn = readOptIn() === true; } catch { /* Storage being unavailable must not open a microphone. */ }
  let enabled = false, visible = true, destroyed = false, inhibited = false, pauseReason = null;
  let epoch = 0, capture = null, opening = null, processing = null, stateKey = '';
  let state = { enabled, optedIn, visible, status: 'off', reason: null };
  const getState = () => ({ ...state });
  function emit(status, reason = null) {
    state = { enabled, optedIn, visible, status, reason };
    const key = JSON.stringify(state); if (key !== stateKey) { stateKey = key; onState(getState()); }
    return getState();
  }
  function remember(value) { optedIn = value; try { writeOptIn(value); } catch { /* Voice still works without persistent storage. */ } }
  const wanted = () => enabled && visible && !pauseReason && !destroyed && !inhibited;
  function idleState() { return emit(enabled ? 'paused' : 'off', !visible && enabled ? 'hidden' : pauseReason); }
  function dispose(item) {
    if (!item || item.closed) return;
    item.closed = true; clearTimer(item.timer); cancelFrame(item.frame);
    if (item.recorder?.state !== 'inactive') { try { item.recorder?.stop(); } catch { /* Already stopped by the browser. */ } }
    for (const track of item.stream?.getTracks() || []) track.stop();
    try { const result = item.audio?.close(); result?.catch?.(() => {}); } catch { /* Closing an interrupted device is best effort. */ }
    item.chunks = [];
  }
  function stopCapture() { const item = capture; capture = null; dispose(item); }
  function errorState(code, message) {
    enabled = false; inhibited = true; epoch += 1; stopCapture();
    emit('error', code); onError(Object.assign(new Error(message), { code }));
  }
  async function permissionGranted() {
    if (!permissions?.query) return false;
    try { return (await permissions.query({ name: 'microphone' })).state === 'granted'; } catch { return false; }
  }
  function recording(item) {
    if (capture !== item || item.closed || !wanted()) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(item.stream, mimeType ? { mimeType } : {});
    item.recorder = recorder; item.chunks = []; item.bytes = 0; item.recorderStarted = now(); item.stopReason = null;
    recorder.addEventListener('dataavailable', event => {
      if (item.closed || item.recorder !== recorder || !event.data?.size) return;
      item.bytes += event.data.size;
      if (item.bytes > options.maxBytes) { errorState('audio_limit', 'That recording was too large. Enable voice and try a shorter request.'); return; }
      item.chunks.push(event.data);
    });
    recorder.addEventListener('error', () => { if (capture === item && !item.closed) errorState('recording_failed', 'The microphone stopped unexpectedly. Enable voice to try again.'); });
    recorder.addEventListener('stop', () => {
      if (capture !== item || item.closed || item.recorder !== recorder) return;
      if (item.stopReason === 'quiet') {
        item.candidate = null; item.speech = false; item.firstSound = null; item.lastSound = null;
        try { item.context = JSON.parse(JSON.stringify(captureContext())); recording(item); }
        catch { errorState('capture_failed', 'Voice could not prepare the next request. Enable voice to try again.'); }
        return;
      }
      if (item.stopReason === 'submit') void submit(item);
      else errorState('recording_failed', 'The microphone stopped unexpectedly. Enable voice to try again.');
    });
    recorder.start(250);
    clearTimer(item.timer);
    item.timer = setTimer(() => endRecording(item, item.speech ? 'submit' : 'quiet'), options.maxRecordingMs);
  }
  function endRecording(item, reason) {
    if (capture !== item || item.closed || item.stopReason || item.recorder?.state !== 'recording') return;
    item.stopReason = reason; clearTimer(item.timer);
    try { item.recorder.stop(); } catch { errorState('recording_failed', 'The microphone stopped unexpectedly. Enable voice to try again.'); }
  }
  async function submit(item) {
    if (capture !== item || item.closed || !wanted()) return;
    const blob = new Blob(item.chunks, { type: item.recorder.mimeType || 'audio/webm' });
    const context = item.context, durationMs = now() - item.recorderStarted;
    capture = null; dispose(item);
    if (!blob.size || !item.speech) { if (wanted()) void open(false); return; }
    const entry = { controller: new AbortController(), promise: null }; processing = entry; emit('processing');
    entry.promise = (async () => {
      try { await onSegment({ blob, context, durationMs, signal: entry.controller.signal }); }
      catch { if (!entry.controller.signal.aborted && !destroyed) errorState('segment_failed', 'This voice request could not finish. Review it before enabling voice again.'); }
      finally {
        if (processing === entry) processing = null;
        if (wanted()) void open(false); else if (!destroyed && state.status !== 'error') idleState();
      }
    })();
    await entry.promise;
  }
  function analyse(item) {
    if (capture !== item || item.closed || !wanted()) return;
    item.analyser.getFloatTimeDomainData(item.samples);
    let square = 0; for (const value of item.samples) square += value * value;
    const rms = Math.sqrt(square / item.samples.length), at = now();
    if (rms > options.threshold) {
      item.candidate ??= at; item.lastSound = at;
      if (!item.speech && at - item.candidate >= options.speechStartMs) { item.speech = true; item.firstSound = item.candidate; emit('speech'); }
    } else if (!item.speech) item.candidate = null;
    if (item.speech && at - item.lastSound >= options.silenceMs && at - item.firstSound >= options.minimumSpeechMs) { endRecording(item, 'submit'); return; }
    if (!item.speech && at - item.recorderStarted >= options.quietRolloverMs) endRecording(item, 'quiet');
    item.frame = requestFrame(() => analyse(item));
  }
  async function open(gesture) {
    if (!wanted() || capture || processing) return getState();
    if (opening) return opening;
    const token = ++epoch;
    // Capture routing before any permission await, and refresh it for every new segment.
    let context; try { context = JSON.parse(JSON.stringify(captureContext())); } catch { errorState('capture_failed', 'Voice could not prepare this request. Enable voice to try again.'); return getState(); }
    emit('opening');
    opening = Promise.resolve().then(async () => {
      let item, stream;
      try {
        if (!mediaDevices?.getUserMedia || !MediaRecorder || !AudioContext) throw Object.assign(new Error(), { code: 'unsupported' });
        if (!gesture && !await permissionGranted()) { if (token === epoch && wanted()) { enabled = false; emit('permission-required'); } return getState(); }
        if (token !== epoch || !wanted()) return getState();
        stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (token !== epoch || !wanted()) { for (const track of stream.getTracks()) track.stop(); return getState(); }
        item = { stream, context, closed: false, chunks: [], bytes: 0, candidate: null, speech: false, firstSound: null, lastSound: null, frame: null, timer: null };
        capture = item; item.audio = new AudioContext();
        const input = item.audio.createMediaStreamSource(stream); item.analyser = item.audio.createAnalyser(); item.analyser.fftSize = 1024; input.connect(item.analyser); item.samples = new Float32Array(item.analyser.fftSize);
        await item.audio.resume();
        if (token !== epoch || !wanted() || capture !== item) { dispose(item); return getState(); }
        for (const track of stream.getTracks()) track.addEventListener?.('ended', () => { if (capture === item && !item.closed) errorState('microphone_disconnected', 'The microphone was disconnected. Enable voice after reconnecting it.'); }, { once: true });
        recording(item); remember(true); emit('listening'); item.frame = requestFrame(() => analyse(item));
      } catch (error) {
        if (item) { if (capture === item) capture = null; dispose(item); }
        else for (const track of stream?.getTracks() || []) track.stop();
        if (token === epoch && wanted()) errorState(error.name === 'NotAllowedError' ? 'microphone_denied' : error.code === 'unsupported' ? 'unsupported' : 'microphone_failed', error.name === 'NotAllowedError' ? 'Microphone access was not allowed. Enable voice when microphone access is available.' : error.code === 'unsupported' ? 'Automatic voice is unavailable here. You can use the text input.' : 'The microphone could not be opened. Check it, then enable voice to try again.');
      } finally {
        opening = null;
        if (token !== epoch && wanted() && !capture && !processing) void open(false);
      }
      return getState();
    });
    return opening;
  }
  async function enable() { if (destroyed) return getState(); inhibited = false; pauseReason = null; enabled = true; return open(true); }
  async function restore() {
    if (destroyed || inhibited || !visible || !optedIn || enabled) return getState();
    // A previous opt-in alone never authorizes a new permission prompt.
    const token = epoch; const allowed = await permissionGranted();
    if (token !== epoch || destroyed || inhibited || !visible || !optedIn) return getState();
    if (!allowed) return emit('permission-required');
    enabled = true; return open(false);
  }
  function disable({ remember: persistOff = true } = {}) { enabled = false; inhibited = true; pauseReason = null; epoch += 1; stopCapture(); processing?.controller.abort(); if (persistOff) remember(false); return emit('off'); }
  function pause(reason = 'busy') { pauseReason = reason; epoch += 1; stopCapture(); if (processing) return emit('processing', reason); return idleState(); }
  function resume() { if (destroyed) return Promise.resolve(getState()); pauseReason = null; return wanted() ? open(false) : Promise.resolve(idleState()); }
  function setVisible(value) {
    visible = value === true;
    if (!visible) { epoch += 1; stopCapture(); processing?.controller.abort(); return Promise.resolve(idleState()); }
    if (enabled && !inhibited) return open(false);
    return restore();
  }
  function finish() { if (!capture?.speech) return false; endRecording(capture, 'submit'); return true; }
  function destroy() { if (destroyed) return; destroyed = true; enabled = false; epoch += 1; stopCapture(); processing?.controller.abort(); emit('off', 'destroyed'); }
  emit('off');
  return { enable, restore, disable, pause, resume, setVisible, finish, destroy, getState };
}
