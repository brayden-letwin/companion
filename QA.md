# Prototype verification — 24 October 2026

## General productivity workspace and source-building assistant (0.6.0)

These checks used disposable workspace data and an isolated source copy where noted. They did not create a human reading-group account, record a human microphone, or enter a user API key.

### Live Codex actions and persistence

- The installed Codex CLI detected its existing ChatGPT sign-in. A real completion succeeded in about three seconds; this is a single observation, not a latency guarantee.
- A real Codex chat request created the high-priority task “Review Companion productivity flow” and the exact “QA scratch” note. Actual tool receipts and server state matched the requested changes.
- The QA workspace survived moving the server from port 4190 to 4192 with the same private data directory. The task and note remained saved after restart.
- The UI saved “QA morning reset” with a create-task step and a save-note step. Running it reported both actual completed steps; task and note counts each advanced from one to two. The persisted state held revision 5, two tasks, two notes, and one workflow.

### Real generated feature, UI behavior, and rollback

- The first live Codex feature attempt selected relevant source in about 14 seconds, then hit the former 180-second generation timeout. It did not activate a feature. Build generation was given a separate 600-second budget before retrying.
- The retry, job `01d0c1ec-cf9b-4691-8cfe-8d4403f2fa2f`, generated actual time-zone module/registration/test source in an isolated application copy. All five recorded checks passed, and the routine feature auto-activated. This was generated source, not a prefilled example panel or a mocked model response.
- On the isolated UI at port 4193, the registered Timezones module mounted and its live clock advanced. Setting UTC to `2026-03-08T10:00` through normal picker input events displayed Seattle `03:00 · UTC−07` and London `10:00 · UTC+00`, including the Seattle daylight-saving transition. The browser automation's raw value fill alone did not trigger input; a normal arrow-key input event did, and the rendered result was checked.
- The same builder job was rolled back through its real rollback operation. Its status became `rolled_back`, the previous manifest was restored, and a browser reload removed the Timezones navigation entry and module. The QA feature was checked in that disposable copy, not silently installed into the user's primary source checkout.

### Managed runtime and frontend state

- Managed HTTP restart on QA port 4192 replaced worker 40776 with 26688 while host 35376 remained. The workspace kept revision 5, two tasks, two notes, and one workflow.
- The live Settings restart then replaced worker 26688 with 14860. The page displayed “Companion restarted and reconnected,” and the provider selector, microphone, and send controls re-enabled. A refresh-button disabled-state oversight found during that check was repaired. A second live browser restart with the final UI confirmed that Refresh connections also re-enabled.
- Targeted VM checks against the actual frontend, using fake DOM/network/media objects, passed for exact receipt retry after a lost save response, failed-tool labels, selected full build-detail loading, provider capture before microphone permission, late track cleanup, PID-change-only restart confirmation, standalone restart instructions, supervisor rollback wording, preserved unsent drafts, and clipboard writes only after an explicit MCP Copy click. These checks did not use a microphone or account credentials.
- Settings offers copyable MCP configuration rather than claiming a client is already connected. Its configuration uses actual server-provided Node/script paths and validates the optional loopback `COMPANION_URL`; workspace-action counts are not presented as the count of MCP wrapper tools. Real external-client setup is still separate verification.

### Automated run and remaining checks

The final combined run passed **166 of 166 Node tests**, and all **30 JavaScript syntax checks** passed. The preceding run exposed a stale health-version assertion after the move to 0.6; it was updated before this final run. The runtime child-process IPC error race was also fixed before final verification. Automated store/tool, model-router, builder, MCP, runtime, and preserved-core results remain distinct from live account/UI evidence.

The normal launcher was then used with `-NoOpen` to start the managed host on the main local port 4174 after backing up its existing private data. Codex and local speech both reported ready. This confirms configured-PC launch/readiness; it does not establish human microphone capture or live Claude credentials.

The live main workspace was visually checked at 1280 × 720 and in the narrow side panel; the composer and navigation remained available. A local overview screenshot was saved outside this public source tree. The user chose to continue with GPT and defer Claude credentials; no Claude key/account has been provided for live validation. OpenAI API and custom-provider accounts, human microphone behavior, offline voice playback, longer sessions, arbitrary PC control, and a voice bridge into this existing Codex conversation remain unverified or unimplemented as described in the product direction.

## Personal assistant workspace (0.5.0)

