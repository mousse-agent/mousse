# Agent platform delivery ledger

## Active completion checkpoint - September 11, 2026, final regression pass

The architecture and AI worktree implementation plan are complete. Reviewed production implementation remains frozen at `778aa39`. Qualification-only work is merged in this core branch through `17631f0`; the original `mousse` checkout is integrated through `6142af7`. SHA-256 verification confirms that the user's package, lockfile, Vitest configuration, selective-worktree test, and bundled-dependency cleanup script remained byte-for-byte unchanged through that transfer.

The exact cross-feature audit found and corrected production defects: scripts now honor thread-workspace CWD; parallel mutating Agents use independently registered Git worktrees; child graphs can bind dominating ancestors; scheduled approval-required effects wait durably; and in-app browser takeover/resume returns fresh owned leases and references. Workspace review additionally fixed authority widening, redirected metadata, mutation leases, and cancellation ownership. These corrections are merged, not deferred as support limits.

Reviewed compound evidence covers E2E01-12. E2E01/02 now pass in a real Electron editor-to-MMS persistence/restart/native-run fixture at `a4422c8`; the exact scope and boundaries are recorded in `reviews/sol-e2e01-02-editor-cross-feature.md`. E2E04 runs a real script, condition, two isolated native Agents, deterministic join, and hashed artifact through authenticated MMS. E2E08 exercises real anonymous HTTP, OAuth-authenticated HTTP, and stdio MCP for main/child actor scopes with live revocation; OAuth tokens are fixture-provisioned. E2E10 kills the actual Node MMS daemon after a script effect and proves unknown-effect recovery without repetition. E2E11 kills the actual migration process at promotion/credential boundaries.

Q03's evaluation harness is merged through `75f1ce5`. It now iterates the selected task × model × observation-mode × repeat matrix and sends profile-scoped, bounded PNG screenshot bytes to the HTTP model fixture; its focused suite passes 17/17. The three-repeat full-catalog conformance run preserved 50 rows: 46 supported trials, four unsupported records, 145/145 supported actions, 44/46 successful supported tasks, and zero false successes or duplicate effects. Both failed navigation trials remain in evidence. After document-ready synchronization, the targeted navigation follow-up passed 10/10 tasks and 15/15 actions. Wilson lower bounds from the broad run were 0.974/0.855, below the proposed targets. Model-driven upload/download task provisioning and uniform document-ready initialization still require final audit before the local model path can be treated as complete. Live-model quality and an executed external benchmark remain unqualified. Q03 is required.

Current-source Windows directory-package qualification passed 17/17 lifecycle/native/migration checks; the rebuilt archive's SHA-256 is `ABD6769ECF92657F0F54F655F61B6C77A990FD41870366E9F1C68ADE6D8A99EE`. All 211 unpacked native/worker files were preserved unchanged. Linux Node CLI/native/migration/approval checks and both AppImage builds passed in the existing AlmaLinux WSL environment on the earlier source. Linux certified Chrome was absent; packaged Electron daemon/PTY and installation matrices remain unqualified. A bounded Linux CLI source refresh is active.

The original-checkout node/web typechecks and full app/CLI build passed. The first current-source combined suite finished with 219 passing files, three failing files, 1,570 passing tests, seven failures, and one POSIX-only skip. After portable browser-fixture discovery and bounded CLI waits, the rerun finished with 221 passing files, one failing file, 1,575 passing tests, two stale browser-cache assertion failures, and one skip. The subsequent focused Q03 suite passes 17/17 at `75f1ce5`, and the E2E01/02 Electron fixture passes 1/1 at `a4422c8`. A single full combined suite at `17631f0` remains required before claiming a green final candidate. The older 1,528-test result below belongs to the preceding candidate.

All four Grok workers stopped with explicit HTTP 402 usage-balance exhaustion. The authorized Luna fallback completed the workspace and evaluation candidates; Sol reviewed and corrected them. All Liquid Glass Orb source remains root-owned. No live user account/provider/channel was used for qualification.

See the [requirement audit](final-requirement-audit.md), [browser evaluation review](reviews/sol-browser-evaluation.md), [workspace review](reviews/sol-workflow-workspace-correction.md), [Windows report](handoffs/windows-lifecycle-qualification.md), and [Linux report](handoffs/linux-qualification.md). Earlier entries are retained as history; they do not close the current G7 release gate.

