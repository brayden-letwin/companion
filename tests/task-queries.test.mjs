import test from 'node:test';
import assert from 'node:assert/strict';
import { listTasks, readTask, summarizeTasks } from '../server/task-queries.mjs';

const at = Date.UTC(2026, 9, 24, 12), iso = time => new Date(time).toISOString();
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const task = (index, extra = {}) => ({ id: id(index), title: 'Task ' + String(index).padStart(4, '0'), details: 'Details ' + index, status: 'todo', priority: 'normal', project: '', dueAt: null, createdAt: iso(at + index), updatedAt: iso(at + index), ...extra });
const state = tasks => ({ revision: 17, tasks });
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('all 2000 tasks can be read in stable oldest-insertion pages without omissions or duplicated IDs', () => {
  const source = state(Array.from({ length: 2000 }, (_, index) => task(index))), before = structuredClone(source), found = [];
  let offset = 0;
  for (;;) {
    const page = listTasks(source, { offset, expectedRevision: 17 });
    assert.equal(page.total, 2000); assert.equal(page.revision, 17); assert.equal(page.offset, offset); assert.equal(page.returned, page.tasks.length); assert.ok(page.returned <= 100); assert.ok(bytes(page) <= 48 * 1024);
    found.push(...page.tasks.map(item => item.id));
    if (!page.hasMore) { assert.equal(page.nextOffset, null); break; }
    assert.equal(page.nextOffset, offset + page.returned); assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.deepEqual(found, source.tasks.map(item => item.id)); assert.equal(new Set(found).size, 2000); assert.deepEqual(source, before);
  assert.equal(listTasks(source, { offset: 2000 }).returned, 0);
});

test('byte-bound list pages reduce the actual page count while preserving metadata and explicit detail previews', () => {
  const source = state(Array.from({ length: 200 }, (_, index) => task(index, { title: '"\\\ud800'.repeat(100), details: '\ud800'.repeat(12000), project: 'Project' }))), ids = [];
  let offset = 0, sawReduced = false;
  for (;;) {
    const page = listTasks(source, { offset, limit: 100, expectedRevision: 17 });
    assert.ok(bytes(page) <= 48 * 1024); assert.ok(page.returned > 0); sawReduced ||= page.returned < 100 && page.hasMore;
    for (const item of page.tasks) { assert.equal(item.title, source.tasks[0].title); assert.equal(item.project, 'Project'); assert.equal(item.details.length, 400); assert.equal(item.detailsLength, 12000); assert.equal(item.detailsTruncated, true); assert.equal(item.createdAt, source.tasks[Number(item.id.slice(-12))].createdAt); }
    ids.push(...page.tasks.map(item => item.id)); if (!page.hasMore) break; offset = page.nextOffset;
  }
  assert.equal(sawReduced, true); assert.deepEqual(ids, source.tasks.map(item => item.id));
});

test('detail previews and full detail pages retain whole Unicode and reconstruct every code unit', () => {
  const details = 'A'.repeat(399) + '😀' + '数"\\\n'.repeat(2000) + 'FINAL criterion 😀'; assert.ok(details.length <= 12000);
  const source = state([task(1, { details })]), preview = listTasks(source).tasks[0];
  assert.equal(preview.details, 'A'.repeat(399)); assert.equal(preview.detailsLength, details.length); assert.equal(preview.detailsTruncated, true);
  let offset = 0, recovered = '';
  for (;;) {
    const page = readTask(source, { taskId: id(1), offset, limit: 400, expectedRevision: 17 });
    assert.equal(page.offset, offset); assert.equal(page.detailsLength, details.length); assert.ok(page.task.details.length <= 400); assert.ok(bytes(page) <= 48 * 1024); recovered += page.task.details;
    if (!page.hasMore) { assert.equal(page.nextOffset, null); break; }
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(recovered, details);
  assert.throws(() => readTask(source, { taskId: id(1), offset: 400 }), { code: 'invalid_task_offset' });
  assert.throws(() => readTask(state([task(1, { details: '😀' })]), { taskId: id(1), limit: 1 }), { code: 'invalid_tool' });
  assert.equal(readTask(source, { taskId: id(1), offset: details.length }).task.details, '');
});

test('readTask reconstructs maximum-length heavily escaped details within its real JSON byte limit', () => {
  const details = '\ud800'.repeat(12000), source = state([task(1, { details, title: '\ud800'.repeat(300), project: '\ud800'.repeat(100) })]);
  let offset = 0, recovered = '';
  for (;;) { const page = readTask(source, { taskId: id(1), offset, expectedRevision: 17 }); assert.ok(bytes(page) <= 48 * 1024); recovered += page.task.details; if (!page.hasMore) break; offset = page.nextOffset; }
  assert.equal(recovered, details);
});

test('summary counts the entire filtered set and preserves empty versus literal and prototype-like project names', () => {
  const source = state([
    task(1, { project: '', priority: 'high', dueAt: iso(at - 1) }), task(2, { project: 'Unassigned', dueAt: iso(at) }),
    task(3, { project: '__proto__', status: 'done', priority: 'high', dueAt: iso(at - 1) }), task(4, { project: 'constructor', priority: 'high', dueAt: iso(at + 1) }),
    task(5, { project: 'toString', dueAt: iso(at - 1000) }), task(6, { project: 'Research' }), task(7, { project: 'research', status: 'done' }),
    task(8, { project: null }), task(9, { project: ' \t ' }),
  ]);
  const result = summarizeTasks(source, {}, at);
  assert.deepEqual({ total: result.totalTasks, open: result.openTasks, done: result.completedTasks, high: result.highPriorityOpenTasks, overdue: result.overdueOpenTasks }, { total: 9, open: 7, done: 2, high: 2, overdue: 2 });
  assert.equal(result.projectCount, 7); assert.equal(result.projects.find(item => item.project === '').totalTasks, 3); assert.equal(result.projects.find(item => item.project === 'Unassigned').totalTasks, 1);
  assert.equal(result.projects.find(item => item.project === '__proto__').completedTasks, 1); assert.equal(result.projects.find(item => item.project === 'constructor').highPriorityOpenTasks, 1);
  const names = result.projects.map(item => item.project); assert.equal(names[0], ''); assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, 'en') || (left < right ? -1 : left > right ? 1 : 0)));
});

