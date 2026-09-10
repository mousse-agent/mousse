# Sol review: Plus authentication and Agent definition domain

## Reviewed range

- Integration base: `dff32f4a7f8873a8e03f208eb554f4f1558860ef`
- Merged core head: `48c56e646f1c5cbfba93a3c30bbb59dba7387657`
- Reviewed merge: `5acc1bb3bba7fb60b40424536b551d920584b04f`
- Plus authentication implementation: `677c97b1ed238b0f48254f27bc9e35a1a6f04eea`
- Agent definition domain implementation: `0b4a7fee035b7578cf805e028d6f0a282c7d86bd`
- Workflow definition/command and canvas changes are present only as merge ancestry and remain separate review passes.

## Findings fixed

1. Control autoconnect ran with no device enrollment token, and RelayClient fabricated a literal `token` admission (or substituted an account access token). This contradicted the new enrollment truth contract and could present an unauthenticated client as enrolled. Autoconnect now requires a server-issued device token, and fallback relay admission fails closed without one.
2. Exact-draft validation converted a stale `expectedDraftHash` into a normal validation result. It now preserves `REVISION_CONFLICT` as a structured domain error so an editor reloads instead of treating concurrency as a definition issue.
3. Agent publication validated dependencies through the resolver, then recomputed lock hashes through a second independently supplied lookup. A mismatched or changing host composition could validate one grant set and publish another. The registry can now accept the exact dependency hashes returned by resolution, and the domain publishes that same validated snapshot.
4. Added replacement-login evidence: a cancelled late desktop exchange followed by a failed replacement leaves existing credentials unchanged. Failed/cancelled CLI attempts likewise preserve existing credentials.

## Verified behavior

- Desktop PKCE uses an ephemeral loopback port, S256 verifier/challenge, timing-safe state comparison, single callback exchange, bounded response bodies and deadlines, escaped HTML, and cancellation before credential persistence.
- Desktop credentials are committed only after both token exchange and device enrollment return validated server values.
- CLI login requires a server-created transaction and server-issued device token, bounds poll intervals/expiry, and cancels its waits and requests.
- Logout, mode change, replacement login, and service stop invalidate pending attempts. Late self-hosted and desktop responses cannot reconnect or persist credentials.
- Agent CRUD is profile-root bound, definition IDs are validated, draft writes and publish use optimistic hashes, model/integration availability is evaluated before publication, visual-only changes do not alter the execution hash, and foreign profile IDs remain inaccessible.

## Remaining gaps

- Hosted and self-hosted authentication still need fixture-service and live-server interoperability qualification. No live account, token, browser session, or channel was used.
- Stored refresh tokens are not consumed by a refresh lifecycle. Hosted access expiry and renewal behavior remain production work.
- Agent definition domain registration, capability admission, renderer profile binding, and structured error preservation still require final MMS/preload/IPC composition.
- Agent try-run has no production executor, abort/disconnect lifecycle, or history. A03 remains open.
- Production model and integration lookups must be live profile-policy adapters. The static lookup fixtures validate the contract only.
- The merged workflow canvas and workflow definition/command bridges were not reviewed in this pass.

## Verification

- `npx vitest run tests/controlAuth.test.ts tests/platformProfileAuth.test.ts tests/controlMmsIntegration.test.ts tests/controlStorage.test.ts tests/controlRelay.test.ts tests/platformAgentDefinitions.test.ts tests/platformAgentDomains.test.ts --maxWorkers=2`
  - 6 matching files passed, 59 tests passed. The requested `controlRelay.test.ts` path does not exist; relay admission behavior is exercised through the control service fixture and wire-vector coverage remains outside this command.
- `npm run typecheck`
  - Node and web TypeScript projects passed.
- `npx vitest run tests/controlWireVectors.test.ts --maxWorkers=2`
  - 1 file passed, 8 wire-vector tests passed.
