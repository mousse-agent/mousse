# P02/P04 profile backend qualification

Branch: `feat/platform-profiles`

This continuation hardens the profile backend after the reviewed production slice. It stays within `src/mms/profiles/**`, `src/shared/profiles/**`, and profile fixtures/tests.

## Migration contract

`ProfileMigrationService.run()` remains resumable by the durable journal. A migration boundary now writes `currentStep` before invoking `beforeStep`, so a crash or injected fault identifies the step that needs replay. Journal JSON, step names, duplicate completion entries, and current-step values are validated before recovery.

`ProfileMigrationService.rollback({ allowCommittedDataLoss?: boolean, clock? })` is the explicit rollback seam. Before a committed manifest it removes only contained staged/promoted profile roots and leaves legacy roots authoritative. After commit it requires `allowCommittedDataLoss: true`, restores the snapshotted legacy `mousse.conf`, removes the generated manifest/profile root, and resets the journal so a later run can migrate again. It never removes installation `auth.json`, provider catalog, repositories, owner, or runtime records.

Migration now inventories and copies a legacy `browser/` root into Default, imports legacy `settings.json` personal selections into Default profile config, and creates the complete profile directory layout including workflow runs, secrets, browser, artifacts, drafts, presentation, MCP OAuth, and generated agent configs. Legacy project `.mousse/.data` and registered Git worktrees remain physically retained with explicit ownership because they cannot be copied as ordinary directories without Git repair.

## Profile deletion recovery

`ProfileHost.remove()` writes an owned marker under `trash/profiles/.pending/` containing the archived record, revision, profile ID, and destination name before forgetting the index entry or moving the root. Startup recovery in `ProfileHost` completes a move interrupted before index cleanup, or safely refuses malformed markers, duplicate roots, active targets, missing roots, and path escapes. The destination and marker are constrained to the installation trash root. `ProfileManager.forgetArchived(ref, revision, fallbackRecord?)` accepts the journaled archived record when `profile.json` has already moved.

Profile creation is transactional: a generated root is removed if layout or manifest publication fails. Profile index and `profile.json` slug/status mismatches are rejected, and malformed display names fail closed.

## Root composition requirements

Root must call the lifecycle owner before `ProfileHost.disposeProfile`, archive, or remove completes:

- stop scheduler ticks, channel ingress, Plus/control relay sessions, workflow/agent/browser runs, headless workers, PTYs, and pending personal questions for the target profile;
- wait for cancellation/termination and mark non-cancelable external effects recovery-required before the owned root can move;
- expose active-work counts to `ProfileHost.previewRemove` and reject destructive removal while work remains;
- restart the still-active runtime if archive/remove loses a revision race or rollback restores the index;
- subscribe integration cleanup to `DomainHandlerRegistry` lifecycle notifications already present in the production slice.

The profile layer does not own `MmsProfileServices`, orchestrator, workflow, browser, protocol, or UI composition. Root should pass these lifecycle hooks through its composition seam rather than adding process-global current-profile state.

Same-repository projects are intentionally independent profile records pointing at the same filesystem path. Repository identity and mutation leases remain installation-scoped, so concurrent profile mutations use the shared lease while project metadata, threads, agents, workflows, schedules, channels, Plus credentials, and browser storage remain under each profile root.

## Evidence

- `npx vitest run tests/platformProfiles.migration.test.ts --maxWorkers=2 --minWorkers=1` — 10 passed, including settings/browser import, injected boundary rollback, committed rollback acknowledgement, credential failure, and restart recovery.
- `npx vitest run tests/platformProfileRuntime.test.ts --maxWorkers=2 --minWorkers=1` — production profile composition, event routing, deletion, same-repository project separation, and interrupted deletion recovery pass.
- `npm run typecheck` — passed.

These fixtures use temporary local homes, fake credentials, and local filesystem/process state. They do not qualify live Plus accounts, hosted channels, or external provider interoperability.
