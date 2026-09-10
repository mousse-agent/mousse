# W01 handoff — workflow format, compiler, registry

Package: **W01**  
Branch: `feat/platform-workflow-runtime`  
Worktree: `mousse-platform-worktrees/workflow-runtime`  
Owner paths only. No orb, protocol, renderer, package.json, or shared aggregator edits.

**Commit SHA:** (filled after commit; see git log `W01:` on this branch)

## What landed

v1 canonical bundle (`workflow.json` + sibling assets + `editor.json` + `workflow.lock.json`), typed node catalog/ports for every architecture §7.3 class, bounded binding/expression AST, `fileInputs` staging declaration, compiler IR, profile-root registry, and the §6.3 `summarize_files` example. Import/compile **never** executes scripts or models.

## Public APIs

### Shared contract — `src/shared/workflows`

| Export | Role |
|---|---|
| `WorkflowManifest`, `WorkflowNode`, `WorkflowEdge`, `WorkflowLimits`, `WorkflowPermissions`, `WorkflowDependencyRef` | v1 manifest |
| `WorkflowBundle`, `WorkflowEditorDocument`, `WorkflowLockDocument`, `WorkflowHeadManifest` | bundle + revisions |
| `WorkflowBinding`, `parseWorkflowBinding` | `{ref:input\|node\|loop}`, `{literal}`, `{secretRef}`, `{template}`, recursive compose |
| `WorkflowExpression`, `parseWorkflowExpression`, `EXPRESSION_OPS` | bounded AST: compare/boolean/arithmetic/coalesce/string/object/array map-filter |
| `WORKFLOW_NODE_CATALOG`, `WORKFLOW_NODE_TYPES`, `getNodeCatalogEntry` | ports, effects, capabilities, versions |
| `BoundedJsonSchema` | allowed keyword set (not full JSON Schema) |
| `WorkflowDiagnostic`, `CompileWorkflowOptions`, `CompiledWorkflow` | compiler IR + diagnostics |
| `canonicalizeJson`, `stableStringify` | key-sorted JSON; semantic hash input |
| `RESERVED_WORKFLOW_SLUGS` | publication rejects built-in command names |
| `WorkflowConcurrencyError`, `WorkflowArchiveUnsupportedError` | registry errors |

Canvas fields live in `editor.json` (and optional `config.ui`). They are stripped from semantic hashing.

### MMS — `src/mms/workflows`

```ts
compileWorkflow(source: unknown, options?: CompileWorkflowOptions): CompiledWorkflow
parseWorkflowManifest(source: unknown): { manifest, diagnostics }

boundedJsonSchemaSubsetValidator.validateDocument(schema)
boundedJsonSchemaSubsetValidator.validateData(schema, data)

evaluateBinding(binding, context)
evaluateExpression(expression, context)  // no eval / Function / host I/O

new WorkflowRegistry({
  profileId: string,       // required, never ambient selected profile
  profileRoot: string,     // required absolute root
  trustedProjectRoots?: { projectId, root }[],
  archiveImporter?: WorkflowArchiveImporter,
  now?: () => Date
})
```

Registry methods: `list`, `discover`, `get`, `getRevision`, `saveDraft`, `publish`, `archive`, `validate`, `importDirectory`, `exportDirectory`, `importArchive`, `watch`.

`saveDraft` / `publish` take `expectedDraftSemanticHash` and `expectedHeadRevisionId` for optimistic concurrency.

Layout: `{profileRoot}/workflows/{uuid}/draft|revisions/{semanticHash}|head.json`.

Discovery of `{project}/.mousse/workflows/**` is **not** enablement and does not run code.

`ZipArchiveImportNotConfigured` is the zip adapter: it **throws** `WorkflowArchiveUnsupportedError` and does not unpack or fake success. Directory packages are the production v1 path.

Hashing: `computeSemanticHash(manifest, executable/instruction/schema assets)` is independent of `computeVisualHash(editor.json)`.

## Test vectors

