import { randomUUID } from 'node:crypto';
import { createProviderSettings } from './provider-settings.mjs';
import { runCodexCompletion, getCodexStatus } from './codex-runner.mjs';
import { createCompletionQueue } from './completion-queue.mjs';

const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const abortError = () => Object.assign(fail('request_cancelled', 'Request stopped.', 499), { name: 'AbortError' });
const jsonSize = value => Buffer.byteLength(JSON.stringify(value));
const REVISION = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const PROBE_MARKER = 'COMPANION_CONNECTION_OK';
const PROBE_SYSTEM = 'This is a fixed synthetic connection check. Return exactly the requested marker as plain text. Do not use tools, read files, browse, or perform any action.';
const PROBE_MESSAGE = 'Reply with exactly COMPANION_CONNECTION_OK and nothing else.';
const PROBE_TIMEOUT_MS = 60000;
const PROBE_OUTPUT_BYTES = 32768;
function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError()); signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
function checkedProbeText(value, type) {
  const invalid = () => { throw fail('invalid_provider_response', 'The connection returned an invalid check response.', 502); };
  let result;
  if (type === 'openai') {
    if (value.status !== 'completed' || !Array.isArray(value.output)) throw fail('incomplete_provider_response', 'The connection did not finish its check.', 502);
    if (value.output.some(item => !obj(item) || !['message','reasoning'].includes(item.type))) invalid();
    const output = value.output.filter(item => item.type === 'message');
    if (output.length !== 1 || output[0].role !== 'assistant' || output[0].status !== undefined && output[0].status !== 'completed' || !Array.isArray(output[0].content) || output[0].content.length !== 1 || output[0].content[0]?.type !== 'output_text') invalid();
    result = output[0].content[0].text;
  } else if (type === 'anthropic') {
    if (value.stop_reason !== 'end_turn') throw fail('incomplete_provider_response', 'The connection did not finish its check.', 502);
    if (!Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text') invalid();
    result = value.content[0].text;
  } else {
    const local = type === 'ollama';
    if (local ? value.done !== true || value.done_reason && value.done_reason !== 'stop' : !Array.isArray(value.choices) || value.choices.length !== 1 || value.choices[0]?.finish_reason !== 'stop') throw fail('incomplete_provider_response', 'The connection did not finish its check.', 502);
    const message = local ? value.message : value.choices[0].message;
    if (!obj(message) || message.role !== 'assistant' || message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length) || message.function_call != null || message.refusal) invalid();
    result = message.content;
  }
  if (typeof result !== 'string' || result.trim() !== PROBE_MARKER) throw fail('probe_response_mismatch', 'The connection did not return the expected check response.', 502);
}
function safeProbeError(error) {
  const failures = {
    provider_changed: [409, 'The connection changed during its check. Test the current settings.'],
    provider_not_found: [404, 'The connection is no longer available.'],
    provider_key_required: [409, 'Add a key in connection settings before testing.'],
    credential_storage_unavailable: [503, 'The saved key could not be unlocked. Enter it again in connection settings.'],
    provider_credentials_rejected: [401, 'The connection rejected its credentials. Update its key in settings.'],
    provider_rate_limited: [429, 'The connection is rate limited or has no available credit. Try later.'],
    provider_busy: [429, 'The AI request queue is full. Stop work or try again shortly.'],
    provider_timeout: [504, 'The connection check timed out.'],
    provider_output_limit: [502, 'The connection returned too much check data.'],
    incomplete_provider_response: [502, 'The connection did not finish its check.'],
    invalid_provider_response: [502, 'The connection returned an invalid check response.'],
    unexpected_provider_action: [502, 'The connection proposed an action during a check that permits no tools.'],
    probe_response_mismatch: [502, 'The connection did not return the expected check response.'],
  };
  const known = Object.hasOwn(failures, error?.code), [status, message] = known ? failures[error.code] : [503, 'The connection check could not finish. Check its settings and try again.'];
  return fail(known ? error.code : 'provider_unavailable', message, status);
}
function schemaValue(value, label = 'schema') { if (!obj(value) || jsonSize(value) > 128 * 1024) throw fail('validation_error', `Use a bounded JSON ${label}.`); return structuredClone(value); }
function text(value, maximum, label, empty = false) { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) throw fail('validation_error', `Invalid ${label}.`); return value; }
function normalizedCall(value) {
  if (!obj(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id) || typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.name) || !obj(value.arguments) || jsonSize(value.arguments) > 64 * 1024) throw fail('invalid_provider_response', 'The provider returned an invalid tool call.', 502);
  return { id: value.id, name: value.name, arguments: structuredClone(value.arguments) };
}
function messagesValue(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || jsonSize(value) > 512 * 1024) throw fail('validation_error', 'Use between 1 and 100 bounded conversation messages.');
  return value.map(message => {
    if (!obj(message) || !['user', 'assistant', 'tool'].includes(message.role)) throw fail('validation_error', 'Use user, assistant, or tool conversation messages.');
    const result = { role: message.role, content: text(message.content ?? '', 100000, 'message', true) };
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls) || message.toolCalls.length > 16) throw fail('validation_error', 'Use at most 16 tool calls per message.');
      result.toolCalls = message.toolCalls.map(normalizedCall);
    }
    if (message.role === 'assistant' && message.rawContinuation !== undefined) result.rawContinuation = structuredClone(message.rawContinuation);
    if (message.role === 'tool') { result.toolCallId = text(message.toolCallId, 160, 'tool call ID'); result.isError = message.isError === true; }
    return result;
  });
}
function toolsValue(value = []) {
  if (!Array.isArray(value) || value.length > 32 || jsonSize(value) > 128 * 1024) throw fail('validation_error', 'Use at most 32 bounded tool definitions.');
  const names = new Set();
  return value.map(tool => {
    if (!obj(tool) || typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name)) throw fail('validation_error', 'Use unique valid tool names.');
    names.add(tool.name); return { name: tool.name, description: text(tool.description ?? '', 4000, 'tool description', true), parameters: schemaValue(tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false }, 'tool schema') };
  });
}

