# Companion

A quiet, voice-driven workspace for getting things done—and adding the tools you are missing.

## Open it

1. **Double-click `Start Companion.cmd`.** It starts Companion and opens **Today** in your browser.
2. **Type what you want to get done.** Use the AI selector at the top; open **Settings** if a connection needs attention.
3. **Use the microphone when voice is ready**, or keep typing. Tap again to finish speaking; **Cancel** stops the current request.

No group account is needed. The existing development PC has a working Codex sign-in. On another PC, install **Node.js 24.15 or newer**, then use an existing Codex CLI sign-in or connect a provider in Settings. API keys belong in the app's password field, never in a chat or a Git commit.

The default address is **http://127.0.0.1:4174/assistant.html**. It runs on this computer; it is not a hosted service. Closing the browser leaves the local server running. Double-click the same launcher next time.

Try a concrete request:

- “Add a task to outline my proposal.”
- “Save a note: the next meeting needs a short agenda.”
- “What are my open tasks?”
- “Start 25 minutes of focus time.”
- “Build a project board that groups my existing tasks by project.”

Requests go to your selected AI. Completed actions appear as real tool receipts and saved workspace changes. Tasks and notes also have direct editing controls; saved workflows can run without a model interpreting the request.

## Your workspace

| View | What works now |
| --- | --- |
| **Today** | Conversation, recent activity, workspace counts, and a visible active focus session. |
| **Tasks** | Create, edit, complete, and reopen persistent tasks, with details, priority, projects, and optional due dates in the underlying tools. |
| **Notes** | Save, search, edit, and archive persistent notes. Keeping an AI reply is an explicit action. |
| **Workflows** | Save a sequence of supported local actions and run it with actual step results. |
| **Build a feature** | Request real source changes, follow their progress, inspect diffs and checks, activate, and roll back. |
| **Settings** | Select or configure AI connections and optional offline read-aloud. |

Workflows currently use registered Companion actions such as creating tasks, saving notes, and starting focus time. They do not send email or operate other applications. A focus session is an in-app timer; it does not block applications or guarantee a system notification.

Changes persist on the local server. If a concurrent edit changes the workspace, your draft remains available for an explicit retry. If a save response is lost, **Confirm last change** resends the original operation receipt rather than creating a duplicate.

## Choose your AI

| Connection | Authentication and behavior |
| --- | --- |
| **Codex · ChatGPT sign-in** | Uses the installed Codex CLI's existing sign-in and model setting. Companion checks the CLI's own status; it does not copy its auth files or ask for your ChatGPT password. |
| **GPT · OpenAI API** | Enter an OpenAI API key and model in Settings. This is a separate API connection with its own access and billing. |
| **Claude · Anthropic API** | Enter an Anthropic API key and model. Signing into the Claude website alone does not connect this API. |
| **Other · compatible API** | Enter an API key, model, and compatible base URL. Remote endpoints require HTTPS; loopback HTTP is supported. |
| **Local · Ollama** | Select an installed model and local endpoint. Model availability and support for tools affect which requests succeed. |

**Configured is different from live-tested.** Codex sign-in, real task/note actions, and a generated feature running in an isolated copy have been confirmed on the development PC. Claude, OpenAI API, and custom-provider protocols have automated transport checks, but no user API-key account has been used to validate those connections. The UI reports configured API connections as not yet tested. A failed provider does not silently switch to another.

Windows API keys are encrypted with **DPAPI for the current Windows user**, bound to their provider and endpoint. The browser receives redacted metadata such as whether a key exists; keys are never saved in browser storage or returned by the provider list. Changing a provider or endpoint requires re-entering its saved key. On other operating systems, this implementation keeps keys in server memory, so they must be entered again after a restart.

## Add a missing feature

**Build a feature** is an actual coding workflow, not a promise that a requested feature already exists:

1. Describe the behavior and what should count as working. Companion starts a persisted build job using the selected AI.
2. The builder reads allowed application source and generates complete changed files in a separate candidate copy. Private runtime data and credentials are excluded.
3. It runs fixed syntax, regression, registration, and applicable feature checks. The interface shows actual events, source diffs, and check output.
4. Passing routine frontend changes may activate automatically when that option is enabled. Protected controls, backend/launcher changes, and file deletions require review of the concrete diff and an **Activate feature** action.
5. Activation checks that the source has not changed since the candidate was prepared. **Roll back changes** restores the retained version when the affected files have not subsequently changed.

New registered panels can appear in the running workspace. **Reload interface** picks up other browser-source changes. The normal launcher now runs a managed host and server worker. Reviewed worker-side server changes trigger a worker restart after the activation response is sent; the page reconnects, refreshes its session and workspace, and confirms a different worker PID. If an updated worker fails startup and its retained source can be restored, the host rolls that feature back and the UI reports the restoration. Settings also offers **Restart Companion** for a managed worker.

