# Mousse Net stack reconciliation

I resumed the existing issue #44 stack without creating another PR. I retained
PR #45 (`codex/issue-44-mousse-net`) as the foundation, PR #50
(`codex/issue-44-chats-candidate`) as its Chats backend layer, and PR #52
(`codex/issue-44-net-ui`) as the GUI layer. I left the dirty primary checkout
and the separate source worktrees intact. I did not merge the default branch
or enable networking on a real profile.

## Preserved integration

I merged Chats checkpoint `37a6e578` into the UI branch in `012a65c1`. Its
resulting tree is byte-identical to the prior UI checkpoint `7eac510b`: the UI
already contained those backend corrections and the later durable task APIs.
The merge records their ancestry without discarding those newer controls.

I reconciled Net source checkpoint `428f0aca` into the backend in `5da21cba`,
then carried the final published foundation `1a971a50` into `64967008`. I
retained the newer enrollment, private-position authorization, bot presence,
RPC gates, preauth bounds, safe worktrees, and join-recovery implementations.
I combined the backend's exact creator receipt correction with the current
private/discovery implementations, and kept default-off Chat admission and
Chat-owned work in the profile disable/drain accounting. I also retained the
default branch's offline catalog initialization and renderer hydration fencing
alongside the previously integrated Chats shell.

The UI reconciliation retains those newer implementations, the prior Control
front-door removal with migration-only credential compatibility, task lookup
and explicit dispatch, private view disposal guards, and validated delivery
state filtering. The reader and Darwin owned-process build now share the
requested output root, preserving the foundation's isolated per-run builds.

## Superseded source PRs

I compared each source PR's own commits with its integrated target using stable
Git patch IDs. A source head need not be an ancestor after cherry-picking. I
checked the PR-owned patch set rather than treating inherited dependency
commits as new work. The following mappings establish where that work lives:

| Source PR | Source commits → integrated commits | Target layer |
| --- | --- | --- |
| #48 | `88c73144` → `484ac108`; `2f966c10` → `c91aacdf`; `c79ba4f1` → `9a6727e7`; `e61659a8` → `1745e28f`; `1320236c` → `f06fc089` | #45 |
| #49 | `7f993f39` → `2f463d6c`; `7540a7e4` → `a91b70d7`; `07f7bc93` → `5a8b54b4`; `937ab513` → `72c77a18`; `d19e3cf5` → `1dabc72e`; `8dab3969` → `9f4c5a9b`; `4247903b` → `703a29c4` | #45 |
| #53 | `5eaad179` → `a988ef60`; `e36e4f49` → `770e14a6` | #45 |
| #55 | `de50e0f1` → `37a6e578`; `97a55700` → `b018d83d` | #50 / #52 |
| #56 | `c4fd3fcb` → `8fe5b3fc`; `8b48a39e` → `efbe701a`; `0204e5a0` → `39e107cd` | #52 |
| #57 | `9a72843a` → `34710376`; `e206ac1f` → `f9a30592` | #45 |
| #58 | `dc2ce007` → `a76b3cb4` | #52 |

I also reviewed two integrations whose patches differ because their target
contains a later correction:

- #51's `eac23222` is integrated as `878356b1` in #52. The complete Control
  removal and migration-only credential implementation are preserved. The
  target additionally passes `preparePrivateAudience` into the Chat binding;
  I retained that required private-aside integration.
- #54's rollback change `ffd39d18` is integrated as `70be5d4e`, with the later
  unchanged-transport reuse correction retained in `NetService.activate`.
  Source `72c4ca14` and integrated `7e4b088c` have identical transport-manager,
  registry, service-command and Electron-lifetime source. The rollback evidence
  `dfabc2cb` has the same stable patch as `107e4242`.

Issue #46 and PR #47 were already closed when I checked them. I did not treat
them as additional active Net delivery layers.

## Verification boundary

I used Node 24.20.0 on macOS arm64 with `TMPDIR=/private/tmp` and one Vitest
worker. I ran no full suite. Earlier qualification reports remain historical
evidence at their stated commits and platforms.

- Backend integration: the nine-file Chats/creator-receipt run passed 36 of 37
  checks. Its one failure was an old framed fixture expecting a foreign-profile
  lookup before explicit opt-in; the current gate correctly returned `disabled`.
  I kept that denial assertion, explicitly initialized/protected the foreign
  fixture, and verified the original isolation/retry flow. That corrected
  framed case plus five directly affected provider/startup files passed all 29
  checks. Both Node/web source typechecks passed. Scoped source lint reported
  zero errors and two existing `App.tsx` async-promise warnings; the test path
  was excluded by the repository lint configuration.
- Final backend `64967008`: after the final safe-worktree correction, I ran
  only `tests/net/chats/device.test.ts` again. Its ten actual device/Dispatch
  cases passed in 27.47 seconds. Log:
  `/private/tmp/mousse-stack-backend-device-final.log`; scoped lint log:
  `/private/tmp/mousse-stack-backend-lint.log`.
- Combined UI source: twelve focused files passed 57 of 58 checks in 77.67
  seconds. They cover R1's malicious-host private replica authorization,
  exact creator receipts/current human aside authorization, framed retry and
  task reads, saved tasks, real mounted React/Electron picker/private/display
  disposal, filtered outbox pages, retained join-race checks, rollback IPC,
  and Control cutover. The only failure was the historical cutover status
  expectation omitting the new explicit false feature flags. I corrected that
  expectation and changed its emitted CLI check to use the existing isolated
  current-source build helper. Both cutover cases then passed in 6.16 seconds.
  I did not rerun the eleven unchanged passing files. Logs:
  `/private/tmp/mousse-stack-ui-focused.log` and
  `/private/tmp/mousse-stack-ui-cutover-final.log`.
- Combined UI Node/web source typechecks and scoped source/script lint passed
  with zero errors or warnings. Logs:
  `/private/tmp/mousse-stack-ui-node-types.log`,
  `/private/tmp/mousse-stack-ui-web-types.log`, and
  `/private/tmp/mousse-stack-ui-lint.log`. I built both native artifacts in one
  requested temporary output root and verified their manifest artifact hashes;
  both remained unqualified. Log:
  `/private/tmp/mousse-stack-ui-native-output.log`.

The backend commands selected `tests/net/chats/{asides,publication,joined,bots,
approvals,crash,framed,device}.test.ts` and
`tests/net/spaces/discovery/creator-descriptor.test.ts`. The corrected framed
run also selected `tests/{providerCatalogStartup,claudeSdkProvider,
openAiCodexModelFetch,providerModelSpeed,guiPresentationBootstrap}.test.ts`.
The UI command selected `tests/net/spaces/private/replicaAuthorization.test.ts`,
`tests/net/spaces/discovery/creator-descriptor.test.ts`,
`tests/net/chats/{asides,framed,tasks,gui-renderer-lifecycle}.test.ts`,
`tests/renderer/{networkChats,networkTaskState,networkTaskPicker-electron}.test.ts`,
`tests/net/spaces/local.test.ts`, `tests/net/cutover/control.test.ts`, and
`tests/net/rollback/ipc.test.ts`. Each used
`node node_modules/vitest/vitest.mjs run <selected files> --maxWorkers=1`.

I preserved this stack locally while the separate hosted Plus proposal is
compared. I did not integrate draft #60, push the reconciled Chats/UI branches,
close the source PRs, or merge default. Partner draft #60 is based on the prior
#52 head; any agreed downstream integration must use the reviewed updated #52
checkpoint. Sensitive authentication/authorization and credential changes
still require the other human teammate's review under the repository workflow.
