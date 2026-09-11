# MCP manager/transport drain for profile archive

Implementation date: 2026-09-11. Worktree `mousse-platform-worktrees/integrations`, branch `feat/platform-integrations-ui`. This slice owns awaited MCP connect/list/call/auth/stdio teardown so a later profile archive/removal can wait on real settlement. It does not bind `MmsProfileServices.stop()`, ProfileHost, protocol, or scheduler, and it does not close P04 or I04.

## Public APIs

```ts
class McpManager {
  beginShutdown(): void
  getActiveCount(): number
  snapshotOwnedWork(): Record<string, number>
  shutdown(options?: { timeoutMs?: number }): Promise<void>
}
```

- `beginShutdown()` is synchronous: it closes admission, broadcasts the manager abort, and starts drain.
- `shutdown()` keeps the legacy no-args signature. `shutdown({ timeoutMs })` is optional. Concurrent callers share the same underlying drain. A completed shutdown is idempotent and does not reopen the manager.
- A timeout or close error retains original ownership for retry. Maps are not cleared to pretend success.
- Default deadline is 30_000 ms. Invalid timeouts throw before waiting.

Internal helpers in `src/mms/integrations/mcp/` (not host APIs): `McpOwnedWork`, `OwnedStdioClientTransport`, `terminateOwnedStdioTree`. Admission uses existing `OwnedWorkBarrier`; raw SDK/connect/close promises are retained until they settle, including after a wrapper abort/timeout.

## Behavior

- New discovery/list/call/auth/connect is rejected after `beginShutdown()`.
- In-flight connect is aborted via the combined manager+caller signal. A raw connect that ignores abort is still tracked; when it finishes the client is closed and is not cached.
- Established connections keep lifetime ownership until close succeeds. Late connections that finish while stopping are closed without caching.
- stdio uses an owned `Transport` implementation that keeps the exact `ChildProcess` handle. Close snapshots descendants with a start key (Linux `/proc` starttime or Windows `CreationDate`), then SIGTERM, then Windows `taskkill /PID <exact> /T /F` (awaited) or Linux SIGKILL of the snapshotted identities. Captured PID alone after handle exit is not used. Descendants must be gone before close resolves.
- Remote HTTP/SSE close aborts local fetch/SSE I/O. Unknown effects on the remote server are not claimed.
- OAuth starts the local `127.0.0.1:8791` callback before SDK `auth()`, passes the manager abort into fetch, awaits callback `close()`, and revokes/unlinks the session if aborted so a late write cannot remain.

## Unsupported platforms

Owned descendant termination supports `win32` and `linux` only. Other platforms, including `darwin`, throw `McpProcessTreeError` (`code: 'mcp_tree_unsupported'`) rather than reporting a successful drain while descendants may still live. POSIX signaling never uses process-group kills.

## Evidence

Focused run, `--maxWorkers=1`:

- `npx vitest run tests/platformMcpLifecycleDrain.test.ts tests/platformIntegrationMcpRuntime.test.ts tests/platformIntegrationIsolation.test.ts tests/platformIntegrationActor.test.ts tests/platformIntegrationDomains.test.ts tests/platformIntegrationLifecycle.test.ts --maxWorkers=1 --testTimeout=20000` — 6 files, 45 tests passed.
  - New drain file: 10 passed, including injected deferred/raw-connect/close-failure/deadline races, local OAuth callback+session write, local HTTP fetch cancel, and a real stdio parent+grandchild holding heartbeat/profile files.
  - Injected races use deferred promises, not sleeps, as proof. Process death is proven with start-key identity checks; a short post-drain heartbeat size check only confirms no further writes.
- `npm run typecheck` — `tsconfig.node.json` and `tsconfig.web.json` passed.
- `npm run build:cli` — run after typecheck; no built CLI was spawned while the bundle was being written.

Fixtures use owned temp roots under `mousse-mcp-lifecycle-`, resolved with `realpathSync.native` and `assertOwnedPath` before cleanup. No live MCP servers, accounts, credentials, or models. No broad process-name kills and no generic Temp cleanup.

## Remaining host binding

Root still owns `MmsProfileServices.stop()` / ProfileHost archive-removal composition, protocol admission, and scheduler completion. Workflow-runtime owns channels/control. Process-lifecycle owns terminal tree review; this helper is MCP-specific and does not copy the unreviewed terminals helper. `previewRemove` must still compose counts from every owner. This checkpoint is not P04, not I04, and not a complete archive-safety claim.
