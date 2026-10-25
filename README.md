# Companion

A quiet, voice-first workspace for getting things done—and adding the tools you are missing.

## Open it

1. **Double-click `Start Companion.cmd`.** It starts Companion and prefers the native corner when its Electron runtime is installed; otherwise it opens the white voice canvas in your browser.
2. **Enable voice** when you want Companion to listen. After microphone access is granted, it detects speech and submits after a pause. The visible voice control turns listening off.
3. Use the small bottom tool strip when you need a tool. **Chat** opens the saved conversation and a typing fallback; **Settings** manages AI connections.

No group account is needed. The existing development PC has a working Codex sign-in. On another PC, install **Node.js 24.15 or newer**, then use an existing Codex CLI sign-in or connect a provider in Settings. API keys belong in the app's password field, never in a chat or a Git commit.

The full workspace is at **http://127.0.0.1:4174/assistant.html**. It runs on this computer; it is not a hosted service. Closing a page or hiding the corner leaves the local server running. Double-click the same launcher next time. **Stop Companion.cmd** gracefully stops the background service and its owned processes while retaining saved work. [QA.md](QA.md) records live checks separately from automated tests and remaining hardware checks.

Try a concrete request:

- “Add a task to outline my proposal.”
- “Save a note: the next meeting needs a short agenda.”
- “What are my open tasks?”
- “Start 25 minutes of focus time.”
- “Build a project board that groups my existing tasks by project.”
- “Work on these two requests in the background while I keep talking.”

Requests go to your selected AI. Completed actions appear as real tool receipts and saved workspace changes. Tasks and notes also have direct editing controls; saved workflows can run without a model interpreting the request.

## Your workspace

The main interface starts as an almost blank white canvas. A small strip at the bottom opens the tools. Voice is the primary input, while Chat keeps the transcript, saved conversations, and typing available when needed. The compact native corner uses the same quiet appearance.

Conversations are saved on this PC. The corner, workspace, and connected AI clients can open the same retained conversation. Each turn records its actual action results and linked build/review IDs. A running or interrupted request is never silently rerun. Two windows cannot send overlapping turns to the same conversation; open a new conversation for a separate intention. Earlier messages load in bounded pages. Unsent drafts remain local to their current window and are not a durable backup.

Teach a lasting preference explicitly, such as “Remember that I prefer short replies and concrete examples.” Companion saves it as a reviewable preference, uses it in future replies, and can stop using it when asked. Preferences shape communication and work context; they do not grant new action permissions. A requested missing capability still goes through the actual source builder, checks, review rules, and rollback. Remembering a preference and changing code are separate, visible outcomes.

New callable functions now share one registry. Voice/chat discovers them, panels call them, saved workflows retain their exact versions, and connected AI tools see the same schemas and results. Open **Tools** to find successfully loaded panels and their spoken names. An unavailable or ambiguous name opens the catalog for a choice. A panel alone is not a callable function: [CAPABILITIES.md](docs/CAPABILITIES.md) describes the actual executor, test cases, guarded runtime, review and restart contract.

Ask Companion to edit, rename, pause or enable an existing routine by voice or chat; it keeps the actual saved ID and checks the current revision. **Workflows** also has direct edit and enable/disable controls. A paused routine stays paused when edited. Saving or enabling it does not run it. [Saved routines](docs/WORKFLOWS.md) explains exact edits, changed actions and recovery.

Each workflow run retains its original definition and real partial results. An exact retry returns that run's receipt even if the workflow was later edited or disabled. A fresh run starts at step one and can repeat earlier effects, including actions completed inside a failed step. Changed or removed custom actions require review before a fresh run; they are never silently replaced. Generated capability behavior checks execute actual code with fixture-only host effects. Those checks supplement concrete review and live acceptance rather than proving every possible feature correct.

Open **Workflows → Run history**, or say **“show run history”**, to inspect earlier results. Per-routine History controls filter that same saved evidence. The original name, steps and actual nested receipts remain available after edits, reload and restart; missing current routines still appear in global history. Older run times stay unknown. **Check last run** reads the exact original identity without sending another run request. Long records load in explicit revision-bound pages. You can also ask the selected AI what happened in a past run; it uses the same read-only evidence.

