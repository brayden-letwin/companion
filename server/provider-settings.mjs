import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, rm, realpath, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = new Set(['codex', 'openai', 'anthropic', 'compatible', 'ollama']);
const DEFAULTS = { openai: { model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1' }, anthropic: { model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1' }, ollama: { model: 'qwen3.5:4b', baseUrl: 'http://127.0.0.1:11434' }, codex: { model: '' }, compatible: { model: '' } };
const error = (message, code = 'validation_error', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const cleanText = (value, max, label, empty = false) => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length > max || (!empty && !value.trim())) throw error(`Invalid ${label}.`);
  return value.trim();
};

export function normalizeProviderUrl(value) {
  let url; try { url = new URL(value); } catch { throw error('Enter a valid provider base URL.'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw error('Use HTTPS, or HTTP on the loopback address, without credentials, a query, or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export async function privateDataDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw error('An absolute private data directory is required.');
  const candidate = path.resolve(directory), source = await realpath(ROOT);
  if (candidate === source || candidate.startsWith(source + path.sep)) throw error('Keep provider data outside the source checkout.');
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const resolved = await realpath(candidate);
  if (resolved === source || resolved.startsWith(source + path.sep)) throw error('Keep provider data outside the source checkout.');
  return resolved;
}

const DPAPI_SCRIPT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; [Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($r.value); $e=[Text.Encoding]::UTF8.GetBytes('Companion-provider-v1:'+ $r.binding); if($r.action -eq 'protect'){$v=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$v=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Out.Write([Convert]::ToBase64String($v))`;

function dpapi(action, value, binding, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child, output = '', size = 0, settled = false;
    const done = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(result); };
    const safe = () => error('The operating-system credential vault is unavailable. The key was not saved.', 'credential_storage_unavailable', 503);
    const timer = setTimeout(() => { child?.kill(); done(safe()); }, 10000); timer.unref?.();
    try { child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
    catch { done(safe()); return; }
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) { child.kill(); done(safe()); } else output += chunk.toString('utf8'); });
    child.stderr.on('data', () => {}); child.on('error', () => done(safe())); child.stdin.on('error', () => done(safe()));
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(output.trim())) return done(safe());
      done(null, action === 'protect' ? output.trim() : Buffer.from(output.trim(), 'base64').toString('utf8'));
    });
    child.stdin.end(JSON.stringify({ action, value: Buffer.from(value, action === 'protect' ? 'utf8' : 'base64').toString('base64'), binding }));
  });
}

/** Metadata is atomic and 0600. Keys use Windows DPAPI; other OSes keep keys in memory only. */
export async function createProviderSettings({ dataDirectory, platform = process.platform, spawnImpl = spawn, vault } = {}) {
  const directory = await privateDataDirectory(dataDirectory), filename = path.join(directory, 'providers.json');
  const secretStorage = vault || platform === 'win32' ? 'dpapi' : 'memory';
  const protect = vault?.protect || ((key, binding) => dpapi('protect', key, binding, spawnImpl));
  const unprotect = vault?.unprotect || ((key, binding) => dpapi('unprotect', key, binding, spawnImpl));
  let saved;
  try {
    const bytes = await readFile(filename); if (bytes.length > 256 * 1024) throw new Error();
    saved = JSON.parse(bytes.toString('utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.providers) || saved.providers.length > 20) throw new Error();
    const ids = new Set();
    for (const entry of saved.providers) {
      if (!object(entry) || Object.keys(entry).some(key => !['id', 'type', 'label', 'model', 'baseUrl', 'protectedKey'].includes(key)) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id) || !TYPES.has(entry.type)) throw new Error();
      ids.add(entry.id); cleanText(entry.label, 80, 'provider label'); cleanText(entry.model, 160, 'model', entry.type === 'codex');
      if (entry.type === 'codex' ? entry.baseUrl !== undefined || entry.protectedKey !== undefined : normalizeProviderUrl(entry.baseUrl) !== entry.baseUrl) throw new Error();
      if (entry.protectedKey !== undefined && (typeof entry.protectedKey !== 'string' || entry.protectedKey.length > 65536 || !/^[A-Za-z0-9+/]+=*$/.test(entry.protectedKey))) throw new Error();
    }
    if (saved.defaultProviderId !== null && !ids.has(saved.defaultProviderId)) throw new Error();
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw error('Provider settings could not be read safely.', 'settings_unavailable', 503);
    saved = { version: 1, defaultProviderId: null, providers: [{ id: 'codex', type: 'codex', label: 'Codex · ChatGPT sign-in', model: '' }, { id: 'ollama', type: 'ollama', label: 'Local Ollama', ...DEFAULTS.ollama }] };
  }
  const memoryKeys = new Map(); let queue = Promise.resolve();
  const binding = entry => `${entry.id}|${entry.type}|${entry.baseUrl || ''}`;
  function redacted(entry) { return { id: entry.id, type: entry.type, label: entry.label, model: entry.model, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}), hasKey: Boolean(entry.protectedKey || memoryKeys.has(entry.id)), secretStorage: entry.protectedKey ? 'dpapi' : secretStorage }; }
  async function persist(next) {
    const temporary = path.join(directory, `.providers-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await chmod(temporary, 0o600); await rename(temporary, filename); }
    finally { await rm(temporary, { force: true }); }
    saved = next;
  }
  function serial(callback) { const result = queue.then(callback); queue = result.catch(() => {}); return result; }
  return {
    list: () => saved.providers.map(redacted),
    defaultProviderId: () => saved.defaultProviderId,
    async get(id) {
      const entry = saved.providers.find(entry => entry.id === id); if (!entry) throw error('That provider was not found.', 'provider_not_found', 404);
      let apiKey = memoryKeys.get(id) || '';
      if (entry.protectedKey) {
        try { apiKey = await unprotect(entry.protectedKey, binding(entry)); }
        catch { throw error('The stored key cannot be unlocked for this user. Enter it again in provider settings.', 'credential_storage_unavailable', 503); }
      }
      return { ...clone(entry), apiKey };
    },
    configure(value) { return serial(async () => {
      if (!object(value) || Object.keys(value).some(key => !['id', 'type', 'label', 'model', 'baseUrl', 'apiKey'].includes(key)) || typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id) || !TYPES.has(value.type)) throw error('Use a valid provider ID and supported provider type.');
      const previous = saved.providers.find(entry => entry.id === value.id);
      if (!previous && saved.providers.length >= 20) throw error('Keep at most 20 providers.');
      const entry = { id: value.id, type: value.type, label: cleanText(value.label ?? previous?.label ?? value.type, 80, 'provider label'), model: cleanText(value.model ?? (previous?.type === value.type ? previous.model : undefined) ?? DEFAULTS[value.type].model, 160, 'model', value.type === 'codex') };
      if (value.type !== 'codex') entry.baseUrl = normalizeProviderUrl(value.baseUrl ?? (previous?.type === value.type ? previous.baseUrl : undefined) ?? DEFAULTS[value.type].baseUrl);
      if (value.type === 'codex' && (value.apiKey || value.baseUrl)) throw error('Codex uses its existing CLI sign-in and does not accept an API key or base URL.');
      const endpointChanged = previous && binding(previous) !== binding(entry);
      if (endpointChanged && value.apiKey === undefined && (previous.protectedKey || memoryKeys.has(entry.id))) throw error('Re-enter the key when changing its provider or endpoint.');
      const nextMemory = new Map(memoryKeys);
      if (value.apiKey !== undefined) {
        if (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[\r\n\0]/.test(value.apiKey)) throw error('Enter a valid API key.');
        const key = value.apiKey.trim();
        nextMemory.delete(entry.id);
        if (key && secretStorage === 'dpapi') entry.protectedKey = await protect(key, binding(entry));
        else if (key) nextMemory.set(entry.id, key);
      } else if (!endpointChanged && previous?.protectedKey) entry.protectedKey = previous.protectedKey;
      if (endpointChanged) nextMemory.delete(entry.id);
      if (value.apiKey?.trim() && secretStorage === 'memory') nextMemory.set(entry.id, value.apiKey.trim());
      const next = clone(saved); next.providers = next.providers.filter(item => item.id !== entry.id); next.providers.push(entry);
      await persist(next); memoryKeys.clear(); for (const [id, key] of nextMemory) memoryKeys.set(id, key);
      return redacted(entry);
    }); },
    select(id) { return serial(async () => { if (!saved.providers.some(entry => entry.id === id)) throw error('That provider was not found.', 'provider_not_found', 404); const next = clone(saved); next.defaultProviderId = id; await persist(next); return id; }); },
    remove(id) { return serial(async () => { if (!saved.providers.some(entry => entry.id === id)) throw error('That provider was not found.', 'provider_not_found', 404); const next = clone(saved); next.providers = next.providers.filter(entry => entry.id !== id); if (next.defaultProviderId === id) next.defaultProviderId = null; await persist(next); memoryKeys.delete(id); return { removed: id }; }); },
  };
}
