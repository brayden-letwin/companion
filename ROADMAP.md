# Companion roadmap

Companion's current direction is a minimal general productivity assistant in the spirit of Jarvis: talk to it, get real work done, and let it build missing capabilities. The earlier math reader and group discussion work remain available as optional views.

[README.md](README.md) explains the running app. [docs/PRODUCT_DIRECTION.md](docs/PRODUCT_DIRECTION.md) preserves the full requirement history and distinguishes implementation from evidence. An implemented item below is not a declaration that every live provider, human voice, operating condition, or original goal has been validated.

## Implemented foundation

- [x] One Windows launcher prefers the installed native corner, with browser fallback and no group account.
- [x] Native compact/expanded views, named window controls, tray and actual global-shortcut availability, plus own-app relaunch.
- [x] Scoped Windows app search/open, window list/focus/read, frozen input proposals, explicit human review, and real receipts.
- [x] Exact local human voice/typed approval bound to the current preview; model output cannot approve actions.
- [x] Persistent tasks, notes, workflows, activity, and visible focus state, with functional views retained behind a minimal main experience.
- [x] Almost blank white voice canvas, small bottom tool strip, and hidden Chat fallback.
- [x] Opt-in local speech detection, quiet discard, remembered granted-permission restore, and one capture owner across same-profile app windows.
- [x] Retained conversations shared across Companion windows and MCP clients, revision guards, partial action checkpoints, explicit interruption, and bounded earlier-message pages.
- [x] Reviewable explicitly taught preferences with archiving/reteaching; preferences shape context and never grant action permission.
- [x] Direct task/note editing, completion/reopening, note archiving, and search.
- [x] Full-list task search, exact project filters, priority/due sorting, progressive rendering, and expandable complete instructions.
- [x] Real allowlisted tools read and change the saved workspace; responses carry actual receipts.
- [x] Explicit reusable workflows execute supported actions in order and report completed steps or failure.
- [x] Revision checks preserve drafts; uncertain workspace sends can confirm the same operation receipt.
- [x] Codex integration uses the existing CLI sign-in and configured model.
- [x] GPT API, Claude API, compatible API, and local Ollama adapters with model/provider selection.
- [x] Redacted provider metadata; Windows DPAPI-protected keys outside source; no keys in browser storage.
- [x] Separate local transcription, bounded toggle-to-talk, opt-in pause-to-send, cancellation, and offline read-aloud.
- [x] Feature requests create persisted coding jobs with actual status events, source candidates, hashes, diffs, and check output.
- [x] Voice/chat can inspect selected build diagnostics and page through the complete stored request before requesting a focused correction.
- [x] Source planning measures complete-file context costs and permits one re-selection within fixed byte/message limits before generation.
- [x] Fixed regression checks, bounded source context, module/feature checks, and protected-change review.
- [x] Automatic activation for passing ordinary changes when enabled; explicit activation for protected changes and deletions.
- [x] Source-conflict protection, retained backups, rollback, and interrupted-promotion recovery states.
- [x] Runtime feature registration adds browser panels through the host action API.
- [x] External AI clients have a source/patch/build interface through the local API and MCP facade; connecting and testing each client is separate work.

The app can edit its own application source. It does not instantly acquire arbitrary capabilities merely because a request was accepted. New backend tools require validated source changes, protected review, and a server restart before they can run.

## Verification in progress

- [x] Existing Codex / ChatGPT CLI sign-in detected; a real completion succeeded on the development PC.
- [x] Automated store/tool, model-router/provider, feature-builder, and preserved reader/group suites pass their targeted checks.
- [x] Frontend state checks cover exact retry receipts, failed-tool labels, full detail loading from lightweight build lists, and frozen voice provider selection/cancellation.
- [x] Record live Codex task/note actions and restart persistence, a two-step saved workflow, and a real generated feature’s build/activation/UI/rollback in an isolated copy.
- [x] Verify managed worker PID changes and live UI reconnection with workspace data preserved.
- [ ] Validate Claude with a real user-owned Anthropic API account.
- [ ] Validate OpenAI API and a custom compatible endpoint with real account access.
- [ ] Test the MCP facade from real external Codex and Claude clients; verify their action receipts and source-change lifecycle.
- [x] User reported basic voice success; this does not independently verify native relaunch or spoken approval.
- [x] Real MCP-to-app saved conversation continuity through GPT, reload, and managed restart; real GPT preference save plus Memory archive/restore.
- [ ] Check the new automatic speech-detection mode with human speech; old manual-flow success does not establish it.
- [x] Live native corner bounds/toggle and GPT installed-app search/open-Calculator chain checked on QA.
- [x] Verify real GPT-prepared Notepad text input through frozen preview, human button approval, and actual editor contents.
- [ ] Validate exact human voice approval on a live target.
- [x] Repeat physical global Stop after native reload: pending action cancelled and existing target text unchanged.
- [x] Visually check the neutral white-outline workspace and responsive navigation in the browser.
- [ ] Check device changes, long/noisy recording, pauses, accents, and read-aloud interruption.
- [ ] Exercise longer sessions, multiple tabs, keyboard-only use, Windows scaling, and narrow screens.
- [x] Check a normal native launcher run with a fresh default profile, visible white-outline corner, and ready GPT.
- [ ] Check repeated launch, source-native Settings relaunch, and fresh-machine installation separately.

