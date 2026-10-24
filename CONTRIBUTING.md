# Contributing to Companion

Companion explores how a theory reading group can build and check an understanding of a paper. Paper discussion uses reading-room member accounts. Source changes use GitHub pull requests. The repository is a prototype, with no implied University of Washington endorsement.

## Try the current interfaces

Use Node.js **24.15 or newer**; Node 24 LTS is tested. From a checkout:

```powershell
npm run shared
```

Open `http://127.0.0.1:4174/room.html`. A fresh data directory has no pre-created account: create the administrator yourself, then create an invitation for each additional member. The server is loopback-only, so an invitation can be tested in another browser on the same PC. It does not make the room available to colleagues over the internet.

On Windows, `scripts/start-shared.ps1` provides a background launcher. Choose `-DataDirectory` and `-Port` for an isolated QA room. The equivalent server variables are `COMPANION_SHARED_DATA_DIR` and `COMPANION_SHARED_PORT`. Keep account databases and logs outside the source checkout. The foreground server stops with Ctrl+C.

The existing personal Electron reader uses `pnpm start` after dependency/runtime setup. The simulated discussion design remains at `/group.html` through `pnpm preview`. See [README.md](README.md) for the model, voice, and packaged-app setup.

## Contribute a mathematical explanation

Attach a question or contribution to the exact passage it concerns. State the assumptions and distinguish intuition, examples, and proof details. A useful correction identifies the failing step and explains how to repair it, or provides a valid counterexample.

Review another member's current revision and describe what you checked. A review is an attributed mathematical assessment, not formal verification. Use **Helped me** for understanding and a linked resolution summary when the question is addressed. Reopen it with a reason if a new gap appears. Earlier reasoning and review history should remain visible.

The current shared room contains one original sample paper and has no AI connection, paper upload, SSO, or account recovery. Use original material or material you have permission to share when proposing additional examples. Keep private papers, recordings, personal notes, account data, and credentials out of the public repository.

## Contribute source changes

Create a focused branch and pull request that explains the user-visible problem and resulting behavior. Include screenshots for interface changes and the checks you ran. Prefer a small change a reviewer can assess independently.

Before submitting:

```powershell
pnpm install
pnpm test
pnpm check
```

The shared server needs no additional npm server dependencies. Its tests create synthetic accounts in temporary or in-memory SQLite databases; they must never use the configured group database. The shared core and HTTP API currently have 18 tests. Some managed sandboxes need permission for loopback HTTP tests; record an actual failure or skip rather than describing an unrun check as passed.

Preserve these implementation boundaries:

- The server derives authorship and permissions from the authenticated member; operation payloads cannot select an actor or role.
- Changes compare room revisions and retain operation IDs for safe retries. A conflict preserves the draft and requires the member to review the latest state.
- Reviews and resolution links name an exact contribution revision. Edits retain history and require fresh review.
- Render contribution text as text, preserve source context, and keep personal familiarity and notes outside shared-room data.
- Keep the server loopback-only until a remote hosting design is explicitly chosen and implemented.

[DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) explains the workflow, [ROADMAP.md](ROADMAP.md) separates implemented behavior from planned work, and [QA.md](QA.md) records verification and limitations.
