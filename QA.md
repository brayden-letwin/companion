# Prototype verification — 24 October 2026

This records what was actually checked for 0.1.0. It is not a claim that every planned feature is complete.

## Passed

- `pnpm test`: 25 tests covering restricted expression parsing, mathematical precedence/functions, domain errors, discontinuities, source pinning, document changes, cancellation, explicit familiarity, provider validation, and mocked API responses.
- `pnpm check`: renderer, Electron main, and preload syntax.
- Browser UI: sample explanation, changed explanation after selecting “Comfortable” for Cauchy sequences, settings persistence after reload, source-linked note creation and persistence, enlargement, and a 1/x plot with separate branches around zero.
- PDF UI: imported a synthetic three-page PDF, navigated pages, clicked a text run and enlarged its context, and selected a passage on a rotated page. Importing a new document cleared the prior conversation and pinned sample passage.
- Native Electron launch: reader and separate collapsed corner appeared; Ctrl+Alt+Space expanded the corner and showed the accurate disconnected-voice state. The expanded window kept the composer and microphone visible.
- Local preview access checks: source/PDF assets served; hidden files, credentials, Git data, Electron source, traversal, non-GET/HEAD requests, and foreign Host headers denied.
- Windows packaging: created `release/Companion/Companion.exe` with supporting files; source copy matched the tested renderer. Private .env and tests excluded. An existing output directory is refused instead of overwritten.

## Still requires verification

- Real microphone recording, transcription, model access, live answers, and audio playback with user credentials/hardware. Provider tests used mocked transport; no API key was supplied.
- Full native PDF/notes/export flow, native restart persistence, multiple monitors/display scales, and packaged launch outside the development folder.
- Real mathematical PDFs with multi-column layout, dense equations, unusual fonts, or unreadable text. The PDF extractor is not OCR and cannot guarantee correct mathematical reading order.
- Longer interaction sessions and additional accessibility checks.

The Windows folder is an unsigned prototype. Keep its supporting files together. The included reader and local tools are implemented; broad desktop control and external-screen context are not.
