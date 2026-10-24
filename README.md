# Companion

A small math companion for reading a paper, asking a question, and following the idea at your own pace.

**Status: runnable early Windows prototype.** The app includes an Electron corner control, a PDF reader, local math tools, and an optional live AI connection. Its sample walkthrough uses labeled prepared explanations. Live API calls and native microphone capture still need an end-to-end check with your credentials and microphone.

## Run it

Requires Windows, Node.js **22.12 or newer**, and pnpm. From the repository directory:

```powershell
pnpm install
node node_modules/electron/install.js
pnpm start
```

The explicit Electron installation command downloads the runtime; Electron 45 does not install that binary automatically through a package postinstall hook.

The reader and always-on-top corner window open together. Point to a passage in the sample, expand Companion, and ask a question to try its prepared walkthrough. Use **Open a PDF** for your own paper. Hover over or select its text, then type a question or use the microphone after connecting AI. Starting a question pins its passage; moving to the microphone does not change the target. The × on the context chip releases the pin.

Try `plot x^2`, `define completeness`, `show this larger`, or `save note: My observation`. **Save** keeps an answer or selected passage with its source. **Preferences** sets concept familiarity and optional read-aloud.

| Control | Behavior |
| --- | --- |
| `Ctrl+Alt+Space` | Start recording; press again to submit. Requires live AI. |
| `Ctrl+Alt+Escape` | Immediately stop recording, requests, and speech. |
| Corner header / collapse button | Expand or collapse: 360 × 82 collapsed, 360 × 520 expanded. |
| Close reader | Hide it; reopen using the corner's book button. |
| `Alt+F4` with the corner focused | Quit Companion. |

Global shortcuts depend on availability on your system. Visible microphone and Stop controls are also provided.

## Optional live questions and voice

Copy `.env.example` to `.env` in the repository directory, set your own `OPENAI_API_KEY`, and restart. Keep the file private. Live features require internet access, API credit, and access to the configured models.

The reasoning model defaults to `gpt-6.1-sol`, configurable through `COMPANION_MODEL`. Submitted recordings use `gpt-transcribe`. Recording is toggle-to-talk, with automatic submission at 60 seconds. Spoken “stop” is processed only after submission; use Stop or the shortcut to cancel immediately.

Without a key, the local PDF reader, prepared sample, glossary, plots, preferences, and notes work. Open-ended explanations about imported papers and microphone transcription require live AI. No key is supplied, and real API/microphone behavior has not yet been verified.

## Current scope

- Local PDFs up to **10 MB and 20 pages**, with selectable text and page navigation. Cursor context works inside the included reader. Extracted notation can be imperfect; scanned pages have no OCR.
- Explicit familiarity levels for Cauchy sequences, completeness, geometric series, and metric spaces. Relevant sample walkthroughs use the Cauchy/series settings; live questions receive all four. Hovering does not change your profile.
- A small local glossary, passage enlargement, and single-variable plots using a restricted parser with no `eval`. Use explicit multiplication, such as `2*x`. Graphs are numerical sketches, not proofs.
- Source-linked notes in localStorage, with removal and Markdown export. Export important notes; this prototype is not a backup service.
- Cancellation, stale-response checks, and optional read-aloud using an available device voice.

The current app performs its own math actions. General PC control, following arbitrary external windows, proactive AI suggestions, symbolic algebra, and continuous voice remain future work.

## Development and packaging

The implementation uses **Electron + plain JavaScript ES modules**, HTML/CSS, and PDF.js. This simplifies the original TypeScript proposal for the first prototype. The Electron main process owns the API connection; renderers have no Node integration.

```powershell
pnpm preview  # Browser preview at http://127.0.0.1:4173
pnpm test     # Math, tutor-state, and mocked-provider tests
pnpm check    # Syntax checks
pnpm package  # Windows unpacked app in release/Companion
```

The browser preview supports local tools and PDF reading; live AI and the native corner require Electron. Packaging uses the installed Windows runtime to create `release/Companion/Companion.exe`. Keep the whole output folder together. This is an unsigned development build, not an installer. For live AI, put a private `.env` beside `Companion.exe`, using the included `.env.example`, and restart. The packager excludes your private `.env` and refuses to replace an existing output directory.

## Data and privacy

Opening a PDF and moving the pointer do not upload it. An explicit live question sends the pinned text passage, paper name/page, question, relevant recent conversation, and familiarity settings to OpenAI. Submitting a recording sends its audio for transcription. The app keeps recording data in memory and does not save audio files. Notes and preferences stay in the local profile until removed or exported. Read-aloud uses the device's available speech interface.

Keep credentials, recordings, private papers, screenshots, and personal notes out of this public repository. The included sample text is original demonstration material.

## Design and next steps

[DESIGN.md](DESIGN.md) preserves the original product vision and proposed contracts. Its design-stage status and planned features are historical, not a description of everything implemented today. This README describes the current app; [ROADMAP.md](ROADMAP.md) separates implemented features, remaining verification, and later work. [QA.md](QA.md) records the checks actually performed and their limits.