**Tools → Files** connects a folder you choose to chat, voice, Work and connected AI tools. Search literal text across that folder, open a result against its observed file hash, read/save requested UTF-8 text/code files, inspect edit history and Undo recent edits. Search can continue across empty pages and reports skipped files or limits; a partial search never proves absence. Each request keeps its original folder; removing access stops dependent future operations. Companion’s own source and private data stay on the Build/review path. See [Project files](docs/PROJECT_FILES.md) for access, recovery and size limits.

When a chat or voice task needs a missing tool, its linked build keeps **Your request** separate from **Build instructions**. Review and activate the change, wait for the callable tool and runtime to be ready, then choose **Continue original request**. You can also say that exact phrase while the intended build is open. The separate Work job keeps the original request, AI connection, project access and window selection; earlier completed actions are reused. It never resumes automatically or substitutes your current source. [Build follow-through](docs/BUILD_FOLLOW_THROUGH.md) explains the steps, Stop and read-only recovery checks.

| View | What works now |
| --- | --- |
| **Chat** | Saved conversations, actual action receipts, and a typing/manual-microphone fallback. |
| **Tasks** | Search the full list, filter projects and Today/Overdue/Upcoming/No deadline, sort by priority or deadline, and read complete instructions. Edit calendar dates or precise times with explicit zone/clock-change choices; complete and reopen saved tasks. |
| **Notes** | Save, search, edit, and archive persistent notes. Keeping an AI reply is an explicit action. |
| **Files** | Choose a local project folder; read/edit text files, inspect saved changes and Undo. |
| **Workflows** | Save routines, run supported actions, and inspect original history and actual partial effects. |
| **Tools → Work** | Hand off independent requests, inspect actual results, stop one job, or open its saved conversation. |
| **Computer** | Search/open installed apps, choose a window as question context, read a snapshot, and review prepared input. |
| **Build a feature** | Request real source changes, follow their progress, inspect diffs and checks, activate, and roll back. |
| **Settings** | Choose AI connections, review memory, control read-aloud and back up/recover workspace content. |

Workflows currently use registered Companion actions such as creating tasks, saving notes, and starting focus time. They do not send email or operate other applications. A focus session is an in-app timer; it does not block applications or guarantee a system notification.

Ask for a calendar deadline when you mean a day, or specify a time and place for an exact deadline. **Tasks → Edit** exposes the same choices. Dates keep their calendar day; precise deadlines show their civil time and offset using the workspace server's timezone data. [Task deadlines](docs/TASK_DEADLINES.md) explains clock changes, filters, clearing, legacy values and save recovery.

Changes persist on the local server. If a concurrent edit changes the workspace, your draft remains available for an explicit retry. If a save response is lost, **Confirm last change** resends the original operation receipt rather than creating a duplicate.

Ask “How many open, high-priority, and overdue tasks do I have?” for actual counts across all matching tasks. Task-list results are pages with explicit totals and continuation offsets; they no longer silently omit older records. Long instructions have a short list preview and complete detail reads. The Tasks view searches titles, full details, and projects, while showing 50 matches at a time. **No project** and a project literally named **Unassigned** remain separate choices.

## Hand off work and keep talking

Say “work on this in the background,” or open **Tools → Work**, describe the request, and choose **Hand off**. Companion saves it in a separate conversation and returns an acknowledgement while the job continues. Two jobs can run independently, with up to ten more queued. Changing conversations or hiding the window does not cancel accepted work while the local server runs. **Show work** opens their status, results and real action receipts; progress history stays collapsed until you open it.

**Stop this work** targets the selected active job. The main **Stop** control and global Stop shortcut also cancel background jobs. Cancellation retains completed actions and can show **Stopping…** until the active turn settles. After a restart, unfinished jobs are marked interrupted and require a new explicit request; they are never silently repeated. If a handoff response is uncertain, **Check handoff** reads the original saved job ID instead of resubmitting it. Only that opaque pending ID is kept in browser storage.

**Result ready** means the job's assistant turn has finished. A linked feature build or desktop preview has its own actual state; the label does not claim code is installed or input is approved. Open its conversation or build link to continue. Jobs use the chosen AI connection and detect changes to its app-configured model/endpoint before later calls. A Codex connection with an empty model field still uses the CLI's configured default. Independent jobs cannot create more work jobs themselves.

When a selected window is attached, the job retains that original source binding and reads it when its turn starts. Clearing or replacing that source stops dependent active work; a queued job whose source was released fails before asking the AI, without switching windows. The general white canvas remains the default, with Work behind Tools.

