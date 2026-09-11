# Profile preferences, removal preview, and agent sandbox review

## Baseline and implementation

- Root candidate: `091e2661803476a92747c5b1e1040f342746270c`, reviewed through core merge `4d762d5916154c1becf4500f2fa26ccb0e250d5e`.
- Review implementation: `7d8991f7c66c4e60db3d7573698774c27fecc82c`.

## Findings and fixes

- Favorites and quick actions use mandatory profile-keyed storage. Their React owners remount by profile, agent-created quick-action events verify the current profile, and legacy values migrate only to the default profile without overwriting later profile values.
- A `send-new-chat` quick action captured the old store, awaited `createAndSelect`, then could switch the newly bound profile to the old thread and send that old thread ID over the replacement connection. Quick-action execution now requires the captured profile identity at entry and after every asynchronous continuation. A profile change stops store updates, follow-up sends, activity probes, and terminal writes.
- Removal preview now exposes the live owned-activity inventory for informed UI confirmation. Removal still enters `withDrainedProfile` and completes the existing full shutdown/retry barrier before archive/delete; no zero-activity preflight was added.
- New agent defaults select workspace execution, while the unavailable sandbox option is visibly disabled. Explicit existing sandboxed definitions remain fail closed in runtime policy rather than being silently broadened.

## Evidence

- `npx vitest run tests/platformProfilePreferences.test.ts tests/platformQuickActionProfileRace.test.ts --maxWorkers=1 --testTimeout=30000`: 3 passed.
- `npx vitest run tests/platformProfiles.manager.test.ts tests/platformProfiles.migration.test.ts --maxWorkers=1 --testTimeout=30000`: 16 passed.
- `npm run typecheck`: node and web TypeScript passed.
- `git diff --check`: passed.

## Limits

- Renderer preference migration intentionally leaves the legacy installation keys in place. A populated profile key always wins, so repeated default-profile startup does not overwrite edits.
- Connection rebinding and personal RPC serialization remain daemon responsibilities. The renderer guard prevents a resolved old-profile operation from mutating or issuing its next operation into the newly active profile.
