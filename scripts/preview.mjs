import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.COMPANION_PREVIEW_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COMPANION_PREVIEW_PORT must be an integer from 1024 to 65535.');
const rootReal = await realpath(root);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };

const server = http.createServer(async (request, response) => {
  const fail = (status) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }); response.end(http.STATUS_CODES[status]); };
  if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) return fail(403);
  try {
    // Inspect the unnormalized path so encoded parent-directory segments cannot disappear.
    let urlPath = decodeURIComponent(request.url.split('?')[0]);
    if (/[\\\0:]/.test(urlPath)) return fail(403);
    if (urlPath === '/') urlPath = '/index.html';
    const parts = urlPath.split('/').slice(1);
    if (parts.some((part) => !part || part.startsWith('.'))) return fail(403);
    const allowed = urlPath === '/index.html' || urlPath.startsWith('/src/') || urlPath.startsWith('/assets/') || urlPath.startsWith('/node_modules/pdfjs-dist/');
    if (!allowed) return fail(404);
    const resolved = await realpath(path.join(root, ...parts));
    if (!resolved.startsWith(rootReal + path.sep)) return fail(403);
    const file = await stat(resolved);
    if (!file.isFile()) return fail(404);
    const contentType = mime[path.extname(resolved).toLowerCase()];
    if (!contentType) return fail(404);
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(resolved).on('error', () => response.destroy()).pipe(response);
  } catch (error) { fail(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400); }
});

server.listen(port, '127.0.0.1', () => console.log(`Companion preview: http://127.0.0.1:${port}\nBrowser preview runs local math tools. Live AI and the native corner window require the Electron app.`));
