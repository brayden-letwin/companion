# Companion: understanding a paper together

Design proposal · 24 October 2026 · First pilot: one paper, one reading group.

Companion helps members turn a confusing passage into a shared explanation they can improve and revisit. The intended audience is the University of Washington theory group; endorsement and discipline are unspecified. Accounts, synchronization, and group review are proposed additions to the personal desktop prototype.

## The discussion flow

1. **Read and point.** Select a passage. Keep its paper version, page, and exact quotation visible. Opening the discussion returns to that passage; a changed source flags the anchor for checking.
2. **Ask privately first.** Type or dictate an unfinished question. Preview and edit the transcript and passage, then choose **Share question**. Personal questions and AI conversations stay private until shared.
3. **Build an explanation.** Add an intuition, proof detail, example, counterexample, or clarification. Show author, time, and revision. Keep follow-ups beneath the question.
4. **Check the mathematics.** Review a specific contribution revision, naming the checked argument, assumptions, and remaining gaps. Corrections remain visible. Generated content retains its **AI draft** label when shared; sharing does not make it reviewed.
5. **Record the understanding.** The question author marks useful contributions **Helped me**. They or a facilitator resolve the question with a short, linked summary. Anyone can reopen it with a reason. Preserve the earlier resolution.

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

Familiarity, private notes, recordings, and unshared drafts stay personal. Share only previewed content and source context; avoid member ability scores. A prototype must label simulated members clearly; real attribution requires authenticated membership.

## Decisions for the first group pilot

Will members contribute **explanations on papers, the software itself, or both**? Then choose the first paper, who can join, and who facilitates summaries and corrections. These decisions can follow the voice-led design session.
