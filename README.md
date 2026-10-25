# Companion

A quiet, voice-first workspace for getting things done—and adding the tools you are missing.

## Open it

1. **Double-click `Start Companion.cmd`.** It starts Companion and prefers the native corner when its Electron runtime is installed; otherwise it opens the white voice canvas in your browser.
2. **Enable voice** when you want Companion to listen. After microphone access is granted, it detects speech and submits after a pause. The visible voice control turns listening off.
3. Use the small bottom tool strip when you need a tool. **Chat** opens the saved conversation and a typing fallback; **Settings** manages AI connections.

No group account is needed. The existing development PC has a working Codex sign-in. On another PC, install **Node.js 24.15 or newer**, then use an existing Codex CLI sign-in or connect a provider in Settings. API keys belong in the app's password field, never in a chat or a Git commit.

The full workspace is at **http://127.0.0.1:4174/assistant.html**. It runs on this computer; it is not a hosted service. Closing a page or hiding the corner leaves the local server running. Double-click the same launcher next time. The main local service was upgraded to 0.9 after a consistent private SQLite backup. [QA.md](QA.md) records live checks separately from automated tests and remaining hardware checks.

Try a concrete request:

- “Add a task to outline my proposal.”
- “Save a note: the next meeting needs a short agenda.”
- “What are my open tasks?”
- “Start 25 minutes of focus time.”
- “Build a project board that groups my existing tasks by project.”

Requests go to your selected AI. Completed actions appear as real tool receipts and saved workspace changes. Tasks and notes also have direct editing controls; saved workflows can run without a model interpreting the request.

## Your workspace

The main interface starts as an almost blank white canvas. A small strip at the bottom opens the tools. Voice is the primary input, while Chat keeps the transcript, saved conversations, and typing available when needed. The compact native corner uses the same quiet appearance.

Conversations are saved on this PC. The corner, workspace, and connected AI clients can open the same retained conversation. Each turn records its actual action results and linked build/review IDs. A running or interrupted request is never silently rerun. Two windows cannot send overlapping turns to the same conversation; open a new conversation for a separate intention. Earlier messages load in bounded pages. Unsent drafts remain local to their current window and are not a durable backup.

Teach a lasting preference explicitly, such as “Remember that I prefer short replies and concrete examples.” Companion saves it as a reviewable preference, uses it in future replies, and can stop using it when asked. Preferences shape communication and work context; they do not grant new action permissions. A requested missing capability still goes through the actual source builder, checks, review rules, and rollback. Remembering a preference and changing code are separate, visible outcomes.

New callable functions now share one registry. Voice/chat discovers them, panels call them, saved workflows retain their exact versions, and connected AI tools see the same schemas and results. Open **Tools** to find successfully loaded panels and their spoken names. An unavailable or ambiguous name opens the catalog for a choice. A panel alone is not a callable function: [CAPABILITIES.md](docs/CAPABILITIES.md) describes the actual executor, test cases, guarded runtime, review and restart contract.

Each workflow run retains its original definition and real partial results. An exact retry returns that run's receipt even if the workflow was later edited or disabled. Changed or removed custom actions require review before a fresh run; they are never silently replaced. Generated capability behavior checks execute actual code with fixture-only host effects. Those checks supplement concrete review and live acceptance rather than proving every possible feature correct.

| View | What works now |
| --- | --- |
| **Chat** | Saved conversations, actual action receipts, and a typing/manual-microphone fallback. |
| **Tasks** | Create, edit, complete, and reopen persistent tasks, with details, priority, projects, and optional due dates in the underlying tools. |
| **Notes** | Save, search, edit, and archive persistent notes. Keeping an AI reply is an explicit action. |
| **Workflows** | Save a sequence of supported local actions and run it with actual step results. |
| **Computer** | Search/open installed apps, list/focus windows, explicitly read a selected window, and review prepared input. |
| **Build a feature** | Request real source changes, follow their progress, inspect diffs and checks, activate, and roll back. |
| **Settings** | Select or configure AI connections and optional offline read-aloud. |

Workflows currently use registered Companion actions such as creating tasks, saving notes, and starting focus time. They do not send email or operate other applications. A focus session is an in-app timer; it does not block applications or guarantee a system notification.

Changes persist on the local server. If a concurrent edit changes the workspace, your draft remains available for an explicit retry. If a save response is lost, **Confirm last change** resends the original operation receipt rather than creating a duplicate.

## The native corner

The compact corner is **400 × 230**, with an expanded conversation view. Use its controls to expand, hide, or open the full workspace. **Ctrl+Alt+Space** toggles it when that shortcut is available; the UI reports actual shortcut availability. **Ctrl+Alt+Escape** is global Stop when registered: it cancels running requests, desktop helpers/pending actions, and queued/generating/checking feature jobs. Completed data and promoted source remain. Hiding the corner stops its microphone/current chat but preserves pending desktop reviews and background builds so you can continue in the full workspace.

Run `scripts/start-companion.ps1 -Browser` to choose the browser instead. `npm run desktop` opens the general native workspace after its server is running. `npm run desktop:legacy` retains the original math reader/corner.

Settings offers **Restart desktop app** for the current native app. When it is running directly from editable source, relaunching loads reviewed Electron changes. A copied desktop package must be rebuilt to include repository changes; relaunching its old copy is not an update. Server-worker restart and full managed-host relaunch remain separate operations.

## Computer actions

Ask for an action, or use **Computer** to find an installed app or explicitly list and read a window. A read returns bounded accessibility text and controls from that chosen window; it does not continuously watch the screen. Launch receipts distinguish an accepted launch from an observed app window. Unsupported or unavailable controls return a failure rather than a claim of success.

