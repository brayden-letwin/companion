import { pathToFileURL } from 'node:url';
import { format } from 'node:util';

const write = process.stdout.write.bind(process.stdout), diagnostic = process.stderr.write.bind(process.stderr);
const MAX = 128 * 1024;
let input = '', bytes = 0, initial, initialReject, waiting = null, ended = false;
const initialized = new Promise((resolve, reject) => { initial = resolve; initialReject = reject; });
const send = value => { const line = JSON.stringify(value) + '\n'; if (Buffer.byteLength(line) > MAX) throw new Error('Capability output is too large.'); write(line); };
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = (...args) => diagnostic(format(...args) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk; bytes += Buffer.byteLength(chunk);
  if (bytes > 2 * 1024 * 1024 || Buffer.byteLength(input) > MAX) { initialReject(new Error('Invalid capability input.')); waiting?.reject(new Error('Invalid capability input.')); process.stdin.destroy(); return; }
  let index;
  while ((index = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, index); input = input.slice(index + 1);
    try {
      const value = JSON.parse(line);
      if (initial) { const resolve = initial; initial = null; if (value?.type !== 'init') throw new Error(); resolve(value); }
      else if (waiting && value?.type === 'host_result') { const current = waiting; waiting = null; value.ok ? current.resolve(value.result) : current.reject(Object.assign(new Error('Host tool failed.'), { code: value.error?.code || 'host_tool_failed' })); }
      else throw new Error();
    } catch { initialReject(new Error('Invalid capability protocol.')); waiting?.reject(new Error('Invalid capability protocol.')); process.stdin.destroy(); }
  }
});
process.stdin.on('end', () => { if (!ended) { initialReject(new Error('Capability input closed.')); waiting?.reject(new Error('Capability input closed.')); } });

try {
  const input = await initialized;
  let calls = Promise.resolve(), firstError = null;
  const ctx = Object.freeze({
    now: input.now,
    runTool(name, args = {}) {
      const call = calls.then(() => new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        try { send({ type: 'call', tool: name, arguments: args }); } catch (error) { waiting = null; reject(error); }
      }));
      calls = call.catch(error => { firstError ||= error; });
      return call;
    },
  });
  const module = await import(pathToFileURL(process.argv[2]).href);
  if (typeof module.execute !== 'function') throw new Error('Capability has no execute function.');
  const value = await module.execute(input.arguments, ctx);
  await calls; if (firstError) throw firstError;
  send({ type: 'result', value });
} catch { try { send({ type: 'error', code: 'capability_execution_failed' }); } catch { /* Parent enforces the output bound. */ } process.exitCode = 1; }
finally { ended = true; process.stdin.destroy(); }
