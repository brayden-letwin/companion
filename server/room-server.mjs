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
const address = await app.listen();
console.log(`Companion shared room: ${address.url}\nLocal pilot only. Create the first administrator in the browser; no account is pre-created.`);
const stop = () => { app.close().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
