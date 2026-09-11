# Sol review: workflow adapter production readiness

## Revisions

- Reviewed core: `cc781e3`
- Review merge: `4400198`
- Generic tool implementation: `a40628fae57f9ac0a0ecc7e16d32e400aa68c40c`

This bounded review traced the current workflow runtime adapter map without modifying the Grok-owned coordinator, MCP/Skill integration adapter, Agent adapter, or Orb.

## Fixed

The catalog's generic `tool` node had no production adapter. `MmsWorkflowCoordinator.preflight()` therefore rejected every such workflow with `executor_unavailable`, even though the app exposed built-in tools.

`MmsWorkflowTools` now binds the existing Pi project tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and Git helpers (`git_status`, `git_diff`) to each profile platform. It:

- admits only project-tool IDs that are enabled in the owning profile's Settings;
- adds only those exact IDs and `tool.invoke` to the installation policy;
- requires the workflow's owned project and exact live run/profile/thread/project/actor/source/policy/cancellation identity at dispatch;
- rechecks Settings and cancellation before dispatch;
- preserves the runtime's durable external-effect approval/no-replay boundary;
- bounds JSON input to 1 MiB and text output to 4 MiB; and
- stops with the profile platform.

The production-framed test executes the real Pi `read` tool in the selected project, observes its bytes through the workflow result, then proves Settings revocation prevents a second admission without creating a second run.

No additional domain registration is needed after merging. `MmsProfilePlatform` constructs and supplies the adapter. Root should preserve `configureAdapters()` as an additive assignment when the separate Agent adapter lands.

## Current adapter map

| Node | Current production binding |
|---|---|
| `mcp-tool` | `MmsWorkflowIntegrations.mcp`; exact admitted installation/config/schema and live grant checks |
| `load-skill` | `MmsWorkflowIntegrations.skill`; pinned admitted Markdown and live installation check |
| browser nodes | `MousseMainService.configureProfileBrowser()` through the profile browser target resolver |
| `tool` | `MmsWorkflowTools`; profile-owned built-in project tools |
| `agent` / `instruction` | Still unbound in this reviewed revision; separate Grok-owned `MmsWorkflowAgents` work is active |
| sandboxed `script` | Still unbound; coordinator correctly fails preflight instead of running it unsandboxed |

## Remaining must-have blockers visible in current code

1. **Agent and instruction nodes cannot run.** `MmsProfilePlatform` does not yet install an `agent` adapter. The pending adapter must bind immutable definition/model/grant context and production cancellation/budgets before these nodes are usable.
2. **Channel and scheduled ingress do not resolve workflow commands.** `runChannelTurnOwned()` sends plain content to a model, while `runIsolatedScheduledJobOwned()` calls `llm.chat()` directly. Neither prepares the durable `workflowInvocationId` used by the GUI/CLI chat path. W04 remains open until authenticated channel/schedule selection pins and admits the workflow before delivery claims are completed.
3. **Sandboxed scripts have no sandbox implementation.** They fail closed with `executor_unavailable`. Either ship a real sandbox for the declared mode or prevent it from being presented as runnable in production creation flows.
4. **The generic Tool picker can expose non-project built-ins.** Interaction, task, quick-action, Skill, and browser operations use different ownership/approval contracts and are deliberately rejected by `MmsWorkflowTools`. The workflow UI/catalog mapping should offer only project-group IDs for a generic `tool` node; existing dedicated workflow nodes should represent approvals, questions, Skills, and browser operations.
5. **End-to-end packaged acceptance remains required.** Current local framed tests establish the individual MCP, Skill, browser, and project-tool paths. They do not yet prove one packaged workflow combining the final Agent adapter with MCP/Skill/browser/project tools, restart, profile switching, and background drain.

## Verification

- `npx vitest run tests/platformWorkflowIntegrations.test.ts --maxWorkers=1 --testTimeout=30000` — 1 file, 11 tests passed, including real framed MMS, real Pi file read, and real local stdio MCP cases.
- `npm run typecheck` — node and web TypeScript passed.
- `npm run build:cli` — passed.
- `git diff --check` — passed before commit, with line-ending notices only.

Temporary local homes only; no accounts, providers, live channels, or browser sessions were used.
