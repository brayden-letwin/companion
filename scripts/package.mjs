import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'Companion';
if (process.argv.length > 3 || !/^Companion(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,59})?$/.test(name)) {
  throw new Error('Usage: node scripts/package.mjs [Companion-version]. Output stays inside release/.');
}
const releaseRoot = path.join(root, 'release');
const destination = path.resolve(releaseRoot, name);
if (path.dirname(destination) !== releaseRoot) throw new Error('Invalid package destination.');
const runtime = path.join(root, 'node_modules', 'electron', 'dist');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');
const sourceFiles = ['index.html', 'group.html', 'assistant.html', 'package.json'];
const sourceDirectories = ['src', 'electron'];
const publicExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const privateNames = new Set(['secrets', 'credentials', 'tests', 'test-results', 'private', 'recordings', 'captures', 'screenshots', 'transcripts', 'user-notes', 'papers', 'node_modules']);

async function copySourceDirectory(source, target) {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name.startsWith('.') || privateNames.has(item.name.toLowerCase())) continue;
    if (item.isSymbolicLink()) throw new Error(`Source links are not packaged: ${path.relative(root, path.join(source, item.name))}`);
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    if (item.isDirectory()) await copySourceDirectory(from, to);
    else if (item.isFile() && publicExtensions.has(path.extname(item.name).toLowerCase())) await copyFile(from, to);
  }
}

async function directorySize(directory) {
  let bytes = 0;
  let files = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, item.name);
    if (item.isDirectory()) {
      const nested = await directorySize(location);
      bytes += nested.bytes;
      files += nested.files;
    } else if (item.isFile()) {
      bytes += (await stat(location)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

// Preflight before creating an output directory. This packages the installed
// Windows runtime without a download, shell invocation, or build service.
try { await stat(path.join(runtime, 'electron.exe')); }
catch { throw new Error('Windows Electron runtime not found. Install dependencies on Windows before packaging.'); }
await stat(path.join(pdfjs, 'build', 'pdf.mjs'));
for (const name of [...sourceFiles, ...sourceDirectories, '.env.example']) await stat(path.join(root, name));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(releaseRoot, { recursive: true });
try { await mkdir(destination); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error(`${destination} already exists. Move or remove that folder yourself, or use a new name such as Companion-${metadata.version}-2. The packager never replaces an existing build.`);
  throw error;
}

try {
  for (const entry of await readdir(runtime)) {
    await cp(path.join(runtime, entry), path.join(destination, entry), { recursive: true, dereference: true, force: false, errorOnExist: true });
  }
  await rename(path.join(destination, 'electron.exe'), path.join(destination, 'Companion.exe'));
  const appDirectory = path.join(destination, 'resources', 'app');
  await mkdir(appDirectory, { recursive: true });
  for (const file of sourceFiles) await copyFile(path.join(root, file), path.join(appDirectory, file));
  for (const directory of sourceDirectories) await copySourceDirectory(path.join(root, directory), path.join(appDirectory, directory));
  await mkdir(path.join(appDirectory, 'node_modules'), { recursive: true });
  await cp(pdfjs, path.join(appDirectory, 'node_modules', 'pdfjs-dist'), { recursive: true, dereference: true, force: false, errorOnExist: true });
  await copyFile(path.join(root, '.env.example'), path.join(destination, '.env.example'));
  await writeFile(path.join(destination, 'README-shared-room.txt'), `Companion ${metadata.version} — local service\n\nThe desktop uses the separately running Companion service at http://127.0.0.1:4174. Start Companion.cmd or Start Desktop Companion.cmd in the source checkout starts that service using Node.js 24.15 or newer. This app folder does not include Node, the server, local models or speech services. Keep the source checkout and runtime folders available.\n\nThe optional group reading room remains at http://127.0.0.1:4174/room.html. Its saved data is separate from the general productivity workspace. Remote hosting and university sign-in are not part of this local build.\n`, 'utf8');
  await writeFile(path.join(destination, 'README-launch.txt'), `Companion ${metadata.version} — Windows desktop\n\nUse Start Companion.cmd in the source checkout for the complete launch. It starts the local service and opens this productivity assistant. For a browser window use scripts/start-companion.ps1 -Browser.\n\nIf the local service is already running, double-click Companion.exe here. Keep this entire folder together. The app opens a small always-on-top corner; Open workspace shows the full app. Use the tray menu to quit. Closing a window hides it; the local service keeps running. The corner shows whether its global keyboard shortcuts are available.\n\nSettings uses the installed Codex CLI sign-in or separately configured API connections. API keys belong in Settings, never in this app folder or a Git commit. Voice needs the separately installed local speech service.\n\nDesktop actions discover installed apps and read explicitly selected accessible windows. Generic clicks and text changes require an exact action review in Companion. Completed receipts describe what actually happened. Generated source changes have checks, review and rollback; native-code changes need a desktop restart.\n\nThis is an unsigned development app folder, not an installer.\n`, 'utf8');
  const size = await directorySize(destination);
  console.log(JSON.stringify({ path: destination, version: metadata.version, ...size, megabytes: Number((size.bytes / 1024 / 1024).toFixed(1)) }, null, 2));
} catch (error) {
  console.error(`Packaging stopped. Partial files remain in ${destination}; choose a new package name after fixing the error.`);
  throw error;
}