test('2000 projects page with global totals, bounded bytes and stable complete project coverage', () => {
  const source = state(Array.from({ length: 2000 }, (_, index) => task(index, { project: String(index).padStart(4, '0') + '\ud800'.repeat(96), priority: index % 2 ? 'normal' : 'high', dueAt: index % 3 ? null : iso(at - 1) })));
  let offset = 0; const names = []; let pages = 0;
  for (;;) {
    const page = summarizeTasks(source, { offset, expectedRevision: 17 }, at); pages++;
    assert.equal(page.totalTasks, 2000); assert.equal(page.openTasks, 2000); assert.equal(page.highPriorityOpenTasks, 1000); assert.equal(page.overdueOpenTasks, 667); assert.equal(page.projectCount, 2000); assert.ok(page.returned > 0); assert.ok(page.returned <= 100); assert.ok(bytes(page) <= 48 * 1024);
    names.push(...page.projects.map(item => item.project)); if (!page.hasMore) break; offset = page.nextOffset;
  }
  assert.ok(pages > 20); assert.equal(new Set(names).size, 2000); assert.deepEqual(names, source.tasks.map(item => item.project));
});

test('status, priority, exact case-insensitive project, assignment and explicit due filters agree across pages and summaries', () => {
  const source = state(Array.from({ length: 350 }, (_, index) => task(index, { status: index % 4 === 0 ? 'done' : 'todo', priority: index % 3 === 0 ? 'high' : 'normal', project: index % 5 === 0 ? '' : index % 2 ? 'Research' : 'research', dueAt: index % 7 === 0 ? null : iso(at + (index % 2 ? -1 : 1)) })));
  for (const filter of [{ status: 'todo' }, { status: 'done' }, { priority: 'high', status: 'todo', dueBefore: iso(at) }, { project: 'RESEARCH' }, { unassigned: true }, { unassigned: false }, { dueBefore: '2026-10-24T14:00:00+02:00' }]) {
    const expected = source.tasks.filter(item => (!filter.status || item.status === filter.status) && (!filter.priority || item.priority === filter.priority) && (filter.project === undefined || item.project.toLowerCase() === filter.project.toLowerCase()) && (filter.unassigned === undefined || (!item.project) === filter.unassigned) && (!filter.dueBefore || item.dueAt !== null && Date.parse(item.dueAt) < Date.parse(filter.dueBefore)));
    let offset = 0; const ids = [];
    for (;;) { const page = listTasks(source, { ...filter, offset, limit: 11, expectedRevision: 17 }); assert.equal(page.total, expected.length); ids.push(...page.tasks.map(item => item.id)); if (!page.hasMore) break; offset = page.nextOffset; }
    assert.deepEqual(ids, expected.map(item => item.id)); const summary = summarizeTasks(source, { ...filter, expectedRevision: 17 }, at); assert.equal(summary.totalTasks, expected.length); assert.equal(summary.openTasks, expected.filter(item => item.status === 'todo').length); assert.equal(summary.completedTasks, expected.filter(item => item.status === 'done').length);
  }
});

