# Agent platform delivery ledger

## Current checkpoint — September 11, 2026

The older initial-wave tables below are historical. Current implementation estimate communicated to the user: **about 40%**, including the remaining integration and verification work. This is an estimate, not a count of completed release gates. Only G0 is fully closed; do not mark later gates complete from component tests alone.

| Area | Authoritative milestone | Remaining |
|---|---|---|
| Documents | Architecture and parallel worktree plan complete, `81c7423` | Keep synchronized with implementation decisions |
| Orb | Root implementation and `c1867e6` layout correction; 11 renderer checks; Sol reviewed | Full visible app route qualification; root mounted route in `c67f3e9` |
| Agent definitions + editor | Grok `c17a486` / `6e7d66c`; Sol `79cd26f`; 28 real Electron/Monaco checks, 42 focused tests | Root mounted profile-bound route in `c67f3e9`; real native/CLI execution/history remains |
| Profile foundations | Grok `c6bc83f`; root `91e5bbe` / `50e3434`; Sol `2391a9a` | Sol `eb2b887` production routing/binding fixes merged; 63 focused tests and 7 real two-window preload checks. Full visible app/migration/account audit remains |
| Plus authentication | Root `677c97b`; Sol `b46eb90` fixed enrollment-token admission; 59 auth/domain tests + 8 control vectors | Actual server interoperability and refresh lifecycle qualification |
| Workflow format | Grok `06e2f5e`; Sol `cd6868d` | Preserve integrity fixes while merging runtime |
| Workflow engine | Sol `d097ceb` reviewed runtime/admission merged in core `8e9fd65`; 109 focused tests + typecheck + full build | Remaining nested retries, concurrent waits, path-based recovery and real process-fault cases assigned to Luna; production adapters/ingress remain |
| MCP/Skills backend | Grok `6ce4a68`; Sol `dff32f4`, 57 focused tests + build; Luna UI `2132ca5` with isolated renderer fixture | Root `66cb864` Settings repairs awaiting review; Luna `3c20a03` project isolation/materialization candidate (64 tests) queued for Sol review and actual launch qualification |
| Browser | Grok core `7042be6`, 30 tests including real managed Chromium; root `85f3b6d` worker build and real Electron child-process launch | Luna B03 `cc6ec7f` and OOPIF/open-shadow `14c6adb` (31 tests) queued for Sol review; model adapters/viewer and binary install/update remain |
| Workflow canvas | Luna `050fcde`; Sol `e40e074`, 38 focused tests, typecheck, 33 hidden Electron checks with populated narrow graph | Root `c67f3e9` mounted app route; actual execution adapter and full app qualification remain |
| Definition bridges | Root Agent `0b4a7fe`, integrations `c065f58`, workflows `7aa54fa`; `0f333b5` production MMS composition with real framed-client isolation/restart checks | Production GUI qualification, workflow run methods and main-agent tools |

Grok stopped with verified HTTP 402 `Grok Build usage balance exhausted` on profiles-production and workflow-canvas, then rejected the integrations-ui and browser-actions launches with the same error. No Grok worker remains active. The API does not report a reset date. The user-authorized GPT-5.6 Luna high/fast fallback is active: `luna_profiles` handed off profiles `94acb0` and now owns browser B03; `luna_canvas` completed the canvas and integrations UI and now owns durable workflow runtime completion in the workflow-runtime worktree. Its initial `d2986bb` continuation is not accepted: the single shared intent and missing nested crash/concurrency matrix require further work. Root writes feature composition, lifecycle wiring and guarded navigation in core. Sol medium/fast holds integration exclusively for reviewed merges and is auditing production profile isolation next. Durable launch evidence and bounded prompts remain in sibling `orchestration/`.

Profile qualification correction: the hidden `profile-isolation` fixture uses a URL/localStorage/CustomEvent simulation and a fixture-only preload. It proves Electron envelope cloning and isolated harness behavior, **not** the production `registerGuiIpc`/`GuiMmsController`/MMS two-window routing. Production profile review and a real composed fixture are still required. Root's separate `platformProductionComposition` tests exercise the real framed MMS service; the Agent Editor fixture now exercises the shared dirty-navigation guard.

Original master and its pre-existing dependency changes remain untouched. Integration is not release-ready. See individual handoffs and Sol reports for exact test scopes and limitations. Project Skill stable identity (same name in two projects), packaged browser lifecycle, real model adapters, root command/run wiring and full acceptance remain open requirements.

