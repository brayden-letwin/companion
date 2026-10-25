# Workspace backup and recovery

Open **Settings → Backup and recovery**, then choose **Create workspace backup**. The service reads one consistent workspace snapshot and saves a private JSON archive on this computer. **Download** lets you keep a separate copy wherever your browser or the desktop Save dialog offers. Creating a saved copy does not establish that a download completed.

The archive contains all saved tasks, notes, routines and remembered preferences, including completed, archived and disabled records. It preserves their original content and IDs. Treat this file as private: its text is readable JSON and may contain personal material. Companion does not send it to an AI to create or preview it.

This is a **workspace content backup**. It excludes conversations, action receipts, independent Work, builds/candidates/source rollback, focus timers, activity history, provider connections and keys, folder permissions, desktop approvals, group rooms, and files in connected project folders. Keep those domains' existing recovery records. This feature is not a complete installation backup or device synchronization.

## Recover chosen content

1. Choose a downloaded workspace JSON file. **Preview** validates it and displays what can be recovered; it does not change your workspace.
2. Select up to 100 tasks, notes or routines from the preview. Preferences are visible for reference; teach a preference explicitly to add or change current memory.
3. Choose **Import copies**. Companion checks the current workspace revision and adds the selected items together. It gives each copy a new ID and keeps the current items and recorded action outcomes.

Imported routines start disabled and do not run during recovery. Their steps and custom action version/hash pins must validate against the currently installed tool catalog. An unavailable or changed action needs review/reselection before it can be recovered. An invalid retained deadline is shown as unavailable for copying; recovery does not guess a calendar day or instant. Original values remain in the archive.

Capacity and revision checks are atomic. A full workspace, changed preview, unavailable action or stale workspace revision cannot leave a partly imported selection. Reopen/review the preview after a rejected import. Selecting another file does not retarget an import already submitted.

If an import response is lost, use **Check import** for its original operation ID. That check only reads its durable receipt; it never sends the import again. Browser storage keeps the pending ID rather than archive text, selections or drafts. The original import receipt survives later changes and service restart. A missing receipt is not proof that an in-flight request never committed; inspect the current workspace before deliberately starting a different import.

## Limits and retention

Each archive is bounded to 96 MiB. The private backup area retains at most 20 archives and 256 MiB; delete a saved server copy explicitly when needed. Deleting it does not erase a previously downloaded file or live workspace items. Preview storage is bounded separately; previews expire after 24 hours. Import receipts remain in the productivity database, with a 200-receipt/32 MiB aggregate limit and a 512 KiB individual bound. A limit refuses a new import atomically; receipts are never pruned to make room silently.

Backup/recovery controls are human-facing and absent from model and MCP tool catalogs. They use the local session, same-origin request and CSRF protections. The desktop permits a download only from its registered Companion main frame to the exact local backup endpoint; other downloads remain blocked. A packaged desktop shell needs a rebuild/relaunch to load changed Electron source.

For an entire private installation copy, stop the owning server before copying its full private data directory, including SQLite sidecars and the separate build/project/continuation recovery records. DPAPI-protected keys are Windows-user bound and may require reconnection on another device. Do not replace a running database with an older archive: doing so can lose newer receipts for actions that already happened.
