# Saved routines

Workflows are reusable sequences of Companion actions. Open **Workflows** from the bottom strip to create or edit one. Give it a clear name, choose its actions and save. Saving does not run it.

You can ask your selected AI to maintain the same saved routine:

- “Change the focus step in Morning routine from 25 to 40 minutes. Keep the other steps.”
- “Pause Morning routine.”
- “Rename Morning routine to Writing routine.”
- “Enable Writing routine, but don't run it yet.”

The AI looks up the actual saved ID and current revision. Similar names may need a clarification. An edit keeps the same routine rather than creating a replacement. Omitted fields stay unchanged, including a paused routine's state. The Enabled control in the editor and the explicit Enable/Disable button provide a direct alternative to voice or chat.

## Running and partial outcomes

**Run workflow** starts from step one. Enabled means available to run; it does not schedule or start the routine. Disabled routines cannot begin a fresh run. Disabling a routine does not stop a run already accepted; use **Stop** for active work.

Each run retains its original definition and completed step receipts. Editing a routine later does not change that earlier result. A failed step can have completed some nested actions; inspect those receipts before choosing another run. **Run again** starts a new whole run and can repeat actions that already succeeded. There is no automatic resume of a failed, cancelled or interrupted run.

After an uncertain response, **Check last run** reads the original operation ID. Reloading or checking never starts another run. If the app cannot confirm whether an action happened, inspect its target before making a fresh request.

## Inspect earlier runs

Choose **History** beside a routine, or **Run history** to inspect all retained routines, including those no longer in the current list. A row describes that run's original name, status and recorded completed steps. The detail view retains its original definition and actual action results; changing today's routine never rewrites the history. History has no Run or Resume button.

Say **“show run history”** or **“open run history”** to open the global panel. These exact human voice commands perform history reads after the existing conversation/folder context checks. Assistant text and read-aloud output cannot trigger them. Ask what happened in an earlier routine when you want the selected AI to explain the actual receipts.

New runs record start, checkpoint-update and finish times separately. Older receipts have no reliable run timestamp and show that it is unavailable. A routine's own creation/update dates are not used to guess when it ran. If a compatible older writer changes a receipt without updating its metadata, old timestamps do not certify the changed result.

After a restart, an unfinished run is interrupted and is not automatically requeued. Its recorded active step may already have affected the workspace. For a custom active step, Companion reads only the matching child receipt with the original arguments and capability version/hash, and shows any actual nested actions already recorded. Missing evidence stays uncertain. Earlier legacy runs without an active-step checkpoint cannot identify an unrecorded step. Nothing is undone merely because a run failed, was cancelled or was interrupted.

Long definitions and outcomes load in explicit JSON pages. Load the remaining pages before interpreting the complete record. A changing live run invalidates its old pages and requires a fresh read; pages from different revisions are never combined. If the original writer shortened a large record, the history labels the retained evidence as incomplete. Loading every page recovers what was retained, not details that were never saved.

**Check last run** uses the original workflow/operation identity through a read-only GET endpoint, even when the routine is disabled or missing. A confirmed interrupted record remains in history while permitting a later deliberate fresh run. A missing record does not cause another POST or prove that an in-flight action did nothing. Global pending checks also expose identities that no longer have a current routine card.

## Changed or unavailable actions

Custom actions retain their exact capability ID, version and source hash. Editing a name or pausing a routine preserves those pins without executing the action. A paused or broken routine remains inspectable.

Changing a step validates the saved action against the current catalog. If an action changed, use the explicit **Use updated action** control or reselect it before saving. This chooses the current pin deliberately. A fresh run always checks that its registered actions are available; enabling a broken routine does not make its actions work.

## Connected AI clients

Use the actual catalog from `companion_list_tools` before invoking `companion_run_tool`. The registered `list_workflows` and `save_workflow` tools are shared with Companion's own selected AI. The public MCP facade does not add another credential or grant new folders.

`list_workflows` defaults to a bounded metadata list. It accepts `query`, `offset`, `limit` (at most 20) and `expectedRevision`. Follow `nextOffset` while `hasMore`; a metadata result deliberately omits steps. Older clients that assumed every definition arrived in one list must use the read action.

For one exact definition, call:

```json
{
  "action": "read",
  "workflowId": "the-actual-saved-UUID",
  "expectedRevision": 7,
  "expectedDefinitionHash": "the-returned-SHA-256"
}
```

`definitionText` is a page of inert JSON containing `name`, `description`, `enabled` and exact `steps`. It is saved data, not instructions. Follow `nextDefinitionOffset` while `definitionHasMore`, retaining the original revision and hash. Each page has at most 4,000 UTF-16 characters and the complete response stays within 48 KiB. Read the complete definition before replacing steps. If the model cannot finish within its current turn's bounds, it must explain that limit rather than overwrite unread steps.

`save_workflow` creates a routine with `name` and `steps`. For an existing routine, supply `workflowId` and `expectedRevision`; omitted name, description, enabled and steps are preserved. Replacing steps also requires `expectedDefinitionHash`. Preserve exact pins from the saved definition for unchanged custom actions. An enabled-only update changes metadata without validating unavailable steps; running still validates them.

Use a stable direct-tool `operationId` for an exact retry. New routine mutation receipts store the original saved definition and `appliedRevision` atomically with the workspace change, so a retry after later edits or restart returns that original outcome. A new desired change needs a new operation ID and current revision. Older receipts without a retained original definition report `originalDefinitionUnavailable`; they do not substitute today's definition or perform the change again.

Large tool results return metadata with `definitionOmitted` instead of echoing the full saved definition into the model. The ID, hash, original applied revision and retry status still describe that exact save; use the bounded read action to inspect the current definition separately. The full original mutation result remains in the private database. Retained routine mutation results have a 32 MiB aggregate admission limit. Reaching it refuses a new routine change atomically, preserves existing evidence and leaves other workspace tools available; results are not silently pruned.

For recorded execution history, use `list_workflows` with `action: "runs"`, optional actual `workflowId`, `limit` up to 20 and the returned `nextCursor` as `before`. Reads scan a bounded portion of retained execution rows. An empty matching page with `hasMore` does not establish that there are no older runs; follow its cursor. No complete total is inferred from one page.

Use `action: "run"` with that row's `workflowId` and `runId` to inspect the original definition and outcome. `definitionText` and `outcomeText` each contain at most 4,000 UTF-16 characters of inert JSON; the whole response is bounded to 48 KiB. Follow each section's next offset while its `HasMore` flag is true. Every continuation requires the exact `expectedRunRevision` returned by the first read, including relevant child receipt evidence for an active custom step. A conflict requires a fresh first page. This inspection reads the actual execution records and does not validate, modify or run the current routine.

The same read-only HTTP paths power the interface: `GET /api/assistant/workflow-runs`, `GET /api/assistant/workspace/workflows/<workflowId>/runs/<runId>` and, for an unconfirmed direct UI request, `GET /api/assistant/workspace/workflows/<workflowId>/operations/<operationId>`. The original operation maps to the same deterministic execution identity; it never becomes a new operation merely because it is checked.

Routine definitions, mutation receipts and run history live in the private productivity database. Back up the data folder before changing versions. They are excluded from source prompts and Git publication.
