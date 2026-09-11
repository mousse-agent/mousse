# A03 native agent runtime policy

This checkpoint adds host-owned native runtime policy, bounded context, and safe model fallback on top of the reviewed execution seam. It does not add a second agent loop, does not implement Orb visuals, and does not touch CLI invocation/materializer files.

## What this runtime now enforces

`AgentExecutionService` compiles an immutable `AgentRuntimePolicy` from the resolved definition plus trusted host bindings. Renderer/provider content cannot supply authority. The policy is carried into `createNativeAgentRuntime` and the existing `LlmClient` trusted-agent seam.

Enforced at native tool dispatch (not prompt text alone):

- Workspace mode, including `read_only` blocking write/edit/shell even when those tools are granted
- Canonical host workspace roots, with symlink/`..`/absolute escape rejection immediately before side effects
- Script policy (`enabled`, workspace execution, filesystem flag). Sandbox and network isolation are not pretended
- Approval policy with no default auto-approve. `always` requires `host.approveToolRequest`. Denied, cancelled, and stale (digest/path mismatch) decisions fail closed before dispatch
- Revalidation after every approval await, including abort, path canonicalization, and exact argument digest
- Built-in alias canonicalization (`read_file`→`read`, `write_file`→`write`, `list_dir`→`ls`, `run_command`→`bash`)
- Exact grant/revision checks already present in `LlmClient`, kept across fallback attempts
- Aggregate turn/tool/token/cost/deadline limits across fallback/retry attempts. Requested `0` is honored. Non-finite or negative requested budgets are rejected

Host-supplied snapshots only:

- `includeCurrentThread` includes or excludes the provided thread history
- Attachments, selected files, project instructions, and memory use the snapshot; this runtime never reads global user state
- Unrelated profile/thread/definition snapshots are rejected

Safe fallback:

- Only for known provider capability/transport failure
- Only when no tool has been dispatched (possible external effects)
- No retry/fallback after a tool call, including a successful write/shell

## SETTINGS_UNSUPPORTED (exact pointers)

Non-default unimplemented features fail closed with `details.pointers`, `details.reasons`, and `details.hostBindings`:

| Pointer | Why | Host binding still required |
|---|---|---|
| `/settings/browser/mode` | No browser adapter in this ownership | Root browser session worker |
| `/settings/delegation/*` | No child-definition runner | Root bounded child runner |
| `/settings/script/executionMode` when `sandboxed` | No sandbox | OS sandbox adapter |
| `/settings/script/allowNetwork` | No network isolation | Network policy enforcer |
| `/settings/script/interpreters` unknown values | Only built-in bash in workspace mode | Additional interpreters |
| `/settings/recovery/stopCondition` | Not implemented | Stop-condition evaluator |
| `/settings/recovery/finalReportTemplate` | Not implemented | Final-report renderer |
| `/settings/workspace/mode`=`dedicated_child_worktree` without a root | Missing authority | `dedicatedWorktreeRoot` |
| `/settings/approval/policy`=`always` without a callback | Auto-approve is never defaulted | `approveToolRequest` |
| Non-default CLI workspace/script/approval | This ownership cannot enforce CLI dispatch | CLI materializers (Sol/root) |

Harmless defaults are not rejected: identity, output language/tone/verbosity/citations, disabled browser, zero delegation, disabled script, inherit approval, thread memory, default context flags.

`error.details` is additive so later CLI capability reports can merge without renaming the field. Unreviewed CLI grants are not assumed to work.

## Tested here

`tests/platformAgentRuntimePolicy.test.ts` uses the real `LlmClient` stream/tool loop with a deterministic local model transport. File and process effects use owned temp roots under `os.tmpdir()` with the `mousse-agent-runtime-policy-` prefix. No live provider, credential, account, channel, or external endpoint is called.

Covered:

- Read-only blocks write and shell; files are not created
- Allowed-root `..` escape and symlink/junction escape; outside bytes are not read or written
- Allowed write and workspace bash actually create files inside the root
- Approval denied / cancelled / stale digest before dispatch; no file is created
- Unrelated profile and thread snapshot rejection
- Current-thread history vs `includeCurrentThread: false`
- Fallback on unknown primary model before any tool; no fallback after a write plus transport failure
- Cumulative cost across a pre-effect fallback attempt
- Zero tool budget; non-finite/negative requested budgets
- Structured `SETTINGS_UNSUPPORTED` pointers; harmless defaults accepted

## Still host-integration work

- Production composition: bind profile-owned `LlmClient`, cancellation owner, durable run/history, and host workspace roots
- Durable approval UI / persisted approval records (this seam only consumes an exact async callback)
- Dedicated child worktree allocation
- Browser, delegation, sandbox, and network isolation implementations
- CLI grant/permission/config materialization (Claude/Codex/OpenCode/Cursor). Those files were not modified
- Main-agent Settings enablement vs definition grants in production (trusted native runs use grants+policy, not Settings → Tools)
- Real provider fallback across data-residency catalogs
- UI tests and packaged qualification (root)

## Limitations

- Workspace-mode bash is cwd-contained and blocked in read-only/disabled-script modes. It is not an OS sandbox; `cd`/arbitrary subprocesses can still leave the tree if script execution is enabled. That case is reported unsupported when `executionMode` is `sandboxed`
- MCP effect class is unknown; unattended mutating MCP is denied. Inherit+attended granted MCP proceeds without a second approval unless policy is `always`
- Token accounting for host snapshots is a UTF-8/4 estimate for `maxContextTokens` truncation only
- Fallback cannot run after any dispatched tool, including a denied-after-start executor throw
