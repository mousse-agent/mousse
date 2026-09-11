# Sol agent execution review

Reviewed integration base: `40097d3924a0decbf1285bc9c0f3b193c10a7ead`  
Reviewed candidate: `047ff7b1ebfbc2e6c5617e098fbfb30a21b49184`  
Candidate merge: `3a6e2372b3243709c6b3932ff061bfd1e6c7213f`  
Review fix: `c67ca49963ee1f5bae31812714d8fe8c17381117`

## Findings fixed

- **The native execution seam bypassed profile actor gates.** The candidate's trusted grant filter was merged with the profile-injected integration resolver. Native definition runs now pass an explicit `agent:mousse` actor containing the resolved Skill, MCP server, and MCP tool identities through discovery, authorization, and dispatch. Stable installation IDs are accepted alongside registry IDs; main-agent settings cannot become the native child authority by default.
- **Resolved dependencies could change before execution.** Granted Skill content is now checked against the resolved content hash/revision before it enters the system prompt. MCP descriptors must retain the resolved installation identity and config revision. Changed dependencies fail before a provider request rather than silently executing new bytes/config.
- **Cost enforcement was per response while reporting only the last response.** A multi-turn tool loop could spend more than `maxCostUsd` when every individual response stayed below the limit. Trusted runs now accumulate all provider token and cost fields, enforce the total, and return the same aggregate usage.
- **Structured output was advisory.** `json` and `schema` definitions could complete with non-JSON or schema-invalid text. The execution service now parses JSON and validates schema output with strict Ajv, returning `OUTPUT_INVALID` while retaining the exact text/history for diagnosis.
- **CLI capture and cancellation were unbounded.** Child stdout/stderr could exhaust memory, abort during asynchronous invocation resolution could still spawn a process, and cancellation targeted only the direct child. Capture is bounded, abort is rechecked before spawn, and cancellation/output overflow terminate the process tree (with a detached process group on non-Windows hosts).
- **Claude's `--allowedTools` was treated as a tool boundary.** That flag grants permission without limiting tool availability. The builder now supplies the exact `--tools` surface, requires an exact runtime-name mapping for every granted MCP tool, uses strict MCP config, disables incidental slash-command loading, and runs bare/non-persistent. Codex uses ephemeral/ignored-user-config workspace-write defaults. Cursor no longer receives unrestricted `--force` merely because a rules file was supplied.
- **Runtime error history could place the user after assistant/tool entries.** A missing source user entry is now prepended, preserving transcript order.
- **The candidate made execution mandatory in every definition-domain service.** Production profile composition does not attach execution yet and failed TypeScript integration. The service remains optional until the host explicitly supplies native/CLI bindings; `createAgentDefinitionServices` still constructs it when requested.

## Verification

No provider request, live account, stored channel, model, MCP endpoint, or external agent run was used. The provider fixture exercises the real `LlmClient` stream/tool-loop code with a deterministic local stream. The CLI process fixture executes the local Node binary only.

```text
npx vitest run tests/platformAgentExecution.test.ts tests/llmNativeToolLoop.test.ts tests/providerStreamStall.test.ts tests/platformAgentDefinitions.test.ts --maxWorkers=2 --reporter=dot
  4 files, 47 tests passed

npm run typecheck
  passed

npm run build
  passed (existing daemonShutdown chunk and CSS optimizer warnings remain)
```

The fixtures prove exact system/user channel separation, actor grant propagation, rejection of forged unadvertised tools, aggregate cost and tool/turn/deadline stops, provider-stream abort, structured result validation, bounded child output, cross-profile rejection, and preservation of exact user input. Local help was inspected for installed Claude Code `2.1.214`, Codex CLI `0.154.0`, and Cursor Agent `2026.07.23-e383d2b`; the installed OpenCode command shim is malformed and could not be treated as consumption evidence.

## Remaining scope

- Native production composition must bind the profile-owned `LlmClient`, integration registries, cancellation owner, and durable run/history coordinator. This checkpoint qualifies the adapter seam and deterministic provider loop, not a live production model invocation.
- Resolved fallback models are carried in the runtime input but are not attempted. A safe fallback policy must distinguish pre-dispatch provider failure from a failure after tool side effects; naive replay would be unsafe.
- Codex, OpenCode, and Cursor still need runtime-specific, profile-owned permission/config materialization that enforces exact built-in and MCP grants. Claude additionally needs the host's exact MCP runtime-name map and isolated credential environment. The invocation builders do not qualify arbitrary installed CLIs as honoring Mousse grants.
- External CLI stdout is currently treated as final text and does not project authoritative tool history or token/cost usage. Only elapsed time is universally enforced; CLI-specific tool/token/cost budgets remain open.
- The current Cursor option asserts that a rules path was prepared but does not itself install or verify that path in the isolated worktree. OpenCode config consumption and the local Windows shim require an actual clean-install fixture. No native/CLI runtime beyond the local Node transport fixture was executed.
- This review does not close A03, the full implementation goal, or any release gate.
