# Sol review: MCP, Skills, and integration lifecycle bridge

## Reviewed range

- Integration base: `3eab0bed74480beb5ee21ea44f37e1937d7a9344`
- Merged source head: `c065f58a3db3442ef476ca1f114ced397b4df8b4`
- Reviewed merge: `cfc77cbdbdd315e78a1413637f73bfa2e687b794`
- Backend implementation in that history: `5a6305144f143af1a92344bb4ea41693e5fa5a6e`
- Backend handoff head: `6ce4a68a873878b2eb92433c8ea71ec9f55ff78b`
- This pass reviewed the MCP/Skills backend and integration domain bridge. The Plus and Agent-domain ancestors remain separate review work.

## Findings fixed

1. ZIP limits were checked only after `unzipSync` had inflated every entry. The importer now rejects excessive declared expanded bytes, oversized entries, excessive entry counts, unsafe Windows paths, and case-colliding names in fflate's pre-inflate filter. Actual inflated sizes remain checked afterward.
2. Managed MCP config/archive and skill state parse failures silently became empty documents, allowing a later mutation to overwrite recoverable user data. Lifecycle mutations now fail closed and preserve malformed files.
3. Skill replacement deleted the live package before copying staged bytes. Promotion now renames the existing directory to a sibling backup, atomically renames the validated staging directory into place, and restores the backup if promotion fails. Generic atomic-file replacement also preserves the old file through the Windows replacement fallback.
4. Native skill and MCP paths, skill state/revision/archive paths, and the MCP OAuth directory did not reject escaping symlink/junction chains. They now use the profile storage owned-path guard before reads or writes. A real project junction fixture confirms that package creation does not escape its project.
5. The MCP lifecycle returned a revision derived from a redacted/discovered server while updates compared the stored entry revision. Reads, creates, renames, and expected-revision checks now use the same stored entry hash.
6. MCP name aliases could silently select one of two global/project installations with the same display name. Exact server and installation IDs take precedence; ambiguous names now fail and ask for an installation ID.
7. Tool execution trusted a descriptor captured during discovery. `callTool` now rechecks actor grants and server enablement at call time and refuses descriptors whose config revision changed. `LlmClient` passes its actual main/child actor through this check.
8. Restart matching used substring searches over connection keys, which could close unrelated servers. It now compares exact installation IDs.
9. OAuth revoke depended on an in-memory provider, so restart or deletion could leave a persisted token. Revocation now removes the profile-scoped session directly when the provider is absent. Interactive auth also closes its callback server/listeners on every outcome and removes tokens created by a cancelled attempt.
10. Managed skill create/import now validates the existing state before writing package files, and replacement IDs must identify the exact destination name, scope, and project.

## Remaining gaps

- Project-scoped managed skills use the profile-wide ID/state key `mousse-project:<name>`. The same skill name in two owned projects therefore collides. A durable fix needs a stable project identity in the lifecycle/storage contract and a migration for existing settings/state; the current backend receives only `projectPath`.
- Interactive MCP OAuth still binds fixed `127.0.0.1:8791`; concurrent apps or auth attempts can collide. No external OAuth provider/account was used in this review, so dynamic registration, browser redirect completion, refresh behavior, and provider-side revoke remain unqualified.
- Skill package files and managed state are separate filesystem commits. The implementation now validates state before package mutation and makes replacement rollback-safe, but a later state-write failure can still leave a newly created package for discovery/reconciliation.
- The Codex TOML reader remains its documented bounded subset.
- Full MMS/preload/IPC/profile composition, Integrations UI, I04 CLI materialization, Git URL import, and streaming packages above the protocol caps remain production wiring or later feature work.
- Plus authentication and Agent domain behavior present in the merged ancestry were intentionally not reviewed in this pass.

## Verification

- `npx vitest run tests/integrations.test.ts tests/platformIntegrationDiscovery.test.ts tests/platformIntegrationLifecycle.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/platformIntegrationActor.test.ts tests/platformIntegrationDomains.test.ts tests/llmNativeToolLoop.test.ts tests/llmTextStream.test.ts tests/llmReasoningStreamOptions.test.ts --maxWorkers=2`
  - 9 files passed, 57 tests passed.
  - Includes real stdio MCP `echo`, typed image/resource result, server error, and abort fixtures.
  - Includes profile/domain CRUD and concurrency, malformed-document preservation, revision conflicts, call-time actor/revision fencing, persisted-token revoke, ambiguous aliases, ZIP validation, and a real escaping junction.
- `npm run typecheck`
  - Node and web TypeScript projects passed.
- `npm run build`
  - Main, preload, renderer, and CLI bundles passed. Vite reported the existing daemonShutdown chunking and generated-CSS warnings.
