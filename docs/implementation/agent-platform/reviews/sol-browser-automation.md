# Sol browser automation manager review

Reviewed integration base: `fd29035c93cf79840cc889a21fcdd1ecbccf912f`  
Reviewed implementation: `c1fc3e269325667aef170130590d100acccec684`  
Reviewed handoff: `91999d6`  
Candidate merge: `d6932ff`  
Review fixes: `cae1c99`, `fce410b`

## Findings fixed

- **Tool-specific grants were ignored.** The manager checked capability and effect arrays but never `ExecutionPolicySnapshot.allowedTools`, so a context granted one browser tool could invoke all tools sharing its capability. Every model-facing operation now checks its exact tool name before contacting the broker.
- **Human handoff used the wrong authority.** `browser_request_human` checked only `browser.session` with a read effect, bypassing its declared `browser.task` capability, external effect, and exact tool grant. It now checks all three against the normalized handoff request. Effects listed in `approvalEffects` fail closed unless the host supplies the policy callback; that callback now receives the exact tool and request so production can bind a durable approval to the actual operation.
- **Profile and returned-session identities were weak.** Construction now requires the platform's canonical UUID-v4 profile identity. A newly opened session must return the exact profile, thread, and optional run identity supplied by MMS. Stored records and returned DTOs are cloned so a caller cannot mutate manager ownership through a returned object reference.
- **Elapsed budgets stopped only later calls.** The manager checked elapsed time before dispatch but allowed the dispatched broker request to run for its independent timeout. Each call now combines caller/profile cancellation with the remaining immutable policy deadline. Exact tool-call budgets remain keyed by run-or-thread plus turn without delimiter collisions.
- **Session inventory writes were non-atomic and followed an unchecked path.** Inventory paths are checked against the injected profile root on load and every write, writes use the repository's durable atomic replacement with private file mode, and malformed or cross-profile/owner-inconsistent inventory fails closed instead of silently resetting live-session knowledge.
- **Shutdown erased recovery evidence and could block once per session.** Failed session closes are retained as `disconnected`, successful closes become `closed`, and closes run concurrently with bounded cancellation before one durable inventory write.
- **The real-browser fixture did not work with the reviewed certified-cache junction and leaked temporary roots when Windows retained a handle.** It now resolves the trusted immutable source before making hard links, uses strict UUID profile identities, retries asynchronous recursive cleanup, and fails on cleanup failure. Repeated final runs left zero `mousse-m01-browser-*` roots.
- **The handoff misstated the model DTO boundary.** It now states that opaque session/tab/observation/ref/control-lease IDs are intentionally returned for follow-up calls, while CDP backend target IDs, filesystem paths, and credentials remain private.

## Verification

The browser fixture used the repository-managed Chrome for Testing binary, hard-linked immutable executable files, loopback pages, and isolated profile/browser/artifact roots. It used no live account, provider, model, network site, or everyday browser profile.

```text
npx vitest run tests/platformBrowserAutomation.test.ts tests/platformBrowserContracts.test.ts tests/platformBrowserWorker.lifecycle.test.ts --maxWorkers=1 --reporter=dot
  3 files, 21 tests passed

npm run typecheck
  passed

npm run build:cli
  passed

post-test Temp inventory
  0 mousse-m01-browser-* roots
```

The five M01 tests include three real managed-Chrome cases and two transport-free authority/storage cases. The real cases open main, child-agent, and workflow sessions against one worker, enforce cross-profile/run ownership, use semantic refs, reject stale navigation state and non-vision coordinate actions, propagate actual wait cancellation, and exhaust an immutable tool-call budget.

## Remaining scope

- Production composition is still required. The host must create one manager for the admitted profile, inject the authoritative `BrowserBroker`, `CancellationRegistry`, approval/policy callback, and durable human-handoff service, then dispose both manager sessions and broker with the profile lifecycle.
- This layer exposes the exact normalized request to the policy callback but does not itself create or consume durable approval records or calculate the approval request digest. The production caller must bind that callback to the same immutable policy snapshot and exact request used for dispatch.
- `maxArtifactBytes` is not enforced by M01. Worker download results contain browser artifact metadata, while the workflow adapter's execution `ArtifactReference[]` projection remains empty. The profile-owned artifact publisher/grant bridge must enforce the policy byte budget, verify ownership, and return authoritative execution artifact references before browser downloads are claimed as workflow artifacts.
- `BrowserExtractArgs.schema` is accepted but not applied or forwarded. Current extraction is bounded untrusted text/structure from the worker; schema-constrained structured extraction remains an adapter capability rather than an implemented M01 guarantee.
- Persisted sessions reload as `disconnected`; automatic broker inventory reconciliation/recovery is not implemented here. Persistent workspace admission also needs the host's profile/project grant policy.
- Native-agent and CLI consumers, workflow coordinator registration, main-agent tool advertisement, GUI viewer/takeover, packaged Electron operation, and non-Windows platforms remain unqualified by this slice.