## Latest root integration checkpoint

After the user requested a percentage, root reaffirmed documents 100% and full implementation approximately 40%, including verification. Reviewed runtime `d097ceb` merged as `8e9fd65`. Root added strict workflow-run domain registration and bounded shared DTO projections, with eight real-engine/domain tests and 54 relevant regression tests passing; full type checking passed. See `handoffs/workflow-run-domain.md`. Production run registration/GUI/CLI wiring is still pending and this does not close G3. Current workers: Luna canvas owns A03 real Agent execution discovery/adapters in agents; Luna profiles owns remaining W02 nested recovery in workflow-runtime; Sol reviews browser then integration materialization and root UI candidates in integration. Original checkout remains untouched.

The combined app/CLI build also passed after the runtime merge and root run-domain work. Existing malformed CSS comment and mixed static/dynamic import warnings remain. No release gate advances from these component/combined-build checks alone.

Root `66cb864` mounts the Skills & MCP workspace in Settings and repairs typed MCP updates, secret preservation, exact argv, OAuth cancellation/failure reporting, fresh skill revisions, bounded uploads, and dirty/profile navigation. The shared Markdown editor resize loop was reproduced and fixed with scheduled layout; 31 Agent Editor regression checks and 29 integration checks passed. Root merge `1d0bfd4` incorporates Sol's production profile review `eb2b887`. Detailed evidence and limits are in `handoffs/integrations-app-ui.md` and `reviews/sol-profile-production.md`.

On combined core `1d0bfd4`, `npm run typecheck`, `npm run build` (app and CLI), and `npm run test:profile-production` all passed. The production fixture's result JSON records all seven checks and no errors. The expected unbound-browser rejection is exercised deliberately. The existing generated-CSS comment warning remains in the build output; it was not introduced by these changes. This is composition evidence, not a complete visible Settings/app or packaged acceptance claim.

The new workflow and browser handoffs were not accepted on test names alone. Early durability cases used an unrelated child process or did not exercise their claimed crash state; root returned them for actual process kill/restart, exact dispatch counts, and settled-loser assertions. B03 was likewise strengthened from interrupting a read-only wait to observing a real local POST before killing the worker and checking same-workspace recovery. Sol must still review both frozen candidates.

The active follow-on integration task addresses two profiles selecting the same repository and two projects containing a same-name skill. Managed writes, identities, grants and secret ownership must be proven isolated before I04 or G2/G4 can close. The full implementation goal remains active.

## Objective and baseline

Implement the full architecture and parallel plan using Grok CLI workers. Only a verified Grok weekly subscription limit permits the requested GPT-5.6 Luna high/fast fallback. GPT-5.6 Sol medium/fast performs verification, merge and code review. The root agent implements the Liquid Glass Orb without delegation.

Source baseline: 205fab2d3799b347f8709a32b4352933d68d83e0.
Planning commit: 81c7423.
Integration branch: feat/platform-integration.
Integration worktree: C:/Users/bubbl/Documents/Projects/RYSPA/mousse-platform-worktrees/integration.

The original master checkout has pre-existing package.json/package-lock.json/vitest.config.ts/selectiveWorktree.test.ts changes and a dependency cleanup script. They are excluded from this initial clean baseline and remain untouched in the original checkout. Existing mousse-implementation-worktrees branches are outside this delivery. Reconcile the original changes explicitly at final integration.

Node 22.23.2; npm 10.9.8; Git 2.45.1.windows.1; Grok CLI advertises grok-4.6 and grok-4.5; Codex CLI 0.154.0. All worker tests use separate temporary/runtime homes. No live user accounts, channels or browser cookies are test inputs.

## Ownership and initial packages