## Earlier delivered candidate - September 11, 2026

The requested architecture and AI worktree implementation plan are complete. The reviewed feature implementation is integrated into the original `mousse` checkout on `master`: Agents/Workflows and the root-built Liquid Glass Orb; revisioned file format, canvas and app/CLI slash execution; profile-owned personal data with shared providers/models; Add Skill/upload/MCP connection flows; and automation of the existing in-app Electron browser. See the [current requirement audit](final-requirement-audit.md) and [usage/support guide](usage-and-support.md). Historical percentages, unchecked boxes, pending merges, and worker tables below are retained as history, not current status.

All named implementation reviews are merged. Background ingress `d0cfd9df` adds stable channel identities, durable scheduled occurrence receipts, cancellation-safe observation, and transcript leases (4 ingress and 49 channel/scheduler tests passed). Quick-action profile switching `0e14b83` prevents stale async callbacks from affecting the newly selected profile. Browser effect review `ea8f45b` allows read-only observations under read policy while retaining external-action requirements. The actual Electron E2E exercises the native main-agent loop and a published workflow on the same surviving guest, with cookies, exact approvals, takeover, and no managed fallback.

The feature source candidate is `3fc2f1c`; subsequent commits through `40a8866` only update documentation. Package startup correction `5e45d1e` normalizes external highlight.js imports against their actual public exports. On the original checkout, the user's upgraded dependencies, all override declarations, exact test/config/script bytes, and existing uncommitted intent are preserved. The original overlay is additionally retained in Git stash `3a754e63b94cde4fde83130c7e83047c2d0daf08` and byte/hash snapshots under sibling `orchestration/original-overlay-20260911`. No user source or account data was removed. The user's existing bundled-dependency replacement script was applied, confirming `fast-uri 3.1.6`, `hono 4.13.7`, and `qs 6.16.0` in the installed Cursor SDK.

