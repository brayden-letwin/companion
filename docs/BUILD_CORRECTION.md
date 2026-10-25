# Correct a failed candidate

An AI-generated feature build can now make **one automatic correction** after its candidate fails an actual verification check. Both candidates belong to the same build and original request. You do not need to repeat the task or start another build to reach that correction.

Open **Build** to see the current attempt and actual stage. **Attempt history** keeps each completed candidate’s diff and checks. Open a report to read it; reading never retries, corrects or activates source. The latest **Changes** and **Checks** describe the current candidate. A failed first attempt remains available when the second passes.

The correction receives the exact original request, the same complete source context, the full failed changed files and explicitly bounded diagnostic excerpts. It returns a complete patch against the original source baseline. Omitted earlier changes revert to that baseline; they do not remain hidden in the final candidate. The implementation cannot silently remove or rewrite its initial feature-test files, discard its registered feature, or weaken its initial capability acceptance cases. Extra acceptance cases and separate tests can be added. If the initial criteria are wrong, inspect them and request a deliberate new build.

The same AI connection and app-configured model/endpoint remain fixed throughout planning, generation and correction. A changed connection or live source conflict stops the job. Complete source and criteria are never clipped to squeeze in a correction: if they do not fit the existing context limits, the build stops with its failed evidence retained. Diagnostic excerpts identify omitted output.

Both attempts run the original trusted regression baseline and ordinary verification in fresh candidates from the same source snapshot. The second attempt has no wider permissions. A passing protected change still needs concrete review and **Activate feature**; installation and **Continue original request** keep their separate readiness rules.

After two failed candidates, the job stops. Planning failures, provider errors, malformed patches, cancellation, source conflicts and external source patches do not cause automatic correction. An external AI client remains responsible for submitting a revised patch with current hashes after inspecting its own failed build. Stop cancels a running correction; restart retains evidence and never resumes it automatically.

Connected clients read the same attempt summaries through `companion_get_build`. Its optional `attempt` number reads one retained full report. Chat/voice can use `inspect_feature_build` with the same optional number for bounded diagnostics. Neither route executes work. Earlier failed evidence is labeled separately from the latest build’s state.

These checks establish the recorded behavior cases and preserved contracts. They do not prove that every possible implementation satisfies a broad request. Review the resulting feature and keep useful acceptance tests with its source.
