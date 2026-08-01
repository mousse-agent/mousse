# Mousse Subagent Audit

**Date:** 2026-08-01  
**Scope:** In-app Mousse subagents, external CLI agents, worktree lifecycle, task progress, persistence, integrations, renderer behavior, and CLI management.

## Executive summary

Mousse's subagent architecture is sensible: the orchestrator delegates work into isolated Git worktrees, workers report durable progress, and the parent integrates completed branches. However, the current implementation has several lifecycle and isolation defects. The most serious can silently delete uncommitted agent work or merge a worktree while its agent is still running.

The existing automated suite and TypeScript checks pass, but they do not cover these failure modes.

## How subagents work

1. The parent orchestrator emits a `spawn_agents` action.
2. Mousse validates and deduplicates assignments.
3. It creates a task and an isolated Git worktree for each assignment.
4. Selected MCP and Skill integrations are prepared for the worker.
5. The worker starts in one of three modes:
   - **Mousse GUI agent:** an in-process `MousseAgentService` session using `LlmClient` in Build/subagent mode.
   - **Headless external agent:** a CLI command launched by `HeadlessAgentRunner`.
   - **Interactive external agent:** a CLI launched in a PTY and prompted through a PTY-scoped macro.
6. Workers update `.mousse/task-progress.json` with working, completed, or failed status.
7. Completed workers become `ready`; when every agent in a delegation batch finishes, Mousse wakes the parent orchestrator.
8. A parent `complete_task` action merges eligible branches and closes worker sessions.

## Findings

### Critical: uncommitted work can be silently deleted

`WorktreeManager.mergeAndRemove()` merges an agent branch and then force-removes its worktree without first checking whether the worktree contains uncommitted or staged changes.

Relevant code:

- `src/mms/worktree/WorktreeManager.ts:100`
- `src/mms/worktree/WorktreeManager.ts:136`

If an agent reports completion without committing, Git can report the branch as already up to date. Mousse then considers the merge successful and executes `git worktree remove --force`, destroying the uncommitted implementation.

This behavior was reproduced in a temporary test.

**Recommended fix:**

- Refuse integration when `git status --porcelain` is non-empty.
- Verify that intended changes are committed before removing the worktree.
- Never force-remove a dirty worktree as part of a successful merge path.
- Keep the agent `ready` and surface a recoverable error instead.

### Critical: running agents can be merged before they are stopped

`completeTask()` considers nearly every status except `failed` eligible for finalization, including `starting` and `running`.

Relevant code:

- `src/mms/orchestrator/OrchestratorService.ts:82`
- `src/mms/orchestrator/OrchestratorService.ts:1225`
- `src/mms/orchestrator/OrchestratorService.ts:1277`
- `src/mms/orchestrator/OrchestratorService.ts:1310-1317`

The worktree is merged before the worker is stopped. For GUI agents, removing the session does not abort its active LLM stream or tool loop. Consequently, Mousse can merge partial work, delete an active worktree, or allow tools to continue against a removed directory.

**Recommended fix:**

- Enforce an explicit state machine.
- Normal integration should accept only `ready` agents and conflict retries.
- A forced stop should abort or kill the worker first, await termination, inspect the worktree, and only then optionally merge it.
- Give every Mousse GUI session its own `AbortController`.

### High: messages sent to a busy Mousse agent are silently dropped

The renderer awaits `mousseAgent:send`, but the IPC handler returns as soon as it starts the service call. The renderer therefore clears its loading state while the agent is still running.

Relevant code:

- `src/main/ipc/registerIpc.ts:286-293`
- `src/mms/orchestrator/OrchestratorService.ts:1327`
- `src/mms/agents/MousseAgentService.ts:235`
- `src/renderer/components/MousseAgentChat.tsx:219-223`

If the user sends another message, `MousseAgentService.send()` silently returns because the session is busy. The composer has already cleared the user's text, so the message is lost without feedback.

