# Executable capabilities

A capability is real JavaScript that Companion can call through voice/chat, a saved workflow, an installed panel, or MCP. A panel's `mount()` function alone does not register a callable action. Use one capability executor for the behavior and make its panel call that executor.

Create `server/capabilities/manifest.json` when the first capability is added. Preserve existing entries. Each entry points to exactly one `server/capabilities/<id>.mjs` file exporting `execute(args, ctx)`. The loader reads and validates source without importing it into the server. Execution happens in a fixed guarded Node child.

## A complete pure example

This manifest registers a duration formatter. `featureId` is optional and links to a panel whose frontend manifest ID is `duration-tool`.

```json
{
  "version": 1,
  "capabilities": [
    {
      "id": "duration",
      "title": "Duration",
      "description": "Format a supplied number of seconds as minutes and seconds.",
      "module": "./duration.mjs",
      "version": 1,
      "tool": {
        "name": "cap_duration",
        "description": "Format the user's supplied seconds as minutes:seconds.",
        "parameters": {
          "type": "object",
          "properties": {
            "seconds": { "type": "integer", "minimum": 0, "maximum": 86400 }
          },
          "required": ["seconds"],
          "additionalProperties": false
        }
      },
      "workflowAllowed": true,
      "effectPolicy": "pure",
      "featureId": "duration-tool",
      "acceptance": [
        { "name": "Zero", "arguments": { "seconds": 0 }, "expected": { "minutes": 0, "seconds": 0, "label": "0:00" } },
        { "name": "Exact minute", "arguments": { "seconds": 60 }, "expected": { "minutes": 1, "seconds": 0, "label": "1:00" } },
        { "name": "Remainder", "arguments": { "seconds": 125 }, "expected": { "minutes": 2, "seconds": 5, "label": "2:05" } }
      ]
    }
  ]
}
```

`server/capabilities/duration.mjs`:

```js
export async function execute(args, ctx) {
  const minutes = Math.floor(args.seconds / 60);
  const seconds = args.seconds % 60;
  return { minutes, seconds, label: `${minutes}:${String(seconds).padStart(2, '0')}` };
}
```

Return a plain JSON object. `ctx.now` is an ISO string fixed at the start of this execution, for example `"2026-10-24T12:00:00.000Z"`. It is not a function; there is no `ctx.nowISO`. Use `new Date(ctx.now)` for time-dependent calculations. Acceptance verification fixes it to `"2000-01-01T12:00:00.000Z"`.

A module is a single source file. Pure Node builtins such as `node:crypto` can be used within the execution restrictions. Do not import neighboring source, packages, or helper files; their files are not readable by the child. Keep DOM setup in the separate panel.

## Workspace effects use the parent broker

Set `effectPolicy` to `"workspace"` when the executor needs approved workspace primitives. `"pure"` denies every `ctx.runTool()` call.

```js
// server/capabilities/save-summary.mjs
export async function execute(args, ctx) {
  const result = await ctx.runTool('save_note', {
    title: args.title,
    text: args.text
  });
  return { noteId: result.note.id, savedAt: ctx.now };
}
```

Register this example as `id: "save-summary"`, `module: "./save-summary.mjs"`, `tool.name: "cap_save_summary"`, with a strict schema for `title` and `text`. A concrete acceptance entry can be:

```json
{
  "name": "Saves the supplied summary",
  "arguments": { "title": "Summary", "text": "A supplied draft." },
  "expected": { "noteId": "fixture-note", "savedAt": "2000-01-01T12:00:00.000Z" },
  "tools": [
    {
      "name": "save_note",
      "arguments": { "title": "Summary", "text": "A supplied draft." },
      "result": { "note": { "id": "fixture-note" } }
    }
  ]
}
```

The broker allows only `list_tasks`, `list_notes`, `read_note`, `search_notes`, `create_task`, `update_task`, `complete_task`, `save_note`, `start_focus`, `stop_focus`, and `get_time`. Their current argument schemas are available through the tool catalog. There are no desktop, approval, feature-building, memory, workflow-recursion, custom-capability-recursion, credential, arbitrary HTTP, or shell calls in this broker. Calls are serialized and limited to twelve per execution. A pending review result stops further execution.

