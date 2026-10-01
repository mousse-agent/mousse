# Sol profile integration owner-binding review

## Revisions

- Reviewed implementation: `69460bd97aa5d7d954da4664945e0060ccb337ed`.
- Core baseline: `ead6082`.
- Review merge: `3dcece3`.
- Added composed retry fixture: `607c53cce241f4cc9f3f1ae044e229720de7cc49`.

## Assessment

No production blocker was found in the bounded `MmsProfileServices` integration. `beginShutdown()` synchronously fences personal requests, MCP work, channels, control, platform runs, orchestrator work, schedules, PTYs and headless processes before `finishStop()` reaches an await. `finishStop()` starts permanent MCP/channel/control shutdown concurrently with their callers and the other profile owners, awaits every result, and retains the runtime when any owner fails or times out.

The final activity inventory runs before config watching stops or the service reports stopped. It includes the reviewed channel failed-close inventory and control executor/relay identities, so a recursively excluded control caller cannot release the profile. Counts may overlap by design; completion requires every count to be zero.

I added an actual composed failure/retry case. A profile channel adapter rejects its first close. Profile removal retains the same live service and directory with nonzero `channelWork`; a second removal retries that same adapter, observes its real close, and only then removes the live runtime and archives the profile.

## Verification

- `npx vitest run tests/platformProfileDrain.test.ts --maxWorkers=2 --testTimeout=20000`: 1 file, 15 tests passed.
- `npm run typecheck`: node and web TypeScript passed.
- `git diff --check`: passed before commit.

The profile tests include actual owned temporary homes and local child-process fixtures. No live MCP, channel, provider, account, or browser service was used.

## Remaining scope

Browser backend/command/guest drain remains separate. Live Discord, Telegram and relay TCP shutdown remain unqualified. Root still owns daemon/main/protocol wiring and must keep the outer personal-request barrier and final profile inventory authoritative.