This behavior was reproduced in a temporary test.

**Recommended fix:**

- Return the actual `Promise` from the service through IPC.
- Alternatively, return an explicit `accepted | busy | missing` result.
- Keep the composer busy until an `idle`, `complete`, or failure event arrives.
- Queue follow-up messages or preserve rejected text in the composer.

### High: completed GUI tabs can remain visible but dead

When a Mousse subagent emits `complete_task`, `MousseAgentService` deletes its session after marking the agent `ready`.

Relevant code:

- `src/mms/agents/MousseAgentService.ts:336`
- `src/renderer/components/AgentsPanel.tsx:17-23`

The Agents panel continues to show `ready` GUI agents, but subsequent sends find no session and silently do nothing. The existing component may retain messages locally, while a remount shows an empty “Starting agent…” view.

**Recommended fix:** disable the composer for ready/completed sessions, preserve the transcript, and retain a resumable session until integration or explicit closure.

### High: GUI sessions do not survive restart or thread switching

Mousse GUI transcripts and Pi-native histories exist only in the in-memory `sessions` map.

Relevant code:

- `src/mms/agents/MousseAgentService.ts:36`
- `src/main/data/ThreadContext.ts:74-91`

Agent and task metadata are persisted, but GUI session history is not. After restart, an agent can still be recorded as `running` while no corresponding Mousse session exists.

Thread switching creates additional problems:

- Interactive PTYs are killed without marking their agents failed or interrupted.
- A GUI agent may finish while another thread's registry is loaded, so its completion cannot update its original task.
- Delegation batches and automatic wake queues are memory-only.
- A queued wake can run after a thread switch and affect the wrong active thread.

**Recommended fix:** associate every runtime session/event with a thread ID, persist GUI transcripts/native context, and reconcile interrupted sessions explicitly during restoration.

### High: parallel Cursor-backed Mousse agents share mutable global scope

Cursor project scope is stored as mutable process-global state.

Relevant code:

- `src/mms/providers/cursorPiProvider.ts:49-61`
- `src/mms/orchestrator/LlmClient.ts:883-887`

Parallel agents prepare requests for different worktrees while changing and resetting the same Cursor session scope. One agent can reset another's session or start a request under the wrong worktree scope.

**Recommended fix:** use a stable per-agent Cursor session key and avoid global `process.chdir()` for concurrent requests. If the provider cannot support request-local scope, serialize Cursor-backed turns.

### High: Mousse MCP and Skill exposure settings are not honored

Mousse subagents run in Build mode, and Build mode explicitly receives no MCP tools.

Relevant code:

- `src/mms/orchestrator/LlmClient.ts:885`
- `src/mms/orchestrator/LlmClient.ts:943`

Skill loading is gated by `enableForMainAgent`, not `enableForAgents.mousse`. The generated `.mousse` CLI-style configuration does not correct this because the in-app Mousse agent calls `LlmClient` directly.

**Recommended fix:** pass an explicit principal such as `main | subagent:<type>` into integration discovery and enforce the appropriate per-agent settings there.

### High: generated external-agent MCP secrets are not supplied

`AgentConfigManager` replaces literal environment variables and headers with environment references, but the generated agent environment remains empty.

Relevant code:

- `src/mms/integrations/agents/AgentConfigManager.ts:38`
- `src/mms/integrations/agents/AgentConfigManager.ts:268-271`

Generated MCP configurations can therefore reference variables that are never passed to the child process.

**Recommended fix:** populate `AgentConfigPreparationResult.env` while replacing each secret and define collision behavior for identically named variables from different servers.

### Medium: agent exit handling is incomplete

- Interactive PTY exits do not update agent or task status.
- A successful headless exit without a progress update can leave the agent `running` indefinitely.
- `HeadlessAgentRunner` has no child-process `error` listener.
- The delayed interactive startup timer can change an already finalized agent back to `running`.
- Early interactive failure does not consistently stop progress monitoring or complete its delegation batch.

