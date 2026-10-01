# Sol review: native Agent Editor production execution

Reviewed candidate: `5989f036c5fb8cb516fd071c26824efb69e9ce4a`

Review base merged before qualification: `fcc9afd0125d685a8550141002026113b14c4715`

## Result

Qualified after fixes. The framed `agentDefinitions.tryRun` path now executes an exact resolved revision through the existing native runtime in a profile-owned scratch workspace and records its canonical thread transcript and durable run result.

The review fixed these production defects:

- A shared `LlmClient` had captured the orchestrator constructor's initial `TaskQueue`. Definition runs now construct the client inside the admitted thread session and bind task tools, project lookup, question service, and callbacks to that session. A framed test proves `create_task` mutates only the Try Run thread queue.
- `ask_user` could remain pending beyond the agent's elapsed-time budget. The native plan-tool wait now observes its run signal and dismisses questions for that run's unique thread.
- Approval prompts truncated serialized arguments. Arguments must now fit the review bound in full and match the dispatch digest; otherwise the request is durably denied without presenting an incomplete approval.
- Recovery trusted weak record identity. Run records now carry a canonical SHA-256 integrity field and recovery validates run/profile/thread/definition/revision/runtime lineage before changing `running` to `interrupted`.
- Selected project files appeared supported even though Try Run owns a new empty scratch workspace. Such definitions now fail with `SETTINGS_UNSUPPORTED`, and successful results explicitly describe the isolated, unbound workspace.
- Definition lookup errors raised during profile service admission escaped the domain error mapper. The registration boundary now maps those errors consistently; a cross-profile Try Run returns `AGENT_NOT_FOUND` without exposing another profile's definition.

## Verification

- `npm run typecheck` — passed both node and web TypeScript projects.
- `npx vitest run tests/platformAgentProductionExecution.test.ts tests/platformAgentExecution.test.ts tests/platformAgentRuntimePolicy.test.ts tests/platformAgentDomains.test.ts --reporter=dot` — 4 files, 42 tests passed.
- `npm run build:cli` — passed; generated `out/cli/index.js`.
- `git diff --check` — passed (Git emitted only the repository's expected LF-to-CRLF checkout notices).

The six framed production cases use a real `MousseMainService`, profile host, protocol server/client, agent registry/resolver, orchestrator, `AgentExecutionService`, native runtime, and `LlmClient`. Only provider authentication/stream transport is deterministic. They cover exact published revision pinning after a draft change, a real file effect in scratch, run-thread task isolation, cross-profile definition isolation, full approval ask/answer, fail-closed oversized approval data, raw cancellation settlement during run-owner drain, deadline cancellation of `ask_user`, explicit CLI/browser/memory/selected-file rejection, and restart interruption without provider replay. The lower-level policy suite covers read-only write denial and effect containment.

## Remaining host requirements

- Try Run has no public list/get/cancel methods. The host can drain all profile runs, but the editor cannot target one run. This review intentionally did not add a new RPC surface.
- Try Run has no selected project binding. It uses an isolated empty scratch directory, so selected files are rejected instead of being read from an ambient checkout.
- Browser, persistent profile-agent memory, and external CLI execution remain explicit unsupported settings until their qualified host bindings are composed.
- Profile lifecycle composition must call `platform.agentRuns.beginShutdown()`, include `getActiveCount()` in active-work accounting, and await `platform.agentRuns.dispose()`. That wiring is owned by the profile lifecycle integration change and was not duplicated here.
