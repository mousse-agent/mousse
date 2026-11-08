# Plan: private threads and thread expiry (#672)

Checked against `origin/master` 7623adb4e (2026-11-06).

## Delivery

Two PRs, stacked, because they are two goals:

- **PR A, private threads** (`feat(threads): private threads stay on the computer that started them`).
- **PR B, thread expiry** (`feat(threads): a thread can delete itself after a set time`), based on A. It adds the
  Settings default expiry for private threads.

Related open work that touches the same files: #640 (new-thread row), #610 / #619 / #634 (sidebar rows), #630
(composer pickers). None implements any part of this. Whichever lands first, the other rebases; the composer toolbar and
the sidebar row are the conflict points.

## Names

- Code field: `Thread.localOnly?: true`. "Private" is already taken in the Bridge code (private streams,
  `PrivateSources`, `space.private`), so the code avoids the word. UI and glossary say **Private thread**.
- Expiry fields: `Thread.expiresAt?: string` (ISO time) and `Thread.expiryStopsRun?: true`.

## PR A: private threads

### Data
- `Thread` (`shared/types.ts`) and `ThreadMeta` (`ThreadDataStore.ts`) gain `localOnly`. Written only by
  `createThread(opts.localOnly)`; not in the `updateThreadMeta` `Pick` list, so it can't be changed after creation
  in either direction. No migration: absent means shared.
- One helper `isLocalOnly(thread, inventory)` in `shared/threadLineage.ts`: true if the thread or its lineage root is
  local-only. The flag is also written on every child, so the root check is a safety net, not the main path.

### Creating one
- `threads.create` accepts `localOnly` only from `gui` and `cli` connections. It is not added to
  `ROUTED_METHODS['threads.create'].keys` or the phone DTO (`bridge/remote/dto.ts`), so another computer or a phone
  cannot create one, and a create with `node` + `localOnly` is refused by `ThreadRouter.ownerParams`.
- Inherit the flag: `createChildThread` (subagents), `createForkThread` (/fork), `makeAgentThread` (`thread_create`:
  an agent in a private thread can only create private threads), scheduled-job threads created from a private
  thread's job tools, `PullRequestThreadService` when its source is private.
- Never private: chat backing threads, bot and Space bot threads (no UI path sets it).
- Renderer: `ComposerWorkspace` draft gains `localOnly`; a Private toggle (lock icon) in `ComposerWorkspaceToolbar`
  next to the worktree toggle, only on a new chat; `prepareComposerThread` passes it to `threads.create`, so the
  thread is never briefly shared. `prepareComposerThread` must not reuse an empty draft of the other mode.
- Palette command **New private thread** (`thread.newPrivate`, `MOD+SHIFT+N`) and slash command `/private` (opens a
  new private draft, like `/new`).
- CLI: `mousse chat --private`.

### Never sent to other devices (owner-side filters)
- Lists: `threadVisibility.visibleThreadsFor` drops local-only threads unless `clientType` is `gui` or `cli`
  (covers routed `threads.list`, phone `threads.list`, every `threads` result). `MmsListsSource.compose` filters
  `inventory` and drops chats whose backing thread is local-only (pushed lists stream for computers and phones).
- Search: `threads.search` passes an `allow` that excludes local-only threads for non-local callers.
- Thread-addressed calls: `OwnerRoutes.assertOwned` and `openStream` treat a local-only thread as not found;
  `MmsRemoteBackend` `execute` / `snapshot` / `stop` / `run` use one shared `remoteThread(id)` helper that does the same.
- Streams: `NodeStreamAuthority.canRead` refuses `node.thread` streams of a local-only thread, and
  `MmsRemoteBackend.snapshot` refuses it, so no stream opens or reactivates.
- Other routed results: `threads.inventory`, `activity.snapshot`, `thread.snapshot.turnSnapshot`,
  `chatReferences.resolve`, `storage.usage` drop local-only threads for non-local callers.
