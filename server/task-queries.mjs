const MAX_BYTES = 48 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (message, code = 'invalid_tool', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('Use supported task query fields.'); };
const integer = (value, minimum, maximum, label) => { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail(`Use ${label} between ${minimum} and ${maximum}.`); return value; };
const projectName = task => task.project == null || typeof task.project === 'string' && !task.project.trim() ? '' : task.project;
const high = (text, index) => { const code = text.charCodeAt(index); return code >= 0xd800 && code <= 0xdbff; };
const low = (text, index) => { const code = text.charCodeAt(index); return code >= 0xdc00 && code <= 0xdfff; };
function endBoundary(text, start, limit) {
  let end = Math.min(start + limit, text.length);
  if (end < text.length && high(text, end - 1) && low(text, end)) end -= 1;
  return end;
}
function snapshot(state, args) {
  if (!object(state) || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.tasks) || state.tasks.length > 2000 || state.tasks.some(task => !object(task))) throw fail('The saved task snapshot is invalid.', 'invalid_task_state', 500);
  if (args.expectedRevision !== undefined) {
    integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision');
    if (args.expectedRevision !== state.revision) throw Object.assign(fail('Tasks changed. Start again from the current revision before combining pages.', 'revision_conflict', 409), { revision: state.revision });
  }
  return state;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) throw fail('dueBefore needs a timezone-explicit ISO timestamp.');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[5] || 0) > 23 || Number(match[6] || 0) > 59) throw fail('dueBefore needs a valid timezone-explicit ISO timestamp.');
  const day = new Date(match[1] + 'T00:00:00.000Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) throw fail('dueBefore needs a valid calendar date.');
  return milliseconds;
}
function filters(args) {
  if (args.status !== undefined && !['todo', 'done'].includes(args.status)) throw fail('Choose todo or done, or omit status for all tasks.');
  if (args.priority !== undefined && !['normal', 'high'].includes(args.priority)) throw fail('Choose normal or high priority.');
  if (args.project !== undefined && (typeof args.project !== 'string' || !args.project.trim() || args.project.length > 100)) throw fail('Use a nonblank project name, or unassigned for tasks without a project.');
  if (args.unassigned !== undefined && typeof args.unassigned !== 'boolean') throw fail('unassigned must be true or false.');
  if (args.project !== undefined && args.unassigned !== undefined) throw fail('Use project or unassigned, not both.');
  const before = args.dueBefore === undefined ? null : timestamp(args.dueBefore);
  return task => (!args.status || task.status === args.status)
    && (!args.priority || task.priority === args.priority)
    && (args.project === undefined || typeof projectName(task) === 'string' && projectName(task).toLowerCase() === args.project.toLowerCase())
    && (args.unassigned === undefined || (projectName(task) === '') === args.unassigned)
    && (before === null || task.dueAt != null && task.dueAt !== '' && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) < before);
}
function metadata(task) {
  const project = projectName(task);
  if (!object(task) || typeof task.id !== 'string' || task.id.length > 80 || typeof task.title !== 'string' || task.title.length > 300 || typeof project !== 'string' || project.length > 100 || !['todo', 'done'].includes(task.status)
    || task.priority != null && (typeof task.priority !== 'string' || task.priority.length > 40)
    || [task.dueAt, task.createdAt, task.updatedAt].some(date => date != null && (typeof date !== 'string' || date.length > 100))) throw fail('A saved task has invalid metadata.', 'invalid_task_state', 500);
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, project, dueAt: task.dueAt, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
function details(task) {
  const value = task.details ?? '';
  if (typeof value !== 'string' || value.length > 12000) throw fail('A saved task has invalid details.', 'invalid_task_state', 500);
  return value;
}
function preview(task) {
  const text = details(task), end = endBoundary(text, 0, 400);
  return { ...metadata(task), details: text.slice(0, end), detailsLength: text.length, detailsTruncated: end < text.length };
}
function boundedPage(items, args, base, key, map = value => value) {
  const offset = integer(args.offset ?? 0, 0, 2000, 'offset'), limit = integer(args.limit ?? 100, 1, 100, 'limit');
  if (offset > items.length) throw fail('The task query offset is past the end of the matching results.', 'invalid_task_offset');
  const page = { ...base, [key]: [], offset, returned: 0, nextOffset: null, hasMore: false };
  const update = () => { page.returned = page[key].length; page.hasMore = offset + page.returned < items.length; page.nextOffset = page.hasMore ? offset + page.returned : null; };
  for (const item of items.slice(offset, offset + limit)) {
    page[key].push(map(item)); update();
    if (Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES) { page[key].pop(); update(); break; }
  }
  update();
  if (offset < items.length && !page.returned || Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES) throw fail('One task result exceeds its bounded response size.', 'task_result_limit', 500);
  return page;
}

/** The store appends tasks in creation order; page that stable insertion order without a newest-only slice. */
export function listTasks(state, args = {}) {
  fields(args, ['status', 'priority', 'project', 'unassigned', 'dueBefore', 'offset', 'limit', 'expectedRevision']); snapshot(state, args);
  const matching = state.tasks.filter(filters(args));
  return boundedPage(matching, args, { total: matching.length, revision: state.revision }, 'tasks', preview);
}

export function readTask(state, args = {}) {
  fields(args, ['taskId', 'offset', 'limit', 'expectedRevision']); snapshot(state, args);
  if (typeof args.taskId !== 'string' || !UUID.test(args.taskId)) throw fail('Choose an actual task UUID.');
  const task = state.tasks.find(item => item.id === args.taskId); if (!task) throw fail('That task was not found.', 'not_found', 404);
  const text = details(task), offset = integer(args.offset ?? 0, 0, 12000, 'offset'), limit = integer(args.limit ?? 4000, 1, 4000, 'limit');
  if (offset > text.length || offset > 0 && high(text, offset - 1) && low(text, offset)) throw fail('Use a returned task details offset within the text, without splitting a Unicode character.', 'invalid_task_offset');
  const end = endBoundary(text, offset, limit);
  if (end === offset && offset < text.length) throw fail('Increase the details limit to include the next whole Unicode character.');
  const result = { task: { ...metadata(task), details: text.slice(offset, end) }, offset, nextOffset: end < text.length ? end : null, hasMore: end < text.length, detailsLength: text.length, revision: state.revision };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw fail('The task detail exceeds its bounded response size.', 'task_result_limit', 500);
  return result;
}

const counts = () => ({ totalTasks: 0, openTasks: 0, completedTasks: 0, highPriorityOpenTasks: 0, overdueOpenTasks: 0 });
function count(result, task, now) {
  result.totalTasks += 1;
  if (task.status === 'done') result.completedTasks += 1;
  if (task.status === 'todo') {
    result.openTasks += 1;
    if (task.priority === 'high') result.highPriorityOpenTasks += 1;
    if (task.dueAt != null && task.dueAt !== '' && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) < now) result.overdueOpenTasks += 1;
  }
}
const compare = (left, right) => left.localeCompare(right, 'en') || (left < right ? -1 : left > right ? 1 : 0);

export function summarizeTasks(state, args = {}, now = Date.now()) {
  fields(args, ['status', 'priority', 'project', 'unassigned', 'dueBefore', 'offset', 'limit', 'expectedRevision']); snapshot(state, args);
  if (typeof now !== 'number' || !Number.isFinite(now)) throw fail('Use a finite timestamp for task summaries.');
  const matching = state.tasks.filter(filters(args)), totals = counts(), groups = new Map();
  for (const task of matching) {
    metadata(task); count(totals, task, now); const project = projectName(task);
    if (!groups.has(project)) groups.set(project, { project, ...counts() });
    count(groups.get(project), task, now);
  }
  const projects = [...groups.values()].sort((left, right) => compare(left.project, right.project));
  return boundedPage(projects, args, { ...totals, projectCount: projects.length, asOf: new Date(now).toISOString(), revision: state.revision }, 'projects');
}
