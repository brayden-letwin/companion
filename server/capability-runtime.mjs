import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const RUNNER = fileURLToPath(new URL('./capability-runner.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('./capability-guard.cjs', import.meta.url));
const SAFE_TOOLS = new Set(['list_tasks', 'read_task', 'summarize_tasks', 'list_notes', 'read_note', 'search_notes', 'create_task', 'update_task', 'complete_task', 'save_note', 'start_focus', 'stop_focus', 'get_time']);
const MAX_OUTPUT = 128 * 1024, MAX_INPUT = 64 * 1024;
let active = 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const cancelled = () => Object.assign(fail('request_cancelled', 'Capability stopped. Completed actions remain in the workspace.', 499), { name: 'AbortError' });
const digest = value => createHash('sha256').update(value).digest('hex');
function jsonCopy(value, max, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail('capability_invalid_data', `${label} must be bounded JSON data.`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > max) throw fail('capability_data_limit', `${label} exceeds its data limit.`, 413);
  const copy = JSON.parse(encoded); let entries = 0;
  function check(item, depth) {
    if (++entries > 10000 || depth > 20) throw fail('capability_data_limit', `${label} is too deeply nested.`, 413);
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('capability_invalid_data', `${label} contains unsupported keys.`); check(child, depth + 1); }
  }
  check(copy, 0); return copy;
}
function environment(scratch) {
  const env = { TEMP: scratch, TMP: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, CI: '1', NO_COLOR: '1' };
  for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Fixed guarded Node execution, not an OS sandbox. Actual effects only enter hostActions via the parent broker. */
export async function executeCapability({ root, capability, arguments: args = {}, signal, runTool, now = Date.now, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) throw Object.assign(cancelled(), { hostActions: [] });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw fail('invalid_capability', 'Capability deadlines must be between 10 and 10000 milliseconds.');
  if (!capability || !['pure', 'workspace'].includes(capability.effectPolicy) || !/^[a-f\d]{64}$/.test(capability.moduleHash || '') || !path.isAbsolute(capability.modulePath || '') || path.extname(capability.modulePath) !== '.mjs') throw fail('invalid_capability', 'Use a reviewed single-file capability.');
  if (!object(args)) throw fail('capability_invalid_data', 'Capability arguments must be an object.');
  args = jsonCopy(args, MAX_INPUT, 'Capability arguments');
  const sourceRoot = await realpath(root), sourcePath = await realpath(capability.modulePath), relative = path.relative(sourceRoot, sourcePath);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || (await lstat(capability.modulePath)).isSymbolicLink()) throw fail('invalid_capability', 'The capability must be contained in application source.');
  const source = await readFile(sourcePath); if (source.length > 256 * 1024 || digest(source) !== capability.moduleHash) throw fail('capability_changed', 'The capability changed after its registration was loaded.', 409);
  if (active >= 3) throw fail('capability_busy', 'Three capabilities are already running.', 429);
  active += 1;
  let scratch;
  const hostActions = [];
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'companion-capability-'));
    const modulePath = path.join(scratch, 'capability.mjs'); await writeFile(modulePath, source, { mode: 0o600 });
    if (signal?.aborted) throw cancelled();
    const instant = typeof now === 'function' ? now() : now, currentTime = new Date(instant).toISOString();
    return await new Promise((resolve, reject) => {
      const controller = new AbortController();
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${modulePath}`, `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${GUARD}`, '--no-addons', '--disable-proto=throw', '--max-old-space-size=64', '--require', GUARD, RUNNER, modulePath], { cwd: scratch, env: environment(scratch), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let outputBytes = 0, buffered = Buffer.alloc(0), frames = 0, fatal = null, value, hasResult = false, exited = false, settled = false, pendingBroker = null, calls = 0, forceTimer;
      const stop = error => {
        fatal ||= error; controller.abort();
        if (!exited) { try { child.kill(); } catch { /* Only our own ChildProcess handle is used. */ } if (!forceTimer) { forceTimer = setTimeout(() => { if (!exited) { try { child.kill('SIGKILL'); } catch {} } }, 500); forceTimer.unref?.(); } }
      };
      const aborted = () => stop(cancelled()); signal?.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(() => stop(fail('capability_timeout', 'The capability exceeded its ten-second execution budget.', 504)), timeoutMs); timer.unref?.();
      function send(message) {
        if (exited || fatal) return;
        child.stdin.write(JSON.stringify(message) + '\n', error => { if (error && !exited) stop(fail('capability_protocol_error', 'The capability channel closed unexpectedly.', 502)); });
      }
      async function broker(message) {
        if (capability.effectPolicy !== 'workspace' || !SAFE_TOOLS.has(message.tool)) { stop(fail('capability_tool_forbidden', 'This capability cannot call that host tool.', 403)); return; }
        if (++calls > 12) { stop(fail('capability_tool_limit', 'A capability can make at most twelve host calls.', 400)); return; }
        if (!object(message.arguments) || Object.keys(message).some(key => !['type', 'tool', 'arguments'].includes(key))) { stop(fail('capability_protocol_error', 'The capability sent an invalid host request.', 502)); return; }
        let argumentsCopy; try { argumentsCopy = jsonCopy(message.arguments, MAX_INPUT, 'Host tool arguments'); } catch (error) { stop(error); return; }
        if (typeof runTool !== 'function') { stop(fail('capability_tool_unavailable', 'The workspace broker is unavailable.', 503)); return; }
        const action = { id: `host:${calls}`, tool: message.tool, arguments: argumentsCopy, result: { outcomeUnknown: true, message: 'The host call has not returned a receipt.' }, status: 'pending' }; hostActions.push(action);
        try {
          const result = await runTool(message.tool, argumentsCopy, { callId: action.id, signal: controller.signal });
          // This is an actual parent result, never an output-supplied receipt.
          action.result = jsonCopy(result, 8 * 1024 * 1024, 'Host tool receipt');
          const review = result?.status === 'pending' || result?.requiresApproval === true || result?.desktopAction?.status === 'pending';
          action.status = result?.error ? 'failed' : review ? 'pending' : 'completed';
          if (review) { stop(fail('capability_review_required', 'A host action needs human review. The capability stopped.', 409)); return; }
          if (fatal || controller.signal.aborted) return;
          let forwarded; try { forwarded = jsonCopy(result, MAX_INPUT, 'Host tool response'); } catch (error) { stop(error); return; }
          send({ type: 'host_result', ok: !result?.error, ...(result?.error ? { error: { code: result.code || 'host_tool_failed' } } : { result: forwarded }) });
        } catch (error) {
          if (action.status === 'pending') { action.status = 'failed'; action.result = { error: error.statusCode ? error.message : 'The host tool did not complete. Inspect the workspace before retrying.', code: error.code || 'host_tool_failed', ...(controller.signal.aborted ? { outcomeUnknown: true } : {}) }; }
          if (!fatal) send({ type: 'host_result', ok: false, error: { code: error.code || 'host_tool_failed' } });
        }
      }
      function message(message) {
        if (fatal) return;
        if (!object(message) || ++frames > 15 || hasResult) { stop(fail('capability_protocol_error', 'The capability sent an invalid sequence of messages.', 502)); return; }
        if (message.type === 'call') {
          if (pendingBroker) { stop(fail('capability_protocol_error', 'Capability host calls must be serialized.', 502)); return; }
          pendingBroker = broker(message).finally(() => { pendingBroker = null; }); return;
        }
        if (message.type === 'result' && !pendingBroker && Object.keys(message).every(key => ['type', 'value'].includes(key)) && object(message.value)) { try { value = jsonCopy(message.value, MAX_OUTPUT, 'Capability result'); hasResult = true; } catch (error) { stop(error); } return; }
        stop(fail(message.type === 'error' ? 'capability_execution_failed' : 'capability_protocol_error', 'The capability could not complete its execution.', 502));
      }
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length; if (outputBytes > MAX_OUTPUT) { stop(fail('capability_output_limit', 'Capability output exceeded 128 KiB.', 413)); return; }
        buffered = Buffer.concat([buffered, chunk]); let newline;
        while ((newline = buffered.indexOf(10)) >= 0) { const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1); try { message(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); } catch { stop(fail('capability_protocol_error', 'The capability sent invalid JSON.', 502)); return; } }
      });
      child.stderr.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > MAX_OUTPUT) stop(fail('capability_output_limit', 'Capability output exceeded 128 KiB.', 413)); });
      child.stdin.on('error', () => { if (!exited && !fatal) stop(fail('capability_protocol_error', 'The capability channel closed unexpectedly.', 502)); });
      async function finish(code) {
        if (settled) return; settled = true; exited = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', aborted); controller.abort();
        if (pendingBroker) await Promise.race([pendingBroker, pause(500)]);
        const actions = structuredClone(hostActions);
        if (fatal || code !== 0 || !hasResult || buffered.length) { const error = fatal || fail('capability_execution_failed', 'The capability exited without a valid result.', 502); error.hostActions = actions; reject(error); }
        else resolve({ value, hostActions: actions });
      }
      child.once('error', () => { if (!child.pid) { fatal ||= fail('capability_unavailable', 'The capability process could not start.', 503); void finish(1); } else stop(fail('capability_protocol_error', 'The capability process reported an error.', 502)); });
      child.once('close', code => { void finish(code); });
      send({ type: 'init', arguments: args, now: currentTime });
      if (signal?.aborted) aborted();
    });
  } catch (error) { error.hostActions ||= structuredClone(hostActions); throw error; }
  finally {
    active -= 1;
    if (scratch) {
      const target = path.resolve(scratch);
      if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('companion-capability-')) throw fail('capability_cleanup_failed', 'The private capability directory needs manual review.', 500);
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
    }
  }
}
