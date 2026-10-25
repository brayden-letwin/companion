# Real source features

The feature builder edits JavaScript, HTML and CSS in an isolated copy of the source tree. It uses the selected model through `complete({providerId,messages,system,schema,signal,onEvent})`. The response is JSON containing a short `summary`, `files: [{path,content}]` with complete file contents, and a `tests` array of short descriptions (`[]` when none). All three fields are required by the strict model schema. Test descriptions are informational and never become commands. New tests can be supplied as actual source files.

## Runtime panel contract

The frontend host loads `src/features/manifest.json`:

```json
{
  "version": 1,
  "features": [
    {
      "id": "focus-timer",
      "title": "Focus timer",
      "description": "A small timer for a focused work session.",
      "module": "./features/focus-timer.mjs"
    }
  ]
}
```

IDs start with a lowercase letter and contain at most 60 lowercase letters, digits or hyphens. Module paths have exactly the form `./features/<id>.mjs`, relative to the host in `src/`. Keep prior entries when adding a feature.

A module exports a named `mount` function. Create DOM state within mount rather than during import, and return cleanup for timers, listeners, observers and other resources:

```js
export function mount({ container, api }) {
  const button = document.createElement('button');
  button.textContent = 'Start a focus session';
  const start = () => { button.textContent = 'Focus session started'; };
  button.addEventListener('click', start);
  container.append(button);
  return () => {
    button.removeEventListener('click', start);
    container.replaceChildren();
  };
}
```

`container` belongs to that feature. The host supplies `api.getWorkspace()` (a detached snapshot), `api.workspaceOperation(type, fields)`, `api.runTool(name, arguments)` and `api.notify(message)`. Operations and tools still pass through the server's validation and action rules. Do not assume Node, unrestricted computer control, credentials, filesystem access or a model connection. Do not issue hidden sends or claim to have performed an action that failed. Features share the app's browser origin and are application code, not independent security sandboxes.

The builder validates registrations and imports the modules to check their named export. Feature modules should therefore remain importable without a browser DOM. Put browser setup inside `mount`. Feature-specific Node tests may live at `src/features/<id>.test.mjs`; these supplement the original regression baseline.

## Build, preview, activate, undo

1. Snapshot only recognized UTF-8 application source. Environment files, private data, logs, Git, dependencies and generated binaries are excluded. For larger repositories the model first selects relevant paths from a source inventory. It then receives complete selected files in lossless ordered line chunks, plus required extension/agent/manifest context. Messages stay under 90 KB each and the source context stays under 420 KB; omitted files remain listed. Replacing an existing file the model was not supplied is rejected. The full snapshot remains available for regression checks and source revision comparison.
2. Generate complete source files into a private candidate. The live app is unchanged. Store file hashes and a full replacement unified diff.
3. Check changed JavaScript syntax. Run the existing selected pure regression tests from original trusted copies; a patch cannot replace them with easier tests. Check feature registrations and any new feature tests. Checks use a fixed Node executable/arguments, restricted read/write directories, no child/worker/addon permissions, a whitelisted environment, a time limit and bounded output. A trusted preload outside the candidate initializes inherited stdio and then blocks/fixes ordinary networking globals and native networking exports before candidate imports: fetch, WebSocket, EventSource, HTTP(S), HTTP/2, TCP/TLS, UDP and DNS. Loopback services are blocked too. Network-dependent tests must mock transports. Additional trusted checks may be supplied by the host.
4. A passing routine frontend patch can activate automatically. Protected server/Electron/launcher/test/package/security edits and file deletion produce `review_required`; the concrete diff is available before an explicit Apply action.
5. Activation compares the complete source revision again. If anything changed, the candidate becomes `conflict`. It never overwrites a later edit. Writers use a shared source-root filesystem lock, same-directory atomic replacements and a persisted backup journal. The lock includes a PID and nonce, is released only by its owner, and is reclaimed only after the operating system confirms that PID is absent. An unknown/permission-denied/live owner is never guessed stale; another writer waits briefly or receives a conflict response.
6. Registered panels can refresh in the running workspace; reload for other frontend changes. Applying or rolling back reviewed worker-side server files schedules a managed worker restart after the HTTP response. Rollback rechecks activated file hashes, verifies a reverse candidate and restores retained files. Later edits to those files cause a conflict instead of being overwritten.

Multi-file replacement is journaled, not one filesystem transaction. After an interrupted promotion, startup restores known before/after states from backups. Unrecognized external edits produce `recovery_required` and are left untouched. Queued/generating/validating jobs interrupted by restart are marked `interrupted`, never automatically rerun. Closing the builder cancels queued and active generation/verification and waits for the current writer.

This workflow provides revision checks, rollback and constrained verification. The network preload supplements Node 24's filesystem/process permissions; it is not an OS sandbox for hostile programs. Existing selected regression checks and module loading do not prove every new UI interaction is correct; inspect the concrete preview and add behavior tests appropriate to the feature.

