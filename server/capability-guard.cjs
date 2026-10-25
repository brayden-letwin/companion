'use strict';
// Load inherited pipes before blocking new sockets. Native permissions restrict files/processes;
// these fixed JavaScript hooks additionally deny ordinary networking and signalling the host.
void process.stdin; void process.stdout; void process.stderr;
const { syncBuiltinESMExports } = require('node:module');
function denied() { throw Object.assign(new Error('This operation is unavailable in a capability.'), { code: 'ERR_COMPANION_CAPABILITY_DENIED' }); }
function block(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || descriptor.configurable) Object.defineProperty(object, key, { value: denied, writable: false, configurable: false, enumerable: descriptor?.enumerable ?? true });
  else if (descriptor.writable) Object.defineProperty(object, key, { value: denied, writable: false });
}
for (const name of ['fetch', 'WebSocket', 'EventSource']) block(globalThis, name);
for (const name of ['kill', '_kill', 'abort', 'chdir', 'dlopen']) block(process, name);
for (const name of ['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', '_http_agent', '_http_client', '_http_server', '_tls_wrap']) {
  let module; try { module = require('node:' + name); } catch { continue; }
  for (const [key, value] of Object.entries(module)) {
    if (typeof value !== 'function') continue;
    if (value.prototype) for (const method of Object.getOwnPropertyNames(value.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(value.prototype, method);
      if (method !== 'constructor' && typeof descriptor?.value === 'function' && /^(?:connect|listen|send|bind|resolve|lookup|query|createConnection|addMembership|_start|onSocket)/.test(method)) block(value.prototype, method);
    }
    block(module, key);
  }
  if (module.promises) for (const [key, value] of Object.entries(module.promises)) if (typeof value === 'function') block(module.promises, key);
}
syncBuiltinESMExports();
