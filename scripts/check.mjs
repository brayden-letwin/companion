import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (/\.[cm]?js$/.test(entry.name)) sources.push(file);
  }
}
for (const directory of ['src','server','electron','scripts']) await visit(path.join(root, directory));
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { shell: false, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) { process.exitCode = 1; throw result.error || new Error(`Syntax check failed: ${path.relative(root, source)}`); }
}
console.log(`${sources.length} JavaScript source files passed syntax checks.`);