The parent assigns nested IDs such as `host:1`, checkpoints an accepted call before dispatch, and records the actual result. Child output cannot manufacture those receipts. A capability result contains `{capability, value, hostActions}`. On failure or cancellation, actual completed or uncertain nested actions remain in retained receipts; stopping a request does not undo them. Inspect `status` and `outcomeUnknown` before claiming that anything happened or was reversed.

## Use the same action from every surface

The normal desktop runtime keeps 28 provider tool definitions: 21 workspace tools, including `list_capabilities` and `run_capability`, plus seven desktop tools. Custom capabilities live in the dynamic catalog rather than being appended to every model request. This avoids exceeding the provider router's 32-definition limit.

Chat and voice discover `list_capabilities`, then call:

```json
{ "name": "cap_duration", "arguments": { "seconds": 125 } }
```

as the arguments of `run_capability`. Voice uses the same server execution after transcription; it does not need a separate speech-specific implementation.

`GET /api/assistant/integrations` returns the shared tool catalog and capability readiness. Custom catalog entries include `name`, `title`, `description`, `parameters`, `kind: "capability"`, `capabilityId`, `version`, `hash`, `workflowAllowed`, `effectPolicy`, and optional `featureId`. Absolute `modulePath`, internal `moduleHash`, source, and acceptance fixtures are not public catalog fields. The public hash pins the normalized registration and exact module hash; execution checks `moduleHash` before copying those reviewed bytes to private child storage.

The normal authenticated `POST /api/assistant/tools/run` accepts either a direct registered name or the gateway:

```json
{ "tool": "cap_duration", "arguments": { "seconds": 125 }, "operationId": "a-caller-chosen-valid-UUID" }
```

Use a real UUID in requests. The HTTP response is `{tool, result, requestId, workspace}`; the capability's computed object is `result.value`, and its parent-confirmed effects are `result.hostActions`. HTTP failure responses preserve `hostActions` and `capability` when effects have already occurred.

MCP clients use `companion_list_tools` to discover the catalog and `companion_run_tool` with the same `tool`, `arguments`, and stable `operationId`. MCP is a facade over this authenticated server; it does not execute capabilities or write application source independently.

## Optional panel and voice names

Add the panel to the root `features` array in `src/features/manifest.json`:

```json
{
  "version": 1,
  "features": [
    {
      "id": "duration-tool",
      "title": "Duration",
      "description": "Format seconds as minutes:seconds.",
      "aliases": ["duration formatter"],
      "capabilityId": "duration",
      "module": "./features/duration-tool.mjs"
    }
  ]
}
```

Keep metadata in the manifest entry. Exporting a metadata object from the module does not register it. The capability's `featureId` matches the panel's `id`; the panel's `capabilityId` matches the capability's `id`. These links group the UI catalog; they do not grant execution permissions. The capability can also work without a panel.

The panel title and optional aliases let local UI commands such as “open Duration” or “open duration formatter” open a ready panel. Opening is different from executing. Duplicate names show a chooser, and missing or failed panels show an unavailable state rather than pretending an action ran.

`src/features/duration-tool.mjs`:

```js
export function mount({ container, api }) {
  const input = document.createElement('input');
  input.type = 'number'; input.min = '0'; input.max = '86400'; input.value = '125';
  input.setAttribute('aria-label', 'Seconds');
  const run = document.createElement('button'); run.textContent = 'Format';
  const output = document.createElement('output');
  let disposed = false;
  const format = async () => {
    run.disabled = true;
    try {
      const receipt = await api.runTool('cap_duration', { seconds: Number(input.value) });
      if (!disposed) output.textContent = receipt.result.value.label;
    } catch (error) {
      if (!disposed) output.textContent = error.message;
    } finally { if (!disposed) run.disabled = false; }
  };
  run.addEventListener('click', format);
  container.append(input, run, output);
  return () => { disposed = true; run.removeEventListener('click', format); container.replaceChildren(); };
}
```

Panel `api.runTool()` returns the HTTP envelope, not the executor value directly: read `receipt.result.value`. Workspace-effect panels must also show relevant actual receipts or partial-error information. Preserve the blank white voice canvas, bottom functions, hidden chat, and More menu; install panels within their supplied container.

## Workflows, corrections, and replay

