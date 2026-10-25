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
| `companion_run_tool` | Run a registered workspace or desktop tool with `tool`, `arguments`, and optional retry `operationId`. Desktop input produces an exact pending review; this wrapper cannot approve it. |
| `companion_chat` | Send `{id, message, providerId?}` to Companion's selected assistant. |
| `companion_build_feature` | Queue `{prompt, providerId?, autoApply?}` as a real coding job. |
| `companion_list_builds` / `companion_get_build` | Read actual build status, diffs, and checks. The latter takes `{id}`. |
| `companion_apply_build` | Explicitly activate a verified build using `{id}`. |
| `companion_rollback_build` / `companion_cancel_build` | Restore retained source or stop a running build using `{id}`. |
| `companion_source` | Read permitted source paths and hashes; `{includeContent:true}` also returns source text. |
| `companion_submit_patch` | Queue a concrete patch with source hashes. |
| `companion_connections` | Read redacted provider metadata; it cannot configure or retrieve keys. |
| `companion_desktop_status` | Read Windows desktop-adapter availability without inspecting a window. |
| `companion_desktop_actions` | Read pending desktop previews and actual results after the user acts in Companion. |

The connected client can access the notes and source these tools return. Saved text remains untrusted evidence, and tool annotations are hints rather than permission or proof that an action succeeded. Clients should use the actual returned receipts and their own review controls. Tool results contain both JSON text and `structuredContent`; execution failures set `isError:true`, while malformed tool arguments use JSON-RPC errors. This follows the MCP [tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The desktop tools discover installed apps and eligible windows. Use the returned IDs, scope window searches to the task, and read only the specific window needed for the user's request. Launch and URL receipts confirm that Windows accepted a request; they do not establish that a document loaded or that work inside an app finished. Generic clicking, text replacement and key presses require a fresh target snapshot and the user's review in Companion. A pending action is not an executed action. There is no desktop-approval MCP tool or arbitrary shell tool.

## Submit and review source changes

First call `companion_source` to obtain current hashes. Submit complete replacement contents, not a shell command or a textual diff:

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

## Retry, cancellation, and connection boundaries

For workspace mutations, retain the same `operationId` on an explicit retry. For `companion_chat`, retain the same `id` and input; completed and partial/interrupted request receipts prevent rerunning actions. Feature generation and external-patch submissions create jobs without an idempotency key: after an uncertain response, inspect build history before starting another.

An MCP cancellation notification aborts the pending HTTP request and suppresses its late MCP response, following the [cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation). Actions already finished and builds already queued may remain. Use the build's explicit cancel or rollback tool when appropriate. Closing stdin aborts pending bridge requests and ends the process.

`COMPANION_URL` can select only an HTTP origin on `127.0.0.1` or `localhost`, with an optional port. It cannot select an external host, URL credentials, a custom path, or redirects. The bridge obtains a personal assistant session from Companion and keeps its cookie/CSRF token in memory. No reading-group account is needed. It never reads Codex auth files, provider-key files, or arbitrary filesystem paths.

Requests are capped at 2 MiB per protocol line, with four concurrent requests and a four-minute HTTP timeout. HTTP responses are capped at 4 MiB; an oversized result produces an explicit error. Initialization and tool discovery do not contact Companion. Session bootstrapping has a separate ten-second timeout. The tests use fake HTTP responses and a disposable local server; no real AI account or client configuration is required.

```powershell
node --test tests/mcp-server.test.mjs
```
