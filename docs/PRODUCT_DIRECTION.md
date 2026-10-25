# Product direction and requirement evidence

## The full goal

Companion should be a simple, beautiful personal assistant that understands a spoken intention, helps get useful work done, and grows when it is missing a needed capability. The current accepted direction is **general productivity first**, inspired by Jarvis. It should connect to GPT/Codex, Claude, and other suitable AIs, and let authorized AI tools improve the actual program rather than merely suggesting code in a chat.

The app should stay easy to open and easy to talk to. It should support several things happening at once, show what it is actually doing, and give the user a clear way to stop, inspect, activate, or undo work. Missing features should lead to a real implementation workflow with source changes, checks, and a usable result. A small set of built-in task tools is a starting point, not a reduction of that goal.

Earlier math-reading and University of Washington theory-group requirements remain part of the history. Math is currently secondary. General intended computer actions, voice-driven development, broader AI-client connections, and a native corner assistant remain goals where the present implementation is incomplete.

This document records scope and evidence. It does not grant a model unlimited PC access, create an institutional affiliation, or make a proposed capability an implemented one.

## Requirement history

| Evidence from the design conversation | Requirement preserved |
| --- | --- |
| “itll be in the corner of my screen and I can speak into my mic” and “super simplistic” | A small, calm assistant with a low-effort voice interface. The original native corner is not the same as the current browser workspace. |
| “it follows your mouse and makes intuitive ideas on what you are trying to understand” | Relevant, user-visible context should follow attention where supported. Do not claim to read thought or infer knowledge from pointer movement. |
| “I want to know how something works. How can I understand this?” | Begin with the user's actual question and help them form an intuitive understanding. |
| “it should follow with the amount literacy you already have” | Adapt to explicitly stated familiarity and requested depth. Keep these preferences reviewable. |
| “call it companion” and “control my pc and do want I intend for it to do” | Preserve the Companion brand and the broader intention-to-action goal; internal workspace actions are not full PC control. |
| “can you have a github added to my github for developing this” | A contributable codebase and reviewable development work, with publication separate from merely generating a candidate. |
| The user selected “Adapt an existing model for math” | The local-model experiment should be described accurately; a prompt alias is not training, and a rejected fine-tune must not be silently deployed. |
| “I can talk to it to command you what to do,” followed by the choice “This Codex chat” | Preserve the desired voice-to-existing-development-chat route. The current app's own provider chat does not fulfill that exact bridge. |
| “design an app for the University of Washington theory group to contribute to and help for understanding” | Shared paper discussion and contribution remain an optional product branch, without a claim of university endorsement or sign-in. |
| “design this system using my voice and do many things at the same time” | Voice should support building the system and coordinating work, not only dictating a question to a reader. |
| “make it clear and easy to run” | One clear launcher and concise first steps; no account setup merely to open the personal workspace. |
| Latest accepted steering: general Jarvis-style productivity, attached GPT/Claude/other AIs, self-building missing functions, minimal and beautiful | Make general work and actual program adaptation the main experience. Keep math out of the default workspace while preserving earlier work. |

The one-day “crank this out” target expressed urgency. It is not evidence that the full scope can be declared finished after a smaller prototype runs.

## Current implementation and evidence

