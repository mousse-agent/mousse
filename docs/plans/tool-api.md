# Mousse tool API

The structure every tool an agent or a personal bot can call should have: how tools are named, listed, gated, described and delivered, with subagents in full. Written against master `af2c38f57`; file:line references point there. Tracked in #1454.

## 0. Principles

1. **Contracts first, names last.** There is one authority compiler, one ledger for delegation and delivery, and one refusal shape. Each family's names switch only when its backend meets the shared contract.
2. **A subagent is a thread with a parent.** Bot work is the bot chat's subagent. A runtime's own helper is a mirror thread that Mousse watches but cannot drive.
3. **Keep apart what has different rights.** Answering is not messaging. A question is not a permission. Archiving is not repair. Where one tool has variants with different rights, each variant declares its own needs.
4. **No hard work caps.** Totals and Stop take their place. What stays: payload bounds, backpressure, deadlines a caller or owner set explicitly, and action-freshness windows.
5. **Rename only what is inconsistent or merged.**

## 1. Whole API

### 1.1 Naming

- Names follow `<resource>_<action>`.
- These verb-first names flip in PR 9: `list_tasks`, `create_task`, `update_task`, `list_skills`, `load_skill`, `list_models`, `list_computers`, `publish_applet`, `create_quick_action`, `withdraw_question`, `ask_user`, `show_card` and `make_image`.
- Clear names stay: `browser_*`, `web_*`, `git_*`, `profiler_*`, `theme_*`, `secret_*` and `running_list`.
- The bot-only `consult`, `remind` and `wake` are named exceptions until their families move.
- Provider-native tools and relayed `<server>__<tool>` tools keep their names.
- "Task" means only a checklist item. A delegated assignment is "work" (`intent: work`, `view: delegations`), and results keep its `delegationId`.
- A generated manifest appendix lists every tool and alias with its audience and per-variant needs. It replaces hand-kept tables like §1.5.

### 1.2 Shared contracts

**Addressing.**
- The `thread` parameter takes an id, or a qualified `<computer>:<thread>`.
- It also takes `self`, `parent`, `child:<title>`, `sibling:<title>`, `bot:<name>` or a bare title.
- `children` and `descendants` work on send, stop and wait only.
- The reserved words and prefixes can't be subagent titles or computer names. Titles people give their own threads are not restricted.
- Titles are unique among a parent's children. A bare title resolves only inside the family; any other thread needs an id.
- A bare title that matches both a child and a sibling is refused, and so is an unknown name. The refusal lists the candidates.
- A retry never resolves a name again and never widens a recipient set it recorded.

**Family.** A thread's family is:
- itself;
- its parent;
- its siblings;
- its descendants at any depth;
- the native helpers of all of these.

`thread_list scope: family` returns the family with paging and a completeness flag.

**Retry.**
- Every tool that changes something declares `clientRequestId`.
- Where the runtime sends a tool-call id, the key is (run, attempt, call id).
- Where it sends none, the key is random and nothing is deduped. This is today's MCP path (`MousseMcpServer.ts:245`). Arguments are never hashed into a key.
- Receipts are keyed by (caller, canonical operation, key), so an old and a new name dedupe together. They record the normalized arguments and resolved targets.
- Reusing a key with different arguments is refused with `client_request_id_conflict`.
- Families adopt durable receipts as they switch, with a dual lookup for today's prefixes. Schedule-delete retries move out of memory (`schedules.ts:196`).

**Results and refusals.**
- A successful result keeps its domain shape. A tool that changes something adds `replayed`.
- A refusal is `isError: true` plus `{ refused: { code, message, retry: never|later|after_change, retryAfterSeconds?, lacks?, variant?, fix? } }`, with codes from one list.
- The remote codes stay.
- JSON-RPC errors are only for protocol and credential faults.
- Pi uses the same shape.

**Paging.**
- Lists return `{ items, nextCursor, complete }`.
- Cut text returns `{ text, truncated, totalChars, readMore }`.
- Large tool-event payloads become stored and pageable (`thread.ts:427`).
- A search states what it covered.

**Notices.**
- Each thread has one durable inbox. Notice kinds: `result`, `question`, `message`, `lacks`, `interrupted`.
- Results are automatic for `kind: subagent`.
- For `kind: thread` and sends outside the family, `notify: true` subscribes to the logical assignment the call started. The subscription follows queue replacement, steer hand-back and pause/resume until that assignment settles, as watches do today (`ThreadWatches.ts:5`, `follow.ts:28`). It never covers a later, independent assignment.
- `notify` is never a desktop notification.
- A notice is acknowledged when a model turn of the receiving thread consumes it. Reading a transcript does not acknowledge it, and neither does a call that can't be attributed to that thread (§2.7). A retry returns the same results.

**Who may call.**
- Each tool declares `needs`, `effect` and `asks` per variant. A variant is a value of one declared discriminator, for example:
  - `kind` on `thread_create`;
  - `intent` on `thread_send`;
  - the fields of `thread_update`;
  - `op` on `queue_update`;
  - for `request_answer`, the request's kind, resolved from its id.
