# Task deadlines

Tasks can have a calendar day or a precise time. Say “Add a task to prepare the outline, due Friday” for a calendar deadline. Include the time and place when you want a precise deadline, such as “due Friday at 9 a.m. in Vancouver.” Companion uses its actual clock and named-zone resolver before saving a local time.

Open **Tasks → Edit** to choose **No deadline**, **Date** or **Date and time**. The editor shows the confirmed workspace timezone. A calendar date stays on that date; it is not converted to UTC midnight. A precise deadline retains one exact instant and displays its civil time and offset in the workspace zone. Changing other task fields preserves an untouched deadline, including its milliseconds.

If clocks repeat a local time, choose the intended offset explicitly. A skipped local time needs another choice; it does not silently roll forward. Existing precise deadlines keep their matching occurrence when reopened. An exact instant requested in another zone can display a different local clock time in the workspace zone.

The **All / Today / Overdue / Upcoming / No deadline** filter works alongside task search, projects, sorting and progressive display. Matching counts cover the full saved task list. Today includes that whole calendar day, including precise times already passed today. Overdue includes open tasks whose calendar day is earlier or whose exact time has passed. Upcoming means a later calendar day. Invalid retained values are shown as unavailable rather than classified as having no deadline. The server supplies the zone, clock, civil fields and complete deadline metadata; browser timezone data does not choose another saved instant. Relative views refresh while Tasks is visible.

## Clock and zone rules

The workspace uses the server's named IANA zone. An open editor captures and displays its zone; a late response cannot change another editor's selection. If the clock context or resolution cannot be confirmed, the app keeps the draft for review instead of inventing a time.

This release was verified with Node 24.19.0, ICU 78.3 and timezone data 2026b. Keep the Node runtime current as jurisdictions change their rules. In 2026, B.C. adopted year-round UTC−7, so Vancouver and Los Angeles cannot be treated as interchangeable winter zones. The [Province of B.C.'s guidance](https://www2.gov.bc.ca/gov/content/governments/celebrating-british-columbia/daylight-saving-time) documents that change. The app uses runtime zone data rather than a hardcoded provincial rule.

## AI and API fields

`create_task` and `update_task` accept:

- `dueDate`: a real `YYYY-MM-DD` calendar date.
- `dueAt`: a precise ISO timestamp with seconds, up to three fractional digits and `Z` or a numeric offset.

There can be one nonempty deadline. A nonempty value wins when the opposite field is empty/null; two nonempty values are rejected. Supplying only empty/null deadline values clears both. Omitting both preserves the saved deadline. Normalization is idempotent, so a returned calendar/exact record can be written without losing its deadline merely because the other field is null. Impossible dates and timezone-free exact timestamps are rejected atomically.

`get_time` defaults to the actual current clock and includes `localDate` and `localTime`. Its `resolve` action takes `localDateTime` and an explicit `timezone`, returning `unique`, `ambiguous` or `nonexistent` with verified exact candidates. A model must ask for the occurrence when needed; it cannot silently pick one.

`list_tasks` and `summarize_tasks` accept `deadline`, `timezone` and `asOf`. Keep the returned clock, zone and revision when following relative-filter pages. Continuations of Today/Overdue/Upcoming require explicit `asOf` and `timezone`. The older `dueBefore` filter remains timed-only; it excludes calendar and invalid/conflicting retained deadlines. Its bound also has millisecond precision.

Authenticated UI reads use GET `deadline-context`, `deadline-resolve` and `task-deadlines`. The first supplies the workspace clock/zone. Resolution accepts exactly one local datetime or qualified instant. The full task deadline view binds the workspace revision and includes at most 2,000 metadata records in a 1 MiB response, without task titles or bodies. These reads do not call a model or change tasks.

## Recovery and existing data

A saved task change retains its original task and applied revision atomically in the private database. An exact retry returns that original outcome after later changes or restart; it does not borrow today's deadline. Older receipts without the original task report `originalTaskUnavailable`. Large tool receipts explicitly omit long details while preserving the original deadline metadata.

Confirming an uncertain save uses its exact operation ID and editor identity. Newer drafts remain available. If a later deadline differs from the recovered save, choose whether to keep the current deadline or replace it before another save. A new desired change uses a new operation ID.

Existing task records are not rewritten merely by reading or upgrading. A legacy UTC timestamp remains its original instant, even when an older client may originally have intended a calendar date. Use Edit to make that intention explicit. Older Companion versions cannot display the new calendar field correctly; retain a private backup before changing versions. The existing two-column operation receipt table stays compatible with the previous writer. New exact task mutation snapshots use a separate table with a 32 MiB aggregate admission limit and no automatic pruning.

Deadlines organize saved tasks. Notifications, recurring reminders and broader calendar integrations remain separate work.
