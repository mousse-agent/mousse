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
