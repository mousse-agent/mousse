# Sol review: E2E11 migration crash recovery

Date: 2026-09-11

Baseline: `2b415db54f26cac9c6dd3fc8f0cf1aad9755cb`

## Result

`platformProfileMigrationCrash.test.ts` launches a separately bundled child process against a real legacy home and the production `ProfileMigrationService`, `ProfileManager`, control credential adapter, and retaining worktree adapter. The child terminates itself with `SIGKILL` from the production `afterStepAction` crash window, so neither a JavaScript cleanup path nor migration lease cleanup can run. A new service process then opens the same home and resumes from its durable journal.

The two cases cover interruption immediately after staging promotion and immediately after credential re-encryption, before either step is journaled complete. Recovery commits the original default profile ID with exactly one live profile directory and no duplicate staging profile. The exact two thread records, active thread, one disabled schedule runtime ID, browser data, and re-encrypted profile control credential survive. The installation-scoped provider secret remains only in the legacy installation `auth.json`; it is absent from the migrated profile and from a newly created profile B. Profile B also has no copied threads or control credentials. A further migration invocation remains idempotent after B exists.

## Evidence

- `npm exec vitest run tests/platformProfileMigrationCrash.test.ts -- --reporter=verbose`: 1 file, 2 tests passed in 2.28 seconds.
- `npm run typecheck`: Node and web TypeScript passed.
- `git diff --check`: passed before freeze.

## Limits

This is a Windows process-termination qualification for the promotion and credential-commit windows. The existing in-process migration fault suite covers the remaining journal steps. The test uses encrypted fixture control tokens and a fake installation provider secret; it does not access live accounts, providers, models, browsers, or the network. It validates restart of the migration service boundary rather than a full MMS daemon restart.