| Owner | Package | Writable paths | State |
|---|---|---|---|
| root | F00/F01/F02/F03 and orb | Shared registrations/configs/ledgers; src/renderer/components/orb/** | Running |
| Grok profiles | P01/P02 foundation | src/shared/profiles/**, src/mms/profiles/**, tests/platformProfiles*.test.ts, own handoff | Running |
| Grok workflow | W01 | src/shared/workflows/**, src/mms/workflows/**, tests/platformWorkflow*.test.ts, examples/workflows/**, own handoff | Running |
| Grok agents/editor | U01/A01 | src/shared/agents/**, src/mms/agentDefinitions/**, src/renderer/components/editors/**, FilesPanel.tsx, tests/platformAgent*.test.ts, tests/platformMarkdown*.test.ts, own handoff | Running |

The coordinator temporarily assigns initial domain schema authorship to each sole domain worker. Their concrete schema/fixture commit must be reviewed before any consumer uses it. Existing shared aggregate types/protocol/preload/IPC, package manifests, appStore, App.tsx and orchestrator remain root-owned. No worker may implement, redesign or modify the orb.

## Gates

- G0: passed. Clean baseline install, typecheck, 125 test files / 857 tests, app + CLI build all succeeded on September 11, 2026. Baseline npm audit reports 15 findings (5 moderate, 10 high); original checkout has separate dependency remediation changes to reconcile.
- G1: contracts/editor/dev isolation pending.
- G2: profile isolation/migration not achieved.
- G3: app/CLI workflow vertical slice not achieved.
- G4: creation/editor/Add UX not achieved.
- G5: managed browser alpha not achieved.
- G6: full automation/recovery not achieved.
- G7: complete requirement audit/review/package evidence not achieved.

## Full package checklist

- [x] F00 baseline
- [ ] F01 contracts/registration seams
- [ ] F02 UI/dependencies
- [ ] F03 dev/test isolation
- [ ] F04 integration/release candidate
- [ ] P01 paths/runtimes
- [ ] P02 migration
- [ ] P03 switcher/Plus/control
- [ ] P04 isolation/deletion/background audit
- [ ] U01 Markdown editor
- [ ] A01 definitions/resolver
- [ ] A02 library/editor/orb (orb root-owned)
- [ ] A03 agent execution qualification
- [ ] W01 workflow format/compiler
- [ ] W02 durable engine/scripts/approvals
- [ ] W03 command ingress/full graph
- [ ] W04 schedules/channels/browser/recovery
- [ ] V01 canvas
- [ ] V02 source/version/full catalog
- [ ] V03 debugger/polish
- [ ] I01 integration defects
- [ ] I02 Skill lifecycle
- [ ] I03 MCP lifecycle
- [ ] I04 native/CLI qualification
- [ ] B01 browser lifecycle
- [ ] B02 observations/refs
- [ ] B03 actions/recovery
- [ ] B04 platform hardening
- [ ] M01 browser tools
- [ ] M02 viewer/takeover
- [ ] M03 native model adapters
- [ ] Q01 fixture harness
- [ ] Q02 cross-feature/fault testing
- [ ] Q03 browser evaluations
- [ ] Q04 packaged acceptance/docs

Worker-process handles and logs are retained under the sibling orchestration directory. A process is considered live only after checking its execution session/process, not merely because a status file says running. Do not restart a worker after a polling timeout without checking the same process.

## First implementation wave evidence

All three workers use Grok CLI grok-4.6 / high, no nested delegation, isolated MOUSSE_HOME, separate node_modules. Started 2026-09-10 20:53:58 UTC (September 11 local).

| Task / branch | CLI execution session | Grok PID | Log |
|---|---|---|---|
| profiles-foundation / feat/platform-profiles | 36843 | 26204 | ../orchestration/profiles-foundation.jsonl |
| workflow-format / feat/platform-workflow-runtime | 36703 | 15224 | ../orchestration/workflow-format.jsonl |
| agents-foundation / feat/platform-agents | 36382 | 26196 | ../orchestration/agents-foundation.jsonl |

No weekly usage limit has been observed. No Luna fallback invoked. Sol verification/merge review remains pending worker handoffs.

Root implemented the Liquid Glass Orb and all palette/appearance controls. `npm run test:orb` passes 10 rendered interaction/accessibility/layout checks in isolated Electron, with zero renderer errors. Screenshots cover dark/light, advanced controls, narrow layout and forced colors. Source and portable fixture are committed together; runtime screenshots live under `.mousse-dev/orb-evidence`. Typecheck passed. This is a reusable component milestone; A02 remains open until its production Agent Editor and persistence are connected.

F03 in progress: development bootstrap now defaults to a per-worktree home and passes explicit Electron userData, renderer port, browser and artifact roots. Eight new isolation/bootstrap tests and the existing daemon restart probe pass. Full two-instance GUI/daemon qualification is still required.

F01 in progress: per-daemon handler registration supports strict DTO validation, required trusted profile bindings, capability gates, bounded params and structured errors. It does not enable multi-profile operation; the actual binding/admission/event ownership work remains P01/P03 integration.