- All 85 Node tests pass, with no skips. Seven new command/source-map tests cover conservative action parsing, source snapshots, exact-source history, local note search, and the distinction between authored sample links and unlinked imported passages. Nine new HTTP tests cover independent personal sessions, group isolation, Origin/CSRF checks, input limits, cancellation, disconnects, timeouts, concurrency, and static-file restrictions.
- Live browser checks on a separate QA server: select Completeness and obtain an actual local-model answer; command a plot of x² on [−3,3]; save the captured passage and search it; set explicit Cauchy familiarity; cancel a live request immediately. The canceled request left no late answer in the conversation.
- Imported the existing synthetic three-page PDF fixture, navigated to page 2, and selected a text line. Its source card kept the exact text, PDF name, and page. The graph showed selected PDF passages without fabricated concept edges.
- At 1280 × 720, the workspace has no horizontal overflow and the composer ends at y=682. Browser rendering and cancellation were checked; microphone recording and read-aloud were not activated during verification.
- The actual local speech API transcribed computer-generated speech exactly as “Companion, explain why completeness matters.” in 371 ms. No human microphone was recorded. A real local-model question returned in 6.7 seconds. These are individual observations, not benchmarks.
- The model's mathematical quality remains a material limitation. One answer incorrectly attributed convergence to the definition of a contraction; another described approaching a limit as reaching it and ignored the requested sentence count. General prompt clarifications did not establish reliability: subsequent original checks still gave wrong incomplete-domain and missing-hypothesis answers, while a geometric-tail explanation was correct. Some answers still emit raw LaTeX. Generated explanations are labeled AI drafts, with their exact source attached.
- Independent frontend review found and repaired source capture around microphone permission, explicit empty voice context, PDF import supersession, and return-to-sample lifecycle issues. Review used fake media objects rather than recording a microphone.
- Browser navigation to the shared room and Back left the assistant usable, with saved familiarity retained. Compact navigation now keeps explicit accessible labels and a PDF import control. The local server was upgraded to 0.5 after a private backup of the existing reading-room database; its first-run state was retained. The main launcher started or reused local AI and speech successfully. A separate Windows 0.5 folder was packaged; the new primary workspace runs through the browser server.

Human microphone permission/capture, automatic turn ending in different noise conditions, device changes, offline voice playback, and longer browser sessions remain to be tested. Commands operate within Companion; arbitrary PC control, wake words, autonomous background work, learned knowledge graphs, and external integrations are not implemented.

## Shared local reading room (0.4.0)

- Simplified launch: the repository's `Start Companion.cmd` and the configured output folder's `Open Companion.cmd` open the same room. A cold start and repeated launch passed against a separate disposable room on port 4186; only that test server was stopped. The launcher finds the installed Node runtime and gives a direct install instruction when none is available.
- The first-run screen now has three steps, plain account instructions, and reopening guidance. Verified on the current 731 × 1244 browser pane: no horizontal overflow and the setup button is visible. No account fields were filled or submitted during this check.
- All 69 Node tests pass on Node 24.19.0, with no skips. The 18 new shared-room tests cover trusted membership, revision-specific reviews and resolutions, authorization, atomic conflicts, duplicate-request receipts, invite races, validation, session isolation, restart persistence, and loopback/static-file restrictions.
- Live browser testing used two synthetic accounts in a disposable database on port 4175. A passage question and another member's explanation appeared across independent browser sessions. The author's private draft survived incoming changes.
- Editing a contribution while a review was open disabled submission and preserved the review draft. A fresh review of r2 saved successfully. “Helped me,” a linked resolution, and another member's reasoned reopening remained separate records; the history retained the earlier resolution and its exact supporting revision.
- Same-document invitation navigation now switches an anonymous tab to Join and clears the earlier password input. Signing out in a second tab clears the first tab's private draft and visible discussion.
- Syntax checks and PowerShell parsing pass. The Windows 0.4.0 folder was packaged locally; it opens the shared room in a browser through a fixed loopback URL. The server and Node runtime remain separate from that folder. This build was not subjected to a new full native-window interaction test.
- The real pilot server on port 4174 was started with an untouched first-run database. No human account, password, or university identity was created during verification.

This is a local pilot with one original sample paper. Remote hosting, university sign-in, account recovery, real-paper group uploads, shared AI responses, group microphone capture, broader responsive/accessibility testing, and production operations remain future work. The 0.3 design demo remains a separate simulation.

## Group discussion design update (0.3.0)

- 51 Node tests pass, including six new discussion state tests: passage anchors, review/understanding separation, author constraints in the simulation, revision invalidation, retained resolution/reopen history, event limits, and malformed local data rejection. Renderer/main/preload/preview syntax passes.
- Browser flow checked: create a question on a selected passage, contribute an explanation, review a particular revision with a scope note, mark it helpful, resolve with a linked contribution and summary, reopen with a reason, and inspect the earlier resolution in history.
- Editing the contribution produced an unreviewed r2, cleared the earlier helpful mark, and preserved the r1 text and review in history. New questions and contributions persisted after reload.
- Drafts stayed with their question and simulated participant when switching. Automatically selected threads keep the matching passage highlighted.
- At a 1280 × 720 browser viewport, the final layout has no page overflow; the contribution composer ends at y=697 and the question list shows both seeded questions. The paper and discussion scroll independently.
- Independent code review checked safe text rendering, one separate group storage key, no network requests, no reads of personal familiarity/notes, and explicit simulated-participant / prepared AI-style labels. The native group window has no preload bridge or microphone/model privileges.

This records the separate interactive design demo on one device. It does not use the real accounts or synchronized server state added in 0.4. Real-paper source anchoring and group voice drafting are not implemented. Broader responsive and accessibility checks remain. The personal Companion microphone and this Codex chat's dictation are separate input routes; no command bridge or global Codex voice shortcut was added.

