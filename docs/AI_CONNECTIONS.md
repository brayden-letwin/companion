# Check an AI connection

Open **Settings**, save the connection, then choose **Test connection** on its card. Companion sends one small fixed test message to that provider. No chats, notes, files, selected windows or Companion tools are included. It uses the account's normal request allowance.

The card separates availability from an actual answer:

- **Signed in** means the Codex CLI reports a usable sign-in.
- **Model found** means Ollama lists the chosen local model.
- **Configured** means the API connection has saved credentials and settings.
- **Completion test passed** records an actual completed test and its time.

A successful message test does not establish voice, computer actions, tool calls or structured feature-generation support. Those have their own actual outcomes. An unavailable or failed connection does not silently switch to another provider.

Tests are explicit. Saving settings, selecting a connection, opening Settings and reloading the app never send another test message. **Cancel test** and global **Stop** cancel pending tests. A helper that has not closed can remain **Stopping**; an uncertain outcome is not treated as a new opportunity to send the same request.

If the response is lost, **Check test** reads the original saved ID. It does not resubmit. After a confirmed missing record, discard that pending reference before deliberately starting another test. Restart retains unfinished checks as interrupted rather than repeating them.

Every save gives the app configuration a new opaque revision, including API-key replacement. A test retains the original provider, model, endpoint and revision. A settings change stops dependent pending checks and prevents a late old answer from verifying the new settings. Selecting another provider alone does not change its configuration.

Results are dated evidence. After Companion's service restarts, a retained success is historical until a new explicit test. Codex's sign-in and configured default model are managed outside Companion; the card says **CLI default** when no app model override is set. Companion does not read authentication files or claim to fingerprint external credential changes. Test again after changing those external settings.

While Settings is open on the intended selected connection, the exact human command **“test connection”** uses the same explicit check flow. Its provider and configuration revision are captured before microphone permission; changing that selection requires a fresh command. Assistant replies and read-aloud text cannot start a test. This route has automated coverage; live human spoken connection testing remains unverified.

API keys remain in the existing credential manager. Private test history contains only identities, public configuration metadata, status, timestamps and fixed error messages. It stores no generated answer, test marker, user context or key. Browser recovery storage keeps only pending test IDs. Up to 200 checks are retained within a 1 MiB file; the app reports that limit instead of silently deleting uncertain evidence.

## Private backups and older versions

Provider settings live in the private runtime's `providers.json`; the separate `provider-checks.json` contains test history. Keep both out of source patches, GitHub and model prompts. Public configuration metadata can still contain private connection names and endpoints, so treat check history as private too.

Before upgrading, stop Companion normally and retain a private copy of its provider settings with the rest of the runtime backup. Version 0.18 adds a durable random revision to each existing provider before exposing it; migration leaves its protected key bytes unchanged. The settings file remains version 1, but older strict readers reject the new `revision` field. A downgrade therefore needs a matching pre-upgrade settings backup and compatible application/runtime data. Do not delete revision fields, discard uncertain check history or overwrite current private data merely to force an old version to open it. Full-workspace backup/restore and general schema downgrades remain separate work.

On Windows, saved API keys use DPAPI for the current Windows user. A copied settings file alone is not a portable credential backup or a guarantee that another user or machine can unlock its keys; re-enter keys through Settings when needed. On other platforms the current manager retains keys in memory only. These files do not back up the Codex CLI's separately managed sign-in or Ollama's installed models, and Companion does not import their authentication files.

## Local API

The same personal session, exact Origin and CSRF rules protect these routes:

| Route | Behavior |
| --- | --- |
| `POST /api/assistant/provider-checks` | Start one test with `{id,providerId,revision}`. Reusing the same identity reads its receipt; it never starts a replacement. |
| `GET /api/assistant/provider-checks` | Read the latest retained check for each current provider. |
| `GET /api/assistant/provider-checks/:id` | Read that exact saved check, including uncertainty or interruption. |
| `POST /api/assistant/provider-checks/:id/cancel` | Request cancellation with an empty body. |

Provider status includes a separate availability label and the latest `connectionCheck`. Its `configurationMatches`, `observedThisSession`, `completionOnly` and `scope` fields describe the evidence precisely. The model-facing tool catalog cannot start tests. These routes do not create conversations, Work jobs, tasks or notes.

The probe uses the existing provider adapters with a smaller output/deadline budget. API requests follow the official [OpenAI text-generation guide](https://developers.openai.com/api/docs/guides/text?api-mode=responses) and [Claude Messages reference](https://platform.claude.com/docs/en/api/messages/create), retaining Claude's documented [API version header](https://platform.claude.com/docs/en/api/versioning). Codex probe calls apply documented per-call [configuration overrides](https://learn.chatgpt.com/docs/config-file/config-reference) to disable tools and replace project instructions with fixed synthetic instructions in its private job. This is layered configuration and output validation, not OS confinement of arbitrary software.
