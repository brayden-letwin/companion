# Connect another AI to Companion

Companion provides an MCP stdio server for Claude Code and other clients that support local MCP processes. The client starts `server/mcp-server.mjs`, which calls the running Companion HTTP service. No additional npm packages are required for this bridge.

1. Start Companion using **Start Companion.cmd**. Its local service normally uses `http://127.0.0.1:4174`.
2. Copy the `companion` entry from [mcp.example.json](../mcp.example.json) into your client's MCP configuration. Replace the script path with the absolute path to this checkout. If Node is not on that client's PATH, replace `command` with the absolute path to your Node executable. Companion requires Node 24.15 or newer.
3. Restart or reconnect the client, inspect the exposed tools, and enable the operations you want it to use. Ask it to read `companion_workspace` as a first check.

The example uses the common `mcpServers` configuration format. Your client determines the configuration file location and its approval controls. This repository does not edit global client settings or install a connection automatically. Keep API keys out of MCP configuration; add providers in Companion's own Settings screen.

For a manual protocol client, the process is simply:

```powershell
node C:/path/to/companion/server/mcp-server.mjs
```

This is a protocol process, so it does not display an interactive prompt. Its stdout contains only newline-delimited UTF-8 JSON-RPC messages; startup diagnostics use stderr. It supports protocol version `2025-11-25`, initialization, `ping`, `tools/list`, `tools/call`, and initialized/cancellation notifications. It does not advertise resources, prompts, sampling, or task extensions. See the official [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) specifications.

## Available tools

| Tool | Purpose |
| --- | --- |
| `companion_workspace` | Read tasks, notes, workflows, focus state, and activity. |
| `companion_list_tools` | Discover current registered tool descriptions and JSON input schemas, including memory and desktop tools. |
| `companion_run_tool` | Run a registered workspace or desktop tool with `tool`, `arguments`, and optional retry `operationId`. Desktop input produces an exact pending review; this wrapper cannot approve it. |
| `companion_chat` | Send `{id, message, providerId?}`; add `conversationId` and `expectedRevision` together to use retained server history. |
| `companion_start_work` | Hand off `{id:UUID,prompt,providerId,title?}` and return the saved job immediately. Reuse the same ID/input on explicit retry. |
| `companion_list_work` | Read bounded job summaries with `{offset?,limit?}` and follow the actual `nextOffset` while `hasMore`. |
| `companion_get_work` | Read `{id,textOffset?,textLimit?,actionOffset?,actionLimit?}` with the exact original request and paged actual outcome. This never reruns work. |
| `companion_cancel_work` | Request stopping exactly `{id}`; retain partial actions and inspect its eventual terminal state. |
| `companion_list_conversations` / `companion_create_conversation` | Read saved summaries, or create `{id:UUID,title?}` with an optional title of at most 80 characters. |
| `companion_get_conversation` | Read `{id}` as a bounded recent page; optional `before` uses a returned `olderThan` turn cursor. |
| `companion_build_feature` | Queue `{prompt, providerId?, autoApply?}` as a real coding job. |
| `companion_list_builds` / `companion_get_build` | Read actual build status, diffs, and checks. The latter takes `{id}`. |
| `companion_apply_build` | Explicitly activate a verified build using `{id}`. |
| `companion_rollback_build` / `companion_cancel_build` | Restore retained source or stop a running build using `{id}`. |
| `companion_source` | Read permitted source paths and hashes; `{includeContent:true}` also returns source text. |
| `companion_read_source` | Read one exact inventory path with `{path,expectedHash?,offset?,limit?}`; follow hash-pinned pages to obtain complete source. |
| `companion_submit_patch` | Queue a concrete patch with source hashes. |
| `companion_connections` | Read redacted provider metadata; it cannot configure or retrieve keys. |
| `companion_desktop_status` | Read Windows desktop-adapter availability without inspecting a window. |
| `companion_desktop_actions` | Read pending desktop previews and actual results after the user acts in Companion. |