## Local AI update (0.2.0)

- 45 Node tests pass, including local model verification, independent speech readiness, cancellation before prompt dispatch, stale response suppression, redirect refusal, output bounds, WebM compatibility, and held-out training families. Syntax and PowerShell parsing pass.
- Ollama 0.40.11 runs on loopback with cloud disabled. The downloaded Qwen3.5-4B GGUF is configured as `companion-math`; this alias is a prompt/configuration, not a fine-tune. RTX 4070, 12 GB VRAM, 32 GB RAM.
- Three original passage questions completed through the actual provider. First model load plus answer: 52.9 seconds; two warm answers: 2.2 and 2.5 seconds. These are individual observations, not a benchmark or a latency guarantee.
- Mathematical review: it explained the role of completeness and correctly rejected continuity implying differentiability for |x| at zero. It identified the missing closedness hypothesis for a sequence limit, but its example `1 - 1/n` in `(0,1)` incorrectly claimed membership for every n (n=1 gives 0). It also exceeded requested brevity and sometimes emitted raw LaTeX. Treat explanations as material to check, not verified proofs.
- The local teaching prompt was subsequently shortened to prioritize the requested length, plain text, and explicit assumptions. A follow-up request for exactly two sentences produced two sentences in 0.83 seconds. This single check supports the brevity adjustment, not a general mathematical accuracy claim.
- Offline faster-whisper base.en (CPU int8) passed 14 helper checks, including WAV and WebM/Opus transcription of computer-generated speech, silence, malformed audio, decoded duration, byte limits, and Host/Origin rejection. The synthetic sentence was “Why is every convergent sequence bounded?” No user microphone was recorded.
- A new unpacked Windows build was created at `release/Companion-0.2.0`; 641 files, 390.2 MiB. Model weights and the isolated speech runtime remain external. The launcher refuses an existing Companion instance so it cannot silently retain a previous cloud configuration.
- The combined launcher started the packaged app with both services already running; the separate native corner appeared. A second launch correctly refused the existing instance. The real local provider also transcribed the generated WAV with the expected sentence. Further native UI interaction was interrupted by ongoing desktop input, so no end-to-end microphone claim is made.

Actual microphone capture, read-aloud, broader mathematical evaluation, and long-session reliability still need user hardware testing. Local service tests do not establish transcription quality for every accent, equation, or paper. The separate training pilot has its own manifest and before/after evaluation; a training loss alone is not evidence of better explanations.

The Qwen3.5-2B BF16 LoRA pilot completed 12 optimizer steps on 24 original examples in 90.52 seconds. Saved adapter tensors verify actual parameter updates. Eight paired questions revealed serious mathematical regressions, so the adapter was rejected and not activated. See [training/RESULTS.md](training/RESULTS.md) and its public paired outputs. The app retains the separately tested 4B base model.

## Earlier prototype (0.1.0)

This records what was actually checked for 0.1.0. It is not a claim that every planned feature is complete.

## Passed

- `pnpm test` on Node 24: 29 tests covering restricted expression parsing, mathematical precedence/functions, domain errors, discontinuities, source pinning, document changes, cancellation, explicit familiarity, provider validation, mocked API responses, and PDF task ownership. Four PDF lifecycle tests skip when Node lacks registerHooks (before 22.15).
- `pnpm check`: renderer, Electron main, and preload syntax.
- Browser UI: sample explanation, changed explanation after selecting “Comfortable” for Cauchy sequences, settings persistence after reload, source-linked note creation and persistence, enlargement, and a 1/x plot with separate branches around zero.
- PDF UI: imported a synthetic three-page PDF, navigated pages, clicked a text run and enlarged its context, and selected a passage on a rotated page. Importing a new document cleared the prior conversation and pinned sample passage. Returning to the sample and reopening worked; rejecting a 21-page PDF preserved the previous valid document.
- Native Electron launch: reader and separate collapsed corner appeared; Ctrl+Alt+Space expanded the corner and showed the accurate disconnected-voice state. The expanded window kept the composer and microphone visible.
- Local preview access checks: source/PDF assets served; hidden files, credentials, Git data, Electron source, traversal, non-GET/HEAD requests, and foreign Host headers denied.
- Windows packaging: created `release/Companion/Companion.exe` with supporting files; source copy matched the tested renderer. Private .env and tests excluded. An existing output directory is refused instead of overwritten.

## Still requires verification

- Real microphone recording, transcription, model access, live answers, and audio playback with user credentials/hardware. Provider tests used mocked transport; no API key was supplied.
- Full native PDF/notes/export flow, native restart persistence, multiple monitors/display scales, and packaged launch outside the development folder.
- Real mathematical PDFs with multi-column layout, dense equations, unusual fonts, or unreadable text. The PDF extractor is not OCR and cannot guarantee correct mathematical reading order.
- Longer interaction sessions and additional accessibility checks.

The Windows folder is an unsigned prototype. Keep its supporting files together. The included reader and local tools are implemented; broad desktop control and external-screen context are not.