| File | Coverage |
|---|---|
| `tests/platformWorkflowCompiler.test.ts` | all node types runnable; §6.3 example; duplicate IDs; cycles; missing refs; branch-output misuse; oversized graph; remote/pattern/prototype schema; unsupported-node preservation; reserved slug; unbounded loop; recursive subworkflow; missing capability/dependency |
| `tests/platformWorkflowEvaluator.test.ts` | required expression ops; missing/type errors not coerced; templates; secrets fail closed |
| `tests/platformWorkflowRegistry.test.ts` | explicit profileId/root; publish/export/import roundtrip; visual vs semantic hashes; script-byte hash change; optimistic conflicts; traversal assets; symlink escape; project discovery disabled; zip not faked |
| `tests/platformWorkflowSchema.test.ts` | bounded subset; remote/pattern/recursion/prototype rejection; local `$defs` |
| `tests/platformWorkflowExample.test.ts` | §6.3 bundle, `fileInputs`, instructions, collect.mjs stored not executed |
| `tests/platformWorkflowPaths.test.ts` | relative OK; `..` / absolute / ADS / device rejected |

Run:

```
npx vitest run tests/platformWorkflow*.test.ts
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
```

Last local result: **36 passed**, both tsconfigs **clean**.

Example bundle: `examples/workflows/summarize-files/` (`workflow.json`, `instructions.md`, `scripts/collect.mjs`, `editor.json`, `schemas/report.schema.json`, `fixtures/sample-input.json`, `workflow.lock.json`).

Catalog fixture: `src/mms/workflows/fixtures/allNodeTypes.ts`.

## Required integration (WG0 / consumers)

W01 does **not** wire protocol, CLI, renderer, or `MousseMainService`. Next consumers:

1. **WG0** compose `new WorkflowRegistry({ profileId, profileRoot })` from C1 profile paths. Never read a global selected profile inside this package.
2. **W02** durable engine consumes `CompiledWorkflow` + published `revisions/{semanticHash}`. ScriptRunner must honor `fileInputs` (stage, rewrite, `MOUSSE_INPUT_DIR`). This package only *declares* staging.
3. **V01/V02** editor uses diagnostics from `compileWorkflow`; React Flow state maps to `editor.json` only.
4. **C7** `workflows.list/get/saveDraft/validate/publish/import/export/inspect` should call registry methods; validators stay WG0-owned.

### Dependency requests (do not silent-claim)

| Package | Why | Status |
|---|---|---|
| **`ajv` (direct, pinned)** | Architecture requires a maintained JSON Schema validator. Transitive `ajv` exists under other packages but is not a resolvable direct import. W01 ships `BoundedJsonSchemaSubsetValidator` and **does not claim JSON Schema draft compliance**. | **Ask WG0 to add** |
| **zip library (`yauzl` recommended)** | `.mousse-workflow.zip` import. `ZipArchiveImportNotConfigured` fails closed until pinned. | **Ask WG0 to add** |

Do not treat the bounded subset as ajv. After `ajv` is direct, keep remote `$ref` / `pattern` / recursive schema rejection.

## Limitations

- No run engine, ScriptRunner, approvals, or model/tool dispatch (W02+).
- No slash/CLI ingress (W03).
- Nested loops/parallel/try-catch are **explicit subgraphs** in node config (no raw parent cycles).
- Filter/reduce `item` bindings are expression-evaluator context, not graph loop refs.
- Watcher debounces and re-lists; it never executes assets. Recursive `fs.watch` is best-effort on the host OS.
- Semantic hash ignores `editor.json`, timestamps, and `config.ui|position|canvas`. Changing `scripts/*.mjs`, instructions, or `schemas/` changes it.
- Unknown node types are preserved (`sourcePreserved`) and force `runnable: false`.
- Sandboxed script mode is declared only; absence of a sandbox adapter is a W02 `SANDBOX_UNAVAILABLE` concern.

## Checks

- `npx vitest run tests/platformWorkflow*.test.ts` — 36 passed
- `npx tsc --noEmit -p tsconfig.node.json` — pass
- `npx tsc --noEmit -p tsconfig.web.json` — pass (shared module is renderer-safe; no `node:` imports)

`npm ci --ignore-scripts` was used so Electron postinstall did not download binaries; W01 tests do not need Electron.
