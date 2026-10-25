import { getRuntimeStatus as currentRuntimeStatus } from './runtime-control.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const controlFiles = new Set(['server/runtime-supervisor.mjs', 'server/runtime-host-entry.mjs']);

function publicRuntime(value) {
  if (!object(value)) return {};
  const result = {};
  for (const field of ['managed', 'restarting', 'hostRestartAvailable']) if (typeof value[field] === 'boolean') result[field] = value[field];
  for (const field of ['workerPid', 'hostPid', 'supervisorPid']) if (Number.isSafeInteger(value[field]) && value[field] > 0) result[field] = value[field];
  for (const field of ['workerInstanceId', 'hostInstanceId', 'supervisorInstanceId']) if (typeof value[field] === 'string' && UUID.test(value[field])) result[field] = value[field];
  return result;
}

function replaced(origin, runtime, component) {
  const pid = `${component}Pid`, instance = `${component}InstanceId`;
  return Number.isSafeInteger(origin[pid]) && origin[pid] > 0 && Number.isSafeInteger(runtime[pid]) && runtime[pid] > 0
    && typeof origin[instance] === 'string' && UUID.test(origin[instance]) && typeof runtime[instance] === 'string' && UUID.test(runtime[instance])
    && origin[pid] !== runtime[pid] && origin[instance] !== runtime[instance];
}

/** Read-only admission proof; it never activates source, restarts, or runs tools. */
export function createFeatureReadiness({ builder, root: _root, tools, getRuntimeStatus = currentRuntimeStatus, owner = 'local-workspace' } = {}) {
  if (typeof builder?.readinessEvidence !== 'function' || typeof tools?.catalog !== 'function' || typeof getRuntimeStatus !== 'function') throw new TypeError('Builder evidence, the loaded tool catalog and runtime status are required.');
  return async function proveReady(record) {
    if (!object(record) || typeof record.buildId !== 'string' || !UUID.test(record.buildId)) throw Object.assign(new Error('Use an actual linked feature build ID.'), { code: 'invalid_feature_link', statusCode: 400 });
    const runtime = publicRuntime(await getRuntimeStatus());
    const result = { ready: false, reason: 'build_unavailable', requiredCapabilities: [], runtime, sourceRevision: null };
    let evidence;
    try { evidence = await builder.readinessEvidence(record.buildId, owner); }
    catch (error) { return { ...result, reason: ['feature_evidence_changed', 'feature_evidence_limit', 'feature_evidence_unavailable', 'unsafe_source_path'].includes(error.code) ? error.code : 'build_evidence_unavailable' }; }
    if (!object(evidence) || evidence.job?.id !== record.buildId || !Array.isArray(evidence.job.files) || evidence.job.files.length > 24) return { ...result, reason: 'build_evidence_unavailable' };
    result.sourceRevision = typeof evidence.sourceRevision === 'string' && HASH.test(evidence.sourceRevision) ? evidence.sourceRevision : null;
    if (evidence.job.status !== 'applied') return { ...result, reason: 'build_not_applied' };
    if (evidence.job.verificationPassed !== true || !evidence.job.files.length || !Array.isArray(evidence.files) || evidence.files.length !== evidence.job.files.length) return { ...result, reason: 'build_evidence_unavailable' };
    if (evidence.files.some(file => !object(file) || typeof file.path !== 'string' || !evidence.job.files.some(expected => expected.path === file.path && expected.afterHash === file.afterHash)
      || file.afterHash !== null && (typeof file.afterHash !== 'string' || !HASH.test(file.afterHash)) || file.currentHash !== file.afterHash)) return { ...result, reason: 'source_changed' };
    if (evidence.sourceStable === false) return { ...result, reason: 'source_changed' };
    if (!Array.isArray(evidence.requiredCapabilities) || evidence.requiredCapabilities.length > 40) return { ...result, reason: 'build_evidence_unavailable' };
    const pins = [];
    for (const capability of evidence.requiredCapabilities) {
      if (!object(capability) || typeof capability.name !== 'string' || !/^cap_[a-z][a-z0-9_]{0,39}$/.test(capability.name)
        || typeof capability.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(capability.id) || !Number.isSafeInteger(capability.version) || capability.version < 1
        || typeof capability.hash !== 'string' || !HASH.test(capability.hash) || pins.some(pin => pin.name === capability.name || pin.id === capability.id)) return { ...result, reason: 'build_evidence_unavailable' };
      pins.push({ name: capability.name, id: capability.id, version: capability.version, hash: capability.hash });
    }
    result.requiredCapabilities = pins;
    if (evidence.requiredCapabilities.some(capability => capability.current !== true)) return { ...result, reason: 'capability_source_changed' };
    if (!pins.length) return { ...result, reason: 'no_callable_result' };
    let catalog;
    try { catalog = await tools.catalog(); } catch { return { ...result, reason: 'capability_unavailable' }; }
    if (!Array.isArray(catalog) || pins.some(pin => !catalog.some(item => item.kind === 'capability' && item.name === pin.name && item.capabilityId === pin.id && item.version === pin.version && item.hash === pin.hash))) return { ...result, reason: 'capability_unavailable' };
    if (runtime.restarting) return { ...result, reason: 'runtime_restarting' };
    const paths = evidence.job.files.map(file => file.path);
    const restartScope = paths.some(file => controlFiles.has(file)) ? 'launcher' : paths.some(file => file.startsWith('server/')) ? 'host' : 'none';
    const origin = publicRuntime(record.origin?.runtime);
    if (restartScope !== 'none' && (!runtime.managed || !replaced(origin, runtime, 'host') || !replaced(origin, runtime, 'worker')
      || restartScope === 'launcher' && !replaced(origin, runtime, 'supervisor'))) return { ...result, reason: 'runtime_restart_required' };
    return { ...result, ready: true, reason: 'ready' };
  };
}