The workflow editor uses the same catalog and parameter schemas. Only entries with `workflowAllowed: true` can be saved as steps. Saving a new custom step adds `{id, version, hash}` as its capability pin. Existing steps retain their pin; execution refuses a missing or changed capability rather than silently selecting new behavior. Review the values and explicitly choose the updated action to save a new pin.

Exact terminal retries return the original saved result even after code changes or removal. Reuse the same operation/request identity and input only to inspect or retry that original execution. A new execution requires a new identity. An interrupted execution is retained and is not automatically resumed. This also applies to workflow receipts: editing a workflow does not make an old completed operation run again.

For a correction, submit a new source patch through the builder, preserve other registrations, add or update concrete cases, and increment the capability version when its intended behavior changes. The code/metadata hash changes independently of the version. Inspect the concrete diff and checks, explicitly apply protected changes, then wait for the worker to reconnect and the current catalog to load. Run the corrected action and inspect its actual receipt before claiming it works. A changed worker PID proves replacement, not every behavior's correctness.

If the registry is malformed, custom capabilities become unavailable while normal workspace tools and build/rollback access remain available. Repair the manifest/module through the builder or roll back its recorded job. Existing workflow definitions remain retained. Rollback refuses later conflicting source edits; resolve those through a reviewed correction rather than overwriting them. See [EXTENSIONS.md](EXTENSIONS.md) for host relaunch and rollback details.

## Bounds and verification

| Area | Implemented bounds |
| --- | --- |
| Registry | Version 1; at most 40 capabilities; manifest and each module at most 256 KiB |
| Identity | ID starts with a lowercase letter, then lowercase letters/digits/hyphens, at most 40 characters; module exactly `./<id>.mjs`; tool exactly `cap_` plus ID with hyphens replaced by underscores |
| Metadata | Title at most 100 characters; descriptions at most 2,000; integer version 1–1,000,000,000; explicit boolean `workflowAllowed`; explicit `pure`/`workspace` effect policy |
| Parameter schema | At most 32,000 serialized characters, depth 6, 256 schema nodes, 24 properties per object; object `required` lists and `additionalProperties: false` |
| Schema subset | `object`, `array`, `string`, `integer`, `number`, `boolean`, `null`; descriptions, required fields, primitive enums, finite numeric bounds, string lengths, and array lengths; no references or arbitrary schema extensions |
| Arrays/strings | Arrays need `maxItems` from 0–100; primitive enums contain 1–50 entries; custom string length bounds at most 24,000 characters |
| Runtime | Three concurrent children; ten seconds each; 64 MiB V8 old-space budget; single-file source; JSON arguments and forwarded host responses at most 64 KiB each |
| Child protocol | Combined stdout/stderr at most 128 KiB, including protocol frames; plain-object result; at most twelve serialized host calls |
| Acceptance | 1–8 cases per capability; expected object at most 32,000 bytes; up to twelve fixture calls with result objects at most 24,000 bytes; thirty seconds total verification budget |
| Workflows | Up to twelve steps; custom steps retain exact capability pins |

The fixed child has a scrubbed environment and native read permission only for its copied module and trusted runner/guard files. It has no filesystem write, child-process, worker, or addon permission. A trusted JavaScript guard blocks ordinary networking, including loopback and DNS, and host signalling. This is layered Node permission and JavaScript enforcement, not an OS sandbox for hostile programs. Capability code cannot read arbitrary user files, access credentials, approve desktop actions, run a shell, or invent a network connector through `ctx`.

Acceptance verification executes the actual candidate source with host-owned comparisons. Workspace calls use declared exact fixtures only; they never mutate a real workspace during verification. Missing, unexpected, unused, or wrong calls/results fail the check. Existing trusted regression tests and generated feature tests add coverage. Passing declared fixtures does not prove an arbitrary user request or every UI interaction is correct; review the cases and validate the requested interaction after activation.

All capability files are under protected `server/` source. Their edits require concrete diff review and explicit activation through the existing builder. Managed worker changes schedule restart after the Apply response. Changes to the host or already cached parent dependencies require full host relaunch. A broader connector can still be implemented as a protected core source change with appropriate tests and review; this capability broker does not silently grant it new authority. Git publishing and external sends remain separate user-authorized actions.
