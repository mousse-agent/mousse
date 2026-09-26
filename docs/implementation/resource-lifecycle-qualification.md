# Remaining resource lifecycle qualification

I use this matrix to track independent qualification of the remaining lifecycle plan. A harness or planned case is not passing evidence. Revision-specific full-suite, build, hosted Linux, rendered Electron and live-provider outcomes belong in the final evidence record.

| Contract | Independent observable gate | Status |
| --- | --- | --- |
| Shared access | Two readers allocate no child checkout; shared writers queue; parent/editor/Git/PTY/workflow mutations cannot overlap a delegated writer | Pending production contract |
| Capability inheritance | A malicious forbidden tool call, nested delegation, and unsupported native adapter cannot broaden read-only authority | Pending production contract |
| Exact review | Snapshot request pins an isolated revision; shared reader reports a moving observation even before a receipt changes | Pending production contract |
| Named identity | Duplicate and cross-task names fail; complete and recall create separate episodes for one identity | Pending production contract |
| Native context | Complete, retire, restart and recall preserve context; concurrent recalls serialize; late callbacks cannot overwrite current context | Pending production contract |
| Undo retention | Fake-clock before/at/after deadlines, fresh matching Redo window, pins/recovery/current-result claims, prefix closure, rollback/forward-jump protection | Retention owner implementing focused tests; independent protocol review pending |
| Expired code | Replay, fork and revert cannot revive expired material after actual disposable-repository object collection; conversation remains readable | Pending retention contract |
| Physical ref release | Expected-old-value update, every reader audited, sole-copy/pending-integration and other-owner claims retain refs | Pending separately gated implementation |
| Retirement proof | Dirty, untracked, ignored, skip-worktree, assume-unchanged, sparse, nested repository and externally replaced directory cases preserve bytes | Pending retirement contract |
| Purge | Fresh proof, durable external irreversible boundary, crash/restart at each mutation, shared artifacts survive, automatic cleanup retains sole copies | Pending purge contract |
| Repeated storage | Many tasks and episodes across repeated retirement/purge cycles return exclusive checkout/runtime resource counts to baseline | Measurement harness prepared; full lifecycle fixture pending |
| Built application | Built Electron renders storage/recall controls using authenticated daemon; restart recovery and original checkout equality | Pending build freeze |
| Live provider | One bounded named complete/dormant/restart/recall sequence using authorized saved credentials in memory | Pending build freeze and named contract |

I prepared `tests/fixtures/resource-lifecycle-qualification.ts` to measure checkout file counts/bytes and content hashes without following links, capture primary worktree/user-reference state, and launch/restart the actual built CLI daemon with authenticated socket admission. It keeps owner credentials inside the harness closure and suppresses daemon output. I measure retained conversation metadata separately from reclaimable checkouts; Git ancestry retained by user/task branches is not a bounded cache.

`resourceLifecycleQualificationStorage.test.ts` establishes a repeated four-task baseline: each workspace contains distinct sole-copy bytes, all tasks cycle through trash/restore three times, and checkout counts/bytes and primary checkout state must remain unchanged. This qualifies protection and absence of duplicate materialization, not retirement or purge reclamation.

I ran `npx vitest run tests/resourceLifecycleQualificationStorage.test.ts --maxWorkers=1` on Windows against the in-progress branch on September 26, 2026: one test passed in 20.42 seconds (13.40 seconds test execution). No provider was invoked. This result is scoped to that baseline fixture; it does not qualify any unfinished phase or the built-daemon helper.

## Source audit requiring explicit coverage

I found these existing ingress points while phase implementation was beginning and sent them to the workspace/access owner:

- `protocol/handlers.ts`: `pty.create` accepts caller-selected cwd and `pty.write` can execute later by ID. Admission needs the process lifetime and confirmed descendant termination, not just the creation request.
- The same handler: `git.checkout`, `git.commit`, `git.push` immediately call the Git service; `files.write` has a direct fallback when no ready task workspace exists. Capability and writer admission must cover these alongside checkpointed editor saves.
- `MousseAgentService.ts`: the existing callback type reduces nested spawn assignments to CLI type and task, and persisted assignment only retains provider/model/effort. Inherited authority and fresh episode identity must survive that boundary.
- `LlmClient.ts`: existing read-only behavior derives from descriptor/plan state. Qualification must attempt forbidden calls directly rather than infer enforcement from omission in a tool list.
- Existing workflow `MmsWorkflowAgents.workspace` preserves definition read-only mode when selecting isolated/shared workspace roots. New contracts must retain that narrowing and the existing fan-out isolation mapping.

These are coverage obligations against the old source, not findings that the in-progress replacements necessarily retain. I will review the integrated implementation before attributing any remaining defect.

