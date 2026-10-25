import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedServer } from './shared-server.mjs';

if (process.argv.includes('--help')) {
  console.log('node server/room-server.mjs\nConfigure COMPANION_SHARED_DATA_DIR and optional COMPANION_SHARED_PORT (default 4174). The server binds only to 127.0.0.1.');
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('Use COMPANION_SHARED_DATA_DIR and COMPANION_SHARED_PORT to configure this launcher.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.COMPANION_SHARED_DATA_DIR || path.resolve(root, '..', '..', 'work', 'companion-shared');
const port = Number(process.env.COMPANION_SHARED_PORT || 4174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COMPANION_SHARED_PORT must be an integer from 1024 to 65535.');
const app = await createSharedServer({ dbPath: path.join(path.resolve(dataDirectory), 'room.sqlite'), port });
const managed = process.env.COMPANION_MANAGED_HOST === '1' && typeof process.send === 'function' && process.connected;
const instance = managed ? process.env.COMPANION_HOST_INSTANCE : null;
if (managed) app.server.prependListener('request', (request, response) => {
  if (request.method === 'GET' && request.url?.split('?')[0] === '/api/health') response.setHeader('X-Companion-Instance', instance);
});
const address = await app.listen();
if (managed) process.send({ type: 'companion:ready', instance, port }, () => {});
console.log(`Companion local assistant: ${address.url.replace('/room.html', '/assistant.html')}\nShared reading room: ${address.url}\nThe personal assistant needs no group account. Everything listens only on this PC.`);
let stopping;
const stop = () => {
  if (stopping) return stopping;
  const deadline = setTimeout(() => { process.exitCode = 1; process.exit(1); }, 12000); deadline.unref();
  stopping = app.close().catch(() => { process.exitCode = 1; }).finally(() => {
    clearTimeout(deadline);
    if (managed && process.connected) { try { process.send({ type: 'companion:stopped', instance }, () => {}); process.disconnect(); } catch {} }
  });
  return stopping;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
if (managed) {
  process.on('message', message => { if (message?.type === 'companion:shutdown' && message.instance === instance) void stop(); });
  process.once('disconnect', () => { void stop(); });
}
