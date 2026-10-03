# P1 independent foundation review

Date: 2026-10-03. Scope: the identity, durable store, transport/mux and authenticated sync foundation on `codex/issue-44-mousse-net`. I continued the recovered thread's independent Astra and Sol 6.1 reviews at extra-high effort. Neither reviewer edited implementation files or wrote to GitHub.

## Verdict and independent evidence

Both reviewers returned: **Ready for the reviewed P1 foundation checkpoint**, with no remaining concrete blocker in their final inspected paths.

Sol independently verified 14 selected post-fix checks: four storage, three identity (including actual process kills), five composed sync, and two cross-service corruption cases. Sol reproduced the unbounded snapshot activation, identity crash lock, roster handshake overflow, stale blob references and corruption write bypass before their corrections. Its source review also checked staging guards, batch accounting and aggregate transfer bookkeeping.

Astra independently reproduced four final session lifecycle failures and verified closure: publication during snapshot staging, cancellation before admission, cancellation during a started send, and delivery after unsubscribe. Its final selections passed five tests. Earlier review reproduced same-position snapshot replacement, old valid renewal rejection, raw transport error classification and stalled snapshot-reader growth. I incorporated those corrections and their focused regressions before final review.

I verified the final changed mux/sync code in one focused run: 47 tests passed (20 mux, 27 sync). I also ran the source Node typecheck and scoped strict TypeScript check for both test files. I retained passing identity/storage/link evidence rather than repeating unchanged suites. The earlier web check covers the unchanged browser/shared surface. No full suite was run.

## Corrected boundaries

I preserved committed position identity and hashes across snapshot generations. Snapshot append validates bounded batches with persisted carry; final completion uses that carry and a captured stream guard, without scanning event history during activation. Global reader leases and session transfer maps bound stalled work; unsubscribe/close releases their resources. Corruption now fences both coordinated services and raw/prepared writes on the shared SQLite connection and persists across restart.

I preserved old signed leases for history while compacting live rosters. Issuance checks the normal hello quarantine budget before roster commit. Archived key epochs cannot be reused, and real killed-writer lock recovery distinguishes a dead owner from a live one. Historical evidence is sent before replay to a fresh subscriber.

I paused live fan-out during snapshot installation and resumed from the installed cursor. In-flight replies after unsubscribe are ignored without storing them. Unknown cancel is harmless; partial-send cancellation returns cancellation to that operation and a retryable transport interruption to the session supervisor. Reconnection restores subscriptions and never replays mutations automatically.

## Review limits and later gates

This review establishes the implemented foundation paths, not all consumer behavior or release readiness. Enrollment and protected transfer delivery remain P2. Registered Bridge methods and request-scoped artifacts remain P3. Authenticated meta projection, membership/participant/controller policy and domain replay authorization remain P5. Actual per-bot admission, approval, runtime budgets and containment remain P6. Supported runtimes, OS-vault packaging, daemon/platform operation and release qualification remain P9.

The body-only private-key primitive requires its domain caller to validate controller and recipient authorization. Identity history is retained in a bounded 1 MiB checkpoint; filling it fails closed before mutation. Root copying and whole-profile rollback are not cryptographically fenced by this implementation. Fixtures for later consumers remain frozen and required at those consumers' gates. I did not treat their loader tests as implemented service conformance.

Repository policy still requires the other teammate to review authentication/authorization changes before merge. These agent reviews do not replace that teammate requirement, and I have not merged PR #45.