test('overdue and dueBefore are strictly earlier, with explicit instants and no inferred local date', () => {
  const source = state([task(1, { dueAt: iso(at - 1) }), task(2, { dueAt: iso(at) }), task(3, { dueAt: iso(at + 1) }), task(4, { dueAt: null }), task(5, { dueAt: iso(at - 1), status: 'done' })]);
  const summary = summarizeTasks(source, {}, at); assert.equal(summary.asOf, iso(at)); assert.equal(summary.overdueOpenTasks, 1); assert.deepEqual(listTasks(source, { dueBefore: iso(at) }).tasks.map(item => item.id), [id(1), id(5)]); assert.equal(summarizeTasks(source, { status: 'done', dueBefore: iso(at) }, at).overdueOpenTasks, 0);
});

test('pinned pages reject changed revisions for list, details and project summaries without mutation', () => {
  const source = state(Array.from({ length: 125 }, (_, index) => task(index))), first = listTasks(source, { limit: 12 });
  const changed = { ...source, revision: 18, tasks: [task(999), ...source.tasks] }, before = structuredClone(changed);
  for (const query of [() => listTasks(changed, { offset: first.nextOffset, expectedRevision: first.revision }), () => readTask(changed, { taskId: id(1), expectedRevision: first.revision }), () => summarizeTasks(changed, { offset: 1, expectedRevision: first.revision }, at)]) assert.throws(query, error => error.code === 'revision_conflict' && error.statusCode === 409 && error.revision === 18);
  assert.deepEqual(changed, before);
});

test('invalid fields, filter combinations, dates, page bounds and detail offsets fail explicitly', () => {
  const source = state([task(1, { details: 'abc😀end' })]);
  for (const args of [{ project: '', unassigned: true }, { project: 'Research', unassigned: false }, { project: ' ' }, { unassigned: 1 }, { status: 'all' }, { priority: 'HIGH' }, { offset: -1 }, { offset: 2001 }, { limit: 0 }, { limit: 101 }, { expectedRevision: 0.5 }, { extra: true }]) for (const query of [listTasks, summarizeTasks]) assert.throws(() => query(source, args, at), { code: 'invalid_tool' });
  for (const dueBefore of ['tomorrow', '2026-10-24', '2026-10-24T12:00:00', '2026-02-30T12:00:00Z', '2026-13-01T12:00:00Z', '2026-10-24T24:00:00Z', '2026-10-24T12:00:00+25:00', '2026-10-24T12:00:00.0001Z', '2026-10-24T12:00:00.999999999Z', 'x'.repeat(41)]) for (const query of [listTasks, summarizeTasks]) assert.throws(() => query(source, { dueBefore }, at), { code: 'invalid_tool' });
  assert.throws(() => listTasks(source, { offset: 2 }), { code: 'invalid_task_offset' }); assert.throws(() => summarizeTasks(source, { offset: 2 }, at), { code: 'invalid_task_offset' }); assert.throws(() => readTask(source, { taskId: id(1), offset: 4 }), { code: 'invalid_task_offset' }); assert.throws(() => readTask(source, { taskId: id(1), offset: 100 }), { code: 'invalid_task_offset' });
  assert.throws(() => readTask(source, { taskId: id(2) }), { code: 'not_found', statusCode: 404 }); assert.throws(() => readTask(source, { taskId: '../private' }), { code: 'invalid_tool' }); assert.throws(() => readTask(source, { taskId: id(1), limit: 4001 }), { code: 'invalid_tool' });
});

test('empty snapshots have explicit terminal pages and zero aggregates', () => {
  const empty = state([]), list = listTasks(empty), summary = summarizeTasks(empty, {}, at);
  assert.equal(list.total, 0); assert.equal(list.returned, 0); assert.equal(list.hasMore, false); assert.equal(list.nextOffset, null);
  assert.equal(summary.totalTasks, 0); assert.equal(summary.projectCount, 0); assert.equal(summary.returned, 0); assert.equal(summary.hasMore, false); assert.equal(summary.nextOffset, null);
});