## The native corner

The compact corner is **400 × 230**, with an expanded conversation view. Use its controls to expand, hide, or open the full workspace. **Ctrl+Alt+Space** toggles it when that shortcut is available; the UI reports actual shortcut availability. **Ctrl+Alt+Escape** is global Stop when registered: it cancels running requests, desktop helpers/pending actions, and queued/generating/checking feature jobs. Completed data and promoted source remain. Hiding the corner stops its microphone/current chat but preserves pending desktop reviews and background builds so you can continue in the full workspace.

Run `scripts/start-companion.ps1 -Browser` to choose the browser instead. `npm run desktop` opens the general native workspace after its server is running. `npm run desktop:legacy` retains the original math reader/corner.

Settings offers **Restart desktop app** for the current native app. When it is running directly from editable source, relaunching loads reviewed Electron changes. A copied desktop package must be rebuilt to include repository changes; relaunching its old copy is not an update. The service restart and desktop relaunch are separate operations.

## Computer actions

Ask for an action, or use **Computer** to find an installed app or explicitly list and read a window. A read returns bounded accessibility text and controls from that chosen window; it does not continuously watch the screen. Launch receipts distinguish an accepted launch from an observed app window. Unsupported or unavailable controls return a failure rather than a claim of success.

To ask about another app, open **Computer → List open windows → Use as context** beside that window. Selecting it checks its identity and privacy without reading document text. A small source label appears above the voice controls. Each question then reads fresh text from that same window and sends it to your chosen AI. Actual source text and its read time are retained with the local conversation. **Clear** removes the selection and cancels its current recording or question; it does not erase earlier saved replies. Selection is kept only in this window's memory and expires after eight hours or a server restart.

The returned answer identifies the actual source title, read time, and any truncation. An empty, closed, replaced, or protected window stops that question before the AI; Companion does not quietly answer without the selected source. Accessibility text can omit graphics, equations, or parts of a document. The source selection follows that window's observed identity, including ordinary title changes; it does not follow the mouse or foreground app. A one-shot Windows observation cannot universally detect a handle destroyed and reused within the same process with identical observable identity. Window text is untrusted evidence and cannot grant approval or new permissions.

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

**Configured is different from live-tested.** Settings separates sign-in, an installed local model and saved API settings from an actual answer. Choose **Test connection** to send one small fixed message, without your chats or files. It records the actual result and time for that saved configuration. Changing the key/model/endpoint prevents an old success from verifying the new settings. A lost response offers **Check test** for the original ID; reload and Save never resend it. You can also say exactly “test connection” while Settings is open with the intended saved AI selected. [AI connection checks](docs/AI_CONNECTIONS.md) explains cancellation, history and scope.

Real GPT/Codex and the installed local model have passed the fixed probe on the development PC. Claude, OpenAI API and compatible-provider protocols have automated checks, but no user API-key account was used for this release. A completion test proves that message exchange; voice, tools and feature-generation have separate outcomes. A failed provider does not silently switch to another.

Windows API keys are encrypted with **DPAPI for the current Windows user**, bound to their provider and endpoint. The browser receives redacted metadata such as whether a key exists; keys are never saved in browser storage or returned by the provider list. Changing a provider or endpoint requires re-entering its saved key. On other operating systems, this implementation keeps keys in server memory, so they must be entered again after a restart.

## Add a missing feature

**Build a feature** is an actual coding workflow, not a promise that a requested feature already exists:

1. Describe the behavior and what should count as working. Companion starts a persisted build job using the selected AI.
2. The builder reads allowed application source and generates complete changed files in a separate candidate copy. Private runtime data and credentials are excluded.
3. It runs fixed syntax, regression, registration, and applicable feature checks. A generated candidate that fails a check gets one bounded correction using the same request, source baseline and initial acceptance checks. **Attempt history** retains both diffs and check reports. External patches are not automatically rewritten. [Build correction](docs/BUILD_CORRECTION.md) explains the limits and recovery.
4. Passing routine frontend changes may activate automatically when that option is enabled. Protected controls, backend/launcher changes, and file deletions require review of the concrete diff and an **Activate feature** action.
5. Activation checks that the source has not changed since the candidate was prepared. **Roll back changes** restores the retained version when the affected files have not subsequently changed.
6. If the build came from a chat/voice task, wait for **Continue original request**, then choose it explicitly. **Open work** shows its actual result and partial receipts. A direct build-form request or external patch changes source without creating a linked task to finish.

