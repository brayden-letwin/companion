# Prototype verification — 24 October 2026

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