Provider protocol tests use mocks unless a dated QA entry says otherwise. A saved API key is configuration, not proof that a live account or model can complete requests.

## Next: complete the general assistant loop

- [x] Manage server-worker restarts, bounded recovery, and browser reconnection through the normal launcher.
- [ ] Make full host-code relaunch/migration as clear and recoverable as the worker restart path.
- [x] Expose registered executable capabilities consistently to chat/voice dispatch, workflows, panels, and external AI tools using one catalog and real receipts.
- [x] Pin workflow definitions and custom capability versions; exact terminal retries never execute later appended steps.
- [x] Run concrete registered-capability acceptance cases in guarded children with fixture-only host effects.
- [ ] Add acceptance checks for generated interactions, not just syntax and module loading.
- [ ] Make missing-capability requests produce useful, scoped plans, with progress that reflects actual work.
- [ ] Add project organization and better task scheduling; extend the retained conversation/context foundation where real use needs it.
- [x] Paginated task reads, explicit completeness metadata, complete detail sections, and actual full-set/project counts for larger workspaces.
- [ ] Improve workflow editing and failure recovery while keeping each action's outcome visible.
- [ ] Add export, backup, restore, and migration for productivity data and build history.
- [ ] Keep the main interface simple as new tools are added; test whether people can find and use them by voice.

## Broader original goals remain open

- [x] A small native corner/tray for the general workspace, with registered-shortcut status and global Stop.
- [ ] Validate shortcut conflicts, multi-monitor placement, scaling, and longer native sessions across target PCs.
- [ ] A deliberate voice bridge into an existing Codex development conversation, if the user still wants that exact route.
- [ ] Multiple independent work streams under voice direction, with clear status and retained intent across them.
- [x] Explicit selected-window accessibility reads with snapshot IDs, expiry, and no continuous screen monitoring.
- [ ] Add user-selected screen-region context and broader application coverage without inferring thought from pointer movement.
- [x] Implement scoped Windows actions with target rechecks, input previews, protected-target blocks, and outcome receipts.
- [ ] Validate broader applications and input patterns; generic scoped input is not unrestricted PC control.
- [ ] Calendar, mail, files, browser, and other useful integrations with real account setup and action permissions.
- [ ] Natural interruption and broader continuous voice modes after the current opt-in flow is tested with people.
- [ ] A tested installation, updates, signing, recovery, and distribution path beyond this configured development PC.

These are part of the product direction. Today's local workspace tools do not constitute general PC control, and a generic compatible API setting does not establish that every AI account or product is connected.

## Optional math and group work

The original reader, source selection, explicit familiarity settings, plots, local notes, native corner, and local shared reading room remain separate. Their detailed instructions are in [docs/LEGACY_READER.md](docs/LEGACY_READER.md); [DISCUSSION_FLOW.md](DISCUSSION_FLOW.md) preserves the discussion design.

- [ ] Choose a real group paper and establish source-sharing permissions.
- [ ] Add group paper uploads, source versions, reliable anchors, and source correction.
- [ ] Choose hosting, HTTPS, membership policy, account recovery, and operational backups before remote group use.
- [ ] Test collaboration with actual group members and wider accessibility needs.
- [ ] Add private voice drafting and evaluate whether shared AI drafts help discussion.
- [ ] Improve PDF math context, equation rendering, OCR, and long-paper retrieval if reading returns to the main scope.
- [ ] Evaluate mathematical explanation quality with knowledgeable reviewers before relying on proof claims.

The existing local model made mathematical errors. The separate LoRA pilot saved real adapter weights but failed quality review and was not activated. Those results remain in [training/RESULTS.md](training/RESULTS.md).

The original one-day estimate was a development target, not a delivery guarantee or evidence that the full assistant, computer-control, collaboration, and voice-development goals are complete.
