// The supervisor freezes this bootstrap before any application update. Only
// node:* imports may precede the acknowledged parent handshake.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const instance = process.env.COMPANION_SUPERVISOR_INSTANCE;
const sourceRoot = process.env.COMPANION_SOURCE_ROOT;
if (process.argv.length !== 2 || process.env.COMPANION_SUPERVISED_HOST !== '1' || !UUID.test(instance || '')
  || !UUID.test(process.env.COMPANION_SUPERVISOR_NONCE || '') || !UUID.test(process.env.COMPANION_SUPERVISOR_LIFETIME || '')
  || Number(process.env.COMPANION_SUPERVISOR_PID) !== process.ppid || !process.connected || typeof process.send !== 'function'
  || typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw new Error('Start the service through its owning Companion launcher.');

const send = message => new Promise((resolve, reject) => {
  if (!process.connected) { reject(new Error('The owning launcher disconnected.')); return; }
  process.send({ ...message, instance }, error => error ? reject(error) : resolve());
});
let host = null, initializing, stopping, closing = false, rejectPermission;
const permission = new Promise((resolve, reject) => {
  rejectPermission = reject;
  const timer = setTimeout(() => reject(new Error('The owning launcher did not acknowledge startup.')), 15000);
  const allow = message => {
    if (message?.type !== 'companion:host-start-allowed' || message.instance !== instance) return;
    clearTimeout(timer); process.removeListener('message', allow); resolve();
  };
  process.on('message', allow);
  const originalReject = rejectPermission;
  rejectPermission = error => { clearTimeout(timer); process.removeListener('message', allow); originalReject(error); };
});
async function stop() {
  if (stopping) return stopping;
  closing = true;
  rejectPermission(new Error('The service is stopping.'));
  stopping = (async () => {
    const firstHost = host;
    let closeFailure;
    const earlyClose = firstHost ? firstHost.close().catch(error => { closeFailure = error; }) : Promise.resolve();
    await initializing?.catch(() => {});
    await earlyClose;
    if (closeFailure) throw closeFailure;
    if (host && host !== firstHost) await host.close();
    if (process.connected) { await send({ type: 'companion:host-stopped' }); process.disconnect(); }
  })().catch(error => {
    // Keep ownership/IPC alive after an unconfirmed close. The supervisor must
    // not replace this service or restore source while its worker may survive.
    console.error(error.message); process.exitCode = 1;
  });
  return stopping;
}
process.on('message', message => { if (message?.type === 'companion:host-shutdown' && message.instance === instance) void stop(); });
process.once('disconnect', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

initializing = (async () => {
  await send({ type: 'companion:host-starting' });
  await permission;
  if (closing) return;
  const { createCompanionHost } = await import(pathToFileURL(path.join(sourceRoot, 'server', 'companion-host.mjs')).href);
  if (closing) return;
  host = await createCompanionHost({ root: sourceRoot, dataDirectory: process.env.COMPANION_SHARED_DATA_DIR,
    port: Number(process.env.COMPANION_SHARED_PORT),
    onHostRestart: ({ jobId } = {}) => {
      if (closing) return Promise.reject(new Error('The service is stopping.'));
      return send({ type: 'companion:host-restart-requested', ...(jobId ? { jobId } : {}) });
    },
    onFatal: () => { process.exitCode = 1; void stop(); },
  });
  if (closing) return;
  const status = await host.start();
  if (!closing) await send({ type: 'companion:host-ready', status });
})();
initializing.catch(error => { console.error(error.message); process.exitCode = 1; void stop(); });