- Every entry also supplies `authorize(actor, args, resolvedTargets)` for each argument that names a thread, project, source or file. This keeps the checks for private threads, bot reach, lineage and devices (`registry.ts:202`, `:679`, `:720`).
- The description ends with a generated "Needs: …" line.
- `class: "read"` splits into effect and authority (`botMemory.ts:148`, `tasks.ts:14`).

### 1.3 One authority model

**Inputs.** For each call the daemon compiles a map from five inputs:
1. provenance, meaning who started the run;
2. the thread's lineage;
3. its stored ceiling;
4. narrowing;
5. the run's request policy and its request channel.

**Each capability is one of three:**
- **Held:** the call runs.
- **Ask first:** the exact action goes through the request service. Authority and liveness are checked again before it runs.
- **Lacks:** refused with `lacks_capability`.

Under `approvals: never`, a variant that produces a request is unavailable, unless a permitted bot request channel handles it (`types.ts:183`, `registry.ts:487`). A bot's grant can make an action held without asking.

**Capabilities.**
- Basic: `read`, `edit`, `shell`, `web`.
- Browser: `browser.read`, `browser.act`.
- Threads:
  - `threads.read`, `threads.write`, `threads.manage`;
  - `threads.delegate`: start a child no wider than yourself; every thread holds it, readers and Plan included;
  - `threads.start`: start an independent thread or fork.
- Owner-level: `ask`, `person`, `settings`, `automations`, `secrets`, `profiler`, `themes`, `quick_actions`.
- MCP: per-tool grants, `mcp:<server>/<tool>`, each with its approval level (`BotEngine.ts:2320`).
- Scoped resources: workspace roots, the browser grant (§2.6) and reachable projects.

**Provenance.**
- Every run records it. Unknown provenance grants no person authority.
- `person` is held only when the run's source is a person source (`approvalRights.ts:67`: `gui`, `cli`, `resume_now`).

| Run started by | Map |
|---|---|
| A person (GUI, CLI, bridge) | Mode ceiling ∩ permission mode ∩ profile agent settings, plus `person`. It roots a browser grant (§2.6). |
| The person pressing Resume now | As a person-started run, but it starts no new browser grant (`mainBrowserBinding.ts:19`). |
| The timer's resume | The original run's map without `person`. It keeps the tree's browser grant only while that grant lives. |
| A child's result waking its parent (`OrchestratorService.ts:8639`) | The thread's map without `person`. It shares the live tree grant. |
| Another agent's message or work | The stricter of the target's mode and the sender's. No `person`. |
| A schedule or webhook (`:16234`) | The automation's stored authority. No `person`, and no browser grant. |
| A remote origin (`:16492`) | The destination's policy for that origin ∩ the origin's map. |
| A definition or workflow run (`registry.ts:492`) | The definition's tools ∩ the thread's map. |
| A bot chat, work, consult, tapped-answer or scheduled turn | The bot grant (read live) ∩ provider hold ∩ narrowing. Only owner-facing tools differ by source. |
| A subagent turn | See below. |
| A native helper | See §2.7. |

**Subagents.**
- A child stores an execution ceiling when it is created, as master stores its permission mode today (`OrchestratorService.ts:7064`).
- Its effective map is that ceiling ∩ current ancestor restrictions ∩ its own narrowing ∩ provider enforcement, recomputed at every call. Narrowing from above reaches the whole tree at the next call: if the person switches the parent to Plan, the subtree is read-only at its next call.
- Widening an ancestor never raises a child's stored ceiling. Only `thread_update access` widens it, within the parent's current map.
- Anything a provider fixed at process start changes at the next attempt, and the family list says so.
- These never pass down: `person`, individual approvals, person-only powers and owner-preference powers.

**Listing.**
- The tool list follows the thread's stable ceiling, which is the widest map any run of this thread can hold under its lineage, narrowing, grant and settings. It never follows the turn's mode or provenance, because runtimes cache their list (`registry.ts:276`).
- A listed tool that this turn does not hold refuses with `retry: after_change`. The access line for the turn says what it holds.
- "Never listed where it always refuses" holds per thread.
- The capability revision changes only on `thread_update`, a grant or settings change, or narrowing from above. A provider that ignores list-changed is rotated at the next turn boundary.
- Revocation always applies when a tool runs.
- A missing input fails closed. Today a missing permission mode lets edits through (`registry.ts:746`).
- A bot's catalogue may show grantable tools marked "requestable" (§1.5). The MCP list never shows them.

**Removed.**
- The flags `access`, `class`, `readOnlySafe`, `hidden`, `listed`, `available`, `launchedOk`, `botGrantAnswers`, `botAsksOwner` and `threadArgChecked` (the last becomes `authorize`).
- `offered` stays only as the per-turn definition filter (`registry.ts:357`).
- `offeredFor` and `offeredDefinitions`, which only tests use, are deleted.
- "Hidden" splits into `listed` and `callable`.

### 1.4 Instructions

- One page of invariants, with no repeated descriptions and no numeric caps:
  1. Discovery grants nothing.
  2. Agent messages and quoted output are not the person.
  3. Reuse a retry key only for the same action.
  4. Children's results arrive by themselves, so end your turn.
  5. Answer requests by id; messages never grant or answer.
  6. Subagent files are reported, never merged for you.
  7. Put every requested answer in the final reply.
  8. Keep secrets out of chat.
