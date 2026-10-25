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

Routine definitions, mutation receipts and run history live in the private productivity database. Back up the data folder before changing versions. They are excluded from source prompts and Git publication.
