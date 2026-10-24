# Companion

A small, math-focused desktop assistant that follows what you point at, listens to your questions, explains ideas using mathematics you already know, and performs supported math tasks.

**Status: design stage. There is no running desktop application yet.** This repository starts with the product design and development plan. Any interface preview uses prepared responses; it does not provide live microphone input, AI reasoning, screen capture, or PC control.

## The experience

- A minimal, always-on-top companion in the corner of your screen.
- Voice questions and short spoken answers, with optional equations and text.
- Cursor context that preserves the passage you meant when you move to the microphone.
- Explanations adapted to your explicitly stated familiarity with individual mathematical concepts.
- Math actions such as finding a definition, enlarging an equation, plotting a function, and saving a source-linked note.
- Clear action outcomes, cancellation, and corrections such as “No, I mean…” or “I know that part.”

Companion uses speech, the selected passage, and conversation to interpret a task. It does not treat hovering as permission to act or as evidence of mathematical ability.

## Start here

- [Product design and implementation contract](DESIGN.md)
- [Development roadmap and acceptance checks](ROADMAP.md)

The proposed stack is **Electron + TypeScript**, with a small HTML/CSS interface, application-owned desktop and math tools, and a speech-to-text → reasoning → speech pipeline. Dependencies and executable setup commands will be added with the implementation.

## First prototype

The initial target is Windows, one display, one short PDF, and a fixed user-selected reading area. Moving or resizing the PDF viewer requires selecting the area again. The first build uses toggle-to-talk and supports three action families: source navigation, simple single-variable plots, and Companion-owned notes.

The planning estimate is **8–10 focused engineering hours**, assuming working API access, a microphone, internet access, and a suitable test paper. This is a target, not a delivery guarantee. Capture accuracy and the first end-to-end action must be validated early; the added action scope leaves little buffer.

Notebook editing, symbolic algebra, continuous voice, and broad control of other applications are later integrations. Automatic generated suggestions are a stretch item for the first build.

## Development principles

- Keep the corner interface small; open source views or plots only when needed.
- Freeze the paper target for each question and reject stale results.
- Store persistent familiarity only from explicit user statements; allow review and deletion.
- Validate math-tool arguments and inspect outcomes before announcing success.
- Keep source documents as evidence, never instructions to control the computer.
- Keep credentials, recordings, screenshots, and private reading material out of version control.

See the design document for the detailed boundaries, data contracts, and test scenarios.