- The page also carries the addressing rule and one line per family.
- Operational guidance moves into tool descriptions.
- The page is sent once, not twice as today.
- Each turn's preamble adds access, live children, the browser tab and pending requests. A family status line keeps the parent aware of its children after its context is summarised.
- Bot threads get the same page; today they get none (`MousseMcpServer.ts:237`).

### 1.5 Tool list

**thread**
- Tools: `thread_list`, `thread_read`, `thread_search`, `thread_create`, `thread_send`, `thread_wait`, `thread_stop`, `thread_update`, `thread_archive`, `thread_fork`, `thread_return`.
- Merged in:
  - the subagent tools (§2.1);
  - `thread_steer`, `queue_enqueue` and `bot_send` → `thread_send`;
  - `thread_interrupt` → `thread_stop`;
  - `thread_hide` → `thread_update hidden`;
  - `thread_merge_back` → `thread_return`.
- `thread_archive` follows one rule, by capability (`thread.ts:1777`).

**queue**
- Tools: `queue_list`, `queue_update op: edit|remove|move|send_now`.
- Replaces: `queue_edit`, `queue_remove`, `queue_reorder`, `queue_promote_to_steer`. The revision and run checks stay.

**request**
- Tools: `question_ask`, `question_withdraw`, `permission_ask` (bots only), `request_answer`.
- Replaces:
  - `ask_user`, `ask_owner` and `automation_ask` → `question_ask`;
  - `withdraw_question` → `question_withdraw`, which bots get too;
  - `escalate` → `permission_ask`;
  - `answer_subagent`, `approval_respond` and `question_answer` → `request_answer`.
- `request_answer` takes the request id, its revision and a typed answer.

**checklist**
- Tools: `task_list`, `task_create`, `task_update`, `goal_update`.
- Replaces: `list_tasks`, `create_task`, `update_task`, `goal_status`.

**discovery**
- Tools: `skill_list`, `skill_load`, `model_list`, `computer_list`, `running_list`.
- Replaces: `list_skills`, `load_skill`, `list_models`, `work_models`, `list_computers`.
- Skills also load in Plan and reader turns (`skills.ts:42`).
- `running_list` lists every running command, server and terminal. `terminal_list` lists only a bot's own background commands.

**bot catalogue** (bots only)
- Tools: `tool_list`, `tool_call`, `mcp_server_list`.
- Replaces: `tool_catalogue`, `use_tool`, `mcp_servers`.
- `tool_call` resolves Mousse tools and offered relayed MCP tools through their own dispatchers. Today `use_tool` rejects MCP names (`registry.ts:459`). #1390 is blocked on this, so the fix ships early and on its own (PR 2c).

**bot self**
- Tools: `bot_list`, `bot_update`, `memory_list`, `memory_read`, `memory_search`, `memory_save`, `memory_remove`.
- Replaces: `set_profile`, `set_depth`, `use_model` and `telling_set` → `bot_update`, with authority checked per field; `memory_forget` → `memory_remove`.
- `consult` stays until the bot port supplies context-thread resolution and serialised consults (`BotEngine.ts:5769`).

**wake and terminal** (bots)
- Tools: `wake_set`, `terminal_start`, `terminal_list`, `terminal_read`, `terminal_stop`.
- Replaces: `wake` and `work_wait` → `wake_set`; `watch_*` → `terminal_*`.
- A wake is a durable continuation. It never resets a deadline, never creates authority and never becomes a person turn.
- Wakes are listed and cancelled through thread status and Stop, so `wake_list` and `wake_remove` are not needed yet.

