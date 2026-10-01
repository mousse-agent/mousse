# Sol review: agent CLI materialization

Reviewed base: `84ff78eb3ec08ba9c5ad5bd2889566150b4a8bec`  
Candidate implementation: `f7c69d9401d695280cc48534492aa34eae4e4722`  
Candidate shared DTO follow-up: `09758caad2aa7d2b6c3eff9f5e2637435ba7ddc9`  
Candidate handoff head: `8f9e4af`  
Integration merge: `0352039`  
Review fix: `406018e`

## Findings fixed

- The candidate treated copied Skill packages as consumed grants, although none of the inspected CLIs exposes a qualified exact Skill allowlist. Skill grants now fail closed for every CLI.
- Codex, Cursor, and OpenCode could qualify with an empty grant list while retaining unrestricted built-in capabilities. They now fail closed. Claude remains the sole potentially qualified CLI through its exact `--tools` and `--allowedTools` surfaces.
- Claude MCP authorization was reconstructed from grant names and could diverge from collision-renamed materialized server names. `AgentConfigManager` now returns the authoritative stable-grant-to-runtime-name mapping.
- Materialization errors were outside the spawn gate. Error diagnostics now enter capability inspection and block invocation.
- Marker-shaped pre-existing Cursor/OpenCode files could be overwritten. Runtime materialization refuses every pre-existing path; cleanup deletes only byte-identical content written by this invocation.
- A failed second materialization step could leave files from the first. Preparation registers cleanup before recursive copies and rolls back partial configuration/runtime output on failure.
- Granted Skill roots could traverse symlinks or copy unbounded trees. Preflight rejects symlinks and non-file nodes and bounds packages to 10,000 files and 100 MiB.
- Claude and Codex placed the user prompt in argv. Both now consume it over stdin.
- OAuth MCP materialization outside Mousse and Codex legacy SSE incompatibility now produce blocking diagnostics.

## Remaining blockers and limits

- Production `AgentExecutionService` still flattens `CliCapabilityError` into a generic runtime error. The native-runtime workgroup owns that catch path and must preserve `CLI_CAPABILITY_UNSUPPORTED` plus the report in `error.details`.
- No provider or real agent CLI was invoked. Installed help establishes flags and missing allowlists; a local Node child proves argv/stdin/config transport and cleanup only.
- Exact Claude MCP mapping has not been exercised through a real Claude-to-fixture-MCP call.
- External CLI stdout does not provide authoritative tool history or token/cost usage.
- CLI children inherit the host environment. Production composition still needs a minimal, profile-owned credential environment.
- Skill preflight and recursive copy are separate filesystem operations, leaving a local mutation race. The coordinator must serialize materialization for one agent ID because cleanup ownership is keyed by that ID.
- Legacy invocation builders remain exported. Production callers must use the qualified builder/runtime at the spawn boundary.

## Validation

```text
npx vitest run tests/platformAgentExecution.test.ts tests/platformIntegrationMaterialization.test.ts tests/platformAgentCliMaterialization.test.ts --maxWorkers=2 --reporter=dot
  3 files, 21 tests passed
npm run typecheck
  passed
npm run build:cli
  passed
git diff --check
  passed (line-ending conversion notices only)
```

This checkpoint qualifies the fail-closed materialization seam. It does not qualify live provider execution, production composition, native fallback, or external-CLI accounting.