**Host code needs a full relaunch.** Changing `server/companion-host.mjs` or a dependency already loaded by that parent process is not applied by restarting only its worker. Stop the owning host and launch it again. For a foreground host, use **Ctrl+C**, then `npm start`. A standalone development server reports a manual restart instruction. Closing the browser or reloading the page does not restart either process.

Checks do not establish every interaction's correctness. Review the resulting behavior, and keep a useful feature's acceptance test with its source. A failed or conflicting candidate is reported as such rather than described as installed. The builder does not publish to GitHub automatically.

[Feature and extension contracts](docs/EXTENSIONS.md) explain editable source, protected controls, verification, runtime panels, and rollback. [External AI / MCP integration](docs/MCP.md) explains how another AI client can inspect source, submit a patch, and use the same verification and activation flow. **Settings → Connect AI tools** provides copyable client configuration using this server’s actual Node path and loopback address. Connecting an external client still requires its configuration; the app's microphone does not automatically send messages into an already open Codex conversation.

## Voice

Tap the microphone to start and tap again to submit. A recording is bounded to 60 seconds. **Hands-free** is opt-in: a short pause ends a turn, listening pauses during transcription and replies, and switching tabs turns it off. **Read aloud** uses only a device voice marked as local; when none is available, replies stay as text.

Voice transcription uses the separate local speech service, independently of the selected chat provider. The launcher can start the already installed local services on this PC. Typed messages, direct task/note editing, and workflows remain available when voice is not ready. The [legacy local setup guide](docs/LEGACY_READER.md) contains the existing Ollama and Whisper installation instructions.

Recordings are processed in memory by Companion's transcription route. A submitted transcript becomes a message to the selected AI. Real microphone hardware, accents, noisy-room behavior, and natural interruption still require human testing; synthetic audio checks are not evidence that those conditions work.

## Data and running locally

The default server data folder is `work/companion-shared`, outside this source checkout. It contains the productivity database, provider metadata and protected keys, group-room database, and private build history/candidates/backups. Keep the whole folder private and outside Git. Saved tasks, notes, workflows, and activity survive a server restart; unsent form drafts and recent chat are not a durable backup.

For a file-copy backup, stop the server before copying its full data folder. SQLite can have active sidecar files. DPAPI-protected keys are tied to the Windows user, so migration may require re-entering them. Automated backup, recovery, remote synchronization, and multi-user productivity accounts are not implemented.

For a foreground development server:

```powershell
npm run shared
```

The command runs the managed host with Node’s built-in server and SQLite. **Ctrl+C** stops that foreground host and its owned worker. `COMPANION_SHARED_DATA_DIR` and `COMPANION_SHARED_PORT` choose another absolute private data folder and port. Use a different folder **and** port for QA; do not populate a real user's workspace with synthetic accounts or test tasks.

```powershell
npm test
npm run check
```

All 166 Node tests and 30 JavaScript syntax checks passed. The automated suites cover the persistent store and real tools, provider protocols and credentials, source builds and rollback, runtime lifecycle, local API boundaries, and the preserved reader/group core. Live Codex requests created real tasks and notes, a saved workflow executed two steps, and the same workspace survived restart. A real Codex-generated time-zone panel passed five checks, activated and ran in an isolated source copy, then rolled back and disappeared from that copy’s UI. Managed worker restart and browser reconnection also passed live checks. [QA.md](QA.md) records these outcomes separately from mock/synthetic tests and lists the remaining live account and human-voice checks.

The app uses plain HTML/CSS/JavaScript and a local Node server. The original PDF/native reader additionally uses PDF.js and Electron. Packaging the desktop reader does not bundle the local model, speech environment, or workspace server. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Earlier reading tools

The **Reading room** link opens the preserved math reader at `/index.html`; **Group room** opens `/room.html` with its separate accounts and saved discussion history. The group design demo at `/group.html` remains a browser-only simulation. Math is an optional secondary workflow in the current product, not the default workspace.

[Legacy reader and group setup](docs/LEGACY_READER.md) retains detailed native-corner, PDF, local-model, speech, and group instructions. [DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) describes the discussion design. [training/RESULTS.md](training/RESULTS.md) records the rejected LoRA experiment; it was not activated.

[Product direction and requirement evidence](docs/PRODUCT_DIRECTION.md) preserves the full goal, including broader computer control, voice-driven development, external AI connections, and capabilities that remain unfinished. [ROADMAP.md](ROADMAP.md) tracks the implementation without treating today's registered tools as the limit of that goal.