The retained regression baseline also includes the original productivity store, saved-conversation UI, and voice-session tests when present. These run from trusted copies against the candidate source, so changing a candidate test cannot weaken them. Microphone-controller source (`src/voice-session.mjs`) is protected and requires concrete review. The main app now starts as a white voice canvas; registered panels remain under the bottom strip's More menu. Preserve that minimal default and keep browser setup inside `mount`.

## Worker restart and host relaunch

The launcher runs `server/companion-host.mjs` as an owning parent with one server worker on the fixed loopback port. The parent manages only its own worker, checks its identity/health, and preserves the private data directory across restarts. A worker restart is not a full host relaunch.

For an applied or rolled-back server-worker change, the API can return `runtime: {managed, workerPid, restartRequested, requiresManualRestart}`. Managed restart is scheduled only after the response finishes. The frontend bootstraps a fresh personal session, polls runtime state with bounded backoff for up to 60 seconds, and requires a changed worker PID before refreshing workspace/providers/build details and reporting reconnection. It reads the affected job again: a supervisor-restored `rolled_back` job must not be described as an activated feature. Unmanaged servers show manual launch instructions instead.

If the updated worker fails startup, the parent can restore that job’s recorded source backup and launch the restored worker. If recovery cannot safely restore the files, the failure and retained backups require attention; do not overwrite external changes. GET `/api/assistant/runtime` reports the responding worker’s managed state and PID. POST `/api/assistant/runtime/restart` accepts an optional activated `jobId` and uses the normal session/Origin/CSRF checks.

Changes to the host module itself, or dependencies already loaded in that parent process, require stopping and relaunching the owning host. Automatic worker replacement cannot reload its parent’s JavaScript. For a foreground host, Ctrl+C followed by `npm start` is the full relaunch path. Closing a browser tab restarts neither process.

## Backend interface for external AI tools

```js
const builder = await createFeatureBuilder({
  root: applicationSourceDirectory,
  dataDirectory: privateBuilderDirectory,
  complete: modelRouter.complete,
});

await builder.source(localOwner, { includeContent: true });
await builder.request({ prompt, providerId, autoApply: true }, localOwner);
await builder.submitPatch({ summary, files, baseHashes, autoApply: false }, localOwner);
await builder.list(localOwner);
await builder.get(jobId, localOwner);
await builder.apply(jobId, localOwner);
await builder.rollback(jobId, localOwner);
await builder.cancel(jobId, localOwner);
await builder.close();
```

`request` and `submitPatch` return a persisted queued job immediately. Poll a job or the host's event endpoint for progress. `list` returns bounded summaries; `get` returns the selected job's source diffs, verification checks, protected-review state and retained events. Source content is opt-in; the default source manifest contains paths, SHA-256 hashes, byte counts and protected flags. `baseHashes` must include every patched path, with its current hash or `null` for a new file. Submission follows exactly the same verification, review, promotion and rollback lifecycle as model generation.

The host must authenticate local browser/API requests and enforce exact Origin and CSRF checks on writes. The builder's `localOwner` identifies one local workspace across app restarts; it is not a cloud identity or a multi-tenant account. Keep builder storage private and outside ordinary source, never expose it as static assets, and do not log credentials or complete prompts containing personal information. Git publishing is deliberately separate.

## Local REST and MCP access

The source-editing routes are under `/api/assistant` on the running Companion origin:

| Request | Result |
| --- | --- |
| `GET /features` | `{jobs}` containing lightweight summaries |
| `POST /features` with `{prompt,providerId,autoApply}` | A queued feature job |
| `GET /features/:id` | Full selected job, including concrete diffs/checks |
| `POST /features/:id/apply` with `{}` | Activate a verified candidate |
| `POST /features/:id/rollback` with `{}` | Verify and restore retained source |
| `POST /features/:id/cancel` with `{}` | Stop queued/generating/validating work |
| `GET /features/source` | Bounded source inventory and hashes |
| `GET /features/source?content=1` | Inventory plus sanitized complete source text |
| `POST /features/patch` with `{summary,files,baseHashes,autoApply}` | Submit an external source patch through the same lifecycle |

Direct API clients first obtain the local guest session from `GET /api/assistant/session`, retain its cookie and CSRF token, and send that exact origin and token with JSON writes. Do not bypass protected review by silently issuing Apply. Preserve a complete concrete candidate for the user's decision.

The MCP facade calls this same running HTTP backend; it does not open a second source writer. Its feature tools are `companion_build_feature`, `companion_list_builds`, `companion_get_build` (`{id}`), `companion_apply_build` (`{id}`), `companion_rollback_build` (`{id}`), `companion_cancel_build` (`{id}`), `companion_source` (`{includeContent}`) and `companion_submit_patch` (the patch shape above). Related productivity tools are `companion_workspace`, `companion_run_tool`, `companion_chat` and `companion_connections`.