## Independent review and focused execution, September 26

I resumed against published checkpoint `56c4437` and the explicitly coordinated in-progress follow-up edits. The following results are scoped to those working files and must be repeated against the final frozen revision.

- I identified default symbolic-ref dereferencing in retirement pin updates and purge ref deletion. A Mousse-namespaced symbolic ref could redirect mutation into a user branch. The cleanup owner is adding symbolic-ref rejection and non-dereferencing compare-and-swap updates. Independent purge regression execution remains pending; this finding is not closed by a source edit alone.
- I identified a byte-reconstruction gap in clean-filter hashing: equal normalized Git blobs do not establish equal checkout bytes. The cleanup owner replaced that proof with materialized-byte comparison. My independent `resourceLifecycleQualificationRetirement.test.ts` passed both cases in 5.66 seconds: staged-but-unchanged mixed line endings remain Git-clean yet are retained, while canonical CRLF bytes retire and reconstruct exactly after service restart. The initial test drafts failed on fixture setup assumptions before reaching the product assertion; I corrected the setup rather than treating those failures as product regressions.
- I independently ran `receiptRefRelease.test.ts`: all eight tests passed. These include real object collection in a disposable repository with missing-object confirmation, honest expired fork/revert refusal, immutable receipt replay, crash after ref deletion, symbolic-ref refusal, named latest-result protection, and cross-profile claims. This is focused implementation evidence, not the entire Phase 3b reader audit.
- I sent malformed named identity/last-episode validation and older unintegrated episode claim retention concerns to the foundation owner. Follow-up integration and independent regressions remain pending.

I received the root's hosted verification record: the CI staging error was fixed at `b93bcd5`, and hosted run `36243631532` was green. The follow-up `56c4437` run is `36244358996`; I have not independently established its outcome here. Historical CI success is not current-head application qualification.

The root subsequently reported `36244358996` failed with 1,825 passed, five failed, two skipped and one unhandled error. I updated the affected protocol/daemon tests to require an operation ID and a fresh reviewed preview before permanent deletion, and to prove an unreviewed request preserves the trashed bytes and restoration capability. I also extended profile-shutdown tests to cover both an initial retention-disposer failure and the existing scheduled-service failure: every lifecycle and runtime disposer must still run. The built-daemon variant has not yet been rerun after these edits.

Further focused outcomes on the coordinated follow-up files:

| Independent check | Observed outcome |
| --- | --- |
| Mixed materialized bytes, canonical CRLF reconstruction, symbolic reconstruction pin and symbolic purge ref substituted after `purge-started` | Four tests passed in 19.36 seconds. Primary branch survived and restore remained blocked after the irreversible boundary. |
| Same-named agents in two tasks, persisted owner-filtered native sessions, source-service restart, cross-task lookup rejection and correct recalled context | One authenticated-protocol test passed in 14.70 seconds. Startup made no model call. The initial run exposed a missing `existsSync` import, corrected by the foundation owner. |
| Interrupted explicit fresh-context reset followed by continuation; malformed last-episode, generation and orphan episode authority | Four tests passed in 1.66 seconds. Old native instructions did not return after reset. |
| Updated protocol protection and shutdown tests, ownership-enforced retirement, malformed ref inventory and post-CAS corruption | 28 tests across five files passed in 43.42 seconds. |

I reproduced another destructive-proof gap: an existing loose Git ref containing forty zeroes was omitted by successful `for-each-ref`, making it appear absent. The cleanup owner now rejects stderr warnings as well as failed enumeration. I hardened `ReceiptRefReleaseService` to use the same direct-reference helper both before and after deletion, and added regressions showing malformed text and all-zero refs keep the external operation `prepared` instead of falsely completing it. All five malformed-ref variants passed in the latter 28-test selection. Retirement regression fixtures now hold real task and repository leases and assert the materialized-byte error specifically.

## Final application and revision gate

I will qualify the production Electron main/preload/renderer against an isolated profile and the authenticated built daemon after the implementation owners freeze source. The existing full-shell driver imports the actual built app and can exercise rendered controls without replacing the renderer or protocol. The lifecycle extension must prove named identity/context continuity, absent-checkout recall, visible retention and purge state, idle restart, and unchanged primary checkout. A separate bounded authorized live-provider sequence will test named completion, dormancy and recall; credentials remain in memory and no provider logs are collected.

Before completion I must record the exact final revision and actual outcomes of Windows typecheck, production build, focused adversarial tests, Windows full suite, hosted Linux checks, rendered Electron/daemon qualification, repeated many-task/many-episode storage measurements, crash recovery and the live sequence. Unresolved findings or red checks remain open evidence gaps; a passing earlier checkpoint cannot close them.
