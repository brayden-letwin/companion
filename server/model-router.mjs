import { randomUUID } from 'node:crypto';
import { createProviderSettings } from './provider-settings.mjs';
import { runCodexCompletion, getCodexStatus } from './codex-runner.mjs';

const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const abortError = () => Object.assign(fail('request_cancelled', 'Request stopped.', 499), { name: 'AbortError' });
const jsonSize = value => Buffer.byteLength(JSON.stringify(value));
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

async function readJson(response, signal) {
  if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw fail('provider_output_limit', 'The provider returned too much data.', 502);
  const reader = response.body?.getReader(); if (!reader) throw fail('invalid_provider_response', 'The provider returned unreadable data.', 502);
  const chunks = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 2 * 1024 * 1024) { await reader.cancel().catch(() => {}); throw fail('provider_output_limit', 'The provider returned too much data.', 502); } chunks.push(value); }
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
  let statusCache = null, statusPending = null, statusGeneration = 0, active = 0;
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
  async function request(entry, route, body, signal) {
    let response;
    try { response = await fetchImpl(`${entry.baseUrl}${route}`, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}), ...(entry.type === 'anthropic' ? { 'anthropic-version': '2026-10-21' } : {}) }, body: JSON.stringify(body) }); }
    catch { if (signal.aborted) throw abortError(); throw fail('provider_unavailable', 'The selected provider could not be reached. Check its endpoint and connection.', 503); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); const code = response.status; if ([401, 403].includes(code)) throw fail('provider_credentials_rejected', 'The selected provider rejected its credentials. Update the key in provider settings.', 401); if (code === 429) throw fail('provider_rate_limited', 'The selected provider is rate limited or has no available credit. Try later or choose another provider.', 429); throw fail('provider_unavailable', `The selected provider could not complete this request (HTTP ${code}).`, 502); }
    return readJson(response, signal);
  }
  return {
    getStatus: status,
    async listProviders() { return (await status()).providers; },
    async configure(value) { const result = await storage.configure(value); invalidate(); return result; },
    async remove(id) { const result = await storage.remove(id); invalidate(); return result; },
    async select(id) { await storage.select(id); invalidate(); return { defaultProviderId: id }; },
    async complete({ providerId, messages, system = '', tools = [], signal, onEvent, schema } = {}) {
      const history = messagesValue(messages), definitions = toolsValue(tools); system = text(system, 100000, 'system instructions', true); if (schema !== undefined) schema = schemaValue(schema);
      if (schema && definitions.length) throw fail('validation_error', 'Use structured output or tool calls in one completion, not both.');
      // Feature planning/generation supplies an explicit schema. The Codex
      // tool-call envelope alone does not extend an ordinary chat's budget.
      const completionTimeoutMs = schema ? buildTimeoutMs : timeoutMs;
      if (signal?.aborted) throw abortError();
      if (active >= 2) throw fail('provider_busy', 'Two assistant requests are already running. Stop one before starting another.', 429);
      active += 1; const controller = new AbortController(); let timedOut = false; const cancelled = () => controller.abort(); signal?.addEventListener('abort', cancelled, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, completionTimeoutMs); timer.unref?.();
      try {
        const id = providerId || (await status()).defaultProviderId; const entry = await storage.get(id);
        if (!['codex', 'ollama'].includes(entry.type) && !entry.apiKey) throw fail('provider_key_required', 'Add a key for the selected provider in provider settings.', 409);
        try { onEvent?.({ type: 'progress', message: `Using ${entry.label}.` }); } catch { /* Observers cannot change completion behavior. */ }
        let result;
        if (entry.type === 'codex') {
          const envelope = definitions.length ? TOOL_ENVELOPE : schema;
          const prompt = JSON.stringify({ system, messages: history.map(({ rawContinuation, ...message }) => message), ...(definitions.length ? { availableTools: definitions, responseInstructions: 'Return the JSON envelope. For an action, put its name and a JSON object encoded as argumentsJson into toolCalls; do not claim it ran. If no action is needed, use an empty toolCalls array. Use unique tool call IDs with letters, numbers, underscores, or hyphens.' } : {}) });
          result = await runCodexCompletion({ prompt, schema: envelope, ...(entry.model ? { model: entry.model } : {}), signal: controller.signal, onEvent, dataDirectory, ...(spawnImpl ? { spawnImpl } : {}), timeoutMs: completionTimeoutMs });
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
      finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); active -= 1; }
    },
  };
}