async function readJson(response, signal, maxBytes = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel().catch(() => {}); throw fail('provider_output_limit', 'The provider returned too much data.', 502); }
  const reader = response.body?.getReader(); if (!reader) throw fail('invalid_provider_response', 'The provider returned unreadable data.', 502);
  const chunks = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > maxBytes) { await reader.cancel().catch(() => {}); throw fail('provider_output_limit', 'The provider returned too much data.', 502); } chunks.push(value); }
  } catch (error) { if (signal.aborted) throw abortError(); throw error; }
  finally { reader.releaseLock(); }
  try { const value = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); if (!obj(value)) throw new Error(); return value; }
  catch { throw fail('invalid_provider_response', 'The provider returned unreadable JSON.', 502); }
}

function openAiInput(messages, providerId) {
  return messages.flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }];
    if (message.role === 'assistant' && message.rawContinuation?.providerId === providerId && message.rawContinuation?.type === 'openai' && Array.isArray(message.rawContinuation.output)) return message.rawContinuation.output;
    const result = message.content ? [{ role: message.role, content: message.content }] : [];
    for (const call of message.toolCalls || []) result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    return result;
  });
}
function anthropicInput(messages) {
  const result = [];
  for (const message of messages) {
    const role = message.role === 'tool' ? 'user' : message.role;
    const content = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }] : [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))];
    if (!content.length) continue;
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  return result;
}
function chatInput(messages, system, ollama = false) {
  return [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(message => ({ role: message.role, content: message.content, ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}), ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: ollama ? call.arguments : JSON.stringify(call.arguments) } })) } : {}) }))];
}

const TOOL_ENVELOPE = { type: 'object', properties: { text: { type: 'string' }, toolCalls: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, argumentsJson: { type: 'string' } }, required: ['id', 'name', 'argumentsJson'], additionalProperties: false } } }, required: ['text', 'toolCalls'], additionalProperties: false };