TypeScript and the full Electron/main/preload/renderer + CLI build pass with the upgraded dependencies, including after startup fix `5e45d1e`. The independent compatibility run also passed 40 native/Agent/workflow/CLI tests. All five previously failed full-suite files subsequently passed together (50 tests); this does not rewrite the historical failed full-suite result. The final original-checkout combined suite passed: **211 files, 1,528 tests passed, 1 skipped, zero failures or unhandled errors**, exit 0 in 409.45 seconds (`npm test -- --maxWorkers=4`, preserving the user's 20-second test timeout). The one skipped case is POSIX-only process termination on Windows. The initial Windows package exposed invalid highlight.js external subpaths before CLI dispatch; root fixed the build normalization in `5e45d1e`, Sol reviewed it, and both TypeScript projects, the full app/CLI rebuild, generated-import regression, and actual Electron worker packaging regression passed (2 files / 2 tests). The corrected Windows package passes CLI `--help`, `--version`, and `service status` with exit 0 and empty stderr under an isolated home; the service remains stopped and uninstalled. [The reviewed package report](reviews/final-windows-package.md) records the official ASAR streams repack, exact preservation of all 211 unpacked files, archive digest, and limits. Root also verified the corrected development bundle starts under the real Electron runtime and reports `mousse-cli 0.1.1`. No daemon lifecycle or installed-upgrade claim is inferred from these smoke checks.

The Agent Editor, workflow editor, integration editor, browser viewer, and real profile/preload UI runners passed; root inspected the Orb and canvas screenshots. Supported generic browser tools are implemented. Provider-native computer adapters remain experimental, OS sandbox execution remains unavailable, and Try Run uses scratch workspaces. Packaged Linux, live Plus/OAuth/channel interoperability, live-provider browser quality, and full install/upgrade matrices remain qualification limits. This delivery is not a claim that G7 release certification is complete.

## Earlier checkpoint — September 11, 2026, 15:15 IST

The architecture and parallel AI worktree plan are complete. Core `4d762d5` contains the reviewed Agent/Instruction adapter, child workflow composition, generic project/MCP/Skill adapters, managed browser setup, human handoff, and production workflow browser binding. The [requirement audit](final-requirement-audit.md) supersedes the historical unchecked package list below as the source-to-requirement map. The [usage guide](usage-and-support.md) describes available product paths and explicit support boundaries. Full implementation/qualification remains active; this checkpoint is not a packaged release claim.

The real Electron fixture now exercises both the native main-agent tool loop and a published `browser-session → browser-action` workflow through authenticated GUI RPC on the same surviving guest. Exactly two durable external approvals are resolved; navigation is verified by the action result and runtime trace. Cookies and guest identity persist, automation release leaves the human tab alive, and managed fallback is never attempted. Review/composition `d309324` is merged. Human handoff review `16de106`, Agent grant-ceiling review `4e82573`, and setup review `109bc15` are merged. Managed setup is available from app and CLI; missing setup does not cache a failed worker and a ready retry works in the same daemon.

Both TypeScript projects and the full Electron/main/preload/renderer + CLI build pass on `4d762d5`. The five UI runners (Agent Editor, Workflow Editor, integration editor, browser viewer, and production profile/preload isolation) passed on the preceding composed source. Root visually inspected the rendered Agent Orb and workflow canvas. These are real component/hidden-Electron checks, not visible packaged-app or live-provider qualification.

The broad suite on `06af7cf` completed in 667 seconds: **207 files, 1,507 tests passed, 7 failed, 1 skipped, and 2 unhandled rejections**. It is explicitly not a passing full-suite result. Reviewed fixes now merged address transport capability advertisement, profile cleanup continuing after a synchronous shutdown failure, and Phase4 tests using the actual profile-owned question service (including the orphan rejections). Root updated an obsolete collapse-markup assertion to the reviewed KeepMounted implementation; the real mounted-guest fixture also passed. The Windows Git-worktree test passed in the subsequent focused run with the original user's 20-second timeout, rather than the old 5-second limit.

Root `091e266` makes model favorites and quick actions profile-owned, remounts their editor state on switching, and migrates legacy values only to Default without overwriting later edits. Two storage/migration checks pass; 53 related profile-drain/Agent/worktree/terminal checks pass; TypeScript passes. The unavailable sandboxed Agent script choice is disabled and new Agents default to supported workspace execution. Removal previews now expose all owned activity. Removal still uses the existing authoritative drain before any filesystem move; changing it to reject every live owner before drain would break the already-tested shutdown/retry behavior. Sol is reviewing preference callbacks and asynchronous quick-action profile switching.

Remaining active owners: Sol child in `agents` reviews/fixes Grok background ingress `d680e2d`, especially stable channel identities, durable waiting schedule occurrences, observation cancellation, and transcript leases. Sol profile in `browser` reviews root preferences. Grok in `process-lifecycle` qualifies the original user's upgraded dependency versions against the implementation. Sol foundation completed the real workflow/browser composition. No verified Grok subscription limit occurred. Root continues integration and original-checkout reconciliation; all Orb implementation remains root-owned.

The original checkout is still unchanged except the delivered documents. Its seven pre-existing/previously delivered overlay files have byte snapshots and hashes under sibling `orchestration/original-overlay-20260911`; a three-way package proposal and offline lockfile resolution preserve the user's dependency upgrades. Final source transfer is prepared but not executed. Required next steps are the remaining reviewed merges, dependency compatibility, a final combined regression run, and safe original-checkout transfer. Packaged Windows/Linux, live Plus/OAuth/channel services, and paid-provider/browser-quality qualification remain unclaimed.

## Earlier checkpoint — September 11, 2026, 14:35 IST

The architecture and parallel worktree plan are complete and synchronized into the original repository's `docs` directory. Full implementation is still active; the estimates below are engineering estimates, not release certification. Current overall estimate is **about 60%**, with the main in-app browser path now connected and independently exercised end to end.

Reviewed daemon composition (`60a3a7a`), main guest/GUI lifecycle (`8f1f9e5`), managed worker/process ownership (`9cdb1e1`), native model tools and immutable per-turn grants (`7c70301`), and the real Electron end-to-end fixture (`8fc6a89`) are merged. The fixture calls the actual native LLM loop with a scripted local provider, sends `browser_open` and `browser_act` through framed MMS and the owning GUI connection, and fills the existing Electron webview while retaining its cookies and identity. Human takeover, resume, release, zero pending guest-closure proofs, and no managed fallback are asserted. It uses isolated temporary homes; it does not certify live provider behavior or packaged visible-app acceptance.

Root's subsequent human-handoff composition (`ef6d19d`) is under independent review. It persists `browser_request_human`, actually transfers control to the user, displays the reason, and preserves the latest authorized observation across separate viewer RPCs. The extended real-tab fixture and both TypeScript projects pass. The reviewer is checking cancellation/recovery and the existing long-running viewer polling budget.

The full Electron/main/preload/renderer and CLI build passed at `78d55f3`; 32 combined built-CLI workflow, native-agent, and profile-drain tests subsequently passed. These cover GUI/CLI slash resolution, durable revision pinning, queued admission reconstruction, real script approval/resume, cancellation versus monitoring, and actual profile-owned process-tree shutdown. The separately reviewed generic workflow project-tool adapter (`ce96125`) is merged, with 11 framed MCP/Skill/project-tool tests passing in review. This is component and combined-build evidence; the final release-candidate suite remains open.

Current workgroups: Sol foundation reviews Grok child workflow composition `289e03d` (transitive pins, deferred completion, deadlines, inherited approval policy and usage accounting) in profiles. Sol profile reviews root human handoff in browser. Sol child fixes the worker/installer active-version layout mismatch in agents. Grok builds the production Agent/Instruction adapter in integrations, managed browser setup app/CLI service in process-lifecycle, and scheduled/channel workflow ingress in workflow-runtime. All remain isolated worktrees; root owns shared composition and all Liquid Glass Orb work. No verified subscription limit occurred, so these workers use Grok rather than a Luna fallback.

Required remaining work includes merging and composing those candidates, enforcing transitive Agent/tool/browser admission, completing production UI journeys and final combined/package qualification, and reconciling the original checkout without overwriting its pre-existing dependency/test edits. Unimplemented settings must remain explicit. Sandboxed scripts currently fail closed; production creation no longer offers that unavailable mode. Only G0 is formally closed; earlier checkpoint entries are historical and must not be interpreted as current worker ownership.

## Historical checkpoints

## Current checkpoint — September 11, 2026

Core `69460bd` includes reviewed MCP lifecycle `feac07c`, channel/control `088ba64`, and browser artifact composition `76dbd6a`. Root's profile owner binding now fences and awaits those services, reports their activity, and rejects disposal with residual ownership. It passed 14 profile-drain tests, 44 combined profile/MCP/channel tests, both TypeScript projects and the CLI build. Independent review is queued after the protocol review. Root subsequently identified failed-channel-close retry and control callback registration issues; Sol foundation's corrective implementation `005c002` has 19 lifecycle tests and TypeScript passing and awaits its final regression/report freeze before merge.

Root browser UI lifetime `8fe03e6` is committed and under Sol review. The real hidden Electron fixture exercised actual MainViewPanel/BrowserPanel/KeepMounted and retained the same guest, form, cookie, scroll position and nonzero viewport across view/mode/thread/empty-thread/collapse transitions. Profile changes and explicit closes destroy the old guest. Nineteen fixture checks and eleven existing browser-tab tests passed. Hidden compositor capture can be stale; this is lifecycle evidence, not visible full-app acceptance. The reviewer is strengthening native input positive controls.

Current workgroups: Sol profile reviews attached executor `9832c82` in browser; Sol child reviews private command transport `8fb50f6` in process-lifecycle; Sol foundation reviews UI lifetime and the channel/control follow-up in workflow-runtime. Grok continues the managed browser broker/worker/process drain implementation in agents, with exact PID 30464 last verified live. The same existing in-app tab remains mandatory for B01a/G5. Production trusted registration, main/preload/domain/model wiring, browser shutdown composition and full app acceptance remain open. Estimate remains about **50% overall**, documents complete; only G0 is closed.

### Earlier checkpoint

Current core is `cc737a5`. Reviewed native Agent Editor execution (`89295de`, 42 focused tests), browser routing (`305024a`, 31 browser tests), and bounded shared artifact ownership (`4f2cde8`) are merged, along with the earlier M02/M03, A03 policy, profile drain, and process-owner fixes. Root browser artifact composition `cc737a5` passed 43 combined tests and 11 artifact/viewer tests, including an actual Chromium screenshot imported into the common store and denied to another session. Both TypeScript projects and the full app/CLI build passed. That artifact layer is under Sol review in profiles. MCP/channel/control/browser owner binding and final product acceptance remain open.

The user clarified that Browser Use must support Mousse's **existing in-app tabs**. Architecture/plan commit `fcc9afd` makes the Electron-attached executor required for G5; managed Chromium remains for CLI/scheduled/headless. Grok's attached executor froze cleanly at `9832c82` (implementation `3b6c793`): 30 tests passed, including a real hidden-Electron existing-webview fixture preserving cookies/form state, one POST, and takeover fencing. It awaits Sol review and does not yet include full-app BrowserPanel/main/preload/model wiring. Hidden-window screenshot capture remains explicitly unavailable in that fixture; the managed screenshot pipeline is separately qualified.

Current workgroup ownership: Sol profile reviews Grok MCP `6858d0e` in integrations; Sol foundation reviews Grok channel/control `9268991` in workflow-runtime; Sol child reviews root browser artifacts `cc737a5` in profiles. Grok builds the targeted browser command transport in process-lifecycle and fixes the audited managed broker/worker drain graph in agents. Both tasks use separate worktrees. The MCP, channel/control, and attached-executor wrappers finished with exit 0 after service-connection retries; no subscription-limit fallback was triggered. Root retains all Orb work and shared production composition. Native Agent Editor Try Run is now real, with explicit remaining limits for selected-project context, persistent memory, CLI/browser binding, and public per-run controls. Estimate remains about **50% overall**, documents complete; only G0 is closed.

### Earlier September 11 checkpoints

Root integrated reviewed owned-work fixes `c1ebb662` as `96d819b`: session-object fencing, observed background failures and retry admission fixes passed 27 focused and 39 queue tests in review. Root then composed personal RPC/profile admission and awaited scheduler teardown; 5 files / 44 combined tests passed, followed by 7/7 final profile-drain fault cases, both TypeScript projects and CLI build. See `handoffs/profile-drain-composition.md`. This candidate explicitly leaves channel/control, process-tree and MCP raw-I/O drain binding open.

Current parallel work: Grok process-lifecycle `e7074bd` finished and is under Sol review in process-lifecycle; Sol A03 policy review remains in agents; Grok channel/control runs in workflow-runtime and Grok MCP lifecycle runs in integrations. Sol completed M02 viewer `59353b9` and M03 adapter `5023dca`; both are ready for root integration. Their tests are local/fixture evidence, and provider model rows remain Experimental pending exact-model evaluations. No later release gate closes at this checkpoint.

Latest integration is core `f3207b5`: reviewed M01/I04 CLI `0a6511f`, profile recovery `2e038ea`, CLI/slash integrity `9b4875a`, child workflow recovery `a590386`, and production MCP/Skill fixes `3061d27` are merged. MCP preparation now discovers only referenced servers and verifies the complete durable admission digest; its reviewed evidence is 4 suites / 39 tests plus typecheck and app/CLI build. Child coordinator wake-up and transitive integration bindings remain open.

Root's owned-work shutdown prerequisite adds actual promise tracking and cancellation for orchestrator/native agent work, with 25 focused tests and 39 queue tests passing. See `handoffs/owned-work-lifecycle.md`; it is not yet connected to profile archive/removal and does not close P04. Grok's native runtime policy candidate `93e5d2b` finished successfully and is under independent Sol review in agents. A second Grok worker is implementing awaited external process lifecycle in process-lifecycle. The original Sol reviewer continues M02 viewer and M03 model adapter review in integration. These current statuses supersede worker states and pending-merge statements in the historical checkpoints below.

The older initial-wave tables below are historical. Current implementation estimate communicated to the user: **about 45–50%**, including the remaining integration and verification work. The architecture and parallel worktree documents are **100% complete**. This is an estimate, not a count of completed release gates. Only G0 is fully closed; do not mark later gates complete from component tests alone.

| Area | Authoritative milestone | Remaining |
|---|---|---|
| Documents | Architecture and parallel worktree plan complete, `81c7423` | Keep synchronized with implementation decisions |
| Orb | Root implementation and `c1867e6` layout correction; 11 renderer checks; Sol reviewed | Full visible app route qualification; root mounted route in `c67f3e9` |
| Agent definitions + editor | Grok `c17a486` / `6e7d66c`; Sol `79cd26f`; 28 real Electron/Monaco checks, 42 focused tests | Root mounted profile-bound route in `c67f3e9`; real native/CLI execution/history remains |
| Profile foundations | Grok `c6bc83f`; root `91e5bbe` / `50e3434`; Sol `2391a9a` | Sol `eb2b887` production routing/binding fixes merged; 63 focused tests and 7 real two-window preload checks. Full visible app/migration/account audit remains |
| Plus authentication | Root `677c97b`; Sol `b46eb90` fixed enrollment-token admission; 59 auth/domain tests + 8 control vectors | Actual server interoperability and refresh lifecycle qualification |
| Workflow format | Grok `06e2f5e`; Sol `cd6868d` | Preserve integrity fixes while merging runtime |
| Workflow engine | Sol `d097ceb` reviewed runtime/admission merged in core `8e9fd65`; production coordinator review `df4f29b` merged in `b78343d` | W02 nested recovery candidate `0423d96` under Sol review; full production adapters and slash ingress remain |
| MCP/Skills backend | Sol I04 `c05de1d` and Settings UI `40097d3` reviewed and merged in core `34fe920`; combined 13 production/integration tests pass | Actual installed CLI consumption and full production Settings/OAuth qualification remain |
| Browser | Sol B03 `c41407f` and OOPIF/open-shadow `bac3959` reviewed and merged in core `34fe920`; combined 18 real Chrome tests pass without skips | B04 `e138f2d` and M01 `c1fc3e2` passed worker qualification and await review; production model adapters/viewer remain |
| Workflow canvas | Root production runs `3afd39c` reviewed in Sol `df4f29b`, merged in core `b78343d`; 50 Electron fixture checks | Slash commands, full debugger/multiwait UI, full app/packaged qualification remain |
| Definition bridges | Root Agent `0b4a7fe`, integrations `c065f58`, workflows `7aa54fa`; `0f333b5` production MMS composition with real framed-client isolation/restart checks | Production GUI qualification, workflow run methods and main-agent tools |

Grok previously stopped with verified HTTP 402 `Grok Build usage balance exhausted`, which triggered the user-authorized GPT-5.6 Luna high/fast fallback. On the user's latest steering, root rechecked Grok: an actual grok-4.6/high request returned `READY`. A new native agent runtime policy worker is active in the agents worktree, PID 18040, wrapper session 81672, with prompt/log/state files named `agent-runtime-policy` under sibling `orchestration/`. The process was independently observed alive after launch. It owns native runtime policy/context enforcement and qualification, not the Orb or root production composition. The Luna child-workflow and profile tasks finished and are now in separate Sol medium reviews. Root owns core; the original Sol reviewer owns integration; additional Sol reviewers exclusively own workflow-runtime and profiles.

Profile evidence has distinct scopes: the earlier hidden `profile-isolation` fixture uses URL/localStorage/CustomEvent simulation and a fixture-only preload. Sol's later production review `eb2b887` and the real `profile-production` fixture exercise the actual two-window routing/binding/event partition. The separate `platformProductionComposition` tests exercise real framed MMS services. Complete migration/account/packaged isolation acceptance remains open.

Original master and its pre-existing dependency changes remain untouched. Integration is not release-ready. See individual handoffs and Sol reports for exact test scopes and limitations. Project Skill stable identity (same name in two projects), packaged browser lifecycle, real model adapters, root command/run wiring and full acceptance remain open requirements.

## Latest root integration checkpoint

Root connected profile-owned production MCP and Skill workflow adapters, with host-created immutable dependency bindings, bounded durable admission reads, exact MCP configuration/schema checks, policy and execution ownership checks, and cancellation propagation. See `handoffs/workflow-integrations-production.md`. Final evidence: the new framed-MMS/real-stdio suite passed all 9 tests; 3 related regression files passed 29 tests; both TypeScript projects and the app/CLI build passed. The final 9-test run corrected a fixture expectation from `invalid_params` to the actual `unknown_field` rejection; no production behavior was loosened. The earlier 36-test run also passed. Child dependency preparation, other executor adapters and full app acceptance remain open; this is a candidate for Sol review, not a gate closure.

Core `031ca936` already incorporates reviewed W02 continuation `c9e0abb` and B04 `fd29035`; subsequent combined typecheck and 5 files / 30 tests passed. Sol then froze M01 at `84ff78e` and I04/A03 CLI qualification at `0a6511f`; both are ready for root integration. CLI Skill consumption and unsupported exact grants now fail closed; installed Claude MCP/provider calls and accounting remain unqualified. P02/P04 recovery was independently reviewed and fixed at `2e038ea7d1300e391ffdbf2afb7c649a025e5eba`, with 7 suites / 52 tests and full typecheck passing. The profile deletion lifecycle barrier remains root work. W02 child recovery candidate `e610041` is under its own Sol review. Corrected viewer `58542ea` and native browser model adapter `b534cc3` candidates remain in the original Sol queue.

Root locally qualified the workflow slash ingress described in `handoffs/workflow-slash-ingress.md`: pinned profile-owned receipts before queueing, idempotent graph admission before atomic chat/run-reference persistence, removal tombstones, app/CLI transport wiring and structured argument errors. Final evidence is six files / 70 tests, both TypeScript projects and the combined app/CLI build passing after disk recovery. Built CLI tests ran after build completion. This slice remains pending Sol review and does not close G3. Main-agent/external adapters, completion/forms/cards, queued CLI follow-through and schedule/channel targets remain open.

Sol froze the reviewed W02 continuation at `c9e0abbdf72a7858c0d671b50926ac68307f5954`, with multiwait domain/UI, deferred control races, sibling denial revocation, parent budgets and authoritative artifact checks corrected. Evidence includes 17 files / 143 tests, final runtime/domain 3 / 60 tests, both TypeScript projects, app/CLI build and 50 Electron checks. Root integration is pending. Child subworkflow waits/unknown effects still incorrectly fail the parent, so W02 is not complete. See `reviews/sol-workflow-runtime-continuation.md` on that freeze. B04 review then froze at `fd29035c93cf79840cc889a21fcdd1ecbccf912f`: bounded download/extraction, root-junction/readiness and rollback fixes; 27 installer/contracts/lifecycle/packaging tests, 11 installer/bounds cases, 18 real Chrome action/observation cases, typecheck and browser-worker/CLI builds passed. Production lifecycle serialization and packaged qualification remain open. Initial M02 viewer and M03 model adapter candidates were returned for concrete renderer/human-input, provider-envelope/cardinality, geometry and safety fixes; they are not accepted.

A subsequent combined build and CLI regression run encountered zero free disk space. The read-only audit identified 22 owned M01 browser fixture roots totaling about 9.4 GB, plus two stale browser-worker oversized download payloads totaling about 5.3 GB. After the two payloads became empty, root verified approximately 5.46 GB free and successfully rebuilt the app and CLI. Fixture owners are correcting cleanup before further browser runs. ENOSPC-affected runs are not passing evidence; source, user data and small qualification evidence were preserved. Root now runs the built CLI tests after the build finishes to keep the tested output stable.

After the latest status request, root reported approximately 45% for full implementation, with documentation complete and only G0 formally closed. Structured workflow CLI commands are committed in `f3bd930`; reviewed native agent execution and production workflow run fixes from exact Sol `df4f29b88c6991aca1f439c5d17deeb8976c9cb1` merged cleanly as `b78343d49660e581b4dd6117b3deb706086821ce`. The first CLI/launch/interactive regression run passed 3 files / 13 tests, including separate built CLI processes connecting to a real owned MMS daemon. Final combined verification passed 4 files / 26 tests for CLI, agent execution, workflow coordinator and execution client; both TypeScript projects and CLI build passed. See `handoffs/workflow-cli.md`. Sol review of the CLI slice remains queued. Main-agent slash ingress and actual external adapter composition remain root's next work, and no later release gate closes here.

Latest final worker freezes supersede the older candidate statuses below: B04 installer `e138f2d601e81cda60d9718913c4113a0c94b457` passed both TypeScript projects, seven installer cases, 24 browser regressions and actual ephemeral/persistent lifecycle checks; M01 automation `c1fc3e269325667aef170130590d100acccec684` (handoff `91999d6`) passed three actual managed-Chrome cases, full type checking and CLI build. Both await independent review and root composition. Sol is reviewing W02 `0423d96` before those two candidates. Luna canvas now owns M02 viewer/takeover in browser; Luna profiles owns I04/A03 actual CLI permission and materialization qualification in integrations. Root retains all Orb work and shared host/command composition. Original master and its existing dependency changes remain untouched.

## Earlier integration checkpoints

The entries below preserve the state at each earlier checkpoint; current ownership and review status are recorded above.

Core checkpoint `3afd39ca96d9c93751924fb5bb63a944b9be6deb` commits the production coordinator/desktop Run work described below. Reviewed browser, I04 isolation and Settings UI `40097d3924a0decbf1285bc9c0f3b193c10a7ead` merged cleanly as `34fe920b178a0b8da3eeb6f04d47f8675648c0f3`. Combined type checking and app/CLI build passed. On the merged source, 13 production-MMS/integration tests and 18 real Chrome action/observation tests passed with no skips. The latter exercise OOPIF/open-shadow refs, actual scriptless browser actions, uploads, downloads, takeover, geometry, and real worker-crash recovery; they do not certify provider-native adapters or packaged cross-platform behavior.

Root `e94144f9dcd0b384b4e6b6d61231c213c1f515c8` fixes the oversize HTTP fixture's backpressure counter. `write(false)` had queued bytes without decrementing its remaining count, making a nominal 51 MiB response unbounded. A real streaming HTTP regression now verifies exactly 51 MiB and aborts on overflow before writing any disk artifact. The initial combined run was interrupted at zero free disk space and is not passing evidence. Sol verified and truncated exactly two stale fixture `.crdownload` files (3.8 GB and 814 MB); root narrowly cleaned only reproducible core build/Vite/incomplete-download artifacts after inspecting Git's exact cleanup preview. Runtime screenshots/journals/source/user data were preserved. Root's separate browser fixture root reuses immutable certified Chrome file bytes via hard links and copies its metadata separately; it shares no session user-data, locks or journals. About 4.3 GB was free after the successful reruns/build. Automatic review had rejected PowerShell deletion; the eventual Git cleanup used explicit exclusion allowlists and was previewed to avoid Git expanding an ignored child into its entire parent.

Worker updates: W02 `0423d96eda7474602fcaf4ef8c072330cf1e87f6` is frozen for Sol; M01 `1dc330542739062325a6d57ba3ead40e7cfadb5f` is an unverified automation candidate still requiring final actual Chrome tests and typechecks. B04 `5785c0e` hardens the rejected initial installer but still awaits final qualification and Sol review. Root's next required work is structured CLI and main-agent slash ingress, then trusted native/CLI/MCP/Skill/browser adapter composition. No G1–G7 gate closes here.

Root now composes the real per-profile workflow coordinator, advertises/registers the run domain through GUI/CLI request paths, and mounts a request-backed execution client. Durable admissions preserve the exact thread/revision/policy through retry/restart; profile timers recover without a UI; real local scripts and workspace input staging are exercised after approval. Six coordinator tests, eight run-domain tests, four client transport tests, and five production framed-MMS composition tests pass. The Electron workflow fixture additionally verifies typed inputs, duplicate clicks, exact published input schemas, and measured visible narrow/read-only graphs with rendered edges. See `handoffs/workflow-production-runs.md`; Sol review remains required. Slash/structured CLI commands, native/MCP/Skill/browser adapter composition and complete W03/W04 remain open.

Current worker ownership supersedes historical assignments below: Luna canvas is correcting B04 installer candidate `bc5ad2f` in browser after root found inflation/cleanup/locking/validation gaps; it is not accepted. Luna profiles froze W02 `0423d96eda7474602fcaf4ef8c072330cf1e87f6` for Sol and is beginning M01 automation tools in integrations. Sol completed browser `bac3959`, I04 `c05de1d`, and Settings UI `40097d3` reviews, and now reviews A03 `047ff7b`, followed by root workflow composition and W02. Root will merge only the exact reviewed checkpoints. The full objective and all remaining gates stay open.

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

## Historical initial gates (superseded by the current checkpoint)

- G0: passed. Clean baseline install, typecheck, 125 test files / 857 tests, app + CLI build all succeeded on September 11, 2026. Baseline npm audit reports 15 findings (5 moderate, 10 high); original checkout has separate dependency remediation changes to reconcile.
- G1: contracts/editor/dev isolation pending.
- G2: profile isolation/migration not achieved.
- G3: app/CLI workflow vertical slice not achieved.
- G4: creation/editor/Add UX not achieved.
- G5: managed browser alpha not achieved.
- G6: full automation/recovery not achieved.
- G7: complete requirement audit/review/package evidence not achieved.

## Historical initial package checklist (not a current implementation inventory)

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