An installed browser panel alone does not make a function callable by the AI. Follow-through waits for the required tool, exact source and loaded runtime. If the original AI configuration, project grant or selected window is unavailable, the continuation stops with a reason. A lost acknowledgement offers **Check continuation**, which reads its saved ID without resending the task. A confirmed pre-admission Ready check permits a new deliberate Continue with that same ID.

Ask “What failed in that build?” to inspect its actual checks through chat or voice. Companion can read a selected build's original request, changed paths, and bounded diagnostics. Ask it to fix the failure to start a focused correction; asking for status alone does not request another build. An applied entry records build history, while current source and runtime availability still need separate verification.

New registered panels can appear in the running workspace. **Reload interface** picks up other browser-source changes. The normal launcher now owns a replaceable service host and worker. Reviewed server changes restart both after the activation response, loading updated parent dependencies as well as worker code. The page verifies new host/worker identities and restores the saved workspace before reporting success. Settings offers **Restart Companion service** for the same full restart. An uncertain acknowledgement offers observation of the original restart, never another automatic request.

If an activated update fails startup, the launcher can use its retained trusted recovery code to restore that build's source backup and start the previous version once. Conflicting edits, failed restoration or unconfirmed shutdown require review; a second service is not started against uncertain ownership. The small control kernel (`runtime-supervisor.mjs` and `runtime-host-entry.mjs`) itself needs **Stop Companion.cmd**, then **Start Companion.cmd**. A legacy direct host must be stopped with **Ctrl+C** first. Restarting the worker or reloading the page cannot load launcher-control changes. Recovery markers survive an owner's disappearance and are never silently removed to force a launch.

Checks do not establish every interaction's correctness. Review the resulting behavior, and keep a useful feature's acceptance test with its source. A failed or conflicting candidate is reported as such rather than described as installed. The builder does not publish to GitHub automatically.

[Feature and extension contracts](docs/EXTENSIONS.md) explain editable source, protected controls, verification, runtime panels, and rollback. [External AI / MCP integration](docs/MCP.md) explains how another AI client can inspect source, submit a patch, and use the same verification and activation flow. **Settings → Connect AI tools** provides copyable client configuration using this server’s actual Node path and loopback address. Connecting an external client still requires its configuration; the app's microphone does not automatically send messages into an already open Codex conversation.

## Voice

Enable voice once to grant microphone access. The voice session detects speech locally, waits for a short pause, and submits that utterance. Quiet periods are not submitted. Each spoken segment is bounded; the mic pauses during transcription, reasoning, and read-aloud. Listening stops when the app is hidden or you turn it off. A remembered opt-in can resume on a visible app only when microphone permission is already granted; it never silently opens a new permission prompt. This is speech detection, not wake-word recognition or validated speech interruption during an AI reply.

**Read aloud** uses only a device voice marked as local. The first Enable voice action may enable it when a local voice exists and no previous preference was chosen. When none is available, open **Chat** to read the reply. Chat also retains the manual microphone and typing fallback. Never treat a visible ready indicator or synthetic audio tests as proof of a particular person's microphone behavior.

Voice transcription uses the separate local speech service, independently of the selected chat provider. The launcher can start the already installed local services on this PC. Typed messages, direct task/note editing, and workflows remain available when voice is not ready. The [legacy local setup guide](docs/LEGACY_READER.md) contains the existing Ollama and Whisper installation instructions.

Recordings are processed in memory by Companion's transcription route. A submitted transcript becomes a message to the selected AI. The user reported that basic voice worked. That report does not independently verify the Restart desktop app control or spoken desktop approval. A later normal launcher run independently verified a fresh native launch. Broader device changes, accents, noisy-room behavior, long pauses, and natural interruption still need testing; one successful use does not establish those conditions.

## Data and running locally

The default server data folder is `work/companion-shared`, outside this source checkout. It contains the productivity database, saved conversations and preferences, provider metadata and protected keys, group-room database, and private build history/candidates/backups. Keep the whole folder private and outside Git. Saved tasks, notes, workflows, preferences, recorded conversation turns, and activity survive a server restart. Unsent form drafts remain in the current window.

