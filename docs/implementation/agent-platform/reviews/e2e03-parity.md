# E2E-03 GUI and CLI slash parity

Reviewed base: `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8`

The focused acceptance fixture publishes one workflow and sends the exact same slash text through an authenticated GUI `orchestrator.send` request and the built `chat` CLI. The two executions use independent threads but the same profile and daemon. The fixture proves both paths select the published definition and revision, consume the same typed arguments, produce the same terminal result and node outcomes, and return the same validation diagnostic for an identical invalid invocation. Invalid commands do not create workflow runs.

The parsed arguments are asserted from the durable start-node trace. The public `WorkflowRunView` currently omits `input`, so its optional DTO field is not suitable as the execution proof.

No production defect was found and no production source changed. This fixture exercises the GUI protocol boundary rather than renderer interaction; E2E-03 specifies invocation parity, so rendering is outside this scenario.

Verification:

- `npm run build:cli` — passed.
- `npx vitest run tests/platformWorkflowCli.test.ts -t "keeps an identical slash invocation equivalent"` — 1 passed, 10 skipped.
- `npx vitest run tests/platformWorkflowCli.test.ts` — 11 passed.
- `npm run typecheck` — node and web TypeScript checks passed.

