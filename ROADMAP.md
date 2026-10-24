# Companion development roadmap

This is an implementation checklist. The project is currently at the design stage; unchecked items are not implemented features. The detailed behavior and contracts are in [DESIGN.md](DESIGN.md).

## First-build scope

Windows; one display; one linked short PDF; one fixed reading rectangle; toggle-to-talk; source-aware explanations; explicit concept-level background memory; source navigation, single-variable plots, and notes.

The target is roughly **8–10 focused engineering hours**, with API access, microphone permission, internet access, and a test paper ready. This estimate has little buffer. Reassess it after capture, voice, and action feasibility checks rather than claiming unfinished features are complete.

## 1. Desktop shell and capture feasibility — target 0–1 hour

- [ ] Create the Electron/TypeScript shell with a small draggable, always-on-top corner control.
- [ ] Add PDF selection and a selected reading rectangle on one display.
- [ ] Map cursor coordinates to captured pixels correctly at 100% and 150% Windows scaling.
- [ ] Keep the last valid paper target when the pointer moves onto the microphone.
- [ ] Open a verified page in a Companion source window.
- [ ] Provide a manual recrop fallback and invalidate the target when the reading area changes.

**Gate:** the crop contains the intended equation, and opening a source shows the correct file/page. If continuous targeting is unreliable, label the limitation and use explicit crop selection temporarily.

## 2. Voice conversation and cancellation — target 1–3 hours

- [ ] Implement click/shortcut toggle-to-talk with a visible recording indicator.
- [ ] Capture and freeze the paper context at recording start; submit it with the completed question.
- [ ] Connect transcription, reasoning, and synthesized speech with readable text fallback.
- [ ] Check microphone denial, missing credentials, network errors, and playback failure.
- [ ] Add a visible Stop control, a configurable global stop shortcut, and turn cancellation.
- [ ] Suppress late responses after cancellation or a paper change.

**Gate:** ask a real question about a real paper and receive a useful answer. Immediate cancellation must work through the control/shortcut. Spoken “stop” is processed only after the recording is submitted in this first pipeline.

## 3. Paper context and adaptive explanation — target 3–5 hours

- [ ] Combine the frozen passage image, linked paper, recent dialogue, and relevant background.
- [ ] Validate proposed page/quote references before presenting them as verified.
- [ ] Save explicit concept familiarity and explanation preferences locally.
- [ ] Implement “I know that,” “remember…,” “forget…,” and reviewable background settings.
- [ ] Keep “simpler” local to the current answer unless the user explicitly asks to remember a preference.
- [ ] Ask one short clarification for materially ambiguous context or unreadable notation.

**Gate:** “I know calculus, but metric spaces are new” changes the explanation appropriately. A later correction about Cauchy sequences affects the next answer without resetting unrelated knowledge. Hovering does not change the profile.

## 4. Bounded math actions — target 5–7.5 hours

- [ ] Route requests to answer, clarify, or one validated action.
- [ ] Implement opening a matching source and enlarging the frozen target.
- [ ] Plot a single real-valued expression with a restricted parser, visible domain, and bounded sampling.
- [ ] Handle undefined values and discontinuities without claiming a plot is a proof.
- [ ] Save source-linked notes atomically in the application workspace.
- [ ] Use action IDs/idempotency to avoid duplicate notes on retries; support undo of note creation.
- [ ] Inspect each result before announcing completion.
- [ ] Stop queued actions and show one cancellation summary for changes already completed.

**Gate:** find a definition, plot x² over [−2, 2], and save an explanation. Verify the source, graph values, and saved note. Unknown tools, stale targets, and instructions inside papers must not execute.

## 5. Integration and launchable build — target 7.5–10 hours

- [ ] Check the full flow on at least three representative math questions with a mathematically informed reviewer.
- [ ] Test scrolling, wrong targets, unreadable equations, recropping, cancelled turns, and changed papers.
- [ ] Test profile edits/deletions and note persistence after restart.
- [ ] Check keyboard access and a compact interface at the intended Windows scaling settings.
- [ ] Verify credentials and private artifacts are absent from tracked files and logs.
- [ ] Package a launchable personal Windows build that does not require a development server.
- [ ] Document actual setup steps, measured limitations, and any incomplete checklist items.

**Gate:** the build performs the supported reading and math workflows, reports failures clearly, and starts correctly when credentials are missing. Public distribution/signing is outside this prototype target.

## Stretch items

- [ ] Silent, tentative AI-generated suggestions with a cooldown, cancellation, and caching.
- [ ] Open a resolved mathematical reference in a browser using a verified URL.

If generated suggestions ship, test that disabling them stops their capture/request loop. Otherwise show the local target indicator and on-request help without implying automatic generation is available.

## Later integrations

- [ ] Symbolic algebra with domain-aware verification.
- [ ] Tested adapters for notebooks, LaTeX editors, and other math applications.
- [ ] Broader native mouse/keyboard control with target-window checks and user takeover detection.
- [ ] Moving windows, multiple monitors, and more reliable equation anchors.
- [ ] Continuous speech and natural interruption.
- [ ] Long-paper retrieval, LaTeX source import, and richer mathematical diagrams.
- [ ] Provider/cost tuning, installer signing, and updates.
