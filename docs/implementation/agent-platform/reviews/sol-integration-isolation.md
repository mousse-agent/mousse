# Sol integration isolation and materialization review

Reviewed integration base: `bac3959fafb23459d740381da219d085097f4704`  
Reviewed candidate: `3c20a033ba639a08dd3ccbbcdca70ed8018df4ae`  
Candidate merge: `96712bd`  
Review fix: `046ae84`

## Findings fixed

- **Same-name external discoveries shared a grant identity.** Project Skill and MCP installation IDs omitted their source, so an explicit grant for a `.mousse` item could also authorize a Cursor item with the same display name. External identities now include stable project and source provenance. Global external Skills also receive stable path/source identities instead of being impossible to grant explicitly. The isolation fixture creates equal-name `.mousse` and Cursor Skills and MCP servers and proves one exact ID selects only one item.
- **Materialization overwrote malformed user configuration shapes.** A pre-existing string or array in `mcpServers`/`mcp` was silently replaced with an object. Materialization now emits an unsupported-capability diagnostic and leaves that file byte-for-byte unchanged.
- **Cleanup could erase edits made after materialization.** Generated keys were deleted by name, and a newly created file was removed unconditionally, even if a user or another process changed it. Each config cleanup record now binds the exact before/written snapshots. Cleanup restores or removes only when the current bytes still equal the owned write; otherwise it preserves the changed file and reports that decision.
- **Config updates were written directly.** Agent MCP materialization and exact restoration now use the existing atomic replacement helper, preventing readers from observing partial JSON or TOML.
- **Remembered cleanup and write paths used only lexical containment.** MCP destinations, Skill destinations, and every recursive cleanup are now revalidated with the symlink-aware profile path guard immediately before use. A directory link cannot redirect a generated write or recursive removal outside the agent worktree.
- **Repeated preparation of one agent discarded its prior cleanup record.** Preparation now first cleans that agent's prior owned materialization before recording the replacement.

## Verification

All fixtures use temporary profile, repository, worktree, and config roots. No live integration, CLI process, account, credential, or network endpoint was used.

```text
npx vitest run tests/platformIntegrationIsolation.test.ts tests/platformIntegrationMaterialization.test.ts --maxWorkers=2 --reporter=verbose
  2 files, 8 tests passed

npx vitest run tests/integrations.test.ts tests/platformIntegrationActor.test.ts tests/platformIntegrationDiscovery.test.ts tests/platformIntegrationDomains.test.ts tests/platformIntegrationIsolation.test.ts tests/platformIntegrationLifecycle.test.ts tests/platformIntegrationMaterialization.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/llmNativeToolLoop.test.ts tests/llmTextStream.test.ts tests/llmReasoningStreamOptions.test.ts --maxWorkers=2 --reporter=dot
  11 files, 65 tests passed

npm run typecheck
  passed
```

The fixtures prove two profiles can manage the same repository without sharing package/config bytes, exact grants do not fall back to display names, equal names remain distinct across projects and external sources, connection keys include profile ownership, all five configured agent formats preserve unrelated content, literal secret values move to the returned environment, cleanup restores unchanged user files, and changed or malformed files are preserved.

## Remaining scope

- These are filesystem materialization fixtures. They do not prove that installed native Mousse, Claude, Codex, OpenCode, or Cursor CLI versions consume every generated convention or environment reference.
- Cleanup ownership is process-memory state for ephemeral agent worktrees. Durable recovery of materialization cleanup after a host crash is not implemented.
- External project files remain read-only discoveries and require an exact actor grant. Production actor and profile composition is reviewed separately; this checkpoint does not claim the renderer or live CLI wiring.