**Settings → Backup and recovery** creates a downloadable workspace JSON archive of tasks, notes, routines and remembered preferences. Preview a file, then explicitly import chosen tasks/notes/routines as new copies; copied routines start disabled. Current work and action receipts stay in place. Chats, builds, keys, permissions and project files are excluded. [Workspace backups](docs/WORKSPACE_BACKUPS.md) explains exact recovery, privacy and limits. Automatic backups and cross-device synchronization remain unfinished.

For an entire installation file-copy backup, stop the server before copying its full data folder. SQLite can have active sidecar files. DPAPI-protected keys are tied to the Windows user, so migration may require re-entering them. Do not roll a running database back over newer action receipts.

For a foreground development server:

```powershell
npm run shared
```

The command runs the outer launcher, service host and worker with Node’s built-in server and SQLite. **Ctrl+C** stops that foreground launcher and its owned service. `COMPANION_SHARED_DATA_DIR` and `COMPANION_SHARED_PORT` choose another absolute private data folder and port. Use a different folder **and** port for QA; do not populate a real user's workspace with synthetic accounts or test tasks. For a custom folder/port, pass the same `-DataDirectory` and `-Port` to `scripts/stop-shared.ps1`; the root Stop command uses the default workspace.

```powershell
npm test
npm run check
```

The 0.24 update passed **952 Node tests** and **76 source syntax checks**. Actual Windows/HTTP/browser checks searched 1,208 synthetic files, continued empty pages and opened the exact observed Unicode file. Search, Stop, drafts and compacted evidence have separate checks; all rows across twelve existing primary tables are preserved. A real GPT build selected the focused editor, changed actual code and added a passing UI test on its first attempt, then stopped at protected review without activation. [QA.md](QA.md) records the exact evidence and remaining human picker, native Save-dialog and broader voice/desktop checks.

The 0.23 update passed **901 Node tests** and **74 source syntax checks**. The routine editor and reusable interface fixture support focused complete-source edits without replacing the large main interface. An isolated deterministic-provider build failed its new UI assertion, corrected once within the unchanged context limits, and retained protected review. Original frozen helpers also caught broken UI despite a changed candidate helper. Its rollout preserved all rows across twelve existing tables; the white canvas and real editor were inspected. A later explicitly approved real GPT build passed against that published source and remained unactivated. [QA.md](QA.md) separates that evidence from the native Save dialog, which remains pending.

The 0.22 update passed **898 Node tests** and **73 source syntax checks**. Real GPT explained a past failure using original run receipts without repeating effects; browser and restart checks preserved original names, nested partial results and truthful legacy times. Exact voice-navigation aliases have integration checks. Its primary rollout preserved eleven original productivity tables. [QA.md](QA.md) records concrete evidence and the separate native Save-dialog check still pending.

The 0.21 update passed **853 Node tests** and **71 source syntax checks**. Actual browser download, selected-copy recovery, disabled routines and restart persistence were verified in an isolated workspace. Its primary rollout preserved existing workspace content and receipts, including a new real conversation message received during the update. The user also reported that enabling voice once, then speaking without tapping the mic again, produced an answer aloud. The native download predicate is tested; loading it into the existing desktop shell and an actual Save-dialog check remain separate work.

The 0.20 update passed **806 Node tests** and **69 source syntax checks**. Real GPT saved a calendar deadline and an explicitly chosen precise time. Browser checks verified dates, named-zone display, repeated-hour choice, clearing and filter counts; restart preserved all five isolated test tasks.

The 0.19 update passed **745 Node tests** and **67 source syntax checks**. Real GPT edited one existing paused routine without duplicating or running it. The actual browser renamed, enabled, ran and disabled it; a service restart preserved its exact state and single note. Its rollout preserved all eight original productivity tables.

The 0.18 update passed **713 Node tests** and **66 source syntax checks**. Real GPT and local Ollama completion tests passed through Settings in an isolated app; reload and service restart preserved their original results without another model request. The desktop corner and its own restart control were inspected, and narrow connection cards now put actions below readable details.

The 0.17 update passed **656 Node tests** and **64 source syntax checks**. In an isolated app, a seeded failing duration tool received one real GPT correction, passed its unchanged acceptance cases, ran through GPT after reviewed activation, and rolled back to all 156 original source files. The first failure remains inspectable.

The 0.16 update passed **623 Node tests** and **62 source syntax checks**. In a separate test app, real GPT built a missing Task fit tool, its reviewed activation loaded a fresh service, and **Continue original request** ran that tool and saved the exact result. Retrying and restarting preserved one completed Work job and single notes.

