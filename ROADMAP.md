# Companion development roadmap

Companion is now a runnable early Windows prototype. [README.md](README.md) describes setup and current behavior. [DESIGN.md](DESIGN.md) preserves the original vision, including features that remain aspirational.

The original estimate was **8–10 focused engineering hours**, conditional on API access, microphone permission, internet access, and a suitable paper. This was a planning target, not a delivery guarantee or evidence that all original requirements are complete. The implementation uses plain JavaScript ES modules and an included PDF reader to keep the first scope practical.

## Implemented in the prototype

Checked items mean the feature has an implementation. They do not establish that all hardware, live-provider, accessibility, and distribution checks have passed.

- [x] Electron reader and always-on-top corner control: 360 × 82 collapsed, 360 × 520 expanded.
- [x] Open both windows on launch; closing the reader hides it, while closing the corner quits.
- [x] Local PDFs up to 10 MB and 20 pages, with selectable text and page navigation.
- [x] Hover/selection context inside the included reader, retained when moving to the corner.
- [x] Passage pinning when a question starts; cancellation and rejection of stale responses.
- [x] A labeled, prepared walkthrough for the original sample when AI is not configured.
- [x] Reviewable familiarity levels for four concepts, saved locally with a reset control.
- [x] Optional API-backed questions with a configurable reasoning model and no model-operated PC tools.
- [x] Toggle-to-talk, transcription on submission, a 60-second recording limit, and optional device read-aloud.
- [x] Visible cancellation plus global recording and stop shortcuts, with unavailable-shortcut reporting.
- [x] Passage enlargement with paper/page metadata and a six-concept local glossary.
- [x] Single-variable numerical plots through a restricted parser, bounded inputs/sampling, and no `eval`.
- [x] Source-linked localStorage notes, exact duplicate prevention, removal, and Markdown export.
- [x] API credentials in the main process, validated renderer requests, and limited permissions/navigation.
- [x] Local browser preview and automated math, tutor-state, and mocked-provider tests.
- [x] Windows unpacked packaging that excludes private `.env` files and refuses to overwrite an existing build.

## Verification before relying on live use

Provider tests use mocked responses. **Real API calls and native microphone capture are not yet verified with a key and microphone.** Browser preview checks do not establish native voice behavior.

- [ ] Configure a private API key and confirm project access to both models.
- [ ] Submit a real spoken mathematical question; check transcript accuracy, the pinned passage, and the explanation.
- [ ] Check microphone denial/device changes, short recordings, the time limit, API failures, and synthetic voices on the target PC.
- [ ] Verify immediate cancellation during recording, transcription, reasoning, and read-aloud; confirm late results stay suppressed.
- [ ] Evaluate at least three real math passages with a mathematically informed reviewer, including ambiguous notation and a false premise.
- [ ] Check familiarity edits and “simpler” follow-ups without inferring ability from hesitation or pointer behavior.
- [ ] Exercise equations, multiple columns, rotated pages, unreadable text, and page changes in real PDFs.
- [ ] Confirm native reader/corner coordination, keyboard access, shortcuts, and Windows display scaling.
- [ ] Confirm preferences and notes persist after a native restart; inspect a Markdown export and its source metadata.
- [ ] Launch the unpacked build outside the development directory, without credentials and with a private `.env` beside the executable.
- [ ] Record concrete QA results and unresolved failures before describing the build as ready for daily use.

## Next implementation improvements

- [ ] Improve PDF equation context and provide explicit corrections for incorrectly extracted passages.
- [ ] Expand editable concept familiarity and explanation preferences beyond the four initial settings.
- [ ] Add more robust note storage, recovery, and backup behavior.
- [ ] Add validated source navigation and exact reference matching beyond showing the current paper/page.
- [ ] Improve mathematical answer rendering and handling of unsupported action requests.
- [ ] Add targeted integration checks for reader, recording, and cross-window behavior where manual QA reveals risk.
- [ ] Review installer, signing, updates, and dependency maintenance before wider distribution.

## Later product vision

- [ ] External PDF viewer or user-selected screen-region context, with coordinate checks and explicit capture controls.
- [ ] OCR, equation-aware parsing, long-paper retrieval, and LaTeX source import.
- [ ] Optional quiet AI suggestions that do not speak or act merely because the pointer pauses.
- [ ] Continuous voice, natural interruption, and other recording modes.
- [ ] Symbolic algebra with domain-aware checks and richer mathematical diagrams.
- [ ] Tested notebook, LaTeX editor, and other math-application adapters.
- [ ] Broader PC actions with target-window checks, clear intent, verified outcomes, and immediate user takeover.

These are future capabilities. The current app follows text within its own reader and performs its own math actions; it does not watch arbitrary windows or control other programs.