test('calendar-aware filters use the captured named-zone day and distinguish open overdue, future days and invalid retained values', () => {
  const clock=Date.parse('2026-10-25T06:30:00Z'),context={timezone:'America/Vancouver',asOf:iso(clock)},source=state([
    task(1,{dueDate:'2026-10-24'}),task(2,{dueDate:'2026-10-23'}),task(3,{dueDate:'2026-10-25'}),
    task(4,{dueAt:'2026-10-25T06:00:00.000Z'}),task(5,{dueAt:'2026-10-25T06:45:00.000Z'}),task(6,{dueAt:'2026-10-25T08:00:00.000Z'}),
    task(7,{dueDate:'2026-10-24',status:'done'}),task(8,{dueDate:'2026-10-23',status:'done'}),task(9),task(10,{dueAt:'an old invalid value'}),task(11,{dueDate:'2026-10-24',dueAt:iso(clock)})
  ]),before=structuredClone(source),ids=deadline=>listTasks(source,{...context,deadline},clock).tasks.map(item=>item.id);
  assert.deepEqual(ids('today'),[1,4,5,7].map(id));assert.deepEqual(ids('overdue'),[2,4].map(id));assert.deepEqual(ids('upcoming'),[3,6].map(id));assert.deepEqual(ids('none'),[id(9)]);
  const summary=summarizeTasks(source,context,clock);assert.equal(summary.today,'2026-10-24');assert.equal(summary.timezone,'America/Vancouver');assert.equal(summary.asOf,iso(clock));
  assert.equal(summary.overdueOpenTasks,2);assert.equal(summary.todayOpenTasks,3);assert.equal(summary.upcomingOpenTasks,2);assert.equal(summary.noDeadlineOpenTasks,1);
  assert.equal(summary.projects[0].todayOpenTasks,3);assert.deepEqual(source,before);
  assert.deepEqual(listTasks(source,{...context,dueBefore:iso(clock)}).tasks.map(item=>item.id),[id(4)]);
  assert.equal(listTasks(source,{...context,timezone:'UTC',deadline:'today'}).tasks.some(item=>item.id===id(1)),false);
});

test('relative continuation pages require their original asOf and stay stable after midnight while all mode remains backward compatible', () => {
  const clock=Date.parse('2026-10-25T06:59:59Z'),source=state(Array.from({length:9},(_,index)=>task(index,{dueDate:'2026-10-24',project:'P'+index}))),first=listTasks(source,{deadline:'today',timezone:'America/Vancouver',limit:2},clock),later=clock+120000;
  assert.equal(first.today,'2026-10-24');assert.equal(first.total,9);
  for(const query of [listTasks,summarizeTasks]){
    assert.throws(()=>query(source,{deadline:'today',timezone:first.timezone,offset:2},later),{code:'deadline_context_required'});
    assert.throws(()=>query(source,{deadline:'today',asOf:first.asOf,offset:2},later),{code:'deadline_context_required'});
  }
  const next=listTasks(source,{deadline:'today',timezone:first.timezone,asOf:first.asOf,offset:first.nextOffset,limit:2,expectedRevision:first.revision},later);
  assert.equal(next.total,9);assert.equal(next.today,first.today);assert.equal(next.asOf,first.asOf);assert.deepEqual(next.tasks.map(item=>item.id),[id(2),id(3)]);
  const summary=summarizeTasks(source,{deadline:'today',timezone:first.timezone,asOf:first.asOf,offset:2},later);assert.equal(summary.totalTasks,9);assert.equal(summary.todayOpenTasks,9);
  assert.equal(listTasks(source,{deadline:'today',timezone:first.timezone},later).total,0);assert.equal(listTasks(source,{offset:2},later).returned,7);
});

test('deadline query context errors are explicit and never rewrite retained deadlines', () => {
  const source=state([task(1,{dueAt:'2026-10-25T01:30:00'})]),before=structuredClone(source);
  for(const query of [listTasks,summarizeTasks]){
    assert.throws(()=>query(source,{timezone:'Imaginary/Zone'},at),{code:'invalid_timezone'});
    assert.throws(()=>query(source,{asOf:'2026-10-25T01:30:00'},at),{code:'invalid_deadline_context'});
    assert.throws(()=>query(source,{deadline:'later'},at),{code:'invalid_deadline_filter'});
    assert.equal(query===listTasks?query(source,{deadline:'none'},at).total:query(source,{deadline:'none'},at).totalTasks,0);
  }
  assert.equal(readTask(source,{taskId:id(1)}).task.dueAt,'2026-10-25T01:30:00');assert.deepEqual(source,before);
});

test('legacy dueBefore includes only valid exact deadlines without guessing malformed dates or conflicting saved fields',()=>{
  const source=state([task(1,{dueAt:'2026-10-25'}),task(2,{dueDate:'2026-10-25',dueAt:'2026-10-25T01:00:00Z'}),task(3,{dueAt:'2026-10-25T01:00:00'}),task(4,{dueDate:'2026-10-25'}),task(5,{dueAt:'2026-10-25T01:00:00Z'}),task(6,{dueAt:'2026-10-25T02:00:00+01:00',status:'done'})]),args={dueBefore:'2026-10-26T00:00:00Z',timezone:'Pacific/Kiritimati',asOf:'2026-10-25T00:00:00Z'},before=structuredClone(source);
  assert.deepEqual(listTasks(source,args).tasks.map(item=>item.id),[id(5),id(6)]);assert.equal(summarizeTasks(source,args).totalTasks,2);assert.deepEqual(source,before);
});
