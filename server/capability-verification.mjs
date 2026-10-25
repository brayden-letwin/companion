import { loadCapabilities } from './capability-registry.mjs';
import { executeCapability } from './capability-runtime.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export async function verifyPanelCapabilityLinks({ root } = {}) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root,'src','features','manifest.json'),'utf8'));
    const capabilities = await loadCapabilities({ root }); let linked = 0;
    for (const feature of manifest.features || []) {
      if (feature.aliases !== undefined && (!Array.isArray(feature.aliases) || feature.aliases.length > 12 || feature.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 100))) throw new Error('Feature voice aliases must be bounded text names.');
      if (feature.capabilityId === undefined) continue;
      const capability = capabilities.find(item => item.id === feature.capabilityId);
      if (!capability || capability.featureId && capability.featureId !== feature.id) throw new Error(`Panel ${feature.id} references a missing or differently linked capability.`);
      linked += 1;
    }
    return { passed: true, output: `${linked} panel/capability link(s) refer to registered executors.` };
  } catch (error) { return { passed: false, output: error.message || 'Panel/capability links could not be verified.' }; }
}

/** Execute declared candidate behavior with host-owned comparison and fixture-only tool effects. */
export async function verifyCapabilityBehavior({ root, signal } = {}) {
  const deadline = AbortSignal.timeout(30000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const output = []; let count = 0;
  try {
    const capabilities = await loadCapabilities({ root });
    for (const capability of capabilities) for (const check of capability.acceptance) {
      if (combined.aborted) throw new Error('Capability behavior checks stopped or exceeded their time limit.');
      let cursor = 0;
      const fixtures = check.tools || [];
      const result = await executeCapability({ root, capability, arguments: check.arguments, signal: combined, now: () => new Date('2000-01-01T12:00:00.000Z').getTime(), runTool: async (name, args) => {
        const fixture = fixtures[cursor++];
        if (!fixture || fixture.name !== name || !equal(fixture.arguments, args)) throw new Error('The capability requested a host action outside its declared acceptance fixture.');
        return structuredClone(fixture.result);
      } });
      if (cursor !== fixtures.length) throw new Error(`Capability ${capability.id}: ${check.name} did not exercise all declared host calls.`);
      if (!equal(result.value, check.expected)) throw new Error(`Capability ${capability.id}: ${check.name} did not return its declared expected result.`);
      count += 1; output.push(`${capability.id}: ${check.name} passed with ${cursor} fixture host call(s).`);
    }
    return { passed: true, output: `${count} capability behavior check(s) passed. Host tools used fixtures only; no real workspace effects.\n${output.join('\n')}`.slice(0,16000) };
  } catch (error) {
    return { passed: false, output: `${output.join('\n')}\n${error.message || 'Capability behavior verification failed.'}`.slice(0,16000) };
  }
}