The 0.15 update passed 529 Node tests and 55 JavaScript syntax checks. Live browser, GPT and MCP checks saved and undid real synthetic text files while preserving BOM, emoji and CRLF. The source-builder regression baseline also passed without activation. [QA.md](QA.md) records exact recovery checks and the human picker, physical-voice and Electron checks still outstanding.

The 0.13 update passed 442 Node tests and 47 JavaScript syntax checks. A real external Codex client used Companion's MCP tools to read exact source pages and submit a working Checklist panel in an isolated test app. An initial failed check stopped activation; a corrected build passed, ran through actual browser controls, and rolled back to the complete original source.

The 0.12 update passed 431 Node tests and 46 JavaScript syntax checks. Real GPT ran two note-saving jobs while a separate foreground chat remained usable. A real MCP client handed off another job, and browser checks exercised handoff, job Stop, saved conversation access and progress. Exact retries and a managed restart preserved results without duplicate effects.

The 0.9.1 checkpoint passed 320 Node tests and 39 JavaScript syntax checks. Real GPT inspected a retained failed build, read its complete original request through paged inspection, and generated a Project board candidate that passed its nine builder checks plus four independent fixture checks. It remains awaiting protected-code activation in the isolated test app. Source planning now fits complete reference files within measured fixed context limits, with one bounded re-selection. Build headings stay concise while the full request remains expandable. See QA.md for live outcomes and remaining generated-feature checks.

The 0.9 checkpoint passed 300 Node tests and 39 JavaScript syntax checks. Real GPT, MCP, an actual panel and a saved workflow used one isolated synthetic capability through the same executor. Exact edited-workflow retries did not execute newly appended steps. Check last run retains the original run ID after a lost response, including after reload, and requires an explicit click. Global Stop also reaches direct tool and workflow requests. See QA.md for the distinction between fixture, live, and generated-feature evidence.

The 0.8 checkpoint passed 255 Node tests and 34 JavaScript syntax checks. Real GPT conversation continuity and preference saving, Memory archive/restore, managed restart persistence, the white browser/native canvas, and the expanded trusted builder baseline were checked separately. Automatic speech detection still needs a human microphone check; its capture and integration tests use fake media.

The 0.7 checkpoint passed all 201 Node tests, 33 JavaScript syntax checks, and the PowerShell parser checks. The automated suites cover the persistent store and real tools, provider protocols and credentials, source builds and rollback, runtime lifecycle, local API boundaries, and the preserved reader/group core. Live Codex requests created real tasks and notes, a saved workflow executed two steps, and the same workspace survived restart. A real Codex-generated time-zone panel passed five checks, activated and ran in an isolated source copy, then rolled back and disappeared from that copy’s UI. Managed worker restart and browser reconnection also passed live checks. The native corner and a real GPT app-search/open-Calculator chain were checked separately. A real GPT-prepared Notepad text action completed after human button approval, and the exact synthetic text was observed in Notepad. Basic voice success was user-reported. A normal native launch showed the new white-outline corner, and a physical global Stop cancelled a pending Notepad action without changing the editor text. [QA.md](QA.md) records these outcomes separately from mock/synthetic tests and lists the remaining live account and human-voice checks.

The app uses plain HTML/CSS/JavaScript and a local Node server. The original PDF/native reader additionally uses PDF.js and Electron. Packaging the desktop reader does not bundle the local model, speech environment, or workspace server. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Earlier reading tools

The **Reading room** link opens the preserved math reader at `/index.html`; **Group room** opens `/room.html` with its separate accounts and saved discussion history. The group design demo at `/group.html` remains a browser-only simulation. Math is an optional secondary workflow in the current product, not the default workspace.

[Legacy reader and group setup](docs/LEGACY_READER.md) retains detailed native-corner, PDF, local-model, speech, and group instructions. [DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) describes the discussion design. [training/RESULTS.md](training/RESULTS.md) records the rejected LoRA experiment; it was not activated.

[Product direction and requirement evidence](docs/PRODUCT_DIRECTION.md) preserves the full goal, including broader computer control, voice-driven development, external AI connections, and capabilities that remain unfinished. [ROADMAP.md](ROADMAP.md) tracks the implementation without treating today's registered tools as the limit of that goal.
