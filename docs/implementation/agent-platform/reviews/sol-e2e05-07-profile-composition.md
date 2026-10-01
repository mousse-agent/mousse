# Sol review: E2E05–07 profile composition

Date: 2026-09-11

Baseline: `dffba4537785b2aebd903726a8f0cf1aad9755cb`

## Result

The new `platformProfileCrossFeature.test.ts` exercises three compound production boundaries with real profile services, the framed MMS protocol, durable workflow state, browser registration/routing, repository mutation leases, encrypted control stores, and the shared provider store. All three cases pass without unhandled work.

### E2E05: active A to B switch

Profile A owns a live framed chat request, a durable workflow waiting for approval, and a selected attached-browser session backed by the reverse-command transport. The switch follows the production host order by closing the raw browser session and unregistering its guest-close proof before rebinding the same GUI connection to B. The chat and workflow remain active while the binding changes.

The late A chat reply is persisted only in A. It is returned to the request that was admitted under A, but its A event is not published through the now-B event binding. B cannot list A's browser thread or read A's workflow run. No managed-browser fallback is attempted. Cleanup cancels the waiting workflow and proves browser/native owner counts and pending guest acknowledgements return to zero.

### E2E06: shared repository and provider

Two profile-owned `ThreadActionService` instances target the same real Git repository. The second mutation does not enter while the first owns the repository lease; after release, execution order is exactly A then B. This verifies serialization is keyed by Git repository identity rather than profile-local paths.

Provider credentials are intentionally installation-shared: a stored credential written through A is visible through B's identical `ProviderAuthService`. Measured turn usage remains profile-owned because each service writes to its own `LineEditStatsStore`; A's 12-token record and B's 24-token record remain separate.

Provider subscription quota endpoints report the upstream account's aggregate window. The product has no truthful facility to divide that external account-global quota between profiles, so this review does not claim per-profile subscription-quota attribution. The locally measured turn accounting required for profile attribution exists and is isolated.

### E2E07: Plus/control logout isolation

A and B hold distinct encrypted Plus/control credentials and device-enrollment tokens while retaining one installation provider credential store. Logging out A clears only A's control credentials and enrollment. B remains enrolled with its original account and device token, and the shared provider credential remains readable through B.

## Evidence

- `npm exec vitest run tests/platformProfileCrossFeature.test.ts -- --reporter=verbose`: 1 file, 3 tests passed in 11.96 seconds; no unhandled errors.
- `npm run typecheck`: Node and web TypeScript passed.
- `git diff --check`: passed.

## Limits

The LLM result, attached-browser executor, Plus credentials, and provider credential are fixture data. No live model, browser, account, relay, quota endpoint, or external network is used. E2E06 qualifies repository serialization through the production cross-process lease in one process; the lease's separate cross-process cases remain covered by `repositoryIdentityLease.test.ts`.
