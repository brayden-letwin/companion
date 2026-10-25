import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { privateDataDirectory } from './provider-settings.mjs';

let activeJobs = 0;
const fail = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const abortError = () => Object.assign(fail('request_cancelled', 'Request stopped.', 499), { name: 'AbortError' });
const command = process.platform === 'win32' ? 'codex.exe' : 'codex';
const PROBE_INSTRUCTIONS = 'You are a completion engine for one fixed synthetic connection check. Return only the exact plain-text marker requested by the supplied check. Do not use tools, read user or project files, browse, retrieve memories, delegate, or perform actions. No user task, application state, conversation history or source files are supplied.';

function terminate(child, spawnImpl) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  if (process.platform === 'win32' && child.pid && spawnImpl === spawn) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
    killer.on('error', () => child.kill());
  } else child.kill('SIGKILL');
}

/** Checks the CLI's own status command; never reads or exposes its auth files. */
export async function getCodexStatus({ spawnImpl = spawn, signal, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) throw abortError();
  return new Promise(resolve => {
    let child, bytes = 0, output = '', settled = false;
    const done = ready => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve({ ready, unavailableReason: ready ? null : 'Codex is not signed in. Run codex login, then refresh.' }); };
    const cancel = () => { terminate(child, spawnImpl); done(false); };
    const timer = setTimeout(cancel, timeoutMs); timer.unref?.(); signal?.addEventListener('abort', cancel, { once: true });
    try { child = spawnImpl(command, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
    catch { done(false); return; }
    const receive = chunk => { bytes += chunk.length; if (bytes > 16384) cancel(); else output += chunk.toString('utf8'); };
    child.stdout.on('data', receive); child.stderr.on('data', receive); child.on('error', () => done(false));
    child.on('close', code => done(code === 0 && /logged in/i.test(output)));
  });
}

/** Read-only ephemeral completion. Prompts are stdin data, never shell text. */
export async function runCodexCompletion({ prompt, system = '', messages, schema, model, signal, onEvent, onHelperStarted, onHelperSettled, connectionProbe = false, dataDirectory = tmpdir(), spawnImpl = spawn, timeoutMs = 180000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  let directory, registered = false, launched = false, helperSettled = false, cleanupPromise;
  function releaseHelper() {
    if (helperSettled) return cleanupPromise;
    helperSettled = true;
    if (registered) { registered = false; activeJobs -= 1; }
    cleanupPromise = (async () => {
      if (directory) { const resolved = path.resolve(directory), parent = path.resolve(dataDirectory); if (resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('codex-job-')) await rm(resolved, { recursive: true, force: true, maxRetries: 2 }).catch(() => {}); }
      // No credentials, prompt, output or process identity leave this observer.
      // An observer cannot prevent resource release or change the turn result.
      try { const result = onHelperSettled?.(); result?.catch?.(() => {}); } catch { /* Optional observer only. */ }
    })();
    return cleanupPromise;
  }
  try {
  if (typeof connectionProbe !== 'boolean') throw fail('validation_error', 'Use a supported completion mode.', 400);
  if (connectionProbe) { timeoutMs = Math.min(timeoutMs, 60000); maxOutputBytes = Math.min(maxOutputBytes, 32768); }
  if (typeof prompt !== 'string') {
    if (!Array.isArray(messages)) throw fail('validation_error', 'A completion prompt is required.', 400);
    prompt = JSON.stringify({ system, messages });
  } else if (system) prompt = `${system}\n\n${prompt}`;
  if (!prompt.trim() || Buffer.byteLength(prompt) > 512 * 1024) throw fail('validation_error', 'Keep the completion prompt under 512 KiB.', 400);
  if (schema !== undefined && (!schema || typeof schema !== 'object' || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > 128 * 1024)) throw fail('validation_error', 'Use a bounded JSON output schema.', 400);
  if (model !== undefined && model !== '' && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model))) throw fail('validation_error', 'Invalid Codex model.', 400);
  if (signal?.aborted) throw abortError();
  if (activeJobs >= 2) throw fail('provider_busy', 'Two Codex requests are already running. Stop one before starting another.', 429);
  activeJobs += 1; registered = true;
    dataDirectory = await privateDataDirectory(dataDirectory); directory = await mkdtemp(path.join(dataDirectory, 'codex-job-'));
    const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false'];
    if (connectionProbe) {
      // Official --disable/config switches, validated against the installed CLI.
      // Retain its chosen default model and existing sign-in; no auth-file reads.
      for (const feature of ['shell_tool','hooks','memories','multi_agent','multi_agent_v2','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use','view_image','image_generation','skill_search','skill_mcp_dependency_install','workspace_dependencies','sleep_tool','goals','tool_suggest']) args.push('--disable', feature);
      if (signal?.aborted) throw abortError();
      const instructionsPath = path.join(directory, 'connection-probe-instructions.txt');
      await writeFile(instructionsPath, PROBE_INSTRUCTIONS, { mode: 0o600, flag: 'wx' });
      args.push('-c', 'web_search="disabled"', '-c', 'tools.view_image=false', '-c', 'project_doc_max_bytes=0', '-c', 'developer_instructions=""', '-c', 'model_instructions_file=' + JSON.stringify(instructionsPath));
    }
    if (model) args.push('--model', model);
    if (schema) { const schemaPath = path.join(directory, 'output-schema.json'); await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600, flag: 'wx' }); args.push('--output-schema', schemaPath); }
    args.push('-');
    const safePrompt = `You are a completion engine for Companion. Work only from the supplied conversation. Do not use shell, filesystem, browser, MCP, app, or external tools. Do not modify any files. Return the requested answer or structured output; the host application handles any requested actions separately.\n\n${prompt}`;
    return await new Promise((resolve, reject) => {
      let child, bytes = 0, stderrBytes = 0, buffer = '', finalText = '', messageCount = 0, settled = false, turnCompleted = false, terminalError = null, killTimer;
      const decoder = new StringDecoder('utf8');
      const emit = event => { try { onEvent?.(event); } catch { /* Observers cannot interrupt process cleanup. */ } };
      const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); err ? reject(err) : resolve(value); };
      // Keep a bounded caller-facing cancellation, but neither release the
      // process lease nor remove its cwd until the owned helper truly closes.
      const stop = err => { if (settled || terminalError) return; terminalError = err; killTimer = setTimeout(() => done(err), 1500); killTimer.unref?.(); try { terminate(child, spawnImpl); } catch { /* Retain ownership until close. */ } };
      const cancel = () => stop(abortError());
      const timer = setTimeout(() => stop(fail('provider_timeout', 'Codex took too long. Try a smaller request.', 504)), timeoutMs); timer.unref?.();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { clearTimeout(timer); signal?.removeEventListener('abort', cancel); done(abortError()); return; }
      function line(value) {
        if (settled || terminalError) return;
        let event; try { event = JSON.parse(value); } catch { if (value.trim()) stop(fail('invalid_provider_response', 'Codex returned unreadable event data.', 502)); return; }
        if (connectionProbe) {
          if (!event || typeof event !== 'object' || !['thread.started','turn.started','item.started','item.updated','item.completed','turn.completed','turn.failed','error'].includes(event.type)) return stop(fail('invalid_provider_response', 'Codex returned unexpected connection-check events.', 502));
          // The CLI can emit non-fatal startup diagnostics as item.type=error.
          // Discard their payload; they prove neither an action nor completion.
          if (event.type.startsWith('item.') && !['agent_message','assistant_message','reasoning','error'].includes(event.item?.type)) return stop(fail('unexpected_provider_action', 'Codex proposed a tool during the connection check.', 502));
        }
        if (event.type === 'thread.started' || event.type === 'turn.started') emit({ type: 'progress', message: 'Codex is working.' });
        if (event.type === 'item.completed' && ['agent_message', 'assistant_message'].includes(event.item?.type)) {
          const text = event.item.text;
          if (typeof text === 'string') { finalText = text; messageCount++; }
        }
        if (event.type === 'turn.completed') turnCompleted = true;
        if (event.type === 'turn.failed' || event.type === 'error') stop(fail('provider_unavailable', 'Codex could not complete the request. Check its sign-in and account limits, then retry.'));
        if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(event.item?.type)) stop(fail('unexpected_provider_action', 'Codex attempted an action outside the completion request.', 502));
      }
      try { child = spawnImpl(command, args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); launched = true; }
      catch { done(fail('provider_unavailable', 'Codex could not start. Install its CLI and sign in, then refresh.')); return; }
      child.stdout.on('data', chunk => {
        if (settled || terminalError) return;
        bytes += chunk.length;
        if (bytes > maxOutputBytes) return stop(fail('provider_output_limit', 'Codex returned too much output. Try a smaller request.', 502));
        buffer += decoder.write(chunk);
        let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); line(value); }
        if (Buffer.byteLength(buffer) > 1024 * 1024) stop(fail('provider_output_limit', 'Codex returned an oversized event.', 502));
      });
      child.stderr.on('data', chunk => { if (settled || terminalError) return; stderrBytes += chunk.length; if (stderrBytes > (connectionProbe ? 32768 : 65536)) stop(fail('provider_output_limit', 'Codex returned too much diagnostic output.', 502)); });
      child.stdin.on('error', () => { if (!terminalError) stop(fail('provider_unavailable', 'Codex could not receive the request.')); });
      child.on('error', () => {
        const error = terminalError || fail('provider_unavailable', 'Codex could not start. Install its CLI and sign in, then refresh.');
        // A live ChildProcess can emit errors for IPC/kill failures. Only an
        // absent PID confirms a spawn failure; otherwise await actual close.
        if (child.pid) stop(error);
        else { void releaseHelper(); done(error); }
      });
      child.on('close', code => {
        void releaseHelper();
        if (terminalError) return done(terminalError);
        buffer += decoder.end();
        if (buffer.trim()) line(buffer);
        if (terminalError) return done(terminalError);
        if (signal?.aborted) return done(abortError());
        if (code !== 0 || !turnCompleted || !finalText.trim()) return done(fail('provider_unavailable', 'Codex did not finish an answer. Check its sign-in and account limits, then retry.'));
        if (connectionProbe && messageCount !== 1) return done(fail('invalid_provider_response', 'Codex did not return one connection-check answer.', 502));
        emit({ type: 'progress', message: 'Codex finished.' }); done(null, { text: finalText.trim(), toolCalls: [] });
      });
      try { const result = onHelperStarted?.(); result?.catch?.(() => {}); } catch { /* Optional observer cannot change ownership. */ }
      emit({ type: 'progress', message: 'Starting Codex with your existing sign-in.' });
      try { child.stdin.end(safePrompt); } catch { stop(fail('provider_unavailable', 'Codex could not receive the request.')); }
    });
  } finally {
    if (!launched) await releaseHelper();
    else if (helperSettled) await cleanupPromise;
  }
}