/** General productivity completions; the caller validates and executes tools. */
export async function createModelRouter({ dataDirectory, fetchImpl = globalThis.fetch, spawnImpl, settings, settingsOptions = {}, timeoutMs = 180000, buildTimeoutMs = 600000 } = {}) {
  for (const [name, value] of [['timeoutMs', timeoutMs], ['buildTimeoutMs', buildTimeoutMs]]) if (!Number.isInteger(value) || value < 1 || value > 600000) throw fail('validation_error', `${name} must be between 1 and 600000 milliseconds.`);
  const storage = settings || await createProviderSettings({ dataDirectory, ...(spawnImpl ? { spawnImpl } : {}), ...settingsOptions });
  let statusCache = null, statusPending = null, statusGeneration = 0;const completions=createCompletionQueue();
  const invalidate = () => { statusCache = null; statusPending = null; statusGeneration += 1; };
  async function status() {
    if (statusCache && statusCache.until > Date.now()) return structuredClone(statusCache.value);
    if (statusPending) return structuredClone(await statusPending);
    const generation = statusGeneration;
    statusPending = (async () => {
      const entries = storage.list(); const codex = entries.some(entry => entry.type === 'codex') ? await getCodexStatus({ ...(spawnImpl ? { spawnImpl } : {}) }) : { ready: false };
      const providers = [];
      for (const entry of entries) {
        let ready = false, verified = false, unavailableReason = null;
        if (entry.type === 'codex') { ready = codex.ready; verified = ready; unavailableReason = codex.unavailableReason; }
        else if (entry.type === 'ollama') {
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
          try { const response = await fetchImpl(`${entry.baseUrl}/api/tags`, { method: 'GET', redirect: 'error', signal: controller.signal }); if (response.ok) { const value = await readJson(response, controller.signal); const canonical = model => model.includes(':') ? model : `${model}:latest`; ready = Array.isArray(value.models) && value.models.some(item => typeof (item.name || item.model) === 'string' && canonical(item.name || item.model) === canonical(entry.model)); verified = ready; } } catch { /* Readiness never exposes network diagnostics. */ }
          finally { clearTimeout(timer); }
          if (!ready) unavailableReason = 'Start Ollama and install this model, then refresh.';
        } else { ready = entry.hasKey; if (!ready) unavailableReason = 'Add an API key in provider settings.'; }
        providers.push({ ...entry, ready, verified, unavailableReason });
      }
      const preferred = storage.defaultProviderId();
      const defaultProviderId = providers.some(entry => entry.id === preferred) ? preferred : providers.find(entry => entry.type === 'codex' && entry.ready)?.id || providers.find(entry => entry.type === 'ollama')?.id || providers[0]?.id || null;
      const value = { defaultProviderId, providers, codexAvailable: codex.ready, reasoningReady: Boolean(providers.find(entry => entry.id === defaultProviderId)?.ready) };
      if (generation === statusGeneration) statusCache = { value, until: Date.now() + 15000 }; return value;
    })().finally(() => { if (generation === statusGeneration) statusPending = null; });
    return structuredClone(await statusPending);
  }
  async function request(entry, route, body, signal, maxBytes) {
    let response;
    try { response = await fetchImpl(`${entry.baseUrl}${route}`, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}), ...(entry.type === 'anthropic' ? { 'anthropic-version': '2026-10-21' } : {}) }, body: JSON.stringify(body) }); }
    catch { if (signal.aborted) throw abortError(); throw fail('provider_unavailable', 'The selected provider could not be reached. Check its endpoint and connection.', 503); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); const code = response.status; if ([401, 403].includes(code)) throw fail('provider_credentials_rejected', 'The selected provider rejected its credentials. Update the key in provider settings.', 401); if (code === 429) throw fail('provider_rate_limited', 'The selected provider is rate limited or has no available credit. Try later or choose another provider.', 429); throw fail('provider_unavailable', `The selected provider could not complete this request (HTTP ${code}).`, 502); }
    return readJson(response, signal, maxBytes);
  }
  return {
    getStatus: status,
    getProviderConfigurations: () => storage.list(),
    async listProviders() { return (await status()).providers; },
    async configure(value) { const result = await storage.configure(value); invalidate(); return result; },
    async remove(id) { const result = await storage.remove(id); invalidate(); return result; },
    async select(id) { await storage.select(id); invalidate(); return { defaultProviderId: id }; },
    async probeConnection(input = {}) {
      if (!obj(input) || Object.keys(input).some(key => !['providerId','expectedRevision','signal','onStopping'].includes(key)) || typeof input.providerId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.providerId) || typeof input.expectedRevision !== 'string' || !REVISION.test(input.expectedRevision) || input.onStopping !== undefined && typeof input.onStopping !== 'function' || input.signal !== undefined && (!input.signal || typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function' || typeof input.signal.aborted !== 'boolean')) throw fail('validation_error', 'Use the current connection ID and revision for a check.');
      const { providerId, expectedRevision, signal, onStopping } = input;
      if (signal?.aborted) throw abortError();
      const current = () => {
        const provider = storage.list().find(entry => entry.id === providerId);
        if (!provider) throw fail('provider_not_found', 'The connection is no longer available.', 404);
        if (provider.revision !== expectedRevision) throw fail('provider_changed', 'The connection changed during its check.', 409);
        return provider;
      };
      try { current(); } catch (error) { throw safeProbeError(error); }
      const controller = new AbortController(); let timedOut = false, release, helperPending = false, notifyClosed, stoppingNotified = false;
      const helperClosed = new Promise(resolve => { notifyClosed = resolve; });
      const stopping = () => { if (stoppingNotified) return; stoppingNotified = true; try { const value = onStopping?.(); value?.catch?.(() => {}); } catch { /* No private data or authority goes to this observer. */ } };
      const cancel = () => { stopping(); controller.abort(); };
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
      const began = Date.now(), timer = setTimeout(() => { timedOut = true; cancel(); }, PROBE_TIMEOUT_MS); timer.unref?.();
      try {
        release = await completions.acquire({ signal: controller.signal, priority: 'background' });
        current();
        const entry = await waitForAbort(storage.get(providerId), controller.signal);
        current();
        if (entry.id !== providerId || entry.revision !== expectedRevision) throw fail('provider_changed', 'The connection changed during its check.', 409);
        if (!['codex','ollama'].includes(entry.type) && !entry.apiKey) throw fail('provider_key_required', 'Add a key before testing this connection.', 409);
        if (controller.signal.aborted) throw abortError();
        if (entry.type === 'codex') {
          const result = await runCodexCompletion({ prompt: PROBE_SYSTEM + '\n\n' + PROBE_MESSAGE, ...(entry.model ? { model: entry.model } : {}), connectionProbe: true,
            signal: controller.signal, dataDirectory, ...(spawnImpl ? { spawnImpl } : {}), timeoutMs: Math.max(1, PROBE_TIMEOUT_MS - (Date.now() - began)), maxOutputBytes: PROBE_OUTPUT_BYTES,
            onHelperStarted() { helperPending = true; }, onHelperSettled() { helperPending = false; notifyClosed(); } });
          if (!result || result.text !== PROBE_MARKER || !Array.isArray(result.toolCalls) || result.toolCalls.length) throw fail('probe_response_mismatch', 'The connection did not return the expected check response.', 502);
        } else {
          const history = [{ role: 'user', content: PROBE_MESSAGE }]; let response;
          if (entry.type === 'openai') response = request(entry, '/responses', { model: entry.model, store: false, instructions: PROBE_SYSTEM, input: history, max_output_tokens: 512 }, controller.signal, PROBE_OUTPUT_BYTES);
          else if (entry.type === 'anthropic') response = request(entry, '/messages', { model: entry.model, max_tokens: 512, stream: false, system: PROBE_SYSTEM, messages: history }, controller.signal, PROBE_OUTPUT_BYTES);
          else if (['compatible','ollama'].includes(entry.type)) {
            const local = entry.type === 'ollama'; response = request(entry, local ? '/api/chat' : '/chat/completions', { model: entry.model, stream: false, messages: chatInput(history, PROBE_SYSTEM), ...(local ? { think: false, options: { num_ctx: 2048, num_predict: 512 } } : { max_tokens: 512 }) }, controller.signal, PROBE_OUTPUT_BYTES);
          } else throw fail('provider_unavailable', 'The connection type is unavailable for this check.', 503);
          checkedProbeText(await waitForAbort(response, controller.signal), entry.type);
        }
        if (controller.signal.aborted) throw abortError();
        current();
        return { passed: true, providerId, revision: expectedRevision };
      } catch (error) {
        if (timedOut) throw safeProbeError({ code: 'provider_timeout' });
        if (controller.signal.aborted) throw abortError();
        throw safeProbeError(error);
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        // A cancelled CLI promise can precede real helper exit. A probe remains
        // stopping and retains its queue lease until that exact helper settles.
        if (helperPending) { stopping(); await helperClosed; }
        release?.();
      }
    },
    async complete({ providerId, messages, system = '', tools = [], signal, onEvent, schema, priority='interactive',expectedProvider } = {}) {
      const history = messagesValue(messages), definitions = toolsValue(tools); system = text(system, 100000, 'system instructions', true); if (schema !== undefined) schema = schemaValue(schema);
      if (schema && definitions.length) throw fail('validation_error', 'Use structured output or tool calls in one completion, not both.');
      // Feature planning/generation supplies an explicit schema. The Codex
      // tool-call envelope alone does not extend an ordinary chat's budget.
      const completionTimeoutMs = schema ? buildTimeoutMs : timeoutMs;
      if (signal?.aborted) throw abortError();
      if(!['interactive','background'].includes(priority))throw fail('validation_error','Choose a supported model request priority.');
      if(expectedProvider!==undefined&&(!obj(expectedProvider)||['id','type','model'].some(key=>typeof expectedProvider[key]!=='string')||expectedProvider.baseUrl!==undefined&&typeof expectedProvider.baseUrl!=='string'))throw fail('validation_error','Use an actual frozen provider descriptor.');
      const controller = new AbortController(); let timedOut = false,release,helperPending=false,completionFinished=false; const cancelled = () => controller.abort(); signal?.addEventListener('abort', cancelled, { once: true });if(signal?.aborted)controller.abort();
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, completionTimeoutMs); timer.unref?.();
      try {
        release=await completions.acquire({signal:controller.signal,priority,onWait:()=>onEvent?.({type:'queue_waiting'})});
        const id = providerId || (await status()).defaultProviderId; const entry = await storage.get(id);
        if(controller.signal.aborted)throw abortError();
        if(expectedProvider&&['id','type','model','baseUrl'].some(key=>(entry[key]??'')!==(expectedProvider[key]??'')))throw fail('provider_changed','The chosen AI connection changed after this work was handed off. Inspect its results and start a new request with the intended connection.',409);
        if (!['codex', 'ollama'].includes(entry.type) && !entry.apiKey) throw fail('provider_key_required', 'Add a key for the selected provider in provider settings.', 409);
        try { onEvent?.({ type: 'progress', message: `Using ${entry.label}.` }); } catch { /* Observers cannot change completion behavior. */ }
        let result;
        if (entry.type === 'codex') {
          const envelope = definitions.length ? TOOL_ENVELOPE : schema;
          const prompt = JSON.stringify({ system, messages: history.map(({ rawContinuation, ...message }) => message), ...(definitions.length ? { availableTools: definitions, responseInstructions: 'Return the JSON envelope. For an action, put its name and a JSON object encoded as argumentsJson into toolCalls; do not claim it ran. If no action is needed, use an empty toolCalls array. Use unique tool call IDs with letters, numbers, underscores, or hyphens.' } : {}) });
          result = await runCodexCompletion({ prompt, schema: envelope, ...(entry.model ? { model: entry.model } : {}), signal: controller.signal, onEvent,onHelperStarted(){helperPending=true;},onHelperSettled(){helperPending=false;if(completionFinished)release?.();}, dataDirectory, ...(spawnImpl ? { spawnImpl } : {}), timeoutMs: completionTimeoutMs });
          if (definitions.length) { let value; try { value = JSON.parse(result.text); if (typeof value.text !== 'string' || !Array.isArray(value.toolCalls)) throw new Error(); result = { text: value.text, toolCalls: value.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: JSON.parse(call.argumentsJson) })) }; } catch { throw fail('invalid_provider_response', 'Codex returned an invalid action proposal.', 502); } }
        } else if (entry.type === 'openai') {
          const value = await request(entry, '/responses', { model: entry.model, store: false, include: ['reasoning.encrypted_content'], instructions: system, input: openAiInput(history, id), max_output_tokens: 8192, ...(definitions.length ? { tools: definitions.map(tool => ({ type: 'function', ...tool, strict: false })) } : {}), ...(schema ? { text: { format: { type: 'json_schema', name: 'companion_output', schema, strict: true } } } : {}) }, controller.signal);
          if (value.status !== 'completed' || !Array.isArray(value.output)) throw fail('incomplete_provider_response', 'The provider did not finish the response. Try a smaller request.', 502);
          result = { text: value.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n'), toolCalls: value.output.filter(item => item.type === 'function_call').map(item => { let args; try { args = JSON.parse(item.arguments); } catch { throw fail('invalid_provider_response', 'The provider returned invalid tool arguments.', 502); } return { id: item.call_id, name: item.name, arguments: args }; }), rawContinuation: { providerId: id, type: 'openai', output: value.output } };
        } else if (entry.type === 'anthropic') {
          const value = await request(entry, '/messages', { model: entry.model, max_tokens: 8192, stream: false, system, messages: anthropicInput(history), ...(definitions.length ? { tools: definitions.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}), ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}) }, controller.signal);
          if (!['end_turn', 'tool_use', 'stop_sequence'].includes(value.stop_reason) || !Array.isArray(value.content)) throw fail('incomplete_provider_response', 'The provider did not finish the response. Try a smaller request.', 502);
          result = { text: value.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), toolCalls: value.content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id, name: item.name, arguments: item.input })) };
        } else {
          const ollama = entry.type === 'ollama';
          const value = await request(entry, ollama ? '/api/chat' : '/chat/completions', { model: entry.model, stream: false, messages: chatInput(history, system, ollama), ...(definitions.length ? { tools: definitions.map(tool => ({ type: 'function', function: tool })) } : {}), ...(schema ? ollama ? { format: schema } : { response_format: { type: 'json_schema', json_schema: { name: 'companion_output', schema, strict: true } } } : {}), ...(ollama ? { think: false, options: { num_ctx: 8192, num_predict: 4096 } } : { max_tokens: 8192 }) }, controller.signal);
          const message = ollama ? value.message : value.choices?.[0]?.message;
          if (ollama ? value.done !== true || value.done_reason && value.done_reason !== 'stop' : !['stop', 'tool_calls'].includes(value.choices?.[0]?.finish_reason)) throw fail('incomplete_provider_response', 'The provider did not finish the response. Try a smaller request.', 502);
          if (!obj(message) || message.role !== 'assistant') throw fail('invalid_provider_response', 'The provider returned an invalid response.', 502);
          result = { text: message.content || '', toolCalls: (message.tool_calls || []).map(call => { let args = call.function?.arguments; if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw fail('invalid_provider_response', 'The provider returned invalid tool arguments.', 502); } } return { id: call.id || `call_${randomUUID()}`, name: call.function?.name, arguments: args }; }) };
        }
        if (controller.signal.aborted) throw abortError();
        if (typeof result.text !== 'string' || result.text.length > 1024 * 1024 || !Array.isArray(result.toolCalls) || result.toolCalls.length > 16) throw fail('invalid_provider_response', 'The provider returned an invalid response.', 502);
        result.toolCalls = result.toolCalls.map(normalizedCall);
        if (result.toolCalls.some(call => !definitions.some(tool => tool.name === call.name)) || new Set(result.toolCalls.map(call => call.id)).size !== result.toolCalls.length) throw fail('invalid_provider_response', 'The provider proposed an unknown or duplicated action.', 502);
        if (!result.text.trim() && !result.toolCalls.length) throw fail('invalid_provider_response', 'The provider returned no answer.', 502);
        return result;
      } catch (error) { if (timedOut) throw fail('provider_timeout', 'The selected provider timed out. Try a smaller request.', 504); if (controller.signal.aborted) throw abortError(); if (error.code && error.statusCode) throw error; throw fail('provider_unavailable', 'The selected provider could not complete this request. Check its connection and settings.', 503); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled);completionFinished=true;if(!helperPending)release?.(); }
    },
  };
}