- Git: a private thread's worktree branch is named `mousse/private-<short id>` instead of from its first message, so
  project-level Git reads on another computer don't show its subject.

### Runs only here
- Run on menu: locked to this computer while Private is on (button disabled with tooltip "Private threads run on
  this computer"); turning Private on resets `node` to this computer.
- `delegate_task {computer}` / `continueRemoteSubagent` refuse from a private lineage (`private_thread` error code),
  and `listComputers` returns none, so agents are told why.
- Agent tools: `AppToolRegistry.checkOthers` refuses `thread_send` / `queue_enqueue` / `thread_steer` from a private
  thread into a shared one, and `thread_read` / `thread_list` / `thread_search` from a shared thread don't see
  private ones (a shared thread's content reaches other devices).
- Spaces: `AgentChatService.assertPublishable` refuses a chat whose backing thread is local-only (defensive).

### Backups and exports
- No thread export, backup or cloud sync exists (`shared/privacy/outbound.ts`). Nothing to change; a test asserts
  that `threads.inventory` and `storage.usage` leave them out for bridge callers. The PR says so.

### Marker
- Sidebar row and card: lock icon before the title, tooltip "Private: stays on this computer".
- Composer: tinted (`.composer.composer-private`, a muted violet tint token in light and dark).
- Bar above the transcript (pattern of `ThreadComputerBar`): "Private thread · stays on this computer".

### Tests (focused)
`threadVisibility`, `MmsListsSource`, `OwnerRoutes`, `MmsBackend`, `nodeAuthority`, `ThreadDataStore` create /
immutability, `OrchestratorService` child / fork / delegate refusal, app tool registry, composer toolbar and slash
command tests.

## PR B: thread expiry

### Data and API
- `expiresAt` / `expiryStopsRun` set at create (`threads.create`, gui/cli only) and by `threads.setExpiry
  {threadId, expiresAt: string | null, stopsRun?: boolean}` (gui/cli, and routed for remote shared threads so a
  remote thread's expiry is set on the computer that owns it). Validation: future time, at most 365 days out.
- Subagents follow their root: the sweeper deletes the root, and the trash already moves owned subagents with it.
- Settings: `threads.privateExpiry: 'never' | '1h' | '24h' | '7d' | '30d'` (default `never`), added to the settings
  validators allow-list; new private drafts start with it.

### Sweeper: `ThreadExpiryService` (daemon)
- Started in `startOwned` after `recoverRunEngineOnBoot` and before `scheduled.start()` and
  `scheduleStartupQueueRecovery`, so a thread that expired while the app was closed is deleted before anything can
  run in it. The daemon outlives the window, so expiry also happens with the window closed.
- Timer armed for the nearest `expiresAt` (re-armed on `threads.created/updated`, capped at 1 h and with a clock
  guard like `StorageSweepClock`).
- When due:
  1. The orchestrator refuses new sends and queue drains for an expired thread ("This thread expired").
  2. Busy (`threadHasPendingWork`) and `expiryStopsRun` off: wait; retry on `run.status` terminal events and every
     minute.
  3. `expiryStopsRun` on: `orchestrator.stopThread(id, 'expired', { clearQueue: true })` first.
  4. Delete for good: `trashThread` with `reason: 'expired'` → `cleanup.preview` → `purge` with a new
     `authorization: 'expiry'`. The purge service accepts it as discard authority only when the daemon itself passes
     it and the trashed thread's `meta.json` has `expiresAt <= now` (never from a protocol parameter).
  5. Busy refusals from the profile-wide idle check retry with backoff; failures are written to the lifecycle record
     and retried, and the thread stays hidden.
- Expired records never show in Recently deleted (`threads.inventory` filters `reason: 'expired'`), and don't go
  to Settled.
- Committed or pushed code is kept: purge removes the worktree folder and Mousse's own refs, not the thread's branch
  or anything pushed. Uncommitted files in the worktree are deleted (that is what expiry means).
- Also removed for an expired thread: Run Engine rows for its thread ids (new `RunStore.deleteThreadData(ids)`),
  composer drafts in the renderer (dropped on `threads.updated` when the thread disappears).

### UI
- Composer toolbar (new chat): timer menu: Never, 1 hour, 24 hours, 7 days, 30 days, Custom… (hours or days input),
  plus a checkbox "Stop a running turn when it expires".
- Existing thread: same menu from the thread's context menu ("Expire…") and from the expiry bar.
- Bar above the transcript: "Deletes in 3 h · Extend · Remove" (combined with the private bar in a private thread).
- Sidebar row: timer icon with remaining time in the tooltip.
- Settings → General → Threads: "Private threads delete after" select.

### Tests (focused)
Expiry service (due, wait for run, stop at expiry, boot pass before queue recovery, clock jump), purge expiry
authorization (refused from protocol, refused when not due), inventory hides expired, `threads.setExpiry`
validation, settings validator, composer timer menu.

## Docs
`docs/GLOSSARY.md`: **Private thread** and **Expiry**.

## Open questions for review
1. The trash refuses while any turn runs anywhere in the profile (`assertLifecycleIdle`). For expiry, keep it and
   retry, or narrow to the thread's own tasks for the expiry path?
2. Remote subagents of an expiring shared thread live on another computer; purge doesn't reach them today. Leave as a
   stated limitation, or set the same `expiresAt` on the remote child at creation and on change?
3. Provider session files (Claude Code / Codex transcripts in the private home) are not deleted by purge. In scope
   for expiry of a private thread, or a follow-up?

## Revisions after review

- **Execution threads inherit Private.** `ensureExecutionThread` takes `localOnly`; workflow agent threads started from
  a private thread (`MmsWorkflowAgents`, `MmsWorkflowCoordinator`) carry it. Agent-created scheduled jobs are refused
  from a private thread (a job runs later in threads of its own).
- **Trashed private threads stay hidden.** `OwnerRoutes.assertOwned` reads the trashed thread's `meta.json` and refuses
  a local-only one, so routed `threads.inventory {threadId}` and `threads.restore` can't reach it.
- **Stated limitation:** with worktree off, a private thread's commits land on the project's own branch, which Git reads
  from another computer can see. The glossary says so.
- **Committed code is kept:** an expiry purge skips `refs/heads/*` items, so the thread's branch and its commits stay.
  (Retirement only releases a branch whose work is published.)
- **Boot:** the expiry pass runs after `start()` returns, not inside `profile-start`. The orchestrator refuses to start
  a turn or drain a queue in an expired thread at admission, so Run Engine workers and queue recovery can't run one first.
- **A run in progress** means an active turn or a non-terminal run only. At expiry, pending questions are dismissed and
  terminals closed; then the thread is deleted.
- **Clock:** `expiresAt` is absolute; a clock jump defers to the next tick, never suspends.
- **Authorization:** the daemon passes `authorization: 'expiry'` to purge; it counts as discard authority for both the
  purge check and `releaseThreadSnapshots`, and only when the trashed `meta.json` has `expiresAt <= now`.
- **Run Engine rows** (`thread_events`, `runs`, `delegations`, `inbox`, outbox) for every owned id are deleted after
  `projectPurged`.
- **Open questions:** keep the profile-wide idle check; at expiry the thread is hidden and refused at once, and the
  delete retries on run end and every minute. Remote subagents get `expiresAt` at creation (routed create accepts it);
  later changes don't reach them (stated). Provider session files are a follow-up.
- **Cut:** `NodeStreamAuthority` change (streams open only through `source.snapshot`), chat filters and
  `assertPublishable` (chat threads are never private), PR thread inheritance.
- **Screenshots:** both PRs carry before/after images.
