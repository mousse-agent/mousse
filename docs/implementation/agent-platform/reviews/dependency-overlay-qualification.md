# Dependency overlay qualification

Worktree: `mousse-platform-worktrees/process-lifecycle`  
Base HEAD: `4d762d5916154c1becf4500f2fa26ccb0e250d5e` (`feat/platform-process-lifecycle`)  
Scope: qualify the user's uncommitted security dependency overlay against this implementation freeze. No Orb, original checkout, live accounts, downloaded browser, full suite, or full app build.

## Overlay applied (worktree only, not committed)

Copied from `mousse-platform-worktrees/orchestration/original-overlay-20260911/`:

| File | Source | SHA-256 |
| --- | --- | --- |
| `package.json` | `dependency-proposal/package.json` | `A7B2F7285137C11BD60E5A9C92621585C0B8E65BD1F3509C02FF576CA6A94D47` |
| `package-lock.json` | `dependency-proposal/package-lock.json` | `A788336279BF89C0D96B565261F0B7420F628FC0135AEAF4819BA8910B2AB4F2` |
| `scripts/remove-vulnerable-bundled-deps.mjs` | `files/scripts/remove-vulnerable-bundled-deps.mjs` (snapshot unmodified) | `05908F147473278A0033D373EF973AE554C2010FA7BCC43CC3CCE3E1CE214F20` |

Snapshot hash for the cleanup script matches the overlay `manifest.json`. Proposal package/lock hashes differ from the user's exact 7-file overlay because the proposal is the three-way package+lock merge.

Not copied (not required for this qualification): `vitest.config.ts` (`testTimeout: 20_000`), `tests/selectiveWorktree.test.ts`, and the two snapshot docs.

## Installed versions (`npm ls --depth=0`)

| Package | Before (committed) | After overlay install |
| --- | --- | --- |
| `@anthropic-ai/sdk` | `^0.91.1` | `0.123.0` |
| `@earendil-works/pi-ai` | `0.84.4` | `0.85.1` |
| `@earendil-works/pi-coding-agent` | `0.83.0` | `0.85.1` |
| `@earendil-works/pi-tui` | `0.83.0` | `0.85.1` |
| `pi-cursor-sdk` | `0.1.62` | `0.3.6` |
| `vitest` | `^3.2.6` | `4.1.11` |
| `@cursor/sdk` | `1.0.23` (lock) | `1.0.27` (lock; package still `^1.0.22`) |

Overrides left as in the proposal (`brace-expansion` 5.0.9, `undici` 8.10.2, `hono` 4.13.7, `fast-uri` 3.1.6, `qs` 6.16.0, and the rest). None were removed or downgraded.

## Commands and results

```text
npm install --offline --ignore-scripts --no-audit --no-fund
  exit 0
  added 12 packages, removed 24 packages, changed 53 packages in 49s
  no network; no second node_modules tree

npx tsc --noEmit -p tsconfig.node.json
  TSC_NODE_EXIT=0

npx tsc --noEmit -p tsconfig.web.json
  TSC_WEB_EXIT=0

npm run build:cli
  BUILD_CLI_EXIT=0
  Built out/cli/index.js

# FORCE_COLOR unset, NO_COLOR=1; after CLI build, not concurrent with it
npx vitest run tests/platformAgentProductionExecution.test.ts tests/platformNativeBrowserRuntime.test.ts tests/platformWorkflowAgents.test.ts tests/platformWorkflowCli.test.ts --maxWorkers=1 --reporter=dot
  RUN v4.1.11
  Test Files  4 passed (4)
  Tests  40 passed (40)
  Duration  168.37s
```

No source, test, or API changes were required.

## pi-cursor-sdk 0.3.6 layout vs `scripts/build-cli.mjs`

Verified against the worktree-installed package (not guessed):

- Ships both `src/` (TypeScript) and `dist/` (compiled JS). 0.1.62 shipped `src/` only.
- No `main` / `exports` fields.
- `pi.extensions` moved from `./src/index.ts` to `./dist/index.js`.
- `prepare`/`build` scripts exist; they were not run (`--ignore-scripts`).
- Internal modules used by this tree still exist as `.ts` under `src/`: `index.ts`, `model-discovery.ts`, `cursor-api-key.ts`, `cursor-provider-lazy.ts`, `cursor-session-agent.ts`, `cursor-session-scope.ts`, `cursor-fallback-models.generated.ts`. Matching `dist/*.js` also exists.
- `scripts/build-cli.mjs` still maps `pi-cursor-sdk` → `node_modules/pi-cursor-sdk/src/index` and `pi-cursor-sdk/<sub>` → that path, appending `.ts` when the bare path is missing. `src/index.ts` is present, so the existing resolver is valid. CLI build succeeded; no rewrite.
- Source imports `pi-cursor-sdk/src/...` still typecheck under `moduleResolution: bundler`.
- APIs used here remain exported: `discoverModels`, `getCursorModelMetadata`, `__testUtils.registerModelItems`, `FALLBACK_MODEL_ITEMS`, `CURSOR_API_KEY_ENV_VAR`, `resolveCursorApiKey`, `streamCursorLazy`, `resetSessionCursorAgent`, `__testUtils.set` on session scope.
- `@earendil-works/pi-coding-agent@0.85.1` still has `dist/core/tools/index.js` and `dist/core/auth-storage.js` with the shim's `create*ToolDefinition` / `readStoredCredential` exports.

## Disk / install limits

- Host started this session at ~1.41 GiB free on `C:`. Immediately before `npm install` the same volume reported 7.6 GiB free (the cause and exact bytes reclaimed were not established; an `npm cache verify` started for cache inspection was killed because it can rewrite the cache). After install: 7.6 GiB. During typecheck/tests: ~6.94 GiB.
- Install updated this worktree's owned `node_modules` in place. No second dependency tree. Offline cache was sufficient; no missing tarball.
- Postinstall (`ensure-electron`, `ensure-native-executables`, `remove-vulnerable-bundled-deps`) was skipped by instruction. Bundled `pi-cursor-sdk` copies of `fast-uri` / `hono` / `qs` were not rewritten here.

## Remaining needed step

Root must reconcile the preserved overlay into the original checkout without losing the user's uncommitted edits:

- Keep dirty in this worktree (do not commit): `package.json`, `package-lock.json`, `scripts/remove-vulnerable-bundled-deps.mjs`.
- Also still only in the snapshot, not applied here: `vitest.config.ts`, `tests/selectiveWorktree.test.ts`, `docs/agents-workflows-profiles-browser-architecture.md`, `docs/parallel-worktree-implementation-plan.md`.
- Run the skipped postinstall cleanup (`scripts/remove-vulnerable-bundled-deps.mjs`) in the original checkout as part of that overlay, not as a second install tree.
- This freeze did not run the full suite, `electron-vite` app build, Orb, live providers, or native executable ensure. Source compatibility with the upgraded versions is qualified for node/web TypeScript, CLI bundle, and the four focused production files above.

## Expected dirty files after this commit

```text
 M package-lock.json
 M package.json
?? scripts/remove-vulnerable-bundled-deps.mjs
```

## Root reconciliation follow-through

The original checkout was reconciled to source `3fc2f1c` with the proposal package/lock and exact preserved test/config/cleanup-script bytes. Offline install completed (21 added, 1 changed, 7 seconds). The existing user cleanup script then replaced only the three bundled dependency directories with the pinned root copies; installed versions were verified as fast-uri 3.1.6, hono 4.13.7, and qs 6.16.0. The proposal lock remained unchanged. Node/web TypeScript and full app plus CLI build passed; final combined suite evidence is in the delivery ledger.
