const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const validNumber = number => Number.isSafeInteger(number) && number >= 1 && number <= 2;
const validSummary = value => !!value && validNumber(value.number) && ['failed', 'passed'].includes(value.status) && typeof value.verification?.passed === 'boolean' && (value.status === 'passed') === value.verification.passed && Array.isArray(value.verification.failedChecks) && (value.status !== 'passed' || value.verification.failedChecks.length === 0);

/** Read-only candidate evidence. Rendering never starts a request. */
export function createBuildAttemptsUI({ api }) {
  if (typeof api !== 'function') throw new TypeError('An attempt report API is required.');
  const reports = new Map(), errors = new Map(), pending = new Map(), expanded = new Set();
  let active = null, closed = false;
  const keyOf = (id, number) => id + ':' + number;
  function node(doc, tag, className, text) { const result = doc.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = String(text); return result; }
  function button(doc, text, callback) { const result = node(doc, 'button', 'quiet-button', text); result.type = 'button'; result.addEventListener('click', callback); return result; }
  function visible(root, buildId) { return !closed && active?.root === root && active.job.id === buildId; }
  function details(doc, className, key, title, root, buildId, onOpen) {
    const result = node(doc, 'details', className); result.open = expanded.has(key); let wasOpen = result.open;
    result.append(node(doc, 'summary', '', title));
    result.addEventListener('toggle', () => {
      if (!visible(root, buildId) || result.open === wasOpen) return;
      wasOpen = result.open; if (result.open) expanded.add(key); else expanded.delete(key);
      if (result.open) onOpen?.();
    });
    return result;
  }
  function fullReport(value, id, number) {
    if (!value || value.buildId !== id || value.number !== number || !['failed', 'passed'].includes(value.status) || !Array.isArray(value.files) || value.files.length > 24 || typeof value.verification?.passed !== 'boolean' || (value.status === 'passed') !== value.verification.passed || !Array.isArray(value.verification.checks)) throw new Error('The attempt report could not be matched to this build.');
    return clone(value);
  }
  async function load(id, number) {
    if (closed || !UUID.test(id) || !validNumber(number)) return;
    const key = keyOf(id, number); if (pending.has(key) || reports.has(key)) return;
    const controller = new AbortController(); pending.set(key, controller); errors.delete(key); paint();
    try {
      const result = await api('features/' + encodeURIComponent(id) + '/attempts/' + number, { signal: controller.signal }, 20000);
      if (closed) return;
      reports.set(key, fullReport(result, id, number)); while(reports.size>12){const oldest=reports.keys().next().value;reports.delete(oldest);} errors.delete(key);
    } catch (error) { if (!closed) errors.set(key, error.message || 'The retained attempt report could not be read.'); }
    finally { pending.delete(key); if (!closed && active?.job.id === id) paint(); }
  }
  function paintReport(doc, section, report, root, buildId) {
    if (report.summary) section.append(node(doc, 'p', 'attempt-summary', report.summary));
    section.append(node(doc, 'p', 'attempt-report-note', 'Retained candidate evidence. Review and activation use the current candidate above.'));
    if (report.files.length) {
      section.append(node(doc, 'h4', '', 'Changes in this attempt'));
      for (const file of report.files) {
        const fileKey = keyOf(buildId, report.number) + ':file:' + file.path;
        const changed = details(doc, 'change-file attempt-file', fileKey, String(file.path || 'Changed file') + ' · +' + (file.added || 0) + ' −' + (file.removed || 0), root, buildId);
        changed.append(node(doc, 'pre', 'file-diff', typeof file.diff === 'string' ? file.diff : JSON.stringify(file.diff, null, 2))); section.append(changed);
      }
    }
    if (report.verification.checks.length) {
      section.append(node(doc, 'h4', '', 'Checks in this attempt'));
      for (const check of report.verification.checks) { const row = node(doc, 'div', 'verification-check' + (check.passed ? '' : ' failed')); row.append(node(doc, 'strong', '', (check.passed ? '✓ ' : '× ') + check.name)); if (check.output) row.append(node(doc, 'pre', '', check.output)); section.append(row); }
    }
  }
  function paint() {
    if (!active || closed) return;
    const { root, job, doc } = active; root.replaceChildren();
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    if (!attempts.length) { root.hidden = true; return; }
    root.hidden = false; root.append(node(doc, 'h3', 'checks-heading', 'Attempt history'));
    if (attempts.length > 2 || attempts.some(value => !validSummary(value)) || new Set(attempts.map(value => value.number)).size !== attempts.length) { root.append(node(doc, 'p', 'inline-error', 'The retained attempt history could not be read. Refresh this build.')); return; }
    for (const attempt of [...attempts].sort((a, b) => a.number - b.number)) {
      const key = keyOf(job.id, attempt.number), section = details(doc, 'build-attempt', key, 'Attempt ' + attempt.number + ' · ' + (attempt.status === 'passed' ? 'Checks passed' : 'Checks failed'), root, job.id, () => { if (!reports.has(key) && !pending.has(key) && !errors.has(key)) void load(job.id, attempt.number); });
      section.setAttribute('data-build-id', job.id); section.setAttribute('data-attempt-number', String(attempt.number));
      const body = node(doc, 'div', 'build-attempt-body'), report = reports.get(key);
      if (attempt.verification.failedChecks.length) { body.append(node(doc, 'p', 'attempt-failures', 'Failed checks: ' + attempt.verification.failedChecks.join('; '))); }
      else body.append(node(doc, 'p', 'attempt-report-note', attempt.verification.passed ? 'All ' + (attempt.verification.totalChecks || 0) + ' recorded checks passed.' : 'This attempt did not pass verification.'));
      if (report) paintReport(doc, body, report, root, job.id);
      else if (pending.has(key)) { const loading = node(doc, 'p', 'attempt-report-note', 'Loading retained changes and check output…'); loading.setAttribute('role', 'status'); body.append(loading); }
      else if (errors.has(key)) { body.append(node(doc, 'p', 'inline-error', errors.get(key)), button(doc, 'Retry loading attempt ' + attempt.number, () => { void load(job.id, attempt.number); })); }
      else body.append(button(doc, 'Load attempt ' + attempt.number + ' report', () => { void load(job.id, attempt.number); }));
      section.append(body); root.append(section);
    }
  }
  function render(container, job) {
    if (closed || !container) return;
    active?.root.remove();
    const doc = container.ownerDocument || globalThis.document, root = node(doc, 'section', 'build-attempt-history');
    if (!job || !UUID.test(job.id)) { active = null; return; }
    active = { container, root, doc, job: clone({ id: job.id, attempts: job.attempts }) }; container.append(root); paint();
  }
  function close() { if (closed) return; closed = true; for (const controller of pending.values()) controller.abort(); pending.clear(); active?.root.remove(); active = null; reports.clear(); errors.clear(); expanded.clear(); }
  return { render, close };
}