| Goal | What exists | Evidence and remaining limits |
| --- | --- | --- |
| Easy launch | `Start Companion.cmd` opens the general Today workspace without a group account. | Configured development-PC workflow; managed worker restart and live UI reconnection passed. Fresh-machine installation and full host-code relaunch still need a polished path. |
| Minimal general workspace | Today, tasks, notes, workflows, build history, and connections in a dark forest theme; compact voice control in the composer. | Real server state with blank initial data, not seeded productivity claims. Wider usability/accessibility testing remains. |
| Real productivity actions | Persistent tasks/notes, focus state, activity, saved workflows, and validated tool execution with receipts. | Store/tools checks pass. Live Codex created a high-priority task and a saved note; both survived restart. A saved workflow completed two real steps. Failed receipts remain visibly failed. |
| GPT / Codex connection | The app uses the installed Codex CLI's existing ChatGPT sign-in and model setting. | CLI readiness and a real completion succeeded on this PC. This does not automatically address this existing Codex conversation. |
| Claude and other providers | OpenAI API, Anthropic API, compatible API, and Ollama adapters; provider/model selection and redacted settings. | Protocol and credential-handling tests exist. No live user-owned Claude, OpenAI API, or custom-provider account has yet been validated. Consumer website sign-ins are not silently imported. |
| Real self-building | Source inventory/context selection, a private candidate, complete changed files, syntax/regression/feature checks, diffs, activation, conflicts, and rollback. | Builder tests pass. A real Codex time-zone feature passed five checks, auto-activated in an isolated copy, ran with a verified DST conversion, then rolled back and left the UI. This is one concrete feature, not proof of every requested capability. |
| Appropriate automatic changes | Passing routine frontend changes may activate when enabled; protected controls and deletions require concrete review and activation. | Existing source remains editable through review. Worker changes can restart under the managed host; changes to that host itself require full relaunch. The current tool registry is not unrestricted dynamic PC access. |
| External AI can improve the app | Local source/build/patch endpoints and an MCP facade use the same candidate/check/review/activation flow. | [MCP.md](MCP.md) describes client configuration. Real external client/account integration needs verification; documentation alone is not a live connection. |
| Voice-led use | Toggle recording, local transcription, optional pause-to-send, local-only device speech, cancellation, and stale-response guards. | Synthetic transcription and frontend media-state checks exist. Human microphone hardware, accents, pauses, noise, and interruption still need testing. |
| Several things at once | Feature builds run as persisted jobs while the workspace remains available; independent saved actions and views can be used. | This is not a completed multi-agent desktop work coordinator or a voice command bridge into the current Codex chat. |
| Broader PC actions | The host performs registered Companion actions. New adapters can be implemented through source changes. | Arbitrary external-window context and broad computer control are not implemented. No claim of sent mail, opened apps, or changed external files should be made without a real tool result. |
| Math and group understanding | The legacy reader/corner, local model, explicit familiarity, plots, PDFs, and local account-based group discussion remain. | Browser-reader context is confined to that reader. Group invitation links are loopback-only; real-paper uploads, remote hosting, university SSO, and account recovery remain open. Mathematical errors were observed. |

Targeted automated results reported during this change include store/tool, model-router/provider, feature-builder, and preserved-core suites. Test counts change as checks are added; [QA.md](../QA.md) should record dated commands and concrete outcomes. Mocks, synthetic media, a ready descriptor, and a successful single completion each establish different things.

## How the assistant should behave

- Keep the main request box simple: “What do you want to get done?” Use context and tools when they are relevant.
- Reuse a working capability before rebuilding it. A missing capability should produce a useful, scoped build request with observable acceptance criteria.
- Ground statements about completed work in actual receipts. Preserve partial results and state when a request fails or is cancelled.
- Keep plans, queued builds, verified candidates, activated code, and working behavior distinct. Show actual progress rather than invented percentages or reasoning logs.
- Preserve the selected provider and request input for the duration of a turn. Do not let navigation or late asynchronous results silently retarget the user's intention.
- Keep keys and private runtime data out of source, prompts, logs, and browser storage. External AI receives only the context deliberately provided through its request/tool workflow.
- Let the user inspect and undo source changes. If later edits prevent a safe rollback, report the conflict rather than overwriting them.
- Add capabilities without turning the interface into an overwhelming dashboard. Registered panels should remain discoverable by navigation and eventually by voice.

## What still makes the full goal incomplete

1. **Live account and client connections.** Claude and optional API providers need user-owned keys and live checks. External Codex/Claude/MCP clients need explicit setup and verified task/build results.
2. **The exact voice-development bridge.** The user asked to speak commands into this existing Codex chat. The present general assistant talks to its own selected provider; that is a useful implementation, but not the same route.
3. **Intended actions beyond Companion.** General computer control, other-app context, calendar/mail/browser/file adapters, and reliable outcome verification need real integrations and permissions.
4. **A dependable adaptive program.** Feature generation needs live acceptance tests, manageable source context, recoverable activation/restart, and long-term maintenance. Automatic ordinary changes alone do not establish reliable self-programming.
5. **Everyday voice and multitasking.** Human voice, interruption, native corner/tray behavior, global controls, longer sessions, and coordinating independent jobs need product validation.
6. **Distribution and durable operation.** Installation, signing/updates, backup/restore, migration, remote access where desired, and operational recovery are unfinished.
7. **The earlier collaboration branch.** Remote theory-group use needs hosting, real papers, source permissions/anchors, membership/recovery decisions, and group testing.

Do not mark the overall product complete because tasks, notes, a provider adapter, or a source-patching API works. Those are concrete advances toward the full intention.

## Where to continue

- [README.md](../README.md): current user workflow and running instructions.
- [ROADMAP.md](../ROADMAP.md): implemented foundation and remaining work.
- [EXTENSIONS.md](EXTENSIONS.md): actual source-change and runtime-panel contracts.
- [MCP.md](MCP.md): external AI client integration.
- [LEGACY_READER.md](LEGACY_READER.md): optional math reader, native corner, local speech/model setup, and group reference.
- [DESIGN.md](../DESIGN.md) and [DISCUSSION_FLOW.md](../DISCUSSION_FLOW.md): original reading and collaboration design history.
