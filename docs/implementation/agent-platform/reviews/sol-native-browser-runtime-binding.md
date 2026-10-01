# Sol review: native browser runtime binding

Reviewed integrated core `cc781e3` (candidate `1e26c55`, production composition `9be1772` and `cc781e3`).

## Fixes

- Native definition requests now advertise only browser tools present in the admitted browser policy. Previously every browser tool was shown to the provider and denied only after the model called it.
- Runtime policy and browser execution authority are recursively snapshotted and frozen before provider retries and host callbacks. Profile, thread, source, actor, grants, and limits cannot drift between attempts.
- Model arguments can no longer select `persistent` or `workspaceId` in `browser_open`; those unsupported host-owned workspace choices are absent from the schema and rejected as forged authority.
- Oversized untrusted browser results remain bounded valid JSON rather than a truncated, malformed JSON prefix.
- The daemon composition fixture now uses `MousseMainService`'s production browser domain/router registration instead of registering a duplicate test-only domain.

## Verification

- `npx vitest run tests/platformNativeBrowserRuntime.test.ts tests/platformAgentRuntimePolicy.test.ts tests/platformAgentProductionExecution.test.ts tests/platformBrowserDaemonComposition.test.ts --reporter=dot` — 4 files, 41 tests passed.
- `npm run typecheck` — node and web TypeScript projects passed.

The framed Agent Editor test uses the real `AgentExecutionService`, native `LlmClient` loop, profile run owner, and browser runtime injection with deterministic provider and browser transports. No live provider or browser was used. Persistent browser workspaces, trace retention, vision/image continuation, and native browser support for CLI agent definitions remain explicitly unsupported by this slice.