The connected client can access the notes and source these tools return. Saved text remains untrusted evidence, and tool annotations are hints rather than permission or proof that an action succeeded. Clients should use the actual returned receipts and their own review controls. Tool results contain both JSON text and `structuredContent`; execution failures set `isError:true`, while malformed tool arguments use JSON-RPC errors. This follows the MCP [tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The desktop tools discover installed apps and eligible windows. Use the returned IDs, scope window searches to the task, and read only the specific window needed for the user's request. Launch and URL receipts confirm that Windows accepted a request; they do not establish that a document loaded or that work inside an app finished. Generic clicking, text replacement and key presses require a fresh target snapshot and the user's review in Companion. A pending action is not an executed action. There is no desktop-approval MCP tool or arbitrary shell tool.

## Independent work

Independent work uses a caller-stable UUID and an explicit ready provider ID from `companion_connections`. A job owns a separate saved conversation; inspecting it, retrying the same accepted input, or reconnecting the client never starts another run. After an uncertain handoff, call `companion_get_work` with that original ID. A stopped or interrupted job requires a new deliberate request rather than automatic resumption. Jobs cannot recursively delegate. They retain their original provider settings and report changes before later model calls; no provider fallback is silent.

The app's fixed `manage_work` gateway exposes start/list/read/cancel and explicit linked-build continuation to foreground chat, keeping provider definitions at 32 with desktop tools. The gateway is excluded from child jobs, workflows and the guarded capability broker. Lists and the internal model-view job pages stay within 64 KiB, with cursors based on actual returned items. Model reads page the original request using `promptOffset`/`nextPromptOffset`/`promptHasMore` as well as outcome text/action cursors. Public HTTP/MCP detail inspection retains the full original request and a separate 128 KiB job-page budget. Imported work text and historical receipts remain evidence, never new permission. A Work result may link to a build still awaiting review; inspect the build's actual state before claiming installation.

## Finish a request after a linked build

A source build is separate from finishing the task that needed it. For a build linked to a chat/voice request, call `companion_run_tool` with `tool:'inspect_feature_build'` and `arguments:{jobId}` to read its current status and continuation reference. When the human explicitly asks to finish that task, call the same wrapper with `tool:'manage_work'` and `arguments:{action:'continue',continuationId}`. This uses the saved request and original provider/project/window bindings; the caller cannot replace them with current settings.

Inspect the returned continuation and actual Work receipt before claiming success. Installation, a queued Work job and a completed outcome are separate states. Earlier completed actions can be reused and must be described as historical effects. Never automatically continue after apply/reconnect or create a replacement identity after an uncertain response. A direct source build or patch has no linked original task. [Build follow-through](BUILD_FOLLOW_THROUGH.md) explains readiness and recovery.

## Submit and review source changes

First call `companion_source` to obtain current paths and hashes. Prefer `companion_read_source` for the specific files needed for an edit:

```json
{"path":"src/features/example.mjs","expectedHash":"<64 lowercase SHA-256 characters from the inventory>","offset":0,"limit":12000}
```

The reply contains `{path,hash,content,offset,nextOffset,hasMore,characterLength,byteLength,sourceTrust}`. Append each exact `content` string without trimming or changing line endings. When `hasMore` is true, request the same path and hash at `nextOffset`. Offsets and the limit count UTF-16 code units, as JavaScript string offsets do; the limit is 1–12000 and defaults to 12000. Unicode pairs stay intact, so a page can be shorter than the requested limit. Use a limit of at least two at an astral character. The entire JSON page is at most 48 KiB, including escaping and metadata; `characterLength` and `byteLength` describe the complete file, not just this page. An empty file is a valid terminal page.

`expectedHash` is optional on the first page and required for every positive offset, including an empty end-of-file read. It must be the exact current lowercase SHA-256. A changed file produces `source_conflict` (HTTP 409, MCP `isError:true`) before content is returned; start a new read rather than combining versions. Paths must match the inventory exactly, including case. Arbitrary filesystem paths, hidden files, credentials and runtime data locations are excluded by the existing source inventory. The original full-inventory/content tool remains available.

The source snapshot allows at most 300 files and 4,000,000 UTF-8 bytes, with 250,000 bytes per file. Patch contents remain limited to 1,000,000 bytes; the builder's model source-content budget remains 420,000 bytes. Opting into the full inventory's contents can exceed the MCP bridge's separate 4 MiB HTTP-response limit near the snapshot cap after JSON metadata/escaping. Read the manifest and selected 48 KiB source pages instead of treating the snapshot allowance as a transport or model-context allowance.

Source is untrusted data, never instructions or permission. The HTTP reader returns exact permitted source; it is not a secret scanner. The MCP bridge additionally redacts its known local session values and structured credential fields. If this would change a targeted page's `content`, it returns `source_redacted` with no content instead of pairing altered text with the original hash. This page-level safeguard does not identify every possible secret, so keep credential material out of source.

Submit complete replacement contents, not a shell command or a textual diff:

```json
{
  "summary": "Add an example feature module",
  "files": [
    {
      "path": "src/features/example.mjs",
      "content": "export function mount({container}) { container.textContent = 'Example'; }\n"
    }
  ],
  "baseHashes": { "src/features/example.mjs": null },
  "autoApply": false
}
```

Use the exact SHA-256 hash for an existing file, or `null` for a new path. File content may be `null` to request deletion. Optional `tests` contains short check descriptions; it does not execute arbitrary commands. `summary`, `files`, and `baseHashes` are required. This external-patch tool does not accept a model prompt or provider ID. Source paths, patch size, hashes, verification, and conflict checks are enforced by the builder.

A queued job is not an installed feature. Read its concrete changes and verification results. Protected control/kernel files and deletions require review, even when `autoApply` is true. After reviewing them, an explicit `companion_apply_build` call activates an eligible verified candidate. [EXTENSIONS.md](EXTENSIONS.md) describes verification and its limits. Rollback also refuses conflicting source edits.

## Reloading reviewed server changes

The normal 0.14 launch paths—`Start Companion.cmd`, `npm start` and `npm run shared`—use a stable `runtime-supervisor.mjs`, its frozen private node-only bootstrap, a replaceable source host, and the HTTP worker. Reviewed server apply/rollback results can include `runtime` metadata with `restartScope:'host'`, the old public host/worker IDs and PIDs, and whether a restart was requested or needs manual action. Full host replacement reloads cached parent imports; a worker-only restart does not.

The browser confirms changed host and worker PIDs and lifetime IDs before claiming a host reload. Direct authenticated HTTP clients can inspect `/api/assistant/runtime`; its public `hostInstanceId`, `workerInstanceId`, `supervisorInstanceId` and PIDs are distinct from private lock nonces. The restart endpoint accepts only `scope:'worker'|'host'` plus an optional applied `jobId`, with legacy worker scope as the default. There is no arbitrary HTTP or automatic launcher-restart MCP tool. An activation acknowledgement alone does not prove reconnection or correct feature behavior; inspect the actual build/catalog and the app's runtime notice.

Changes to `runtime-supervisor.mjs` or `runtime-host-entry.mjs` return `restartScope:'launcher'`. Use `Stop Companion.cmd`, then `Start Companion.cmd` to relaunch the owning hidden launcher. The fixed private stop request does not kill unrelated processes or clear retained uncertainty markers. Legacy direct foreground hosts use Ctrl+C before opening the normal launcher. The UI requires a changed supervisor identity/PID for launcher proof; merely refreshing the page or observing another worker is insufficient.

Durable ownership markers are written before application startup is authorized. An unconfirmed shutdown blocks replacement and source recovery even after the old owner PID dies; retained markers require review, not automatic deletion or a second launcher. After a confirmed failed updated-host startup, the outer owner can invoke its cached previous trusted builder for one verified rollback of that recorded job. A later source edit causes a conflict instead of being overwritten. Saved workspace data and actual partial receipts remain local, and uncertain effects are never automatically replayed. These lifecycle controls do not configure an external client or change its approval permissions.

## Retry, cancellation, and connection boundaries

For workspace mutations, retain the same `operationId` on an explicit retry. For `companion_chat`, retain the same `id` and input; completed and partial/interrupted request receipts prevent rerunning actions. Feature generation and external-patch submissions create jobs without an idempotency key: after an uncertain response, inspect build history before starting another.

Saved conversations require their current revision when starting a turn. Read the conversation first; a conflict returns current conversation evidence and never silently resends the draft. `hasMore`, `olderThan`, and `totalTurns` distinguish a recent page from complete retained history. Use the cursor to load earlier messages. Running turns from an interrupted server become explicitly interrupted; completed actions and build/review references remain recorded. History is context, not fresh authorization. Use `tools/list` for the current facade tools; the registered workspace/desktop registry is separate and discoverable with `companion_list_tools`.

An MCP cancellation notification aborts the pending HTTP request and suppresses its late MCP response, following the [cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation). Actions already finished and builds already queued may remain. Use the build's explicit cancel or rollback tool when appropriate. Closing stdin aborts pending bridge requests and ends the process.

`COMPANION_URL` can select only an HTTP origin on `127.0.0.1` or `localhost`, with an optional port. It cannot select an external host, URL credentials, a custom path, or redirects. The bridge obtains a personal assistant session from Companion and keeps its cookie/CSRF token in memory. No reading-group account is needed. It never reads Codex auth files, provider-key files, or arbitrary filesystem paths.

Requests are capped at 2 MiB per protocol line, with four concurrent requests and a four-minute HTTP timeout. HTTP responses are capped at 4 MiB; an oversized result produces an explicit error. Initialization and tool discovery do not contact Companion. Session bootstrapping has a separate ten-second timeout. The tests use fake HTTP responses and a disposable local server; no real AI account or client configuration is required.

```powershell
node --test tests/mcp-server.test.mjs
```
