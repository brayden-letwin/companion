# Companion: understanding a paper together

Workflow and pilot status · 24 October 2026 · First pilot: one paper, one reading group.

Companion helps members turn a confusing passage into a shared explanation they can improve and revisit. The intended audience is the University of Washington theory group; endorsement and discipline are unspecified. Version 0.4 adds real local member accounts, server-saved discussions, and updates between sessions alongside the earlier simulated design demo.

## What the current pilot does

The shared room runs at `http://127.0.0.1:4174/room.html` with Node 24.15 or newer. Its first user creates the group and administrator account; additional members join through one-use, 24-hour invitation links. It supports up to 50 members and the original fixed-point sample paper. Server sessions determine authorship and permissions. SQLite stores the discussion and its history.

The server is local to this PC. People on other computers cannot join until hosting is configured. University sign-in, account recovery, paper uploads, shared-room voice input, and AI answers are not implemented. The `/group.html` design demo remains available with simulated participants and separate browser-only data.

## The discussion flow

1. **Read and point.** Select a passage. Keep its paper version, page, and exact quotation visible. Opening the discussion returns to that passage; a changed source flags the anchor for checking.
2. **Ask privately first.** Type an unfinished question in the shared room, check the attached passage, then choose **Post question**. The form is a private draft until submitted. Voice drafting and transcript preview remain proposed additions. Personal reader notes, familiarity, and AI conversations are not attached automatically.
3. **Build an explanation.** Add an intuition, proof detail, example, counterexample, or clarification. Show author, time, and revision. Keep follow-ups beneath the question.
4. **Check the mathematics.** Review another member's specific contribution revision, naming the checked argument, assumptions, and remaining gaps. Both a positive review and a correction require a scope note. Corrections remain visible. The shared room has no current AI connection; generated-draft provenance remains a requirement for any future AI sharing feature.
5. **Record the understanding.** The question author marks useful contributions **Helped me**. The author or group administrator resolves the question with a short summary linked to an exact contribution revision. Any member can reopen it with a reason. Preserve the earlier resolution.

When someone else changes the room before a submission, update the visible discussion and preserve the draft for an explicit retry. An uncertain send reuses the same operation ID. Editing a contribution starts fresh review and helpfulness status while retaining the earlier text and reviews.

## Keep the signals distinct

| Signal | Meaning |
| --- | --- |
| **Unresolved → Resolved → Reopened** | Whether the question currently has an adequate group summary. Reopening preserves the previous discussion. |
| **Unreviewed / Reviewed / Needs correction** | Review of one contribution revision. Name the reviewer and scope; this is not proof verification. Substantive edits need fresh review. |
| **Helped me** | The question author found an explanation useful. This is separate from whether the mathematical argument has been checked. |

Members edit their own contributions; corrections to others are attributed replies or proposed revisions. Preserve earlier text and reviews. The pilot needs no reputation scores or leaderboard.

## Three short journeys

- **Understand a hypothesis.** A reader selects the completeness step in Companion's original fixed-point sample. A member explains why late terms approaching one another does not guarantee a limit in the space; a proof detail supplies the Cauchy condition. After review, the author marks the explanation helpful and resolves the question.
- **Catch a false step.** Someone claims boundedness implies a sequence is Cauchy. A member counters with `(-1)^n`, whose late terms can remain distance 2 apart. Mark the contribution **Needs correction**, preserve its attributed revision, and reopen any affected resolution.
- **Clarify first.** “Consequently A is positive” lacks a definition of A. Ask for that definition and the intended meaning of “positive.” Keep the question unresolved until context arrives; an AI draft must not invent a proof.

## A small interface

Keep the paper central, with passage markers and a discussion panel: question list, selected discussion, and compact composer. Default to **Unresolved**; offer **All** and **Resolved**. Put a resolution's summary above its supporting discussion. Show authorship, AI provenance, and review beside the relevant text.

Familiarity and private notes stay in the personal reader; the shared room does not import them. Unsubmitted room drafts stay in the page and are not durable storage. The current room records no audio. Share only previewed content and source context; avoid member ability scores. The design demo labels simulated members clearly, while the shared room uses authenticated membership.

## Decisions for the first group pilot

Will members contribute **explanations on papers, the software itself, or both**? Then choose the first actual paper, who can join, and who facilitates summaries and corrections. A remote pilot also needs hosting, HTTPS, backups, and account recovery decisions. These choices can follow the voice-led design session; the local implementation is available for testing now.