Clicks, text replacement, and supported keys are first prepared as a target-bound action. **Review the actual window/control and exact input**, then use its action button or, while that same preview is open, say or type exactly **“approve desktop action”** or **“cancel desktop action.”** The review has its own microphone control. Approval is tied to the visible, unexpired preview captured before recording; a closed, changed, or different preview cannot receive that old command. Assistant replies and read-aloud text do not trigger approval.

The model has no approval tool. Companion controls, credential fields, terminals, and other protected targets are blocked from generic input. Input can affect another app, including submitting or saving; the concrete preview is where you decide on that one action. A timeout or cancellation can leave an uncertain outcome, so check the target before retrying when the app reports that input may already have happened. This is scoped Windows automation, not unrestricted control of every program.

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

Enable voice once to grant microphone access. The voice session detects speech locally, waits for a short pause, and submits that utterance. Quiet periods are not submitted. Each spoken segment is bounded; the mic pauses during transcription, reasoning, and read-aloud. Listening stops when the app is hidden or you turn it off. A remembered opt-in can resume on a visible app only when microphone permission is already granted; it never silently opens a new permission prompt. This is speech detection, not wake-word recognition or validated speech interruption during an AI reply.

**Read aloud** uses only a device voice marked as local. The first Enable voice action may enable it when a local voice exists and no previous preference was chosen. When none is available, open **Chat** to read the reply. Chat also retains the manual microphone and typing fallback. Never treat a visible ready indicator or synthetic audio tests as proof of a particular person's microphone behavior.

Voice transcription uses the separate local speech service, independently of the selected chat provider. The launcher can start the already installed local services on this PC. Typed messages, direct task/note editing, and workflows remain available when voice is not ready. The [legacy local setup guide](docs/LEGACY_READER.md) contains the existing Ollama and Whisper installation instructions.

Recordings are processed in memory by Companion's transcription route. A submitted transcript becomes a message to the selected AI. The user reported that basic voice worked. That report does not independently verify the Restart desktop app control or spoken desktop approval. A later normal launcher run independently verified a fresh native launch. Broader device changes, accents, noisy-room behavior, long pauses, and natural interruption still need testing; one successful use does not establish those conditions.

## Data and running locally

The default server data folder is `work/companion-shared`, outside this source checkout. It contains the productivity database, saved conversations and preferences, provider metadata and protected keys, group-room database, and private build history/candidates/backups. Keep the whole folder private and outside Git. Saved tasks, notes, workflows, preferences, recorded conversation turns, and activity survive a server restart. Unsent form drafts remain in the current window; exports, automatic backup, and cross-device synchronization remain separate work.

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

The 0.9 update passed 300 Node tests and 39 JavaScript syntax checks. Real GPT, MCP, an actual panel and a saved workflow used one isolated synthetic capability through the same executor. Exact edited-workflow retries did not execute newly appended steps. Check last run retains the original run ID after a lost response, including after reload, and requires an explicit click. Global Stop also reaches direct tool and workflow requests. See QA.md for the distinction between fixture, live, and generated-feature evidence.

The 0.8 checkpoint passed 255 Node tests and 34 JavaScript syntax checks. Real GPT conversation continuity and preference saving, Memory archive/restore, managed restart persistence, the white browser/native canvas, and the expanded trusted builder baseline were checked separately. Automatic speech detection still needs a human microphone check; its capture and integration tests use fake media.

The 0.7 checkpoint passed all 201 Node tests, 33 JavaScript syntax checks, and the PowerShell parser checks. The automated suites cover the persistent store and real tools, provider protocols and credentials, source builds and rollback, runtime lifecycle, local API boundaries, and the preserved reader/group core. Live Codex requests created real tasks and notes, a saved workflow executed two steps, and the same workspace survived restart. A real Codex-generated time-zone panel passed five checks, activated and ran in an isolated source copy, then rolled back and disappeared from that copy’s UI. Managed worker restart and browser reconnection also passed live checks. The native corner and a real GPT app-search/open-Calculator chain were checked separately. A real GPT-prepared Notepad text action completed after human button approval, and the exact synthetic text was observed in Notepad. Basic voice success was user-reported. A normal native launch showed the new white-outline corner, and a physical global Stop cancelled a pending Notepad action without changing the editor text. [QA.md](QA.md) records these outcomes separately from mock/synthetic tests and lists the remaining live account and human-voice checks.

The app uses plain HTML/CSS/JavaScript and a local Node server. The original PDF/native reader additionally uses PDF.js and Electron. Packaging the desktop reader does not bundle the local model, speech environment, or workspace server. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Earlier reading tools

The **Reading room** link opens the preserved math reader at `/index.html`; **Group room** opens `/room.html` with its separate accounts and saved discussion history. The group design demo at `/group.html` remains a browser-only simulation. Math is an optional secondary workflow in the current product, not the default workspace.

[Legacy reader and group setup](docs/LEGACY_READER.md) retains detailed native-corner, PDF, local-model, speech, and group instructions. [DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) describes the discussion design. [training/RESULTS.md](training/RESULTS.md) records the rejected LoRA experiment; it was not activated.

[Product direction and requirement evidence](docs/PRODUCT_DIRECTION.md) preserves the full goal, including broader computer control, voice-driven development, external AI connections, and capabilities that remain unfinished. [ROADMAP.md](ROADMAP.md) tracks the implementation without treating today's registered tools as the limit of that goal.
