# W02/W03 handoff — durable workflow runtime

Package: **W02/W03** (format gap-close + engine). Not G3 until root wires app/CLI ingress.  
Branch: `feat/platform-workflow-runtime`  
Frozen modules left untouched: `src/mms/execution/ExecutionPolicyService.ts`, `CancellationRegistry.ts`, `src/shared/execution/**`, `src/shared/browser/**`.

**Commit SHA:** `4d53c47041d2c4113fd22af0c331ca970e8434ea`

## W01 files changed in this package (reconcile with Sol review)

Root should re-review these W01 paths; they were updated to consume pinned `ajv@8.20.0` and `fflate@0.8.3`:

- `src/shared/workflows/schema.ts` — document Ajv2020 supported subset vs restricted keywords
- `src/shared/workflows/diagnostics.ts` — `RESTRICTED_SCHEMA_KEYWORD`
- `src/shared/workflows/jsonPointer.ts` — `setJsonPointer` for fileInputs rewrite
- `src/shared/workflows/index.ts` — runtime/adapter/public exports
- `src/mms/workflows/schema/boundedJsonSchema.ts` — **Ajv2020 instance validation** + subset walk
- `src/mms/workflows/archive.ts` — **fflate ZIP** importer/exporter; `ZipArchiveImportNotConfigured` remains for explicit tests
- `src/mms/workflows/registry/WorkflowRegistry.ts` — default `FflateZipArchiveImporter`, `exportArchive`
- `src/mms/workflows/index.ts` — engine exports
- `tests/platformWorkflowSchema.test.ts`, `platformWorkflowRegistry.test.ts`, `platformWorkflowCompiler.test.ts`

No package.json/lock edits (root already pinned ajv/fflate/yaml).

## APIs

### Schema

`WorkflowJsonSchemaValidator` / `workflowJsonSchemaValidator` (alias `boundedJsonSchemaSubsetValidator`):

- Walks schema: bounded depth/size, local `#/$defs` only, prototype keys rejected
- Restricted keywords (`pattern`, `oneOf`, remote `$ref`, `$dynamicRef`, …) emit **exact** `RESTRICTED_SCHEMA_KEYWORD` or `REMOTE_SCHEMA_REF`
- Instance data is compiled/validated by **Ajv2020**. Not a claim that every JSON Schema document is supported.

### ZIP

`FflateZipArchiveImporter.extractToStaging` — bounded compressed+expanded totals, per-entry bytes, entry count, path/ADS/device/absolute rejection, duplicate and case collision, no symlink execution. Import never runs scripts. Directory import/export unchanged. `registry.exportArchive` / `exportWorkflowZip`.

### Runtime

```ts
new WorkflowRunService({
  profileId,            // required
  profileRoot,          // required
  registry,             // WorkflowRegistry for same profileId
  policy: ExecutionPolicyService,       // frozen C4
  cancellation: CancellationRegistry,   // frozen C4
  adapters?: WorkflowExecutionAdapters, // no silent fakes
  clock?, faults?, now?
})
```

Implements `WorkflowRuntimePort`: `start`, `list`, `get`, `trace`, `pause`, `resume`, `approve`, `answer`, `cancel`, `tick`, `subscribe`.

`start` pins published `definitionId+revisionId` (or slug→head), validates input with Ajv, copies bundle into `{profileRoot}/workflow-runs/{runId}/bundle` (pin-while-edited), journals `attempt-prepared` + idempotency key before effectful dispatch.

States: `queued|running|waiting-approval|waiting-input|waiting-condition|succeeded|failed|cancelled|interrupted|unknown-effect`.

Scripts are classified **unknown** (manifest.effect cannot grant authority). `ExecutionPolicyService` always puts `unknown` in `approvalEffects`, so trusted-local scripts pause for durable `ApprovalService` (exact run/profile/actor/node/attempt/revision/policy/digest). Sandboxed mode uses `SandboxAdapter`; default `UnconfiguredSandboxAdapter` fails `SANDBOX_UNAVAILABLE` and does **not** downgrade.

### Adapters (injected; missing = `executor_unavailable`)

