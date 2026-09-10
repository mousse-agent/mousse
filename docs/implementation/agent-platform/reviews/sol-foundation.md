# Sol foundation integration review

## Review boundary

- Reviewer: Codex GPT-5.6 Sol, medium/fast verification pass
- Worktree: `mousse-platform-worktrees/integration`
- Branch: `feat/platform-integration`
- Reviewed base: `ce0667c1146d6e0f3af83bdd0faaab7fd4150854`
- Reviewed code head: `52351a435178b13a0cb2d2a8db76de93de8d4db4`
- Review date: 2026-09-11 (Asia/Calcutta)

The integration includes these exact handoffs without pushing or modifying `master`:

| Foundation | Exact handoff | Integration merge |
| --- | --- | --- |
| Agent definitions and Markdown editor extraction | `c17a486` | `0e43862` |
| Profile registry and migration | `c6bc83f` | `98fb6a8` |
| Workflow format and registry | `06e2f5e` | `39e3db7` |
| Orb review correction | `c1867e6` | `e5c322d` |
| Execution and browser contracts | `bf89215` | `c94432c` |

The review also covers the integration foundation at `666a3ba`, the implementation commits behind each handoff, and the fixes at `b84bd94`, `cd6868d`, and `52351a4`.

## Findings fixed

### Agent definitions and editor

- Published visual-only agent changes were keyed only by the semantic revision, so a later visual revision could not be retrieved independently. Visual artifacts now use their own digest, while semantic execution revisions remain stable.
- Published semantic and visual bytes were trusted after storage. Reads now verify their SHA-256 revision before returning content.
- `importBundle({ retainId: true })` generated a new ID and therefore violated its API contract. It now keeps the supplied ID and rejects collisions.
- Profile-root registry construction permitted a junction or symlink to escape the profile root. The resolved real path is now checked before use.
- A missing pinned skill revision could fall through to the currently installed revision. Resolution now fails closed instead of silently changing the effective dependency.
- Agent MCP overrides replaced the inherited set. Unmentioned profile MCP tools are now retained.
- Empty model capability lists were treated as allowing every effort, speed, and context value. Unsupported selections are now rejected.
- Dependency hashes could reflect stale lock grants instead of the live effective grants. Hashing now uses the resolved effective set.
- Markdown document tabs exposed multiple tab stops and keyboard navigation did not move focus. The active tab alone participates in roving focus; Arrow, Home, and End activate and focus the destination tab.

### Profiles and workflows

- Profile manifest reads accepted malformed entries, duplicate IDs, invalid defaults, incompatible schema/app versions, unsafe roots, invalid migration states, and bad timestamps. The registry now validates these invariants before constructing runtimes.
- `ProfileRuntime.record.appearanceSeed` remained mutable through the readonly wrapper. The nested value is now frozen.
- Workflow manifest and package parsing lacked bounded aggregate size checks. Reads now cap the manifest and total package, and reject duplicate or reserved asset paths.
- Workflow registry mutations could race across processes. Mutations now use a cross-process lock.
- Draft replacement could lose the previous draft if the second rename failed. The swap now stages the replacement and rolls the old draft back on failure.
- A visual-only workflow save could include semantic edits. The registry now compares compiled semantic content and rejects the save.
- Published workflow visuals were addressed through semantic revisions. Visual artifacts now have independent revision hashes, and both semantic and visual bytes are verified when read.
- Workflow revision IDs accepted arbitrary path-like strings, and exporting a nonexistent explicit revision silently fell back to the draft. Revision IDs now require SHA-256 and explicit missing revisions fail.
- Archive paths are reserved and locked until the archive implementation lands.

### Orb follow-up

The initial fixture screenshot showed the preview orb collapsing and clipping its eyebrow when the advanced appearance panel opened. Root corrected this in `c1867e6`: the panel is bounded and anchored, the orb keeps its size, and Escape/outside-click dismissal is covered. This review merged that exact correction and made no changes under `src/renderer/components/orb/**`.

## Verification

Runtime used Node `v22.23.2`, npm `10.9.8`, and Git `2.45.1.windows.1`. No live account, model, or channel was used.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed (main, preload, renderer, browser worker, CLI). |
| Focused agent and Markdown tests | 30 passed: 22 agent and 8 Markdown editor checks. |
| Focused profile tests | 17 passed. |
| Focused workflow tests | 40 passed. |
| Focused execution/browser contract tests | 14 passed. |
| Combined focused foundation/protocol run | 21 files and 138 tests passed, covering agent/Markdown, profile, workflow, domain, development, FilesPanel/file editor, protocol, and execution/browser contracts. |
| `npm run test:orb` | 11 checks passed. Updated desktop, dark, light, narrow, and forced-colors evidence was inspected; the expanded panel preserves orb size and the eyebrow. |
| `npm run build` | Passed for main, preload, renderer, and CLI targets. |
| `npm test` | 140/141 files and 969/971 tests passed. Both failures were default 5-second timeouts in `worktreeReadiness.test.ts` under full parallel load. |
| `npx vitest run tests/worktreeReadiness.test.ts --testTimeout=15000` | 5/5 passed in isolation; one readiness case took 5.794 seconds, confirming the suite timeout is too tight under load. |
| `git diff --check ce0667c..HEAD` | Passed after normalizing trailing whitespace in the workflow handoff. |

The build emits one pre-existing CSS parser warning from the comment at `src/renderer/styles/global.css:142`, where the text `p-*/m-*/space-*` contains comment terminators. Blame places it before the reviewed base, and it is unrelated to these foundations.

## Remaining production wiring and qualification

- A02 still needs the production agent library/editor route, persistence flow, save/restart behavior, and its profile integration. The current agent editor evidence covers pure/static behavior; actual Monaco keyboard focus, selection preservation, and Source/Preview interaction have not been qualified in a real renderer. The FilesPanel regression is covered by source-level extraction checks and `fileEditor.test.ts`, not a production UI end-to-end run.
- A03 still needs the resolver wired into the native and CLI execution paths, with runtime records pinned to the resolved agent/model/skill/MCP revisions. Current CLI/model compatibility is a validated contract, not an executing runner.
- Profile migration and management are not wired to `MousseMainService`, stores, protocol/IPC, events, or browser partition ownership. Multi-profile activation remains gated. Domain-registry profile methods also need trusted binding admission and real connection capabilities.
- W02 and later work still needs the workflow engine, script staging, approvals, slash/CLI entry points, and runtime records. Full Ajv JSON Schema validation and zip/archive handling are intentionally absent despite their dependencies being pinned; archive APIs fail closed for now.
- The C4/C6 slice defines policy, cancellation, browser references, validation, and geometry contracts. It does not yet provide executors, durable approvals, browser process lifecycle, reference actionability, or production observation/action wiring.
- Development environment variables for browser and artifact roots are established, but production consumers are still pending.
- The full-suite readiness test retains a load-sensitive five-second timeout. Its isolated passing run establishes that it is a timing flake, but the timeout itself remains unresolved outside this foundation scope.

This review qualifies the merged foundation contracts and fixes above for continued integration. It does not qualify the unfinished production wiring or complete the agent-platform plan.