**monitors and background work** (threads; #1605)
- Tools: `monitor_start`, `background_run`, `background_stop`, `keep_working`.
- `monitor_start` runs a script (each printed line is an event) or watches a `wss://` socket (`ws://` only on loopback); events within 200 ms are one notice. `background_run` tells the agent once, when its command ends, with the exit code and the end of its output. `keep_working` keeps the thread Working while it waits on something outside Mousse; `release: true` ends its holds. `background_stop` stops any of them by id.
- Notices are `reconcile_notice` rows with payload `monitor_event`, delivered as agent notes are; the output is quoted. Every end is told (exit, socket close, failure, timeout, over-chatty, thread Stop, daemon restart); a Stop's notice waits for the next turn. `background_stop` posts no notice: its result carries what was not reported yet.
- Limits are named constants in `src/mms/monitors/ThreadMonitors.ts`; nothing caps how many run at once.
- Starting a script needs what the agent's shell needs (`editsWorkspace`, asks unless Full access, refused in Plan and read-only subagents). Bots keep `watch_start` and `wake`; these four are not offered to bots yet.

**automation**
- Names unchanged: `schedule_*`, `automation_*`, `bot_schedule_*`, `remind`, `reminder_*`, `run_report`.
- They get the shared contracts now. The merge is left to the Automations revamp.

**web, browser, secret, git, theme, profiler**
- Names unchanged, except `browser_request_human` → `browser_ask_human`.

**publish**
- Tools: `applet_publish`, `quick_action_create`, `card_show`, `image_make`.
- `applet_publish` takes a file path or inline source plus an `appletId` to revise it (#761), and subagents may use it.

**dev**
- `mousse_gui_*` → `dev_gui_*`, in dev builds only.

## 2. Subagents in full

### 2.1 Tools

| Tool | Parameters | Returns | Who may call |
|---|---|---|---|
| `thread_create` | `kind: subagent\|thread` (required), `title`, `message`, `project` (required for `thread`), `workspace: isolated\|shared`, `readOnly?`, `requires?`, `instanceId?`, `model?`, `effort?`, `mode?: agent\|plan`, `computer?`, `deadlineMinutes?`, `wake?: always\|settled_only` (default `always`, `delegation.ts:46`), `hidden?`, `notify?`, `clientRequestId` | `thread`, `run`, `delegationId`, `access {holds, lacks}`, `workspace`, `browserTab?`, `computer` | `kind: subagent` needs `threads.delegate`; `kind: thread` needs `threads.start`. A bot turn always goes through the bot port, with no fallback. |
| `thread_send` | `thread`, `message`, `intent: work\|note`, `attention?: none\|needed` (notes only), `runId?`, `mode?`, `interrupt?`, `notify?`, `clientRequestId` | `delivery: started\|presented\|waiting_for_boundary\|queued\|after_answer\|waiting_on_command\|runtime_owned`, `runId`, per-target receipts | Notes: family members, including readers. Work: the direct parent. Outside the family: today's rules, and `runId` is needed to join a running turn. |
| `thread_wait` | `thread?` (default: any of your children), `runId?`, `delegationId?`, `timeoutSeconds` (0 returns status now), `any\|all` | `state`, unread results, the children's open requests, connection loss | Readers. Wait cycles are refused. |
| `thread_stop` | `thread` (id, title, `children` or `descendants`), `runId?` | Per target: `stopped`, `stop_requested`, `uncertain` or `runtime_owned`, plus `resultKept` | Your own subtree needs no `runId`. Other threads need `runId` and `threads.manage`. |
| `thread_update` | `thread`, `expectedRevision`, then `title?`, `hidden?`, `access?` (`readOnly`, mode ceiling, named capabilities), `model?`, `workspace?`, `apply: next_turn\|now` | New revision, access, restart receipt | Metadata: as today. `access`, `model` and `workspace`: the direct parent only, within its current map. |
| `thread_list` | `scope: family\|all\|bot_work`, filters, `limit`, `cursor` | Each row: `title`, `thread`, `relation` (self, parent, child, sibling, descendant, native), `parentThread`, `state`, `doing` (step and seconds), `access`, `workspace`, `computer`, `model`, `unread`, `tokens`, `elapsedSeconds`, `actions`, and `agentId` for native rows | Everyone. |
| `thread_read`, `thread_search` | As today, plus `view: delegations` | Subagents and native helpers are included. Search covers them by default; today it skips them (`thread.ts:1474`). | As today. Subagents and mirrors take their root's visibility and secret masking. |
| `request_answer` | `thread`, `requestId`, `revision`, a typed answer, `clientRequestId` | `answered`, `stale`, `fenced`, `already_answered`, or refused | `canAnswerApproval` unchanged, including the profile-switch branch (`approvalRights.ts:132`): direct parent only, within its mode, never "always", never your own request (`:128`). |

**Old names map as follows.**
- `delegate_task`, bot `subagent_start`, bot `work_start` and `create_subagent(s)` → `thread_create kind: subagent`. `create_subagent` keeps its reader default, and `create_subagents` returns per-child receipts.
- `continue_subagent`, `subagent_send` and `recall_subagent` → `thread_send intent: work`.
- `thread_steer` and `work_note` → `thread_send intent: note` with `runId`.
- `task_status`, `subagent_wait` and `subagent_result` → `thread_wait`.
- `task_cancel`, `subagent_stop`, `work_stop` and `thread_interrupt` → `thread_stop`.
- `list_subagents` and `work_list` → `thread_list`.
- `list_delegations` → `thread_read view: delegations`.
- `integrate_*` reads the frozen result and reports that nothing was merged.

### 2.2 Delivery

**Work**
- Work is a new assignment.
- Sent to your own child, it writes the assignment, the run and the result subscription in one transaction. Today that send is refused (`thread.ts:1561`).
- It always queues behind running work.
- It runs no wider than the stricter of the sender's mode and the target's mode.

**Note**
- A note is information. It grants nothing, and it is the only kind delivered mid-run.
- It arrives as labelled data with the sender's name and access, never as an instruction. Only a parent's note to its own subtree may be worded as direction.
- A note from outside the family into a run looser than the sender's is refused, as a steer is today (`thread.ts:659`).
- `attention: needed` (a question or finding) schedules a notice turn on an idle target.
- `attention: none` waits for the target's next turn and does not hold a delegation open.

**How a note or notice reaches a running thread.** Runtime support is checked in code (`adapter.ts:34`).

| Runtime | Steer support | Normal delivery | Explicit interrupt |
|---|---|---|---|
| Codex | `native` (`codex/adapter.ts:103`) | Injected into the running turn. It waits out a running command, MCP call or search (the hold). | Not needed. |
| Pi | `native` (`pi/engines/rpc.ts:35`) | Injected into the running turn. | Not needed. |
| Claude Code, Cursor, ACP | `interrupt_restart` (`claudeCode/adapter.ts:46`, `cursor/adapter.ts:13`, `acp/capabilities.ts:12`) | At the next Mousse tool call, as a separate labelled block after that tool's own result. Otherwise at the next turn (`waiting_for_boundary`). | `interrupt: true` (parent only) uses the restart path. |

Rules for every runtime:
- Activity in a native tool (file edits, the shell) is not a Mousse delivery boundary.
- A pending note stays pending until its path confirms it was presented.
- Boundary delivery marks the row as delivered by that call, as a steer does. The row goes back to pending if the call fails (`wake.ts:206`, `restoreUndeliveredRows`).
- Relayed `<server>__<tool>` results carry nothing.
- `interrupt` is refused with `waiting_on_request` while the target waits on a question or approval, because a steer settles a waiting request today.

**What the sender gets back, by target state.**

| Target | Result |
|---|---|
| Idle | Work starts a turn (`started`). A note follows `attention`. |
| Running | `presented` or `waiting_for_boundary`. |
| In one long command | `waiting_on_command`, with the command and its running time. |
| Waiting on a request | `after_answer`. A message never answers, dismisses or replaces a request. |
| Native helper | `runtime_owned`, with the runtime agent id and the runtime's own message tool. |

**Chains.** One causal chain record covers every agent and bot message, wake and delegation (#1442). Exact duplicates coalesce. A likely loop holds the message for the person's Continue or Stop, and nothing is dropped (#1443).

### 2.3 Results

- Each settle sends one `result` notice, redelivered until it is acknowledged. It carries:
  - the outcome and the final text, cut with a read-more link;
  - the access the child had and what it lacked;
  - its workspace;
  - the base and result snapshots, the changed files and the Git state.
- A child is not finished while it has descendants, actionable inbox items or provider background work. A note with `attention: none` does not count.
- Stop never deletes a result. One cancellation path drops a result today (`OrchestratorService.ts:8377`); that gets fixed.

### 2.4 Missing capability: notice and repair

1. If a `requires` capability can't be held or enforced, the create is refused before the child starts.
2. The create result, the family list and the result all show `access` and `lacks`.
3. A child's first refusal for each missing capability goes up as follows:
   - **The parent holds it.** A `lacks` notice wakes the parent, even an idle one. The child's refusal says "your parent was told", and the child goes on with what it can do.
   - **The parent lacks it too.** In a thread tree, one notice on the root names the mode or setting that would give it. It is not a request and grants nothing. In a bot tree, the bot asks the owner (`permission_ask`).
   - **It was revoked during this work.** The refusal is `revoked` with `retry: never`. That work never asks for it again, and the bot chat gets one notice.
4. `thread_update access … apply: now` repairs the same thread:
   - it checkpoints the transcript, pending messages and snapshot;
   - it revokes the old execution epoch;
   - it recomputes access;
   - it restarts the current attempt with that history.
5. The parent can lift only a narrowing it imposed, and only up to what it holds.

The real case this fixes: a read-only reviewer has no shell, so the parent is told, it calls `thread_update access {readOnly: false} apply: now`, and the same thread continues.

### 2.5 Corrections, Stop and lifetime

**Corrections.**
- When the person steers a thread that has live descendants, the daemon records a tree instruction revision.
- The composer offers "also to subagents". It is on by default for a steer and off for an ordinary or queued message.
- Each descendant receives: "The person told your parent <title>: … Apply it where it changes your task; do not take on work it gives your parent." It carries no `person` authority.
- The parent and the person get a delivery record for each child.

**What a correction does to each descendant.**

| Descendant | Effect |
|---|---|
| Running | Delivered as in §2.2. One stuck in a long command shows `waiting_on_command`, with Stop on its row. |
| Queued, not started | Starts with the revision. |
| Started later from a run older than the revision | Inherits the revision. |
| Waiting on an approval | The request is fenced (below). |

**Fence.**
- The fence covers pending actions in the descendants the correction reached.
- It applies when the answer settles and again immediately before dispatch, whoever answers (`UserQuestionService.ts:435`, `ThreadApprovals.ts:379`).
- An approval from an older revision can't release the action. The child reads the correction and presents the action again if it still applies.
- The old card stays visible, marked "correction arrived", so it can be read or rejected.
- A correction never answers or approves anything.

**Stop.**
- A person's Stop on a parent stops its subtree, as it does today.
- An unconfirmed remote stop shows `stop_requested` and is applied on reconnect.

**Lifetime.**
- A parent's turn ending does not stop its children.
- Archiving is refused while owned work runs.
- Expiry, expiry changes, removal and deletion are replicated to the executing computer as durable intents (#685).
- Completing bot work stops its remaining descendants. Dispatch boundaries don't.

### 2.6 Browser

**The grant.**
- A browser grant belongs to a task tree, not to a source label. It records the backend, the browser workspace, the allowed operations, domains, owner, revision and life.
- It is rooted in a person-started run. It covers that run and every run descended from it: its children and the result wakes of the same tree.
- It lives until the tree has no running or queued run and no undelivered result or notice, or until Stop or revocation.
- A run paused by a usage limit or parked on a request keeps the grant.
- Schedule, webhook, remote-origin and agent-message turns start no grant.
- This loosens the rule at `mainBrowserBinding.ts:17–19` in one case: runs inside a live, person-started tree. Subagents need the browser there, and the person's agent-browser permission covers it.

**Remote.**
- A tree has one browser authorization lineage, with a binding issued separately on each executing computer.
- Each binding fixes that computer's backend and workspace, is bounded by its policy, and records the parent grant and its revision.
- Sign-ins are never copied, and no local browser id stands in for a remote one.
- If current authority is lost, browser actions stop until it is revalidated. This ships with remote browser inheritance.

**Rights.**
- `browser.read`: observe, find, extract, screenshot, wait, and `browser_tabs operation: list` (`tools.ts:86–99`, `automation.ts:59`).
- `browser.act`: act, `browser_open`, and `browser_tabs` new, switch and close. These need the tab's lease.
- Reader definitions leave out mutation arguments, and execution checks them again.

**Tabs.**
- Each agent with `browser.act` holds a lease keyed by (root, agent thread). A lease may hold several tabs.
- A missing lease opens a new tab. It never borrows a free tab, which `selectedTarget` does today (`MmsBrowserService.ts:316`).
- A tab has one driver. Trying to drive another agent's tab is refused `browser_busy`, naming the owner.
- A reader has no tab of its own. It observes tabs in its tree through a host-made session. If it needs its own page, it gets a `lacks` refusal and §2.4 applies.

**Backend.**
- The backend is fixed when the grant is made:
  - the in-app browser, if a window of this profile is attached and the person allowed agent browser access;
  - otherwise, the profile's managed browser workspace, which has its own sign-ins (`MmsBrowserService.ts:159`).
- Sign-ins are never copied between backends.
- If the backend disappears, browser calls pause the work with one rebind request per grant. There is no automatic move to the other backend.
- An in-app grant whose request is answered from another device also pauses with a rebind request.
- Before shipping, confirm that a background in-app tab still gives screenshots and waits.

**Other cases.**
- **Bot subagent:** uses the bot's own browser under the bot's grant, never the person's tabs. Ships in PR 7.
- **`browser_ask_human` from a child:** the request goes to the root.
- **Stale refs:** action refs carry the tab generation and observation id.
- **Person takeover:** holds agent input (`person_has_tab`) until released.
- **Binding caps:** the 100-call and 30-minute caps (`mainBrowserBinding.ts:33`) become visible counts.

**What the person sees.** Each tab shows a chip with the agent's name, a spinner while it acts, its observers, and a link to the agent's thread. This builds on #1052 and #822.

### 2.7 Native subagent threads

**Mirror threads.** These are made at provider ingestion. Each has:
- relation `native`, its lineage, provider instance and session epoch;
- an id ending in the runtime agent id;
- its own log: prompt, tool calls, results, messages and outcome;
- real run rows.

**Sources and state.**
- Claude frames come from `parent_tool_use_id` (`turnFrames.ts:254`, `liveSession.ts`).
- Codex helpers are read from the app server, including nested ones.
- Stable source-event ids stop backfill from duplicating.
- A missing end shows `unknown` or `disconnected`, never idle or done.
- Partial backfill is marked partial.
- Usage is summed once, on the parent.
- A mirror takes its root's visibility.

**Send and Stop.**
- A send returns `runtime_owned` with the agent id (for Claude, use its SendMessage).
- `thread_stop` stops the helper where the runtime can (Codex). Otherwise it is refused `runtime_owned`, naming the hosting run to stop.
- The helper idle and pin caps (`CodexProviderService.ts:149`) stay until that Stop exists.

**Execution identity.**
- Mirroring creates no authority.
- **Trusted attribution** has to be established when the call is admitted. Where it exists, a helper's Mousse calls take their authority and browser ownership from the helper's identity.
- PR 6 checks whether the MCP request carries the tool-use id. Joined to the frame's `parent_tool_use_id`, that would give trusted attribution.
- **Unattributed calls** use only the hosting run's delegable authority. That excludes `person`, owner-preference powers and individual approvals.
  - If parent and helper calls share one indistinguishable credential, that restriction applies to the whole credential. Parent-only actions then need a separately authenticated, person-mediated path.
  - Unattributed calls never acknowledge the parent's notices.
  - Each `browser_open` they make gets its own tab under the host's grant, and later calls name that session. The chip reads "<host> · helper".

**Approvals.**
- A helper's request is the hosting run's own, so the hosting thread can never answer it (`own_request`).
- It is resolved through namespaced item maps (runtime thread plus item id), with no fallback to the parent's patch or command.
- It is shown on the helper and the root, and settles the provider request once.
- Today Codex helper approvals are cancelled (`CodexProviderService.ts:2320–2372`).
- Bot and reader policy still apply.

### 2.8 Bots

**One ledger.**
- Threads and bots share one ledger for delegations, receipts, inbox, results and notices.
- The bot port supplies only the grant, provider hold, budget and visibility.
- The in-memory state in BotEngine moves into the ledger (`BotEngine.ts:771–783`).
- One contract test file runs against both.

**Bot port.**
- A bot turn's subagent call without the bot port is refused, and a test covers this.

**Grants.**
- The grant is read live, so a removed permission applies at each descendant's next call.
- A revoked capability follows §2.4: refused `revoked` and never asked for again.
- The provider hold stays (`subagentHold.ts`).

**Nesting and messages.**
- Nesting works at any depth. Today it is stripped (`compile.ts:274`) and refused (`BotEngine.ts:3577`).
- A working bot child accepts notes; today it refuses them (`BotEngine.ts:5997`).

**No hard cut-offs.**
- Delegated bot work loses the mandatory work-time and continuation limits (`definition.ts:349`, `manifest.ts:444`, `BotEngine.ts:455`).
- Limits the owner set explicitly stay. A migration tells explicit limits apart from old defaults.
- A runtime continuation continues the same assignment.

**Other rules.**
- A bot's helper never answers on the owner's behalf.
- Briefs that are too long are refused or passed by file reference, never silently sliced (`bots.ts:871`).

### 2.9 Remote

- The remote codes and one-computer-deep chains stay.
- Expiry, expiry changes and removal are durable intents. The remote side deletes at expiry (#685).
- Remote creation accepts an optional `deadlineMinutes`, with no default and no maximum. Today the default is 6 hours and there is a clamp (`OrchestratorService.ts:7843`, `:7873`). The deadline counts running time, is enforced on the executing computer, and pauses while the work waits on a person.
- A person on another permitted device answers through the executing daemon. A remote agent cannot.
- Depends on #868 and #871.

### 2.10 Workspaces and cost

- **Workspaces:**
  - `isolated` is the default.
  - Shared writers are allowed, and each is told who shares the folder.
  - Mousse serialises its own Git, snapshot and Undo operations per folder. It does not lock the agents' own edits, and it says so.
- **Cost:**
  - Tree totals come from the existing ledgers.
  - They show on the root and in the family list.
  - There is a Stop for each child and one for the whole tree.

### 2.11 Requests while the person is away

**What the plan does.**
- Requests belong to the executing daemon. They survive the parent's turn ending, the app closing and restarts.
- Each shows once on the root and in Needs you, named by agent.
- Questions and ordinary approvals get no default unattended timeout. Today it is 10 minutes (`UserQuestionService.ts:386`, #1449).
- A phone answers once and makes no standing rule.
- A scheduled run parked on a request shows the ticks it has skipped (`OrchestratorService.ts:16228`).

**What stays.**
- Explicit caller deadlines.
- Action freshness.
- The accepted-send dispatch window (`BotActions.ts:254`, `:356`).
- Withdrawal on Stop or when the work is removed.

**After a restart.** A parked request reconnects to a new attempt. A decision is reused only for the exact same action. A stale external action needs a fresh review.

### 2.12 Restarts

- Task rows are durable.
- Interrupted children reach the parent as an `interrupted` notice with a Continue action. Runs get the same Continue (#514).
- Automatic resume is left for later.

### 2.13 What the person sees

- Subagents and native helpers nested under their parent, with a chip such as "4 · 2 running · 1 needs you".
- A tree panel on the root. Each row shows state, what it is doing, access, computer, model, tokens and time, with a Stop on each row and a Stop all.
- Every request in the tree shown on the root.
- "Watch-only" on native helpers.
- Relayed corrections labelled "from you, via <parent>".

## 3. Issues

| Issue | Effect | How |
|---|---|---|
| #1454 | Closes | Replaced by this plan. |
| #657 | Closes | Requests reach the parent as notices (§2.2) and through `thread_wait`. |
| #685 | Closes | Expiry, its changes and removal become durable intents; the remote side deletes at expiry. |
| #1360 | Closes (tool side) | One map based on provenance covers every bot turn kind. |
| #1446 | Closes | `question_withdraw` for bots. |
| #1449 | Closes | No default unattended timeout. |
| #1442 | Closes | One causal chain. |
| #1443 | Closes | A loop holds the message instead of dropping it. |
| #761 | Closes | `applet_publish` takes a file path. |
| #514 | Closes | Continue on interrupted runs. |
| #1364 | Closes | Oldest-work eviction is removed (`BotEngine.ts:1487`). Run slots are already gone (#1452). |
| #1361 | Helps | The chat gets web and granted MCP calls. The handoff policy for long shell and browser jobs, and checks that the chat stays responsive, are still open (`compile.ts:217`). |
| #1363 | Helps | Asks are no longer counted and repeats coalesce. "Allow everything" is left out. |
| #1448 | Helps | Fan-out, send, binding and bot work-time caps are removed. The 6-hour turn, scheduler and definition limits are left out. |
| #1362 | Helps | Bot work-time and continuation limits are removed (§2.8). |
| #1369 | Helps | Bot parity umbrella. |
| #1335 | Helps | `ask_first`. The approval UI is #1390 and #1403. |
| #1368 | Helps | Applet revision only. |
| #1444 | Helps | Intents, `attention`, coalescing. |
| #1052 | Helps | One viewer for agent tabs. |
| #592 | Helps | Narrowing applies at the next call. |
| #970, #477 | Helps | `interrupted` notice and Continue. |
| #1062 | Helps | Explicit tab identity makes it traceable. |
| #595 | Mostly fixed already | `secret_request` and `secret_run` exist. Check and close. |
| #345 | Left out | Needs the agent-definition domain-list change (`AgentDefinitionRegistry.ts:423`). |
| #1366 | Left out | Needs its own design for bot folder grants. |

## 4. Ship order

Old names stay listed until their family switches.

| PR | Content | Unlocks |
|---|---|---|
| 0 | Fail closed on a missing permission mode (`registry.ts:746`), after listing which turn kinds pass none. | Safety fix |
| 1a | Tracked `thread_send` to your own child; search covers subagents; `needs_input` on local waits; boundary delivery for results and requests. | #657, search |
| 1b | One refusal shape. | One error contract |
| 2a | Authority compiler at parity: provenance, stored ceilings, request policy, per-variant needs, `authorize`. A table test proves that no tool changes for any turn kind. | Structure |
| 2b | Intended changes: live narrowing, `lacks`, `thread_update access` repair, `threads.delegate` and `threads.start`, applets with file paths, skills for subagents, list-changed rotation. | Reader case, #761 |
| 2c | `tool_call` resolves offered MCP tools. | Unblocks #1390 |
| 3a | Family list, totals, tree panel, Stop on each row, the `interrupted` notice and Continue, paging and read-more. | Visibility, #514 |
| 3b | Work and note intents, the runtime delivery table, `attention`, `interrupt`, acknowledgement. | Messaging |
| 3c | Chain record and loop hold. | #1442, #1443, #1444 |
| 4 | Remove fixed fan-out and send caps, and the remote default deadline and clamp. | Part of #1448 |
| 5 | Browser grants for thread trees: leases, reader rights, chips, takeover, rebind. With #822. | Problem 2, #1052 |
| 6 | Native helper threads: attribution check, identity rules, Stop, approvals. | Problem 5 |
| 7 | One ledger for bots, bot port, nesting, live grant and `revoked`, notes, `question_withdraw`, no eviction, removal of bot work-time limits, bot browser. | #1360, #1362, #1364, #1446 |
| 8 | Requests that park; correction revision and fence. With #1390 and #1403. | #1449, #1363 |
| 9 | Names switch family by family, with durable receipts per family. Hidden aliases that still work. The instructions page. | One naming scheme |
| 10 | Remote expiry and stop intents, running-time deadline, remote browser bindings. With #868 and #871. | #685 |

Aliases stay hidden but callable until a later cleanup PR, once the logs show no calls. They map to the canonical operation before authorization and before the key is built. Old response shapes stay where prompts depend on them.

## 5. Risks

| Risk | Containment |
|---|---|
| One name unifies authority | Per-variant needs; `kind` and ownership fixed at creation; the bot port chosen first. |
| The compiler changes who holds a tool | PR 2a's parity table, including request policy. |
| Delivery promised where a runtime can't do it | The runtime table, honest delivery states, pending until presented. |
| A correction arrives after the old action runs | The tree revision and the dispatch fence, whoever answers. |
| A helper borrows the parent's authority | Delegable authority only without trusted attribution; `own_request`; namespaced items. |
| Wrong tab or wrong sign-ins | Tree grant, leases, a fixed backend, per-computer bindings, no copying. |
| A wake drives the person's tabs unwatched | Grants only within a live person-started tree; timer resumes lose `person`. |
| Tool lists churn and cost warm processes | Lists follow the thread's stable ceiling, not the turn. |
| A child widens when its parent does | Stored ceiling; only `thread_update` widens. |
| The rename breaks saved prompts | Switches family by family, aliases, dual retry lookup. |
| Work runs away without caps | Totals, loop holds, subtree Stop, helper caps until the helper Stop exists. |

## 6. Structural findings on today's API

1. A missing permission mode lets edits through without asking (`registry.ts:746`). Fixed in PR 0.
2. Five refusal shapes. PR 1b.
3. Listing and dispatch disagree (`bots.ts:607`, `registry.ts:436`, `skills.ts:42`, `browser.ts:56`). PR 2a.
4. `use_tool` rejects offered MCP tools (`registry.ts:459`). PR 2c.
5. `clientRequestId` is stripped, yet declared on only a few tools (`MousseMcpServer.ts:245`). PRs 1b and 9.
6. `class: "read"` mixes reads with writes to the thread's own state. PR 2a.
7. "Hidden" means both unlisted and uncallable. PR 2a.
8. `subagent: false` is passed while modules hold subagent exclusions (`OrchestratorService.ts:4167`). PR 2a.
9. `thread_create` and `thread_fork` are in different classes. `thread_archive` follows two rules. `thread_hide` is listed for bots only. PR 2b.
10. Local `thread_list` has no byte-fitting and no cursor (`thread.ts:1469`), and large payloads are preview-only (`thread.ts:427`). PR 3a.
11. Bot briefs are sliced silently (`bots.ts:871`), and schedule-delete retries live in memory (`schedules.ts:196`). PRs 7 and 9.
12. The instructions repeat descriptions and state caps. PR 9.
13. A missing space: "for them.Name" (`thread.ts:2292`).

