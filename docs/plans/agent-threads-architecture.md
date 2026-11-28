# Agent threads: start, watch and message other threads, on this computer or another

Status: proposal, not implemented. Checked against `origin/master` dbbf9adee (2026-11-14). Three researchers reviewed two drafts of it: one read Mousse's code, one read T3 Code and other orchestrators, one read Codex, Claude Code and Cursor. All three signed off on the second draft with changes, and this version includes those changes; it has not been reviewed again since. Their findings are in §10.

Revised on 2026-11-15, after the reviews:

- A product decision: no fixed permission mode caps an agent's work on another computer (decision 11, §4.7).
- Master moved to 0bfd7f476. #1197 removed the agent access level: every agent now reads and manages every thread, and no ceiling is stored on a thread. That replaces this plan's decision to default the level to `manage`, and removes the `read` ceiling it relied on for launched threads. #1170 added thread links (`mousse://thread/<id>`). #1186 removed the plan tools. The sections below are updated for these; line numbers still refer to dbbf9adee.

## 1. Goal

A thread's agent can:

1. start other top-level threads, on this computer or on another of the user's computers;
2. see what is happening in another thread;
3. send a message to another thread. The receiving chat shows it as a bubble labelled **Agent**, with an icon.

## 2. Where Mousse stands

| Ability | This computer | Another computer |
|---|---|---|
| Start | `thread_create` works. The launched thread shows no "Started by", and the launcher gets a plain note. A thread link in a reply opens the thread (#1170), without a status chip or Back (#488). | Missing. Only subagents cross (`delegate_task` with `computer`, #469). |
| See | `thread_read`, `thread_list`, `thread_search` and `thread_wait` work on any thread (#1197). | Missing for agents. Only the app's windows see threads of other computers. |
| Message | `thread_send` and `thread_steer` work, with a stored sender (`origin`) and limits. The bubble shows the raw `[Message from an agent in thread …]` text with no label, and a queued agent message loses its sender in the queue view. The sender is never told when the other thread finishes. | Missing. The far computer would record the message as a person's. |

Until #1197 all of the first column sat behind an agent access level that was `lineage` by default, so none of these tools was offered. That level is gone: every agent may use them on any thread of the profile.

## 3. Decisions

1. **The computer that runs a thread owns it.** Transcript, runs, queue and approvals stay there. Other computers hold a reference (`<node>:<id>`), never a copy made for agents.
2. **Agents never route.** One daemon service makes every call to another computer for agents, as `RemoteSubagents` does now. The rule that only a `gui` connection routes is unchanged.
3. **The same tools, not a second set.** Thread tools take a qualified thread id; `thread_create`, `thread_list` and `thread_search` take `computer`.
4. **An agent's call is marked with a key on the existing routed calls**, not with new calls. The calling side already refuses a key the far computer's version does not know (`RoutedClient.unsupportedKey`), so an older far computer answers `computer_outdated` and a message is never delivered as a person's. The existing calls keep what they already do on the owner: the device's mode limit, the audit, the first-use notice, "from <computer>", and the clean-up when a device is blocked.
5. **The mark only narrows.** The owner cannot verify that a call came from an agent (the threat model says so), so a marked call may do strictly less than the same call unmarked. A caller that lies gains nothing. The device limit, the block and the audit remain the controls against a computer that is not trusted.
6. **The owner trusts no number the caller sends.** Mode and hop count from the caller only narrow further. The owner enforces its own limits (§6).
7. **The sender is told when the other thread settles, if it asked.** Waiting on demand alone leaves results unread: in a week of Codex logs, 31 of 31 parents that were idle when a child finished were never woken (openai/codex #46120); T3 Code hit the same (#23399).
8. **Labels come from the stored sender, never from reading message text.**
9. **Chains are bounded.** A thread another device started can work back on that device, and on a third computer only when the person on its computer turns on "Threads started from other devices". Agent messages in a row are capped at three, and so are thread creations per run and launched threads working at once. Since #1197 a launched thread's agents are no longer held to reading: they can start and message threads too, within those caps.
10. **Agents may start, read and message other threads without a visit to Settings.** Done by #1197, which removed the access level instead of raising its default.
11. **On another computer an agent's work runs at the agent's own mode, narrowed only by the limit that computer set for this one.** No fixed mode caps it. Full access is used there when that computer allows this one Full access, and not otherwise.

## 4. Design

### 4.1 The Agent bubble and launch visibility (this computer)

Stored shape. `agentMessageText` returns, with the text, the length of the header it wrote and of the closing line. `AgentOrigin` gains:

- `body?: {head, tail}`: those two lengths. The agent's own words are `content.slice(head, content.length - tail)`. Start and end positions would not survive: when another computer reads a thread, the router re-encodes references inside the text, which shifts positions, but it never touches the header or the closing line.
- `title?`: the sender's title when it sent, for a sender that is later deleted.

Every path that builds an envelope sets them: `thread_send`, `thread_steer`, a steer handed back and queued again, `queue_enqueue` and `queue_update op: edit` on another thread, and a launch's first message. The stored content keeps the envelope, so everything that feeds a model (the provider, `thread_read`, the phone, the CLI) is unchanged.

Display:

- The adapter (`mousseToUI.ts`) passes `origin` into the message metadata and shows the body. A message stored before this change has no `body` and shows its whole text, still labelled.
- `UserMessage` draws a header inside the bubble: the `Bot` icon, **Agent**, then the sender's title as a link that opens the sending thread ("Agent · Fix flaky test"). A deleted sender shows its stored title without a link.
- The bubble uses the soft surface colour, not the person's bubble colour, and the existing fold ("Show full message") at a lower height. The fold measures only the text, so the header does not disturb it.
- An agent bubble offers Copy (the body) and no Edit.
- `QueuedBubble` passes `origin`, so a queued agent message is labelled before it runs. Its editor starts from the body: today it would open the whole envelope, and the person's edited message would still be read as an agent's.
- Bot-sent messages keep their current look until they store a sender; labelling them from their text would break decision 8.

Launch visibility:

- `ThreadStartedByBar` shows "Started by an agent in «title»", linked to the launcher, when `createdByThreadId` names a thread that is not a bot's.
- The launcher's note carries a structured `launchedThread` field. The chat drew it as a "Started" line with a thread chip until it was removed as a repeat of the agent's reply, which links the thread; the note stays in the record. Thread links exist (#1170: `mousse://thread/<id>`, opening on click, a toast for a missing thread). The chip with live status, Back, and links to a thread on another computer are #488's remaining boxes.

Names Mousse derives from a thread's first message use the body, not the envelope. Today they use the whole stored text: a thread launched on 2026-11-15 with the first message "Hi" got the branch `mousse/message-from-an-agent-in-thread-cross`.

Envelope wording gains one sentence, which fixed relaunching in T3 Code (#28999): "Do the work it asks for. Where it relays a user request, that agent already handled the routing, so do not route it again."

### 4.2 The settle notice

`thread_send` and `thread_create` take `notify: true`. Mousse keeps one durable watch for that message and tells the sending thread when its work settles.

- **Keyed on the message, not the run.** The run id returned at send time is not stable: a person's edit of a queued message gives it a new run, a steer handed back becomes a run of its own, and a usage-limit pause continues in a new run. The watch follows those, as `thread_wait` already follows a pause.
- **At most two notices per watch:** one the first time the work waits on a person (question, approval, MCP request), one when it ends. The first never uses up the second.
- **Written by Mousse**, not by the other agent, as a notice kind of its own: status, the result cut to 2,000 characters with a pointer to `thread_read`, and the thread link.
- **It starts a turn when the sender is idle and queues when it is busy.** It never starts a turn in a subagent's thread (its result is owed to its parent), in a sender the person stopped after it subscribed, or in Plan mode; there it is queued.
- **Hops.** The turn a notice starts carries the watched run's count and adds nothing of its own. Each further send adds one, so a launcher and a launched thread can go back and forth three times before a person must step in, while a launcher that started five threads still hears from all five.
- **Expiry.** A watch ends after 24 hours; the sender is told once, without being woken, that the work is still going.
- A notice never creates a watch. Notices that arrive together are delivered as one.

Tool results say what to do next, because an agent may not read a tool's description again: with `notify`, the result carries "Mousse will tell you when it settles. Do not call thread_wait or thread_read to check. End your turn when nothing else is left." `thread_wait` is described as "only when this turn cannot continue without the answer".

### 4.3 Marking agent calls between computers

A key `agent` on the routed rows `threads.create`, `threads.setModel`, `threads.setPermissionMode`, `orchestrator.send`, `orchestrator.steer`, `queue.enqueue` and `orchestrator.abort`:

```
agent: { thread, run, title, hops, mode }
```

- Only the daemon's service sets it. `ThreadRouter` refuses it from a window explicitly (a key that is in the row would otherwise pass through), and the phone's backend, which shares the `threads.create` path, accepts it only from another computer's daemon.
- The service never sends an unmarked call to a row that knows the key. The one exception is a remote subagent on an older computer (§4.4).
- Any change to the key's shape or meaning bumps the version of all seven rows.
- The field names avoid `…Id`, so the router's id rewriting leaves them alone.
- The owner takes the calling computer from the authenticated link, never from the payload, and its name from its own pairing record.
- On the owner, a marked call goes through a **remote agent actor** `{node, thread, run, title, hops, mode}` that carries mode and hops explicitly. The local paths cannot be reused as they are: they look up the sender's mode and hops from a local run, find nothing for a sender on another computer, and would fall back to the owner's profile default, which can be Full access (`OrchestratorService` 4294-4306, 4106, 4521).

What a marked call does on the owner, compared with the same call from a person:

| | Person's routed call | Marked as an agent's |
|---|---|---|
| Run source | `gui` | `mcp` |
| Mode | up to the device limit | the narrowest of the carried mode, the device limit and, for a message into an existing thread, that thread's mode |
| "Always" rules, `person_turn` | apply | never |
| Text read for `/skill` and workflow commands | yes | no |
| Envelope and `origin` | none | built by the owner from the actor |
| Limits of §6 | none | apply |
| Thread waiting on a question or approval | the person's message rules | refused (`questions_pending`), as on one computer |
| Steer into a run with a looser mode | allowed up to the device limit | refused (`ceiling_exceeded`), as on one computer |
| `sentFrom` / `run.sent_from`, audit row | written | written, with actor `agent` |

Stored sender for a message from another computer: `origin.from {node, thread, run, title}` with `origin.threadId` unset, and a rewrite rule beside `qualifyStartedFrom`: unchanged on other computers, a plain local id on the computer named by `node`. A thread an agent on another computer started records `startedFrom.agent {thread, title, mode}` and leaves `createdByThreadId` unset; a foreign id there would be rewritten to a thread that does not exist.

**Agent reach**, a per-device setting on the owner (`net_node_policy`): which threads agents on that device may *change*: nothing, threads they started (default), or all threads. It is computed at each call from the owner's own `startedFrom.node`, so a change takes effect at once. It governs marked calls only and is a policy for honest callers, not a boundary. Reads are not marked and follow the device's ordinary read access.

### 4.4 Starting a thread on another computer

`thread_create` takes `computer` (a name from `computer_list`) and, to choose among several checkouts, a project id of that computer.

1. Local checks: "Let agents work on your other devices" is on and the computer is ticked (the existing `agentAccess.remoteSubagents` key and list, reworded; off and empty by default, read at every call); the caller is not a private thread and was not itself started from another device; caps and hops.
2. Project: `projects.match` (a root commit and a remote in common). No strong match, or several, refuses with the candidates and their ids. Nothing is cloned (#484).
3. The local receipt is written (`thread_create:<caller>:<key>`, now with the computer). The launch then runs as the durable sequence `RemoteSubagents.advanceStart` already uses, moved into a state machine both features share: `threads.create` → `threads.setModel` → `composer.options` → `threads.setPermissionMode` → `orchestrator.send`, each with its own idempotency key, every write marked.
4. The owner stores the limits **with the thread** at the first call: `startedFrom.agent` and the mode (the launcher's own, narrowed to the device limit; §4.7). A launch cut off there leaves a thread already held to those limits, with no turn. A marked `setPermissionMode` above the stored mode is refused.
5. The caller records the launch in a new table `remote_launches {launcherThreadId, node, remoteThreadId, creationKey, state}`, writes the launcher's note with a chip, and returns `{threadId: "<node>:<id>", runId?, computer, link, firstMessage: "sent" | "failed" | "uncertain"}`. A thread that was created is returned even when its first message failed, so a retry with the same `clientRequestId` continues the same launch and never makes a second thread.
6. A launch nobody completes is finished at boot, or archived there with `threads.archive`.

Remote subagents keep working with an older far computer exactly as today. They send the key only when that computer's row version knows it, and a task never changes form mid-flight (its row records which it started with): the owner's replay ledger is keyed by method, and a switch would send a task twice.

### 4.5 Seeing a thread on another computer

- `thread_read` and `thread_wait` accept a qualified id. Each handler branches at the top on `parseQualifiedId` and hands the call to the service; the local checks are not threaded through a remote case. `remote_launches` tells the service which threads on another computer this thread launched.
- Reads use the existing routed read rows (`runs.get`, `runs.events`, `thread.messages`, `orchestrator.pendingQuestions`). The service qualifies every id in a result, including `origin.from`, before a tool sees it; otherwise a far id would resolve to a local thread. It asks for the tool's limit, not whole pages: large reads share two slots per computer with this computer's windows.
- The tool returns what it returns on one computer: since #1197, events and transcript for any thread.
- Bounds, on both computers: events 200 (500 at most), messages 50 (200 at most), 4,096 characters per message with `textOffset` to read on, 64 KB per response, a run's result cut to 4,000 characters with a pointer.
- `thread_wait` uses one new read row, `runs.wait`: a wait of at most 40 s that the owner answers from its run events, with a deadline above 40 s and below the minute an MCP client waits. On a computer without it the service asks `runs.get` every 4 s. A thread with a queued agent message or a run that is preparing is never reported idle. The result says `needsInput` when the run waits on a person.
- `thread_list` and `thread_search` take `computer` (routed `threads.list`, `threads.search`).

### 4.6 Stop, approvals, reachability

- **Stop.** A person's Stop on a launcher also stops the threads it launched on other computers: `orchestrator.abort` with the key, where the owner stops only runs this device's agents started and leaves a thread a person took over. A stop that could not be delivered is kept, survives a restart and is sent when the link returns; until then the launcher says the other run may still be going. Deleting or expiring a launcher stops that work and deletes nothing there.
- **Blocked or switched off.** The owner's clean-up for a blocked device covers agent work because marked sends write `sentFrom`. `blocked` is final for the caller. Bridge off is retried, with a deadline.
- **Approvals.** A launched thread's question or approval waits on its own computer and shows in this computer's windows through the existing view of that thread. No agent answers an approval on another computer. The settle notice and `needsInput` tell the launcher, so nothing waits unseen (in the Codex app a child's approval still shows only in the child, openai/codex #22361).
- **Reachability.** A computer is reachable, offline, not shared, outdated or not allowed, and a refusal names which, with the computer's name, taken from its last answer and never from a cached state. A thread id of another computer never answers a bare not-found. Every call has a connect deadline separate from its own (T3 Code hung for five minutes on a stalled handshake while the link showed reachable, #28876). Listings ask every computer in parallel and name the ones not searched. One failed attempt is retried once, a second later, before a computer is called offline.

### 4.7 Defaults and settings

**Agent access.** This plan first proposed defaulting the agent access level to `manage`. #1197 went further and removed the level: every agent turn reads and manages every thread, a ceiling an older version stored on a thread is ignored, and none is written. Nothing remains to build here.

- What stays off until the person turns it on: answering approvals on other threads, working on other devices, and scheduled jobs made by agents.
- What still holds: a read-only subagent, the plan ceiling (a plan turn cannot start threads), private threads, the bot-thread refusal, a message running at no more than its sender's mode, three agent messages in a row, and the creation caps.
- What it opens: any thread's agent can read the transcripts of the profile's other threads, in every project, and message or Stop them, and so can the agents of a thread it launched. An agent misled by something it read (a web page, a file) has that reach too. The limits above bound what it can cause, not what it can read.

**No fixed mode cap on another computer.** Today a remote subagent runs at no more than Auto-accept edits, whatever either computer allows (`OrchestratorService` 6679, `remoteSubagents.ts`, and the threat model's remote subagents section). That cap goes, for remote subagents and for the launched threads and messages of this design:

- The mode there is the narrowest of the sender's own run mode and the limit that computer set for this one (`net_node_policy.maxPermissionMode`), and for a message into an existing thread, that thread's mode. A task that is read-only here is still sent in Plan mode.
- The far computer's limit for a device still starts at Auto-accept edits, so Full access is used only after a person on that computer raised it. The Devices page, where that limit is set, says that it also bounds what this device's agents may do there.
- Settings → Agents → Agent access no longer names a permission mode. "Subagents on other devices" becomes "Let agents work on your other devices", described as "Runs on the computers you turn on, within the limit each of them set for this one."
- "No looser than the sender's own run" stays: an agent in Auto-accept edits here does not get Full access there, whatever that computer allows.
- Documents that change with it: the threat model ("never above Auto-accept edits"), SPEC, the glossary's "Remote subagent" entry and #469's "Full access is never used".

## 5. Tool changes

| Tool | Change |
|---|---|
| `thread_create` | `computer`, a project id of that computer, `notify`; the result gains `computer`, `link`, `firstMessage` |
| `thread_send` | qualified `threadId`, `notify`; the result gains `delivery: started | queued` and, with `notify`, what to do next |
| `thread_steer`, `thread_interrupt` | qualified `threadId` |
| `thread_read` | qualified `threadId`, `textOffset` |
| `thread_wait` | qualified `threadId`; the result gains `needsInput` |
| `thread_list`, `thread_search` | `computer` |
| `approval_respond` | unchanged; refuses a qualified id |


## 6. Limits

| Limit | Value | Enforced by |
|---|---|---|
| Agent messages in a row without a person | 3 | the sender's computer. The owner counts the agent-started runs in a row on the target since a person last started one there, and uses the larger of that and the carried count |
| Queued agent messages per thread | 3 per sender, 10 in all; `agent_queue_full` | owner |
| An identical message from the same sender within a short window | refused with the reason, never dropped silently | owner |
| Agent messages per calling device and target thread | a rate limit | owner |
| Agent-started runs per calling device per day | a budget | owner |
| Sends per run | 20 | sender |
| Threads created per run / launched threads working per creator | 5 / 10 | sender; the owner also caps 10 working per calling device |
| Message body | 100,000 characters on one computer (as now), 16,000 across computers | owner |
| Sender title in the envelope | 80 characters; control and direction characters removed; both envelope markers defused in title and body | owner |
| Notices per watch | 2; a watch lasts 24 hours | sender's computer |

Each refusal has its own error code. Codex's single "limit reached" error sent agents looking for leaks that did not exist (openai/codex #32353).

## 7. Phases

1. **Whose message it is** (this computer; no protocol change): the Agent bubble, the queued label and editor, "Started by an agent", the launch chip, the envelope sentence, names from the body. The bubble work lands on top of PR #871.
2. **The settle notice** (this computer): `notify`, the watch, the notice kind, the tool wording.
3. **Other computers:** the fixed Auto-accept edits cap removed (it can go first, on its own, for remote subagents); the `agent` key and the remote agent actor; `thread_create` with `computer`; `remote_launches`; read, wait, send, steer and Stop for launched threads; `runs.wait`; the notice across computers; agent reach; settings wording; reachability rules. Remote subagents take the key where the far computer knows it. Migrations: `remote_launches` and the watch table in the run database, a reach column in `net_node_policy`, an actor column in `bridge_audit`.
4. **Beyond launched threads:** `thread_list` and `thread_search` with `computer`; reading and messaging any thread on an allowed computer (to send, reach "all threads").

Later, each on its own: setting up the project on the far computer (#484); grouping several agent bubbles in a row; a per-thread switch to hold agent messages for the person.

Tests the design names, on one computer and through the remote agent actor: `origin` survives start, queue, drain (also after a daemon restart), promote to steer, a steer the turn never reads, a replay with the same `clientRequestId`, a queue edit and merged notices. T3 Code lost the sender on exactly one such path (#34721). The routed table and id tests (`table.test.ts`, `routedVersions.json`, `ids.test.ts`) and `remoteSubagents.test.ts` pin behaviour phase 3 changes.

## 8. Related work

- **#1197** (merged 2026-11-15): removed the agent access level and the ceilings stored on threads. It replaces decision 10 and the first half of §4.7.
- **#1170** (merged): thread links in replies. Phase 1 builds the status chip on it.
- **#1186** (merged): the plan tools are gone; a Plan-mode turn replies with its plan as a message.
- **#1219** (merged): a bot's thread starts and messages are no longer capped per turn; §6's caps must not put that back.
- **#488** (open): the chip with live status, switching with Back, links to a thread on another computer. Phase 1 does its remaining boxes.
- **PR #871** (open): message authors. It edits the same lines of `user-message.tsx`, `mousseToUI.ts` and `QueuedMessages.tsx`. Phase 1 lands after it. Its author badge sits under the bubble; the Agent header sits inside it, and a queued message can carry both.
- **PR #868** (open): the `crossUser` mark and the routed table's security digest. Phase 3 changes the same table and lands after it; marked calls stay out of `CROSS_USER_METHODS`.
- **PR #869** (open): the simpler Devices page. The agent reach setting goes on it; phase 3 lands after it.
- **#484** (open): project missing on the far computer. Not solved here.
- **#685** (open): remote subagents outlive their parent's expiry. Phase 3's kept stop can cover them.
- **#1049** (open): replying to an agent's reply. Shares the message actions; no conflict in design.



## 9. Not chosen

- **Dedicated agent calls in the routed table.** Both forms refuse an older far computer. New calls would need their own handler path and lose the owner's send machinery.
- **One call for the whole launch.** It needs a second copy of the owner's creation receipt path for a caller that is not a local thread. Storing the limits at the first call removes the hazard, and T3 Code's single call had partial launches too (#31263, #22017).
- **A token the owner mints for each launched thread.** It guards against a bug in the caller, not against a computer that is not trusted, and the owner's own `startedFrom.node` already answers "did this device start it".
- **Holding an agent's message for the person's approval.** A steer into a run looser than its sender is refused, a new turn is narrowed to its sender's mode and the device limit, a queued message keeps its sender's mode, and a pending question is never answered by an agent. With decision 11 a sender at Full access can steer a Full access run on a computer that allows this one Full access, as it can on one computer.
- **A consent card in the chat before first use of a computer.** The Settings switch and the ticked computers are an approval in advance, per computer, read at every call, which is the standard Cursor moved to in October 2026.
- **A follower for every launched thread.** Only work someone asked to be told about is followed.
- **Hiding agent messages from the receiving chat**, as Codex does, or folding them to one line, as T3 Code does after full bubbles pushed the person's own messages off screen (#23135). The request is a labelled bubble; the fold keeps long ones short.

## 10. What the research found

Read from source at `openai/codex@65a5410f` and `pingdotgg/t3code@ee4ef064` (both 2026-11-14) and from official docs. The ChatGPT desktop app's chat-to-chat messaging is closed source; its label ("sent by Codex from another chat") is known only from secondary sources.

| | Start | Another machine | See | Message |
|---|---|---|---|---|
| **T3 Code** | `delegate_task` (child) and `create_threads` (peers); modes only narrow; no depth or rate limit | Linked environments: a one-time pairing code, the far machine owns the thread, the caller follows it with 50 s waits; work a link starts can change only that link's threads | Paged list, read, wait; 20,000 characters per item | One tool with auto, queue, steer and restart modes; the receiving model gets the text with no marker (open bug #24711); folded one-line row |
| **Codex** | Children only (`spawn_agent`); peers only from the app | Remote command execution, a remote app-server, and handoff of a whole chat | Status list; a wait that returns no content; results are not pushed to an idle parent by default | A queue-only verb and a start-or-steer verb; its own input item type; hidden in the receiver's history |
| **Claude Code** | Subagents and teams; a Projects coordinator with a per-thread "Allow once" | Remote Control and cloud sessions | `ListAgents`; a one-shot notice when a session goes idle | `SendMessage`; a peer message cannot answer an approval; the receiver can accept, hold or refuse; rate limits and duplicate refusal |
| **Cursor** | API and a Projects coordinator | Self-hosted machines; first use of a machine needs a person's approval | Run stream and statuses | Follow-up run or steer; another person's agent is answered in a side chat |

Where Mousse is already ahead: the envelope the receiving model reads (T3 Code has had this bug open since its first version), the hop cap and queue cap (T3 Code has neither), and refusing an agent message while a person's question waits.