Relevant code:

- `src/mms/terminals/PtyManager.ts:78`
- `src/mms/terminals/HeadlessAgentRunner.ts:63`
- `src/mms/orchestrator/OrchestratorService.ts:228`
- `src/mms/orchestrator/OrchestratorService.ts:1192-1203`

**Recommended fix:** centralize PTY/headless/GUI exit events in one state-transition handler and make delayed callbacks conditional on the agent still being in `starting` state.

### Medium: spawn failures can leave orphan state

Exceptions after worktree creation—such as integration preparation, command construction, or process startup failures—are not handled as one transactional spawn operation. They can leave an in-progress task, generated configuration, branch, or worktree without a usable agent record.

**Recommended fix:** wrap each assignment in a transaction-like `try/catch/finally` and roll back every allocated resource on failure.

### Medium: documented CLI agent management does not load or persist agent state

`mousse-cli agents list`, `stop`, and `spawn` create a fresh `MousseMainService`, but do not load the active thread's agents/tasks or install persistence callbacks.

Relevant code:

- `src/cli/commands/agents.ts:24-79`
- `src/cli/mmsContext.ts:64`
- `src/main/data/ThreadContext.ts:206-208`

As separate invocations, `list` and `stop` generally see an empty registry, while `spawn` does not durably save the new agent metadata despite being documented as background management.

**Recommended fix:** either manage agents through a long-running MMS daemon/IPC endpoint or load and atomically save the selected thread state in every CLI command.

### Low: progress validation accepts non-finite values

`Number(update.progress)` can produce `NaN`, which survives clamping and can appear as `NaN%` before being serialized as `null`.

Relevant code:

- `src/mms/tasks/TaskProgressMonitor.ts:68`
- `src/mms/tasks/TaskQueue.ts:70`

**Recommended fix:** require `Number.isFinite()` and ignore or reject invalid values.

### Low: renderer and scrollback resources are retained

Completed interactive agents are filtered out of the UI, but their xterm instances and wrapper elements are not disposed. PTY and headless scrollback buffers are also unbounded.

**Recommended fix:** dispose xterm instances on agent removal/completion and cap or ring-buffer persisted scrollback.

## Verification performed

- `npm run typecheck` — passed.
- `npm test -- --reporter=verbose` — 40 test files and 173 tests passed.
- Temporary focused tests reproduced:
  - silent loss of a follow-up GUI-agent message while a turn is running;
  - destruction of uncommitted work after a no-op merge followed by forced worktree removal.
- Temporary audit test files were removed after execution.

## Recommended implementation order

1. Protect worktree data: clean-worktree check and no forced removal of dirty work.
2. Enforce lifecycle states and stop/abort workers before integration.
3. Repair GUI send acknowledgment, busy handling, and cancellation.
4. Make runtime sessions thread-owned and restart-safe.
5. Isolate or serialize Cursor-backed agents.
6. Correct MCP/Skill exposure and secret environment generation.
7. Centralize exit handling and transactional spawn cleanup.
8. Make CLI agent commands operate on durable/shared state.
9. Add lifecycle, concurrency, and recovery tests.

## Suggested regression tests

- Refuse merge when a worktree has staged or unstaged changes.
- Never finalize `starting` or `running` agents through normal `complete_task`.
- Abort and await a GUI tool loop before removing its worktree.
- Queue or reject a second GUI message without losing its text.
- Restore or explicitly interrupt a GUI agent after application restart.
- Complete an agent while another thread is active without cross-thread mutation.
- Run two Cursor-backed agents concurrently with distinct worktree scopes.
- Verify per-agent MCP/Skill toggles independently of main-agent toggles.
- Verify generated MCP secrets are present in child environment variables.
- Mark PTY and headless exits deterministically.
- Roll back worktree, task, and generated config after every spawn-stage failure.
- Confirm CLI `spawn`, `list`, and `stop` work across separate processes.
