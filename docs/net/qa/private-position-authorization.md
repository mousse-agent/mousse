# Private replica position authorization (security R2)

I reproduced R2 on integration checkpoint `02fdaeb955f83d3b3f4931b329a69512a2c1fa79` using three independent protected profiles and their actual direct TLS sessions. The host/controller, honest recipient, and excluded participant have separate identities, keys and SQLite stores. After the signed epoch-two removal had committed on the recipient, the excluded participant signed a fresh message with its retained epoch-one key. I bypassed only the malicious host's append gate and delivered its signed original through the authenticated host session. The unfixed recipient stored the message and advanced its cursor. The retained key also decrypted this fresh ciphertext.

## Commit boundary and recovery

I moved position-dependent private authorization from receipt-time verification to the composed replica's `afterStored` hook, inside `SqliteStreamStore.applyFromAuthority`'s record/cursor transaction. Signature, stream, meta bounds and typed-author checks still run on receipt. The private content validator runs when a record becomes contiguous, after every preceding control has committed; a record buffered before its preceding control therefore cannot be accepted using the older audience.

I share that content validator with isolated snapshot and archive history replay. It requires the signed control strictly preceding the record's `(epoch, seq)`, the exact content key epoch, historical Space membership, private participant membership, the author's entitled node/wrap and assigned nonce prefix. Bot authors must have the historical participant/owner/placement/key proof; bot-run records retain the concrete immutable execution verifier. Owner grants and denials must reference an earlier signed permission request for a bot owned by that human author. Snapshot subject lookup stays in the generation containing the record being validated.

Discovery can adopt a later signed control before the contiguous replica cursor reaches it. In that case I select the preceding signed control from the active record generation rather than authorize earlier history with the newest key. Replaying an earlier control validates its predecessor but does not roll the adopted current projection back. Legitimate pre-removal ciphertext remains accepted and readable with retained historical keys.

A denied record throws `forbidden` before the record/cursor transaction commits. Both the record insertion and cursor change roll back. The existing `NetSyncSession` invalid-delivery handler closes the offending authenticated session, reports `forbidden` to its subscriptions, clears overlap/snapshot state, and retains the durable accepted prefix. I do not skip the rejected position or advance to the host's advertised head. Reconnection resumes from the durable cursor and continues to reject the invalid prefix if the host repeats it; this is host misbehaviour, not an instruction to trust a replacement snapshot.

## Regression coverage

`tests/net/spaces/private/replicaAuthorization.test.ts` covers:

- Fresh excluded-writer old-key attacks through real TLS live delivery, ordinary replay and snapshot, without storing the attack or advancing the honest cursor.
- Pre-removal signed history through incremental replay and snapshot, including discovery adopting the later control before replay; both paths decrypt the historical plaintext.
- A current-key record buffered before its removal control is accepted when contiguous, and an excluded-writer record buffered in the same ordering is rejected when contiguous.
- A wrong nonce prefix and a genuinely delegated, unassigned node of a still-entitled participant, both under the current key with authenticated GCM ciphertext and valid signatures.
- Signed bot-owner decisions accepted through incremental and snapshot history, while another entitled private participant's decision is rejected.

I changed no existing test assertions, shared composition seams, transport code or sync subscription code. The running soak and sibling worktrees are outside this qualification.

## Verification ledger

I used Node `v24.20.0`, `TMPDIR=/private/tmp`, and only this fix worktree. I ran no install, full test suite or whole Net test folder.

The final focused area command was:

```sh
npx vitest run tests/net/spaces/private/service.test.ts tests/net/spaces/private/tls.test.ts tests/net/spaces/private/botBindings.test.ts tests/net/spaces/private/profile.test.ts tests/net/spaces/client/service.test.ts tests/net/spaces/client/join-timeout.test.ts tests/net/spaces/discovery/bootstrap-author.test.ts tests/net/spaces/discovery/codec.test.ts tests/net/spaces/discovery/renewal.test.ts tests/net/spaces/discovery/current-after-snapshot.test.ts tests/net/spaces/discovery/profile.test.ts tests/net/sync/integration.test.ts --maxWorkers=4
```

That command passed **85/85 tests in 12 files**. Its earlier run passed 84 and failed the existing renewal test at `NetIdentityService.renewExpiring`'s exact equality of two live-clock samples, before private verification. I reran only `npx vitest run tests/net/spaces/discovery/renewal.test.ts`, which passed 1/1; the later focused-area run also passed that test. I did not change or establish the cause of the intermittent renewal failure. My later [renewal clock report](renewal-clock.md) records its deterministic production-timer reproduction and focused fix.

| Command | Results |
|---|---|
| `npx vitest run tests/net/spaces/private/replicaAuthorization.test.ts` | Initial unfixed fixture: 1 passed / 6 failed (two failures were my local-append fixture mistake). First fix iteration: 5 passed / 2 failed (discovery fixture attempted rediscovery of an already-known stream). Corrected seven-case fixture: 7 passed / 0 failed. Expanded nine-case fixture: 9 passed / 0 failed. Complete eleven-case fixture against the unfixed integration source: **4 passed / 7 failed**, with R2 live/replay acceptance reproduced. Final source and complete fixture: **11 passed / 0 failed**. |
| `npx vitest run tests/net/spaces/private/replicaAuthorization.test.ts -t 'wrong author'` | 0 passed / 2 failed / 5 skipped: my assertion used the domain decryption API, which already rejects a wrong author namespace. I corrected the fixture to authenticate its altered ciphertext directly with GCM before asserting replica rejection. |
| `npx vitest run tests/net/spaces/private/replicaAuthorization.test.ts -t 'bot owner decisions'` | 2 passed / 0 failed / 9 skipped. The final eleven-case run additionally installs the positive permission snapshot on the third profile, whose active store has no permission request. |
| `npx vitest run tests/net/spaces/discovery/renewal.test.ts` | 1 passed / 0 failed. |
| `npx vitest run tests/net/spaces/archive/multi-epoch.test.ts tests/net/spaces/archive/private-rotation.test.ts tests/net/spaces/archive/bot-receipts.test.ts --maxWorkers=3` | 6 passed / 0 failed in 3 files. These cover the shared archive validator's private rotation and signed receipt compatibility. |
| `npx tsc --noEmit -p tsconfig.node.json` | My first implementation produced 2 errors from using delegation fields directly on `BotRecord`; I corrected it to verify its signed delegation. Subsequent checks passed with 0 errors. |
| `npx eslint src/mms/spaces/private/service.ts src/mms/spaces/client/service.ts` | Passed with 0 errors and 0 warnings. |
| `npm run format:net` and `npm run format:net:check` | Passed; all matched files use Prettier style. Only my two source files and new regression file changed. |
| `git diff --check` | Passed. |

The final qualification totals **102 passed tests across 16 focused files**. I did not establish packaged GUI/provider behavior or complete-soak qualification. I touched no shared seam files listed in the brief, opened no PR, posted no GitHub comment and performed no merge.