| Node | Adapter |
|---|---|
| script | `ScriptRunner` (real spawn) + optional `sandbox` |
| agent, instruction | `agent` |
| tool | `tool` |
| mcp-tool | `mcp` |
| load-skill | `skill` |
| browser-* | `browser` |
| fileInputs / workspace files | `workspace` |
| write-artifact / render-report | `artifacts` or built-in `FileArtifactStore` |

Deterministic nodes actually execute: start/end, transform/select/filter/reduce/format, condition/switch, for-each/bounded-repeat, parallel/join, try-catch/finally/fail, delay/wait-for-condition, ask-user, prompt-template, read-input, artifacts. Note/group are skipped.

### ScriptRunner

`src/mms/execution/ScriptRunner.ts` — argv arrays, scrubbed env, JSON stdin/stdout, bounded bytes/time, AbortSignal + Windows `taskkill /T` process-tree kill. `fileInputs` staged into run-private `staging/{destination}`, rewrite **only** declared JSON pointers, `MOUSSE_INPUT_DIR` set. Links/escapes/undeclared raw paths rejected.

### Approvals

`src/mms/execution/ApprovalService.ts` — atomic JSON records, consume-once, expiry, digest mismatch, revoke on cancel.

## Root bridge (G3)

1. Construct per-profile `WorkflowRegistry` + `WorkflowRunService` with C1 `profileId`/`profileRoot`. Never ambient selected profile.
2. Wire C7 `workflows.*` and slash/CLI to `WorkflowRuntimePort.start({ source: 'gui'|'cli'|'schedule'|'channel', definitionId/slug, revisionId, input, threadId, projectId, installationPolicy, actor })`.
3. Register real agent/tool/MCP/skill/browser adapters from A01/I01/M01 when those packages land. Until then those nodes fail closed with executor unavailable.
4. Slash tokenizer / ChannelRouter / scheduler stay WG0. This package only publishes typed trigger payloads and the port.
5. Do not create a second model loop; agent adapter must call existing native/CLI contracts.
6. Policy intersection is already `ExecutionPolicyService.snapshot(installation, run, ...)`. Imported `permissions`/`effect` are requests only.

**ExecutionPolicyService / CancellationRegistry:** no changes required. Unknown-always-approval is the trusted-local gate. Cancellation IDs are stored on the run and passed to ScriptRunner; OS process kill is in `killProcessTree`.

## Tests (50 passed)

| File | Evidence |
|---|---|
| `platformWorkflowRuntime.test.ts` | **real collect.mjs** e2e, staged `a.txt`/`b.txt` → `{ summary: "alpha\\n\\nbeta" }`; traversal reject; pin-while-edited; dispatch-fault unknown-effect no replay; A/B isolation; missing agent adapter; delay via fake clock; catalog loops/joins |
| `platformScript.test.ts` | Node spawn JSON contract; abort child; sandbox fail-closed |
| `platformApproval.test.ts` | consume-once; expired |
| `platformWorkflowSchema.test.ts` | Ajv2020 subset + exact restricted-keyword diagnostics |
| `platformWorkflowRegistry.test.ts` | fflate zip roundtrip without executing scripts |
| existing compiler/evaluator/example/paths | still pass |

```
npx vitest run tests/platformWorkflowCompiler.test.ts tests/platformWorkflowEvaluator.test.ts tests/platformWorkflowExample.test.ts tests/platformWorkflowPaths.test.ts tests/platformWorkflowRegistry.test.ts tests/platformWorkflowSchema.test.ts tests/platformWorkflowRuntime.test.ts tests/platformScript.test.ts tests/platformApproval.test.ts
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
```

## Remaining constraints (not G3)

- Root must wire protocol/CLI/composer and real agent/MCP/browser executors.
- Nested waits inside subgraphs are not inline-durable (fail rather than fake success).
- Parallel first-success cancellation of in-flight branches is best-effort via AbortSignal; join currently consumes parallel node output after all launched branches in this slice (policy field is accepted).
- No live accounts, network, or model calls in default tests; agent fixture is an explicit counter adapter, not a production executor.
- YAML import adapter was not added (canonical JSON remains the runtime).
