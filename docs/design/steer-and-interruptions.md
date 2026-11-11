# Steer waits for commands, Pi cuts in, and cut-off turns are marked

Status: design, revision 4 (final), after council rounds 1–3 (responses in §8, §9 and §10). PR 1 (acceptance per token) and PR C (the mark) are built; PR 2 (the hold on Claude Code, Send now) builds §2.2–§2.4 and §2.9–§2.11, with §2.4 updated to spike S1. Code references are checked against `master` at `6d846d9ec`. The orchestrator is `src/mms/orchestrator/OrchestratorService.ts`; "`OS.ts:N`" below means that file.

## Summary

Three related changes to how a running turn takes a person's message:

1. **A steer waits for a running command (best effort by default, strict as an option).**
   - While the model writes or thinks, Steer still cuts in at once (#873).
   - While a foreground tool of the turn's own agent is announced or running (Bash, an edit, an MCP call), the steer is held until the tool's result is recorded, then goes in.
   - Background shells, subagents and everything a subagent runs are never waited on.
   - The Steer block says what it waits for ("Waits for Bash") and offers **Send now**, which stops the tool and delivers at once. There is no automatic timeout.
   - **The guarantee is best effort, and it is labelled that way.** Mousse never sends a cut while it knows of a foreground tool, and it checks again at the moment it sends. A tool the provider starts, or has started without telling Mousse yet, inside the remaining delivery window can still be cut. §2.3 names that window per provider.
   - A **strict** release can be switched on per provider instance (§2.3.2). Then a held steer on Codex, ACP agents or Cursor waits for the provider's turn to end, or for Send now, and is never released early.
2. **Pi cuts in like the others.** Today a Pi steer is read only at Pi's next step, so a long reply runs to its end first. Pi will abort the reply, keep what it wrote and the results of finished tools, and continue the same turn with the steer, taken once. During a tool, Pi waits as in item 1. This also fixes #368 (a steer at Pi's last step is lost).
3. **A mark on cut-off turns.** A turn that a Stop, a restart or a crash ended gets a short muted word in its header ("Stopped", "Interrupted"). A steer's cut and Send now do not count.

**Delivery guarantee, worded exactly.** Every steer is either read by the model or comes back to the thread as a message of its own; none is lost. A steer reaches the model at most once, with one exception that exists today (#881): when the daemon dies after a provider that keeps its own session (Claude Code, Codex) received a steer, and before Mousse recorded its acceptance (§2.6), the steer runs again after the restart, so that model can read it twice.

## 0. Terms

- **Own call:** a tool call of the turn's own agent: no `parentCallId`, or a parent chain that never reaches a subagent call or a background call.
- **Foreground tool:** an own call that is announced or running, whose result the turn waits for.
  - Not foreground: a call waiting for an approval or a question; a background call (`activity.background`); a subagent call (Claude's `Task`/`Agent`, Codex's `collabAgentToolCall`, Mousse's `delegate_task`); a wait-only tool (`WAIT_TOOL_NAMES`, `src/mms/run/transcript/TranscriptAssembler.ts:71`); and any call whose parent chain reaches one of these.
  - Exception: a subagent call the adapter reported as not movable to the background (§2.4) counts as foreground.
- **Announced:** the provider has said a tool call is coming, before it runs. Claude Code sends `content_block_start` for a `tool_use` while the model still writes the call's input (`turnFrames.ts:157`). Pi sends the call inside the assistant message that ends before `tool_execution_start`. Codex, ACP agents and Cursor say nothing until the tool starts.
- **Writing:** the model streams text or thinking, or a request is in flight and no foreground tool is announced or running (the #874 steps `waiting`, `reasoning` and `retrying`, and the phases `thinking` and `streaming`).
- **Model output (after a tool):** a text or reasoning delta of a model response that began after the last tool event. Not model output: a tool's own output (Codex `outputDelta`, ACP `tool_call_update` content, a Bash row's streamed output), trailing deltas of a response that began before the last tool event, and a repeated tool start.
- **Held steer:** a steer the orchestrator accepted (its Steer block shows) and has not handed to the provider, because a foreground tool is announced or running, or the release window is still open (§2.3).
- **Cut:** the provider's current reply is ended so the turn can go on with the steer (#873).
- **Hold generation:** a number per run that only ever rises. It is never reset, including when Codex goes on in a new `turn/start` inside the same run. It is raised whenever the set of held items changes (a hold begins, or a steer joins it). It is not raised when the waited-for tool changes (A ends, B is announced) or when a hand-back resumes the same hold. A Send now click names the generation it was shown for.

## 1. Today

### 1.1 How a steer reaches a turn

- **Promotion.** A steer is a queue item promoted to `steering` (`promoteQueueItem`, `OS.ts:7900-7979`; `deliverPromotedItem`, `:8148`), or a composer steer made into such an item. It shows at once as a Steer block in the running reply (`steer-group.tsx`, grouped by `metadata.steered` in `groupMessagesIntoTurns`, `message-list.tsx:737-774`).
- **Drains.** The turn reads it through `TurnControl.drainSteerEntry` (`src/mms/harness/adapter.ts:226-245`), built in `executeTurn` (`OS.ts:11470-11513`). Each drain has a token. The provider calls `steerTaken(token)` when it has the text, or `returnSteer(text, token)` when it cannot use it, which puts the entries back in front of newer steers.
- **Cut flag.** `drainEntry` sets `cut` when any entry is a person's message (`OS.ts:11487-11490`).
- **Peer and remote steers.** A steer another process promoted exists only as a `steering` row on disk. `drainSteerForSession` finds it by refreshing the queue from disk and scanning it (`OS.ts:11981-11990`). A remote turn's steers come from `opts.externalDrainSteer()`, a callback that takes them (`OS.ts:11477`).
- **Acceptance is not per token today.**
  - `steerTaken(token)` only deletes the token from an in-memory map (`OS.ts:11495`).
  - `sink.steerAccepted(text)` appends the text to the model context, saves every id in `session.drainedExternalSteerIds` as accepted, persists, and then drops all of those queue rows (`OS.ts:11454-11463`, `acknowledgeDrainedSteers` `:12035-12054`). The `nativeMessages` path does the same (`OS.ts:11400-11412`).
  - With two drains outstanding, accepting A also acknowledges B, and a crash before B is read loses B. This happens on Claude Code, which can drain A, wait up to 5 s to move subagents, and drain B in the next poll.
- **Carried inbox rows.** They are marked taken by the run at drain time (`OS.ts:11974`) and unmarked by `returnSteer`. That marking is ownership: reconciler rule 4 does not hand them to a wake meanwhile.
- **Unread steers.** A Stop hands them back to the front of the queue (`returnUnreadSteerItems`, `OS.ts:8058`). A turn that ends makes them a `steer-followup` turn (`OS.ts:9571-9597`, SPEC §14.7). A restart puts a steer the provider never accepted first in the queue (`returnOrphanedSteers`, `OS.ts:12520`, #881).
- **An existing hold.** `drainSteerForSession` already holds some steers back: an agent's steer waits while a question is open (`OS.ts:11962-11968`). The new hold is the same kind of rule.

### 1.2 Per provider

| Provider | `steer` capability | A person's steer now | A running command |
|---|---|---|---|
| Claude Code (live session) | `interrupt_restart` (`drivers/claudeCode/adapter.ts:45`) | Polled every 100 ms (`ClaudeSubscriptionProviderService.ts:2613-2623`). `LiveSession.steer` (`liveSession.ts:763-809`) calls `backgroundTasks()` with no argument, waits up to 5 s, then pushes the text with `priority: 'now'`. | Ends. #874's check saw a 40 s command end at the steer. The SDK (0.3.291) says the no-argument `backgroundTasks()` moves Bash to the background too, so whether it was killed or moved is spike S1's question. |
| Claude Code (no live session) | same | Pushes the text and calls `query.interrupt()`, then resumes the session with it (`:2463-2469`, `:2780-2794`). | Ends. |
| Codex | `native` (`drivers/codex/adapter.ts:77-95`) | Cut: `turn/interrupt`, then the next `turn/start` carries it (`CodexProviderService.ts:2933-2967`). It counts as taken only once that `turn/start` is accepted (`cutHeld`, `cutStarting`, `handBack`, `:2939-2943`, `:3036-3039`). A steer left when a turn completes starts the next turn of the same run (`undelivered`, `:3058-3082`). Other steers use `turn/steer` (`:2918-2932`). | Ends by the interrupt. |
| Pi (RPC engine, every `pi:*` instance) | `native` (`drivers/pi/engines/rpc.ts:34-50`) | Drained only at Pi's `turn_end` and sent as RPC `steer`, not awaited (`pi/engine.ts:1923-1936`). Taken when a user `message_start` whose text *includes* the steer arrives (`:1943-1951`). `cut` is ignored. | Not ended: tools are over by `turn_end`. |
| ACP agents (generic, Antigravity, Grok) | `interrupt_restart` (`acp/capabilities.ts:11-21`) | Tokenless `drainSteer()` (`drivers/acp/adapter.ts:117`). The steer is accepted (`onSteer` → `sink.steerAccepted`) *before* `session/cancel`. A new prompt "Additional guidance: …" follows (`acp/session.ts:788-852`). | Ends, if the agent's cancel stops it. |
| Cursor | `interrupt_restart` (`drivers/cursor/adapter.ts:12-24`) | Tokenless `drainSteer()` (`drivers/cursor/adapter.ts:75`), accepted before `active.cancel()`, then a new run with the guidance (`cursor/session.ts:524-556`). | Ends. |

## 2. Item 1: a steer waits for a running command

### 2.1 Behaviour

| The turn is | A person's steer | An agent's steer or a subagent notice |
|---|---|---|
| Writing or thinking | Cut now (#873). | As today: native on a `native` provider; on Claude, pushed `now`. |
| At a step boundary the provider reports (Pi's `turn_end`; the provider's turn end on Codex, ACP agents and Cursor) | Sent natively; nothing to cut. | Native, as today. |
| A foreground tool is announced or running, or the release window is open | **Held** until every foreground tool has its result and the release rule (§2.3) holds. | Held on an `interrupt_restart` provider. On a `native` provider: native, as today (it waits for the tool by itself). |
| Only background work runs (background calls, subagents and their own calls, wait-only tools) | Cut now. A foreground subagent is first moved to the background where the provider can do that (§2.4). | As today. |
| A call waits for an approval or a question, and no other foreground tool runs | Cut now. The steer answers it as the person, as today (`autoRejectPendingForThread`, #873). | Waits, and never answers it (existing rule, `OS.ts:11962-11968`). |
| Pi compacts its context | Held ("Waits for compaction"). A steer never stops a compaction. | Held. |
| Set up, stopping, ending or paused | Unchanged (`steerWhenStarted`, `sendNowAfterTurn`, `sendNowIdle`, `steer-late`). | Unchanged. |

- **Send now** on a held steer stops the running tool and delivers at once (a cut).
- **No automatic timeout.** A long build keeps running; the person decides.
- **Several steers** sent while one is held join it: one Steer block, one wait line, one input (the drain joins them, `OS.ts:11490`).
- **A long tool input** being written (a big Write) counts as announced on Claude: the block reads "Waits for Write" until the call has run and its result is in.
- **Sources.** The rules apply to steers promoted by another process, to a remote turn's steers, and to steers from the CLI, Bridge and `thread_steer` (§2.2, "What the peek reads").

### 2.2 Where the decision lives

The orchestrator decides, once, from stored and reported state. Adapters report tool calls and boundaries, and check again before they send a cut. No provider name appears in run or orchestrator code (SPEC invariant 8).

**The policy** (`src/mms/run/CommandPolicy.ts`, pure):

```ts
export type SteerDelivery = 'cut' | 'native' | 'hold'
export function steerDelivery(
  caps: ProviderCapabilities,
  turn: { foreground: number; releaseOpen: boolean; strict: boolean; atBoundary: boolean; forced: boolean },
  steer: { person: boolean }
): SteerDelivery
```

| | `forced` (Send now) | `foreground > 0` or `releaseOpen` | `atBoundary` | otherwise (writing) |
|---|---|---|---|---|
| person, `steerBoundary` not `none` | `cut` | `hold` | `native` | `cut` |
| agent or notice, `steer: 'native'` | (never forced) | `native` | `native` | `native` |
| agent or notice, `steer: 'interrupt_restart'` | (never forced) | `hold` | `native` | `cut` (as today) |
| any, `steerBoundary: 'none'` | today's behaviour (`cut` for a person, else the capability) | | | |

- **`releaseOpen`** is true while the release rule of §2.3 has not yet allowed a held steer to go. The window follows tool events the same way in both modes. Strict mode only keeps a steer that is **already held** held until the provider reports its turn's end (`atBoundary`) or Send now. A steer that arrives after the window closed (a tool finished, model output seen) cuts at once in both modes.
- **Order of the decision.** `steer.person` comes from the pending entries without taking them (the peek below), so the decision is made before any drain. A batch with both a person's and an agent's steer is decided as a person's.
- **`hold`** takes nothing: the entries stay where they are (`turn.pendingSteer`, the queue file, or the remote source).
- **`native`** means "deliver with the provider's own steer, or as the next provider turn of the same run at a boundary". Pi does it only at `turn_end`. For an agent's steer on Codex it is today's `turn/steer`.

**A new capability, `steerBoundary`** (`ProviderCapabilities`, read by `steerDelivery`), says when the adapter reports a tool call:
- `announce` (Claude Code, Pi): before it runs;
- `start` (Codex, ACP agents, Cursor): when it starts;
- `none`: the adapter has not adopted the contract, and the provider keeps today's behaviour. Setting an adapter back to `none` is also the per-provider rollback (§6). That provider then makes no promise about commands.

**`TurnControl` additions** (`src/mms/harness/adapter.ts:226`):

```ts
/** What a drain now would do, without taking anything. undefined: nothing pending. */
peekSteer?(): { delivery: SteerDelivery; holdGeneration?: number } | undefined
/** drainSteerEntry, but takes only when the current decision is `expect`; otherwise takes nothing. */
drainSteerEntry?(opts?: { expect?: SteerDelivery | SteerDelivery[] }): { text: string; token: string; cut?: boolean } | undefined
/** The check at dispatch, called right before the adapter sends a cut for `token`. false: hand the drain back and wait. */
mayCut?(token: string): boolean
```

- **`peekSteer`** is the non-taking read. Every adopting adapter calls it on its poll and stays idle while a steer is held, and Pi's poll follows the table with it (§3.2).
- **`mayCut(token)`** returns true when the drain is forced, or when the orchestrator knows of no foreground tool and the release window is closed. When it returns false, the adapter calls `returnSteer(text, token)` and the hold resumes in the same generation.
- **Unchanged for non-adopters.** `drainSteerEntry()` with no options keeps its meaning for adapters at `steerBoundary: 'none'`.

**What the peek reads.** The hold only works if the peek sees every steer a drain would take. `peekSteer` does, on each call:
1. **Disk.** It refreshes the queue from disk (`refreshSessionQueueFromDisk`, which the 100 ms drain already calls today) and applies the same scan and question rule as `drainSteerForSession` (`OS.ts:11962-11990`). So a `steering` row another process promoted for this run counts, and `heldSteer.itemIds` lists it.
2. **Remote turns.** A remote turn's source gains a non-taking form, `externalPeekSteer()`, next to `externalDrainSteer()`. The peek reads it, and only a drain takes. A caller that passes `externalDrainSteer` without `externalPeekSteer` makes the **whole turn** decide as `steerBoundary: 'none'` (today's behaviour): the peek cannot see those steers without taking them, so no part of the turn can hold safely.
3. **Send now requests.** It reads `steerNow` on the held items and the pending `steer_now` journal entries of this thread, including while Pi compacts (§2.9).

On Claude Code the drain already does the disk refresh every 100 ms, so the peek adds no new cost there. On the others it costs one file stat and read per poll while a turn runs.

**Counting foreground tools.** The transcript assembler already tracks the turn's running calls (`activeToolCallMessageIds`, used by `isBlockedOnWait`, `TranscriptAssembler.ts:611-626`) and stores each call's parent (`activity.parentId`, from `parentCallId`, `:397-404`).
- A new `foregroundTools(): Array<{ callId; toolName; detail? }>` returns the open **own** calls (§0) that are not excluded.
- It walks each call's parent chain, so a Bash that a subagent runs never counts, whether the subagent is in the foreground or was moved to the background.
- A call whose parent chain cannot be resolved (an ACP agent that names no parent) counts as the turn's own: it may hold, never cut.
- A subagent call carrying `activity.notMovable` counts (§2.4).

**What adapters report.** Every adapter already sends `start` and `complete` tool events with a `callId` (Claude `tool_use`/`tool_result`, `turnFrames.ts:157-207`; Codex `item/started`/`item/completed`; Pi `tool_execution_start`/`end`; ACP `tool_call`/`tool_call_update`; Cursor `tool-call-started`/`completed`). For the hold, these facts are added:
- **Claude:** the call's `start` is sent at `content_block_start`, before the call runs (it already is). A subagent call whose background move failed is patched with `notMovable: true` (§2.4).
- **Pi:** an assistant message that ends with tool calls opens those calls as announced (a `start` with `announced: true`) before `tool_execution_start`.
- **Boundaries:** `TurnSink.boundary()` (new) is reported at Pi's `turn_end`, and at the end of a provider turn on Codex (`turn/completed`), ACP agents (the prompt's response) and Cursor (the run's end). It sets `atBoundary` until the next model output or provider turn.

**The hold's state.** While steers are held, the orchestrator sets `TurnState.heldSteer` (§2.9). When they are drained, handed back or the turn ends, it clears it. It lives in memory, like `step`.

### 2.3 Release rule and the guarantee

The decision and the cut are separate steps: the adapter sends the cut after the drain, sometimes after an await. Claude waits up to 5 s per subagent background move (`liveSession.ts:769-779`); Codex queues the cut behind its `steering` chain (`CodexProviderService.ts:2955-2965`). A tool can start in between, so the contract has three parts:

1. **The hold starts at the announcement**, where the provider gives one (`steerBoundary: 'announce'`): a Claude `tool_use` block streaming, or a Pi assistant message ending with tool calls.
2. **For `start` providers, release needs evidence.** A count of zero after a tool's result does not show that no other tool is about to start: two commands from one model response start one after the other. After the last foreground tool's result, the release window stays open until one of these happens:
   - model output (§0) is seen, or
   - `STEER_SETTLE_MS` passes with no tool event.

   Any tool event (a start, update or result of any own call) restarts the window. The value comes from spike S4 (§6) under a rule written now.
3. **The check at dispatch.** Every adapter calls `mayCut(token)` as the last step before the provider's cut request. If it returns false, the adapter hands the drain back. A tool that started during an await is seen here, through the same tool events.
   - Claude: inside `LiveSession.steer`, after the background moves and `afterCancel()`, just before `push` (`liveSession.ts:782-793`).
   - Codex: inside `cut()`'s `steering` step, before `turn/interrupt` (`CodexProviderService.ts:2957-2964`).
   - Pi: before `abort` (§3.2).
   - ACP agents and Cursor: before `session/cancel` / `active.cancel()` (§2.7).

#### 2.3.1 The best-effort guarantee (default)

**Mousse never sends a cut while it knows of a foreground tool that is announced or running, or while the release window is open.** That is the whole promise. It is best effort, because what remains is a tool the provider runs that Mousse does not know of when the cut reaches the provider:

| Provider | What remains | How it closes |
|---|---|---|
| Claude Code | A `tool_use` whose `content_block_start` is still in the pipe when `now` is pushed. Claude Code runs a call only after its input is complete, so this needs a call with a tiny input announced within the pipe latency. S1 measures it. | `'next'` pushed during the hold, if S1 proves it (§2.4). It is a later change, not part of PR 2. |
| Codex | (a) A command that starts after the release window closed and before `turn/interrupt` lands. (b) A command already running whose `item/started` has not reached Mousse. (c) Model text between two commands of one response, which closes the window early, followed by the second command. | Strict mode (§2.3.2). Native `turn/steer`, gated on S2 (§2.5). |
| ACP agents, Cursor | As Codex (a), (b) and (c). | Strict mode. |
| Pi | A tool whose call arrives in a `message_end` that crosses the `abort` request. Pi checks its abort signal before it runs a tool, so the tool is refused at its start rather than ended while running. S3 confirms. | Native `steer` at the boundary, which this design already uses. |

The same window exists today for any cut made while the model writes: on a `start` provider, a cut during writing can meet a command that starts a moment later. S4 measures timing; it does not prove a maximum, and this document does not present it as proof.

Send now and Stop end tools by design; the guarantee is about steers only.

#### 2.3.2 Strict release (an option per provider instance)

- **What it does.** With strict release on, a held steer on a `start` provider is released only at a boundary that excludes running tools: the provider's own turn end (`boundary()` above), or Send now. It is never released on output or a timer.
  - The steer then goes in as the next provider turn of the same Mousse turn, with no cut. On Codex this is the existing `undelivered` path (`CodexProviderService.ts:3058-3082`); on ACP agents it is the guidance re-prompt after the prompt's response; on Cursor, the next run with the guidance.
- **What it costs.** A steer held during a command waits for the agent's whole turn to end, which can be many commands and a long answer. Send now is the escape.
- **What it does not change.** Strict only keeps a steer that is already held held. A steer sent while the model writes, with no tool known and the window closed, still cuts at once, with the writing-case window stated above.
- **Where it is set.** It is a per-instance setting, `runs.steerRelease[<instanceId>]: 'best_effort' | 'strict'`, read when the turn starts and passed to `steerDelivery` as `strict`. It is `best_effort` by default and has no UI in this design. On `announce` providers it changes nothing.
- **Why both ship.** The two modes differ only in how `releaseOpen` ends, so either can become the default without a redesign. Best effort is the chosen default (§7).

### 2.4 Claude Code

**The hold.**
- `steerBoundary: 'announce'`. Nothing drains while a foreground `tool_use` is open.
- `collectSteer` (`ClaudeSubscriptionProviderService.ts:2440`) asks `peekSteer()` and drains with `expect: 'cut'` only.

**Release.**
- When the `tool_result` frame arrives (`turnFrames.ts:207`), the call completes, and the next poll drains with `cut: true`.
- `LiveSession.steer` makes the background moves, waits for `afterCancel()`, calls `mayCut(token)`, and only then pushes `priority: 'now'`. Claude Code has the tool's result in its conversation by then, so the cut only ends the request that follows.

**Background moves.**
- `LiveSession.steer` no longer calls `backgroundTasks()` with no argument. S1 showed that this call is what ended commands for the person (#874): it moves a running Bash to the background, where it finishes unseen and a wake turn follows.
- It calls `backgroundTasks(toolUseId)` once for each foreground subagent call still open. The 5 s wait (`STEER_BACKGROUND_MOVE_MS`) stays; a move that does not answer within it counts as not moved.
- **A subagent that cannot be moved.** When the call throws (background tasks are disabled for the session) or returns false:
  - the adapter reports a tool-event patch, `{ phase: 'update', callId, activity: { notMovable: true } }`, so `foregroundTools` counts that subagent;
  - it hands the steer back.

  The next peek then says `hold` rather than `cut`, so the adapter does not retry the move every poll. The subagent is waited on, never ended.

**Send now.**
- It drains forced and pushes the steer, with no background move. On Claude Code 2.1.322 a `'now'` message waits for a running Bash: it neither kills nor moves it (S1). So pushing alone does not stop the command.
- Right after the push, Send now stops the foreground calls:
  - when Claude Code has named a task for every one of them (`task_started`, about 3 s after a command starts), `stopTask(taskId)` for each (SDK 0.3.291 `Query.stopTask`). The command ends, and the steer is read once in the same turn;
  - otherwise one `interrupt()`. It ends the command, and the pushed steer stays queued and runs once, as the turn's next request. An interrupt also stops background agents, so the task stop is preferred when it is possible.
- The push comes first, so the steer is already queued when the command ends: it cannot be lost to the interrupt, and it is never sent twice.

**No live session:** the same hold through `drainEntry`, and `mayCut` before `query.interrupt()`.

**`priority: 'next'` (a later change, gated on S1).** `'next'` is never pushed at release. At the release moment Claude Code has already sent the next request, so a `'next'` pushed then would be read only after that response's tools, or at the turn's end. The only place it helps is **during** the hold: pushed while the tool runs, so that Claude Code reads it at that tool's result, with no cut and no window.

It may replace the hold for Claude only if S1 proves all three of these:
1. a read signal: Claude echoes the pushed id when the model reads it;
2. what Stop, an interrupt and a daemon crash do with a pushed, unread `'next'` message, so a "pushed, unread" state can be given back exactly once;
3. that Send now can stop the tool (`stopTask` or an interrupt) without the text being sent twice.

Until then, PR 2 holds and then pushes `now` after `mayCut`. On 2.1.322 the push after the result only ends the request that follows (S1: `'now'` waits for a running Bash), so a steer released after a command never ends one.

**Spike S1** (hands-on: the real Claude Code CLI against a local fake Messages server, fake key, isolated home, no sign-in). In this order:
1. `priority: 'next'`, for each of these questions:
   - pushed while a foreground Bash runs: is it read right after that call's result, in the same turn, with nothing cancelled?
   - pushed at the instant the `tool_result` arrives: which request reads it?
   - pushed while the model writes text with no tool: is it read before the turn ends, or after (as a new turn)?
   - is the pushed id echoed when it is read?
   - what do Stop, an interrupt and a crash do with it while it is unread?
2. `priority: 'now'` during a foreground Bash, with and without the no-argument `backgroundTasks()` before it: is the Bash killed, or moved to the background?
3. `now` with two foreground tools running in parallel.
4. Consecutive tools: two Bash calls from one response, with a steer released between them.
5. A delayed announcement: a `tool_use` with a one-word input, steered at the moment the previous result lands. Measure the gap between `content_block_start` reaching Mousse and the call starting.
6. A tool that starts while `backgroundTasks(id)` is awaited.
7. `detachedToolCall`: what `now` does to a running WebFetch or WebSearch. The SDK says they step aside; `claudeActivity.ts:369-374` shows that row as interrupted.
8. `backgroundTasks(id)` when background tasks are disabled.

### 2.5 Codex: the hold from the start

- **Mechanism.** `steerBoundary: 'start'`. A person's steer is held while a command, MCP call or web search runs, and while the release window is open. Then the existing #873 cut runs: `mayCut`, `turn/interrupt`, and the next `turn/start` carries the text. It counts as taken only when that start is accepted (`cutHeld`, `cutStarting`, `handBack`). The command's output is already in Codex's history by then.
- **Strict release** waits for `turn/completed`, then starts the next turn of the run with the text (`undelivered`). There is no interrupt.
- **Send now.** A forced drain goes through the same cut while the command runs, so `turn/interrupt` ends it. There is no new state.
- **Agents' steers and notices** keep today's `turn/steer` path, unchanged.
- **Cost.** One `turn/interrupt` and `turn/start` round trip after the command, and the start of the model's next request is wasted.
- **Later change, gated on S2:** native `turn/steer` for a person's steer during a command. It can replace the hold only once S2 shows all of these:
  1. an event that proves Codex read the steered text;
  2. what Stop, a failed turn, `turn/interrupt` and a thread resumed after a daemon kill do with a steer Codex accepted and has not read;
  3. a way for Send now to reach a steer already sent (an adapter control bound to the hold generation and item ids, §2.9);
  4. acceptance per token (§2.6).

### 2.6 Acceptance per token (a prerequisite)

Before any hold, a steer is accepted per drain, in one step that also saves its text.

- **Each drain** (`drained`, `OS.ts:11472`) keeps the item ids and the carried inbox rows it took.
- **`steerTaken(token)`** stays an in-memory note that the provider has the text. It keeps the token's entry until acceptance, and it saves and drops nothing. A taken drain can still be handed back (`returnSteer(text, token)`) while it is not accepted: it is then restored whole, its rows back in the queue and its copy hidden, so it runs once (#906). An accepted drain is never handed back.
- **`sink.steerAccepted(text, token)` is the single acceptance step.** In one `persist` it appends the text to the model context and adds that token's item ids to `nativeContext.acceptedSteerItemIds`. After that write, it drops that token's queue rows (`dropSteerItems` with those ids only) and deletes the token's entry. This keeps today's rule that queue rows go only after the text and ids are saved (`OS.ts:12034`).
- **Crash windows:**
  - a crash between `steerTaken` and `steerAccepted` leaves the row `steering` and not accepted, so `returnOrphanedSteers` runs it once after the restart. That is the documented at-least-once case for providers that resume their session;
  - a crash after the persist and before the rows are dropped leaves the id accepted, so `returnOrphanedSteers` drops it (#881).
- **Carried inbox rows** stay marked taken at drain time, as today (`OS.ts:11974`). The mark means "this run's drain owns them", so rule 4 and wakes leave them alone while a drain is outstanding. `returnSteer(text, token)` unmarks only that token's rows. They are acknowledged when the run completes, as today (SPEC §14.3). This reverses revision 2, which moved the mark to acceptance and would have left the rows unowned during an outstanding drain.
- **`returnSteer(text, token)`** restores only that token's entries.
- **Claude Code accepts what it read, not what it was pushed.** A pushed steer is accepted when the model answers it: model output that names its id (a streamed event, or a message that is not one Claude Code made up itself, `<synthetic>`), a `command_lifecycle` `completed` frame, or a successful result that names it (S1). A `started` frame means only that Claude Code took the steer for its next request, about 200 ms before that request goes out. Then the run's next model output of the main turn (a streamed event other than a `ping`, or a message that is not `<synthetic>`, with no `parent_tool_use_id`) is the steer's answer, though it does not name it: Claude Code names a message only when the turn's `user_message_uuid` changes, so a steer folded into a turn the person started is never named by a reply frame. Claude Code says `started` after the tool round that took the steer has ended, or as a new turn starts, so no frame of the request before can follow it. A taken steer with no answer counts as a read only when the turn then ends with its result. When a Stop, an interrupt, a close or the process's death ends the turn first, the request may never have gone out, and the steer is handed back (#928). A message start is only the steer's place in the reply, never a read: an interrupt or a Stop starts one too. A steer Claude Code has not read when the turn ends is handed back by its token, and Claude Code must not also run it:
  - a cancelled turn (Stop, an interrupt) whose run owns an unread steer is interrupted with `cancel_queued` in the same request, with no plain interrupt first (S1: after a plain interrupt the queued steer starts at once as a new turn). A Stop also closes the process. A Claude Code that sends no receipt ignored the cancel, so its process is closed unless background work keeps it;
  - at a result, `cancelAsyncMessage` drops it from Claude Code's queue (handed back), or answers false. False alone is not a read: Claude Code also answers it for a steer its queue gave up a moment before the cancel came, and the turn that took it then drops it unrun, with a `cancelled` lifecycle. So the run stays open at its result and waits for a sign that Claude Code took the steer (`started` or `completed`, or a frame or result that names it). Taken, the run goes on to its turn's result, so the answer is shown once (#919). The steer is accepted when the model answers it, as above, or at that result; `started` alone does not accept it, so a Stop before the answer hands it back. A `cancelled` lifecycle hands it back at once. With no sign within `LATE_STEER_READ_MS` (2 s), the run ends with the result it had and the steer is handed back, with a warning: at least once, never lost. The same holds when the run ends any other way before the model answers it (a Stop during the ask or the wait, the process closed or dead), so false alone never accepts the steer. A stand-in owns its id until that turn's result, or `LATE_STEER_STAND_IN_MS` with no sign of it, so a late turn for it is dropped. A `started` lifecycle or model output for it then is marked `mayRunTwice`, with a warning; the error result of the turn a Stop interrupted, which names the steer too, is not.

  Where Claude Code cannot say (no per-message cancel), the steer is still handed back: at least once, never lost. One window stays: a steer whose request reached the model just before the Stop, with no model output at Mousse yet, is handed back although the model saw it. That is at least once, never lost.
- **The tokenless path** (`steerAccepted(text)` with no token, and `nativeMessages`) keeps today's blanket rule. It is correct only with one drain outstanding. It remains only for adapters at `steerBoundary: 'none'`: the ACP and Cursor adapters until PR 3 (§2.7), and runtimes that report through `nativeMessages`. No adapter on the contract may use it.

This change does not change behaviour, and it lands first (§6). Tests:
- A and B drained separately, A accepted, then each of these leaves B unread and brings it back once: Stop, a failed continuation, a provider crash, and a daemon restart;
- a kill between `steerTaken` and `steerAccepted`: the steer comes back once.

### 2.7 ACP agents and Cursor

- **The hold.** `steerBoundary: 'start'`; held while a tool runs and while the release window is open; then `mayCut` and the existing cancel and re-prompt. Send now cancels at once, as today.
- **Migration in PR 3.** Both adapters move from `ctl.drainSteer()` (`drivers/acp/adapter.ts:117`, `drivers/cursor/adapter.ts:75`) to:
  - `peekSteer()` and `drainSteerEntry({ expect: 'cut' })`;
  - `returnSteer(text, token)` when `mayCut` is false, or when the cancel or the re-prompt fails;
  - acceptance (`onSteer` → `sink.steerAccepted(text, token)`) only once the re-prompt carrying the text is accepted: the ACP prompt request is accepted, or the next Cursor run starts. Today it is accepted before the cancel (`acp/session.ts:791-793`);
  - **the boundary drain:** at the end of a provider turn (the ACP prompt's response, or the Cursor run's end), the adapter reports `boundary()` and drains with `drainSteerEntry({ expect: 'native' })`. A drained steer goes in as the guidance re-prompt (ACP) or the next run (Cursor), with no cancel, and is accepted by its token as above. This is the path strict release uses. Each adapter gets a strict-boundary test: a steer held during a tool, the provider turn ends, the steer goes in as the next prompt, and nothing is cancelled.

  Until PR 3 they stay at `steerBoundary: 'none'`, on the tokenless path.
- **Hand-back limits.** After the cancel is sent, the text is not handed back if the agent ends the turn or the session dies. In that case it goes in the next re-prompt or the follow-up turn, as for any drained, unaccepted steer when the turn ends. A cancel the agent ignores ends the turn (`steerFailure`, `acp/session.ts`); the steer then runs as the follow-up.
- **Sparse events.** An ACP agent that never sends `completed` for a call keeps the steer held until the turn ends, when it runs as a follow-up turn, or until Send now. The hold never outlives the turn.
- **Subagents.** Only Grok marks subagent calls ("subagent: …", `acp/session.ts:684`). Other ACP calls count as foreground.

### 2.8 Exactly once across every end

A held steer has not been drained, so it is an unread steer, and every existing path already handles it. With §2.6, a drained steer is accepted only with its own token, together with its text.

| Event | Held (not drained) | Drained, not taken | Taken, not accepted | Accepted |
|---|---|---|---|---|
| **Stop** | `returnUnreadSteerItems` puts it first in the queue, shown there, and hides its Steer block copy (`withdrawSteerEchoes`). Nothing runs it until the person sends again (#873). | The provider hands it back (`returnSteer` / `handBack`), then as held. | The provider has it: the turn's end accepts it, or, if the turn never reads it, it comes back as for an unread steer. | Kept. |
| **Turn ends** (the tool's result ended it, or the provider failed) | Becomes a `steer-followup` turn, shown once as its prompt (SPEC §14.7). | Handed back, then as held. | As above. | Kept. |
| **Usage-limit pause** | Unread: queued as a follow-up behind the pause (SPEC §16.4). | Handed back, then as held. | As above. | Kept. |
| **Restart (#881)** | `steering` on disk and not accepted: `returnOrphanedSteers` puts it first, and the startup drain runs it once, after the cut-off turn. | Same. | Same. This is the documented at-least-once case for providers that resume their session. | Its id is in `acceptedSteerItemIds`, so it is dropped. |
| **Provider crash** | The turn fails: as "turn ends". | The `died` paths hand it back (Pi `engine.ts:1862`, Codex `handBack`, Claude `returnSteer`). | As "turn ends". | Kept. |
| **Double steer** (same item twice) | #845 / #873 id guarantees: a second promotion of an item already pending returns `ok` and does nothing (`OS.ts:7915-7919`). | Same (`drainedExternalSteerIds`). | Same. | Same. |
| **Batching** (several steers while held) | All stay pending. One drain takes them all, under one token. | One token restores them all, in order. | Taken together. | Accepted together. |
| **Separate drains** (A, then B) | — | Each token is handed back or accepted alone (§2.6). | — | Only that token's ids and text are saved. |
| **A tool starts between drain and cut** | — | `mayCut` is false: handed back, held again in the same generation. | — | — |
| **An approval appears while held** | That call waits for a person. If no other foreground tool runs, the steer cuts and answers it as today. A pending approval for A never releases a running B. | — | — | — |
| **An approval is granted while the steer is on its way** | — | The call becomes running, so `mayCut` is false and the steer is held again. | — | — |
| **Send now: stale, double, cross-process, recovered** | §2.9. | — | — | — |
| **A cut ends a foreground `delegate_task` call** | — | — | — | The call returns at once with the delegation's ids (SPEC §14.2), so a cut rarely meets it. If it does, the delegation is already a stored row: the child keeps running, and its result reaches the parent through the inbox (`child_result`, rule 4: a wake run, or a steer notice once the run ends). A repeated call by the model returns `title_taken` with the existing subagent, so no second child starts. |

### 2.9 Send now: protocol, durability and state

**Turn state.** `TurnState.heldSteer` (`src/shared/types.ts:1513`) is in memory, like `step`:

```ts
heldSteer?: { waitsFor: string; detail?: string; tools: number; since: string; holdGeneration: number; itemIds: string[] }
```

- `waitsFor` is the oldest foreground tool's display name (the #874 rule, `turn-progress.tsx:72-77`), or "compaction". While the release window is open after the last result, it keeps the last tool's name, so the line neither flickers nor goes blank.
- `detail` is that tool's first input line (`inputDetail`, `:79-90`).
- `itemIds` lists the held queue items, including disk-only rows promoted by another process (§2.2).
- It travels in `turn-state` events, the resnapshot (`resnapshotTurnState`) and Bridge snapshots; older clients ignore it.
- A window that never receives `heldSteer` (it does not get turn state for that thread) shows no Send now. So the command has no caller there.

**The command.** `steer_now` is a new run-engine control command (SPEC §4):

```ts
{ kind: 'steer_now'; threadId; clientRequestId; runId; holdGeneration: number; itemIds: string[] }
```

**Durability across two stores**, following the queue journal (`src/mms/queue/queueJournal.ts`, `src/mms/run/QueueCommands.ts`, issue #184):
1. **Intent.** `dispatch` commits, in one run-database transaction:
   - the receipt;
   - a `queue_commands` entry (new op `'steer_now'`, status `pending`, intent `{ runId, holdGeneration, itemIds, requestId }`);
   - the `steer.now_requested` event;
   - the audit event (`steered_run`, `{ now: true }`).

   A run that is not the active run returns `ignored` (`run_not_active`) and writes no entry. A repeated `clientRequestId` replays the receipt.
2. **Apply.** Under the queue lock (`mutateDurableQueue`), the journal sets the field on each named item that is still `steering` and bound to the run. An item counts as bound when `steerRunId === runId`. An item with no `steerRunId` also counts when `runId` is the thread's active run in the engine at that moment. (`steerRunId` is set at promotion only when a run is active, `OS.ts:8205`; the composer's and a remote turn's steers can lack it.) The field it sets is:
   ```ts
   steerNow: { runId, holdGeneration, requestId }
   ```
   It then marks the entry `applied`. If no named item qualifies, it marks the entry `applied` with result `stale` and appends `steer.now_stale`.
   - The apply is idempotent: an item already carrying that `requestId` is left alone.
   - An entry that reaches `failed` after its retry limit also appends `steer.now_stale`.
   - The request's own process runs it right after the commit. If it crashes, three things finish it: the next queue change of the thread (every `mutateDurableQueue` recovers first), boot repair, and the owner's held poll, which looks for pending `steer_now` entries of its thread because a held turn may not change the queue.
3. **Consume.** The owner's `peekSteer` reads `steerNow` on held items. It acts only when all of these hold:
   - `steerNow.runId` is the turn's run;
   - `holdGeneration` equals the current hold generation;
   - the named items are still held.

   It then forces the hold: the whole held group goes now, in one drain. It clears the field under the queue lock and appends `steer.now_applied { runId, holdGeneration, requestId }`. Otherwise it clears the field and appends `steer.now_stale`.
4. **Acknowledgement to windows.** `steer.now_applied` and `steer.now_stale` are thread events, which windows already receive.
   - While waiting, the button reads "Sending…".
   - On `applied`, the hold line clears as the steer goes in.
   - On `stale`, the button goes back to "Send now" for whatever hold is shown then, or the line is gone.
   - The button also leaves "Sending…" whenever `heldSteer` clears or its `holdGeneration` changes. Stop, `returnOrphanedSteers` and a turn's end strip the field without either event, so no ordering of writes can leave the button stuck.
   - A held entry with no queue item (text a provider handed back) can be forced only by the owning process. A click about it from another process is recorded `stale` at once, so it never hangs on "Sending…".

**A stale field never outlives its run.** Every path that moves an item out of `steering`, or hands it back, strips `steerNow`:
- `demoteSteerItems` and `dropSteerItems` (`src/mms/queue/ThreadMessageQueue.ts:633`, `:650`), which `returnUnreadSteerItems`, promotion reverts and `returnOrphanedSteers` use;
- the `steer-followup` enqueue (`OS.ts:9571-9597`);
- the pause follow-up.

The field carries `runId` too, and is honoured only for that run. A click that missed its run therefore cannot force a hold in a later run, even one with the same generation number.

**Generations, stale clicks and double clicks.**
- One hold generation covers a held group as long as its items are unchanged. A click aimed at "Waits for A" therefore also stops B, if A ended and B was announced before release: the person asked for this steer to go now.
- A steer joining the group raises the generation. The item set changed, so an older click is stale.
- A click shown for generation g that arrives after that steer went in matches nothing and stops nothing.
- A second click with a new `clientRequestId` finds the generation consumed, or the field already set with another `requestId` for the same generation (it is then a no-op `applied`).
- A second click with the same id replays the receipt.

**Who may Send now:** the people who may steer the thread (GUI, and Bridge peers with the `chat` capability, through `orchestrator.steerNow`). Agents may not: `thread_steer` has no `now`, so an agent never ends another thread's command. There is no CLI command in this design (scope, §8).

### 2.10 UI

The Steer block (`steer-group.tsx`) gets one line while the turn's `heldSteer` names items that the block shows:

```
                                   ↪ Steer · Waits for Bash · Send now
                                   ┌──────────────────────────────┐
                                   │ actually use pnpm, not npm   │
                                   └──────────────────────────────┘
```

- "Waits for Bash" is muted, in the existing `.steer-group-label` style. Its tooltip reads "Goes in when Bash finishes" and gives the command (`npm test`). With several tools: "Waits for 2 tools", and the tooltip lists them.
- "Send now" is a quiet text button like `.chat-run-interrupted-action` (no fill, hover background). Tooltip: "Stop Bash and send now". After the click it reads "Sending…" until `steer.now_applied` or `steer.now_stale` arrives, or the hold clears or changes generation (§2.9).
- When the steer goes in, the line clears and the reply continues below the block. There is no "Delivered" state.
- No edge bars, no accent fill, no new colour. The button is focusable, with the accessible name "Send steer now, stops Bash". There is no keyboard shortcut.
- A held steer is `steering`, which the queue list already hides (`useThreadQueue.ts:448-452`). The composer's "Steered" notice (`OrchestratorChat.tsx:461-481`) is unchanged.

### 2.11 Fit with #874, #880 and #872

- **#874 progress line:** it keeps "Running Bash…". The wait shows only on the Steer block, which sits just above the line in the live turn. The line's tooltip adds "Your steer goes in when it finishes." Once the steer is taken, `steerAccepted` sets the `waiting` step as today, which #880 shows as "Thinking…".
- **#880 thinking line:** unaffected while a steer is held. A cut during a live thought ends that thought row as written, and the next thought is a new row.
- **#872 Done:** a held steer does not end the turn, so the thread stays Working; Done is recorded when the turn ends. No change.

### 2.12 Tests

Each new test must fail on the code before its change.

**Policy and counting**
- `tests/run/commandPolicy.test.ts`:
  - every row of the `steerDelivery` table, and `steerBoundary: 'none'`;
  - `strict` keeping an already held steer held until the boundary;
  - strict, after a tool finished and model output was seen, a new steer: `cut`.
- `tests/run/capabilityReaders.test.ts`: `steerBoundary` → `steerDelivery`, and `steer` gains `steerDelivery` as a reader.
- `tests/run/transcriptAssembler.test.ts`: `foregroundTools` excludes background, subagent, wait-only and approval-waiting calls, and counts a `notMovable` subagent. Ownership cases:
  - a foreground Agent with a nested Bash: nothing holds;
  - the same Agent moved to the background: nothing holds;
  - a root Bash and the subagent's child Bash together: only the root Bash holds. The steer goes in when the root Bash ends, while the subagent's Bash runs on;
  - a call whose parent cannot be resolved: it holds.

**`tests/run/queueSteerExactlyOnce.test.ts`**, with a fake adapter on each `steerBoundary` and deterministic interleavings:
- **Hold and release**
  - a steer during a tool is not drained; it is drained after the result once the window closes;
  - two consecutive tools with the steer between them: on `start`, held through the window; on `announce`, held by the second announcement;
  - **text between two consecutive tools** on a `start` provider: the text is model output, so the window closes and the cut is asserted (the documented best-effort window). In strict mode the steer is held until the boundary;
  - **a delayed start notification:** the second tool runs before its `start` reaches Mousse and the cut lands. This is asserted as the documented best-effort window; in strict mode the steer is held;
  - a tool's own output deltas never close the window, and any tool event restarts it;
  - a tool that starts between drain and cut: `mayCut` is false and the steer is held again in the same generation.
- **Peek coverage**
  - a steer promoted by another process during a tool: held, shown in `heldSteer.itemIds`, released once;
  - a remote turn's steer through `externalPeekSteer`: held without being taken.
- **Mixed and approvals**
  - a mixed batch: a person's and an agent's steer while a question is open;
  - a pending approval for one call while another runs, and an approval granted while the steer is on its way.
- **Ends**
  - Stop while held; the turn ends while held; a usage-limit pause while held;
  - three steers batched.
- **Send now**
  - Send now forces a drain;
  - a stale generation; two clicks with different ids; two with the same id;
  - **cross-process:** the foreground tool never ends, Send now comes from another process, and the cut reaches the provider before any result; this also runs while Pi compacts;
  - **crash recovery:** a crash between the database commit and the queue-file write, which boot repair or the owner's poll finishes; and a crash after the file write and before the `applied` mark, which the journal finishes without writing twice;
  - a stale request recovered after the target run ended: `steer.now_stale`, nothing forced;
  - an item with no `steerRunId`, held in the active run: Send now applies to it;
  - a journal entry that reaches `failed`: `steer.now_stale` is appended;
  - Send now, then Stop before the owner's poll, then the item re-steered into a new run with a held tool: nothing is forced, and the field is gone.

**Other files**
- `tests/run/restartRecovery.test.ts`: a new kill point while a steer is held. The run ends `interrupted`, and the steer runs once after it.
- `tests/claudeLiveSessions.test.ts`:
  - no push while a `tool_use` is open, from `content_block_start` to its `tool_result`;
  - a push after the result, with `mayCut` checked after the background move;
  - a Bash that starts during the move hands the steer back;
  - `backgroundTasks(id)` only for subagent calls, never the no-argument form;
  - a failed move reports `notMovable` and the next peek holds without another move;
  - Send now pushes the steer during the tool, then interrupts the turn; or stops the command's task (`stopTask`) once Claude Code named it (`task_started`).
- `tests/run/codexAdapter.test.ts` with a new fixture `steer-during-command`:
  - `item/started` for a command, the steer held, `item/completed`, the window, `turn/interrupt`, then `turn/start` with the text, taken on its acceptance;
  - strict: `turn/completed`, then `turn/start` with the text, and no interrupt;
  - Send now during the command interrupts at once.
- A new scenario `tests/run/scenarios/steer-mid-tool/` (SPEC §13.6 lists "steer mid-tool"; only `steer-mid-turn` exists): every adapter keeps the tool's result and reads the steer after it.
- Renderer:
  - `tests/renderer/steerGroupHeld.test.ts`: the line, the tooltip, Send now, "Sending…", the line clearing, the stale result returning the button, the tool name kept while the window is open, and "Sending…" ending when `heldSteer` clears or its generation changes with no `steer.now_*` event;
  - `tests/renderer/turnProgress.test.ts`: the tooltip sentence;
  - `tests/resnapshotTurnState.test.ts`: `heldSteer` survives a resnapshot.
- Windows, automated: `tests/harness/piShell.test.ts` gets a win32 case. A Send now (abort) during a command that starts a child process (`ping -n 60 127.0.0.1` under a shell) ends the whole tree, the output written so far stays in the tool's result, and no later event from that call reopens the turn.

**Hands-on gate** (dev app, software rendering, isolated home, no real sign-ins; cua-driver on Windows):
1. Claude Code against a local fake Messages server:
   - a steer during a 40 s command: the block shows "Waits for Bash", the command finishes (exit 0 in its row), the steer goes in after it, and the reply answers it;
   - the same on Windows with `ping -n 60 127.0.0.1`;
   - a steer while the reply is being written: the cut is immediate;
   - a steer during a foreground subagent that runs Bash: nothing is waited on;
   - Send now during the command: the command row ends interrupted, and on Windows no `ping` process is left (`Get-Process ping`);
   - three steers during the command: one block, one line, one input;
   - Stop while a steer is held: it is back first in the queue;
   - the dev daemon killed while a steer is held: the steer runs once after the restart;
   - scrolled up while a steer is held: the view does not move.
2. Codex: the real `codex app-server` with a local mock model provider (its configured base URL, a fake key):
   - a steer during a 20 s command;
   - two commands in a row from one response, in both modes;
   - Send now.
3. Pi: a `pi:*` instance pointed at a local mock OpenAI-compatible server: the §3.4 hands-on list.

ACP agents and Cursor are checked by hand only if they can run with no account; otherwise the PR says so.

### 2.13 Risks

- **A tool that never reports its end** (a sparse ACP agent, a lost `complete`) keeps the steer held until the turn ends. Send now is the way out; at the turn's end the steer becomes a follow-up, and the assembler's end-of-turn `unfinished` close clears the count.
- **A long build delays the steer by minutes.** That is by design: the line names what it waits for, and Send now is one click.
- **Strict mode** can delay a steer for a whole agent turn. That is the stated cost.
- **A misclassified tool** waits rather than being cut (an unmarked subagent, an unresolvable parent, a background shell not marked `background`). The failure is a delay, never a lost command.
- **The best-effort window** in §2.3.1 remains until strict mode, `'next'` (S1) or Codex native (S2) is adopted for that provider.
- **The release window** delays a steer on `start` providers by up to `STEER_SETTLE_MS` after a command when the model shows nothing yet.
- **Run-engine queue ordering is unchanged:** held steers stay where #873 put them.

## 3. Item 2: Pi cuts in like the others

### 3.1 Behaviour

| Pi is | A person's steer |
|---|---|
| Writing or thinking (an assistant message streams, no tool call announced) | **Cut:** the reply is aborted. The text already shown stays as written, above the Steer block; finished tool results stay; and the same turn goes on with the steer. |
| At `turn_end` (no request yet) | Native `steer`. If an assistant reply that started after the send is open while the steer is still unread (`sending` or `queued`), it is cut (§3.2, "Release at `turn_end`"). |
| A tool call is announced or runs | Held (§2). Send now: a cut (Pi's abort ends the tool, §3.5). |
| Retrying (`auto_retry_start`) | Cut: the abort also cancels the backoff (`engine.ts:1565`). |
| Compacting (`compaction_start`) | Held until `compaction_end`. A Send now request is still read during the compaction (§2.2) and forces the cut once it ends: a steer never stops a compaction. |
| After `agent_end` | Unchanged: no drain runs once the turn is no longer running (the drain is at `turn_end`), so the text becomes the next turn. |

Agents' steers and subagent notices keep Pi's native next-step path; they never cut.

### 3.2 Mechanism (`src/mms/harness/pi/engine.ts`)

**One lane.** Every control operation of a turn runs through one serialized lane (a promise chain on the turn), and each waits for Pi's response before the next starts: a native `steer`, `clear_queue`, `abort`, the continuation `prompt`, and Stop. Pi's RPC child does not serialize input lines itself (`rpc-mode.js:644-645` in Pi 1.4.0), so the order is enforced here. The `turn_end` native send, which is fire-and-forget today (`:1923-1935`), joins the lane. Responses are matched to their requests by RPC id (`rpcClient.ts:205`).

**Attributing Pi's events.** Pi's events carry no Mousse generation, but they arrive in order on one stdout stream, and Pi runs one prompt at a time.
- **The settlement barrier** of a cut is the first `agent_settled` that arrives after the `abort` request is written. It is not `agent_end`: a retry emits several `agent_end` events and one `agent_settled` (`engine.ts:2039-2050`, `:2078-2088`). A cut during a retry's backoff therefore waits for the `agent_settled` the abort produces, not for an `agent_end` that has already passed.
- **No other run can settle in between.** The lane starts a cut only after the previous cut's continuation `prompt` was accepted, and that cut first waited for its own barrier. So the only unsettled prompt at the time of the abort is the one being cut.
- **A late RPC response** from an earlier operation is a response, matched by its id, never an event of a run.
- S3 item 12 confirms the bracketing.

**Ownership of each steer.** Every entry the engine holds is in exactly one state, and each move is one event:

| State | Entered by | Left by |
|---|---|---|
| `drained` | `drainSteerEntry` (token kept) | the lane sends it (`sending`), or a Stop or crash hands it back |
| `sending` | native `steer` request sent | its response, matched by RPC id: OK → `queued`; error → handed back. A matching user `message_start` → `taken` (Pi can dequeue a steer before it writes the response; the OK that follows then changes nothing). |
| `queued` | Pi accepted the native steer | its user `message_start` → `taken`; `clear_queue` returns it → `cutHeld`; the cut's settlement barrier (step 2.5) → `cutHeld` |
| `cutHeld` | the cut takes it | the continuation `prompt` is accepted → `taken`; Stop, crash, refused prompt → handed back |
| `taken` | `steerTaken(token)`, then `sink.steerAccepted(text, token)` (§2.6) | — |

**What the operation generation does, and what it does not do.** `turn.opGen` rises at each cut and at Stop. It decides only which operation may act next:
- it voids obsolete **lane effects**: a `prompt` or `abort` response for an older generation does not start a continuation or end a cut, and an older generation's operation cannot settle the turn or start the next one;
- it **never voids ownership bookkeeping**. The response to a native `steer` (`sending` → `queued`), and a user `message_start` matching a `sending` or `queued` entry (→ `taken`), are applied whatever the generation, until the cut's settlement barrier has been processed. A steer Pi already read is therefore taken, and never put into the continuation as well.

Only after that settlement may entries still `queued` move to `cutHeld`, and may anything be handed back.

**Matching by order and token.** Pi delivers queued steers in the order it received them.
- A user `message_start` is matched to the oldest `sending` or `queued` entry by exact text, not `includes` (`:1946` changes).
- If S3 shows Pi joins several queued steers into one user message, the match takes the oldest entries whose joined text equals the message, in order.
- The continuation `prompt` is matched by its lane operation (its response, under its generation), never by the text of a `message_start`. A queued steer whose text appears inside the prompt is never counted as taken by it.

**The cut**, for a drain with `cut: true` while Pi is writing:
1. Set `turn.phase = 'cutting'`, raise `opGen`, and hold the drained entry in `cutHeld`, if there is one. A cut started by the release condition below holds no new entry. From here no new native `steer` is sent; the poll only peeks.
2. On the lane:
   1. Wait for any native `steer` already in `sending` to get its response, and apply it. If every entry the cut was for is now `taken` (Pi read it meanwhile) and nothing is in `cutHeld`, stop here: no abort, back to `running`.
   2. `clear_queue`. Each returned text matched to a `queued` entry, in order, moves to `cutHeld` with its token. A returned text that matches no entry is handed back as text (`returnSteer(text)`), as Stop does (`:1559-1563`), so nothing in Pi's queue is dropped.
   3. `mayCut(token)`. If it is false (a tool call was announced meanwhile), skip the abort, go back to `running`, and hand back the cut entries; the hold resumes.
   4. `abort`. One deadline, `INTERRUPT_DEADLINE_MS`, covers the abort and the wait in step 5 together. Missing it gives the steers back (item 5 below, "Give-back").
   5. Wait for the settlement barrier: the first `agent_settled` after the `abort` request. Events before it keep moving entries (→ `taken`) until then. After it, any entry still `queued` (Pi took it from its queue and never showed it) moves to `cutHeld`. Every entry is now `taken` or `cutHeld`.
   6. `prompt` with the `cutHeld` texts joined in order, in the same process and session.
3. **The aborted text stays as written.** The aborted `message_end` (skipped today, `:1977`) closes the current text segment (`streams.text.break()`), the split Codex makes (`drivers/codex/adapter.ts:196-202`).
4. **Acceptance.** When the `prompt` response for this generation is OK, every `cutHeld` entry is taken and accepted (`steerTaken(token)`, `sink.steerAccepted(text, token)`). The phase goes back to `running`, and `awaitingModel = true`.
5. **Give-back.** Each of these hands every `cutHeld` entry back with `returnSteer(text, token)`, once each (`cutHeld.splice(0)`):
   - a Stop (`stopTurnOnce`, `:1540-1574`), which raises `opGen` first, so a pending continuation never starts after it;
   - a crash (`died`, `:1862`);
   - a refused or failed `prompt`;
   - an `abort`, or its settlement barrier, that misses the deadline.

   A Stop during the cut wins: the steer is back first in the queue.

**Release at `turn_end`.** A held person's steer is released at `turn_end` as a native `steer` (no cut needed). If it reaches Pi after Pi already read its queue for the step that starts there, it would wait a whole reply. The trigger for the cut is therefore a **condition, not an event**:

> While an assistant reply that started after the native send is open, and a person's entry from that send is `sending` or `queued` (not `taken`), the cut runs for it.

- **When the condition is checked.** The engine evaluates it at every transition that can make it true:
  - an assistant `message_start`, which also records `replyStartedSince` on each person's entry still `sending` or `queued`;
  - the native `steer` response being applied in the lane (`sending` → `queued`). This check runs after the event handler has applied any consumption evidence that came first.

  Pi's RPC client dispatches the events of a stdout chunk synchronously and resolves the response's promise afterwards (`rpcClient.ts:77-84`, `:196-205`). So when the OK and the assistant start arrive in one chunk, the event marks the entry first, and the response's check then sees `queued` plus `replyStartedSince` and cuts.
- **A cut for a `sending` entry starts at once.** Step 2.1 waits for its response.
  - If Pi read the steer meanwhile (a user `message_start` took it), nothing is cut.
  - Otherwise `clear_queue` moves it to `cutHeld`, then come `mayCut`, `abort` and `prompt`.

  `mayCut` still holds the cut back if a tool call is announced meanwhile.
- **No cut is needed** when Pi emits the steer's user `message_start` before the step's assistant message: the steer was taken first, so the condition is false.
- **Cost.** One wasted request start when the race is lost. S3 item 11 measures how often that happens.
- **A later improvement (not in this design).** Send the native steer at the last foreground `tool_execution_end` of the step, instead of at `turn_end`, so it is more likely to be in Pi's queue before Pi polls it. S3 item 11 decides whether it is worth doing.

**#368: the turn's end.** At the final `agent_end`, before the engine lets `agent_settled` settle the turn (`:2081-2088`), the lane:
1. waits for any native `steer` in `sending`;
2. sends `clear_queue`;
3. hands back each entry still `queued`.

Each such steer then runs once as the next turn, and Pi's queue holds nothing. Only then does the turn settle.

### 3.3 Spike S3 (before code: the stub Pi child and the real Pi 1.4.0 child against a local mock model)

1. After `abort` in the middle of a message, does Pi's session keep the partial assistant message, nothing, or the whole message? Mousse's transcript keeps what was shown either way. If Pi drops it, the model does not see its own cut-off words, as with Claude Code.
2. Does `prompt` after `abort` continue the same session with its full history? (Expected: `thread.warm` stays set, `:1477-1480`.)
3. Does `clear_queue` return steers that are queued and unread, in order? What does it return for a steer whose `steer` request has not been answered yet?
4. A native steer paused before Pi queues it, then `clear_queue`: which comes first?
5. A steer Pi took from its queue whose user `message_start` Mousse has not read when `clear_queue` answers.
6. `agent_settled` arriving before the `clear_queue` response.
7. Stop while the continuation `prompt` is being checked.
8. An abort after an assistant message with tool calls and before `tool_execution_start`. Does the next `prompt` work, given an assistant tool call with no result (some model APIs refuse it)? Is the tool refused at its start?
9. Does Pi join several queued steers into one user message?
10. While a tool runs, does a native `steer` wait for it, and does it skip tool calls not started yet? Not needed here (Mousse holds during tools); it decides whether a later change may send natively during tools.
11. **A native steer sent in reply to `turn_end`:** is it in the next request? How often does it miss, with Mousse's lane latency?
12. **Event bracketing:**
    - Does exactly one `agent_settled` follow each prompt, after all its events, including several `agent_end` events when Pi retries?
    - Is nothing of that prompt emitted after its `agent_settled`?
    - Does an `abort` during a retry's backoff produce that `agent_settled`?

### 3.4 Tests

`tests/harness/piRpcLifecycle.test.ts` (stub Pi):
- **The cut**
  - a cut while writing keeps the shown text and continues the same turn; the steer is taken once;
  - two cuts in a row;
  - a cut while a native steer is `sending`, and while one is `queued`.
- **Generations and ownership**
  - a Stop during each step of the cut gives the steer back once; a late `prompt` response or `agent_settled` for the old generation starts nothing;
  - **A's late events:** native steer A is `sending` under generation g; cut B raises the generation; A's OK response and then its user `message_start` arrive. A is taken once and is not in the continuation `prompt`;
  - **the same with A already `queued`** when the cut begins;
  - **retries and the barrier:** several `agent_end` events before one `agent_settled`. The cut waits for the `agent_settled`, not the first `agent_end`. A missed barrier deadline gives the steer back;
  - the S3 interleavings 4–7 as deterministic tests.
- **Failures**
  - a failed `prompt` gives the steer back;
  - an `abort` that misses its deadline gives the steer back and ends the turn as a Stop would.
- **Matching:** repeated identical steers; a steer whose text is part of another; the continuation prompt not matching a queued steer.
- **Release at `turn_end`:**
  - the condition holds (an assistant `message_start` while a person's entry is `queued`): the cut starts; an agent's queued steer does not;
  - **(a)** the assistant `message_start` arrives before the steer's OK, and the reply goes on forever. The cut starts when the OK is applied, the steer is taken once, and the cut lands without waiting for another assistant start or the turn's end;
  - **(b)** the OK and the assistant `message_start` arrive in one stdout chunk, in either order. Same outcome as (a);
  - a user `message_start` takes a still-`sending` entry, and the OK after it changes nothing;
  - a tool call announced while the cut waits for the OK: `mayCut` is false and the steer is held.
- **Other phases:**
  - a steer during retrying cuts, and the continuation `prompt` is sent;
  - one during compaction holds;
  - Send now during compaction forces the cut at `compaction_end`.

Other files:
- **#368:** a steer at the last step comes back once, and `clear_queue` was sent before the turn settled. With the real Pi child, as #368 asks, in `tests/harness/piRpcProcess.test.ts` ("Pi RPC engine with the real Pi child").
- **`tests/run/scenarios/steer-mid-turn`:** Pi now splits the reply at the steer like the others; the scenario's Pi exception from #873 is removed.
- **Windows:** the `piShell` win32 case in §2.12.

**Hands-on gate:** a `pi:*` instance against a local mock OpenAI-compatible server:
- a steer while writing;
- a steer during a `sleep`;
- Send now during the `sleep`, also on Windows with `ping -n 60 127.0.0.1`, leaving no `ping` process;
- a steer at the last step (#368).

### 3.5 Risks

- **Pi's abort on Windows.** Pi's shell runs detached only off Windows (`extension/shell.ts:193`), so on Windows Pi's abort may not end a command's children. If the win32 test shows a surviving tree, Send now then ends the tool's tree with the same tree kill Stop uses: the thread's process groups and descendants, `pi/descendants.ts`. The POSIX process-group evidence is not taken as Windows evidence.
- **A Pi version whose `abort` leaves the session unusable** would end the turn. A failed `prompt` hands the steer back and the turn ends as stopped; the steer runs next.
- **More aborts mean more partial requests billed**, including a missed `turn_end` release. The other providers already have this trade-off.

## 4. Item 3: a mark on cut-off turns

### 4.1 Does it help?

Yes, for turns that ended early; no for steer cuts.

- **Why it helps.** A turn that a Stop, a restart or a crash ended looks finished when you scroll back: "Worked for 7s", then a reply that stops. Nothing says the agent did not finish, so a reader can take half-done work (a half-run migration, an edit plan with no edits) as done. The latest such turn has the "Run interrupted · Continue" notice, but only while its in-memory phase is `stopped`: until the next turn, or the next restart (#881). Earlier turns show nothing.
- **Why steer cuts don't count.** A steer cut is not an ending: the turn goes on in the same row, and the Steer block already shows where the person cut in. With Steer cutting in by default, almost every steered turn would carry the mark, and it would say nothing new. With item 1, a steer no longer ends a command Mousse knows of. When Send now stops a command, that command's row already reads interrupted (`format-tool.ts:78-86`), and the turn itself went on.

The mark counts a Stop (by a person, or by an agent in another thread), a restart and a crash. It does not count steer cuts, Send now, usage-limit pauses (they have their own line), failures (they show their error) or a bot's wall.

### 4.2 What it says and where

The mark sits in the turn header, after the duration, in the same muted style (`.turn-work-label`, `message-list.tsx:242-295`):

```
Worked for 7s · Stopped ──────────────────────────────
Worked for 41s · Interrupted ─────────────────────────
```

| Cause | Mark | Tooltip |
|---|---|---|
| `user` | Stopped | "You stopped this turn before it finished." |
| `agent` | Stopped | "An agent in another thread stopped this turn." |
| `daemon_restart` | Interrupted | "Mousse restarted during this turn." |
| `crash` | Interrupted | "Mousse quit during this turn." For an `uncertain` run it adds "May have run: bash". |

- One word. No icon, no colour change, no edge bar. It is not a button; Continue stays on the live notice only.
- **Every** cut-off turn gets it, the latest included, except while the live "Run interrupted" notice shows for that same turn (the two would sit a few lines apart and say the same thing).
- A subagent's turns follow the same rule in its own thread. Bot chats show no turn headers and are unaffected.
- **`provider` is not marked.** When the reconciler's rule 2 ends a run with no terminal event (`Reconciler.ts:180`), nothing writes a transcript line, and the reconciler never touches transcripts (§8).

### 4.3 Data path

**Writers.** The system line that a turn's end writes today gains two fields: `turnId` (the run id) and `turnEnd: { cause: 'user' | 'agent' | 'daemon_restart' | 'crash'; tools?: string[] }`. No new message is written, and there is no schema change (they are fields in a `ChatMessage` row's JSON).
- **The Stop path** (`OS.ts:11738`):
  - a shutdown abort is `daemon_restart`;
  - a bot wall gets no mark;
  - otherwise the cause is `agent` when the run's outcome has `stopRequestedBy: 'agent'` (`src/mms/run/types.ts:74`), and `user` if not.

  The line is written after the terminal write (`markRunTerminal`, `:11741`), so the cause comes from the run's stored outcome, which records `agent` (`RunEngine.ts:1162-1174`).
- **The boot path** (`writeRestartTranscripts`, `OS.ts:2614`):
  - the cause is `crash` when the boot found that the previous daemon crashed (`daemonEpochs.begin`'s `previousCrashed`, `RunEngine.ts:839`), and `daemon_restart` if not;
  - an `uncertain` run's line adds `tools` from the restart note;
  - the boot records `crashed` on each `restart.transcript_pending` marker's payload (an event payload, so no schema change). A marker from an older build has no field and reads as `daemon_restart`.

**Normalisation** (`src/renderer/chat/adapters/mousseToUI.ts:344-373`). These system messages become a hidden marker: a `UIMessage` with `role: 'system'`, its `turnId`, and `metadata.turnEnd`.
- A message with `turnEnd`.
- An older line whose text is exactly `'Turn stopped.'` (cause `user`).
- An older line whose text is exactly `RESTART_INTERRUPTED_TEXT` (`restartNote.ts:88`, cause `daemon_restart`, restart wording).

The marker is reused by identity like the other rows (`reuseUIMessages`), so an unchanged marker keeps its object. Today, system lines pass through without the field, and the grouping drops them.

**Grouping** (`groupMessagesIntoTurns`, `message-list.tsx:737-774`):
- A marker attaches to the turn whose user message has the same `turnId` (the run id), wherever it sits in the list. A marker written at boot after newer turns still lands on its own turn.
- A marker with no `turnId` (an older line) attaches to the turn it falls inside, by position.
- The turn gets `end?: { messageId; cause; tools? }`, cached per marker message, so its identity follows the marker's.

**Reuse.** `sameTurn` (`message-list.tsx:776-780`) also compares `a.end === b.end`. A marker that arrives after a snapshot, or changes, re-renders its turn instead of being discarded by `reuseTurns`.

**Scope.** Only the transcript reads the mark. CLI, search, export and Bridge rendering are follow-ups (§8). Bridge already carries the fields, since they are on stored messages.

### 4.4 Tests

`tests/renderer/turnInterruptedMark.test.ts`, through the whole pipeline (`ChatMessage[]` → `mousseToUIMessages` → `groupMessagesIntoTurns` → `reuseTurns` → the rendered `TurnRow`):
- each cause and its tooltip;
- no mark for a steered turn, a paused turn, a failed turn or a bot wall;
- the latest turn's mark is hidden while its notice shows, and shown after;
- the older-text fallback;
- a marker arriving after a snapshot re-renders its turn;
- a marker written after newer turns lands on its own turn by `turnId`;
- an unchanged marker keeps the memoised row.

Other files:
- `tests/run/continueAfterRestart.test.ts`: the restart line carries `turnEnd` with `crash` or `daemon_restart`, and a third boot does not add a second one.
- `tests/run/stopThread.test.ts`: a person's Stop writes `cause: 'user'` and the turn id; an agent's `thread_interrupt` writes `cause: 'agent'`.

Hands-on, with real app captures before and after for the PR:
- Stop a turn, then send another: the first reads "Stopped".
- Kill the dev daemon mid-turn, restart, then send another: the first reads "Interrupted", with the tooltip.

### 4.5 Risks

Small: the renderer reads an optional field. A wrong cause shows a wrong word and never loses data.

## 5. Related work (checked against `6d846d9ec`)

- **Already done:** none of these three. #873 (cut-in), #874 (progress line), #880 (thinking line), #881 (restart cut-offs) and #872 (Done) are the base.
- **Will collide:** #871 (Teams message authors, open) changes `OrchestratorService.ts`, `QueuedMessages.tsx` and `src/shared/types.ts`. Its author field on queue items must carry through `returnUnreadSteerItems`, the `steerNow` field and the held state. Land after #871, or rebase on it.
- **Issues:** §3.2 fixes #368. #514 (Continue on interrupted runs) is separate, since the mark adds no action. #546 (shortcuts) is unaffected: Send now has no shortcut.

### 5.1 SPEC edits (made in the PR that builds each part)

- **§4:** add `steer_now` to `RunCommand`, with its receipt, the `run_not_active` ignore, the `steer_now` queue-journal op, and the events `steer.now_requested`, `steer.now_applied` and `steer.now_stale`.
- **§13.2:**
  - `native` no longer says "only the pi loop does this"; it covers Codex and Pi.
  - Replace "User steers are delivered the same way whatever the value; the capability decides only whether reconciler rule 4 may push a delegation notice" with the rule that `steerDelivery` reads `steer` and `steerBoundary` for a person's steer.
  - Add `steerBoundary` with its reader, and the strict release setting.
- **§13.3:** add `steerDelivery`.
- **§13.4:** the Pi row is the RPC engine (`native`, `announce`).
- **§13.6:** add the `steer-mid-tool` scenario.
- **§14.3:** rule 4 is unchanged. Notices still wait on `interrupt_restart` providers while a run is live; that is out of scope.
- **§14.7 "Unread steers":** a held steer is an unread steer. Add acceptance per token, and Send now.
- **§12.5 step 5:** the restart line carries `turnEnd` (`crash` or `daemon_restart`).

## 6. Rollout

Spikes come first, then small PRs in order. Each run-engine PR is Tier 5 and goes through the council's code gate.

1. **Spikes S1–S4.** No product code; a short note is added to this document with what each one showed. Done: see "Spike results" after this section.
   - **S4: timing on `start` providers.** On the Codex app-server with a mock model, Cursor and one ACP agent (each only if it runs with no account), measure:
     - (a) **the gap as Mousse sees it:** from the moment a tool's result arrives at the adapter to the moment the next tool start of the same response arrives there. This is measured at arrival, never from provider-side timestamps, so it includes notification lag;
     - (b) how late a start notification can be after the command actually began (a command that writes a timestamp, compared with the notification's arrival). This is a check on (a), not a separate input;
     - (c) whether Codex reports a response's later tool calls before the first one finishes. If it does, Codex moves to `announce` and needs no window.

     **Pass rule, written now:** with G the largest gap (a) over at least 200 consecutive-tool pairs, `STEER_SETTLE_MS` = 2 × G + 100 ms. If that exceeds 1 s, the margin cannot be kept: the adapter does not ship best effort, and keeps `steerBoundary: 'none'` (today's behaviour) or ships with strict release as its default. The same applies to a provider whose gaps do not settle. S4 records observed timing; it is not a proof of a maximum.
   - **S2 (Codex native) is optional now.** It only gates the later native change.
2. **PR 1: acceptance per token** (§2.6). No behaviour change.
3. **PR 2: the core hold with Claude Code.**
   - The policy: `steerDelivery`, `steerBoundary`, strict release, `peekSteer` (disk, remote and Send now reads), and `mayCut`.
   - `foregroundTools` with ownership and `notMovable`.
   - `TurnState.heldSteer`, and `steer_now` with its journal op, queue field and events.
   - The Steer block line and Send now.
   - Claude's targeted background moves, `mayCut`, and `stopTask`.
   - SPEC §4, §13.2, §13.3, §14.3 and §14.7.

   The other providers stay at `steerBoundary: 'none'` (today's behaviour) until their PR.
4. **PR 3: Codex, ACP agents and Cursor** on the hold (`start`, the release window, strict release, `mayCut`). The ACP and Cursor token migration (§2.7), the Codex fixture, and SPEC §13.6.
5. **PR 4: Pi cut-in** (§3) on top of PR 2, with Pi at `announce`. Closes #368.
6. **PR C: the mark** (§4). Independent, so it can land first. Tier 4.
7. **Later, each gated on its spike:** Claude `'next'` during a hold (S1), and Codex native `turn/steer` (S2).

If a release shows a provider whose tool events are unreliable, that adapter goes back to `steerBoundary: 'none'`, or to strict release, without touching the others.

## Spike results

Run on 2026-11-11 against `master` at `395e026b1`, on macOS (Apple silicon).

**Setup, shared by all spikes.**
- Every CLI ran in an empty temporary home (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, Pi's agent folder), with a fake key, against a local mock model on 127.0.0.1. No account was used and no sign-in ran.
- All other traffic went to a local trap proxy that refused it. The trap recorded no attempt in any run.
- The scripts were throwaway and are not in the repo: one streaming mock per API (Anthropic Messages, OpenAI Responses, Chat Completions) and one driver per CLI that timestamps each event when it is read.
- Commands write their own start time (and, in S1, their end time), so a killed command shows up as a missing end.
- The mocks answer at once, so timings measure the CLIs and the pipe, not a model.

### S1: Claude Code

Claude Code 2.1.322, driven through the Agent SDK 0.3.291 (`query` with streaming input and partial messages), as Mousse runs it.

| Question | Observed |
|---|---|
| `'next'` pushed during a foreground Bash | The Bash ran to its end (3 s). The steer was in the very next request, right after the tool result, as a "The user sent a new message while you were working" reminder. Same turn, nothing cancelled. |
| `'next'` pushed when the `tool_result` frame arrives | Too late: Claude Code had already sent the next request. The steer ran after the turn's result, as a new turn. |
| `'next'` pushed while the model writes text | Read only after the turn ended, as a new turn. |
| Read signal | Yes. `command_lifecycle` frames report `queued`, `started` (taken into a request) and `completed` for the pushed uuid, and later frames carry it in `user_message_uuids`. |
| Unread `'next'`, then an interrupt (Stop) | The interrupt killed the Bash. Its receipt listed the steer as `still_queued`, and the steer then ran at once as a new turn. A Stop that gives it back has to cancel it first (`cancel_queued` or `cancel_async_message`; not tried). |
| Unread `'next'`, then the CLI killed | Lost on Claude's side. The session file holds only a `queue-operation` line with the text and no uuid, and the resumed session never ran it. The command itself ran on to its end. |
| `'next'`, then `stopTask(taskId)` | The Bash was killed (exit 137). The steer was read once, in the next request of the same turn. |
| `'now'` during a foreground Bash | **Neither killed nor moved.** Claude Code waited for the command (runs of 4 s and 12 s), ended the turn (`aborted_tools`) and ran the steer next, with the full output in its history. |
| `'now'` after the no-argument `backgroundTasks()` | Moved, not killed: the result reads "Command was manually backgrounded by user", the command finished in the background, and a wake turn followed. This matches what #874 saw. A Bash can be moved only once Claude Code reports it as a task (`task_started`, about 3 s after it starts). At 1 s nothing moved, although the call returned `true`, and `backgroundTasks(id)` returned `false`. |
| `'now'` with two Bash calls running in parallel | Both ran to their end, then the steer went in. |
| Two Bash calls from one response, `'now'` pushed at the first result | The second call was refused before it ran ("Command was aborted before completion", no start time), 5 of 5. |
| Delayed announcement | A `tool_use`'s `content_block_start` reached the SDK reader 30.5–48.9 ms (median 36.6, n = 20) before the command started. `'now'` pushed at the previous result aborted the next request before any `tool_use` arrived, 20 of 20. `'now'` pushed 0–100 ms after an announcement, while the input still streamed, dropped the call before it ran, 8 of 8. |
| A tool starting while `backgroundTasks(agentId)` is awaited | The await returned in 1–9 ms (3 runs, a subagent started with `run_in_background: false`). The main loop's next tool was announced 8–10 ms after that and started 16–20 ms later, so none started during the await. Subagents now start in the background unless the model asks otherwise. |
| `'now'` during WebFetch or WebSearch | Both ended at once: WebFetch with a `canceled` error, WebSearch with an empty result. No `detachedToolCall`, and no result came later. |
| `backgroundTasks` with background tasks disabled | `backgroundTasks(id)` and `backgroundTasks()` both throw "Background tasks are disabled in this session." at once. The Bash is unaffected. |

Conclusion against §2.4:
- On this version a `'now'` cut never ended a command that had started. It waits for a running Bash and refuses calls not yet started. The Claude row of §2.3.1 does not show up for Bash. Other tools (edits, MCP calls) and other versions were not checked.
- The no-argument `backgroundTasks()` is what ended commands for the person. Removing it, as PR 2 plans, is required.
- **Send now cannot rely on `'now'`**, because `'now'` waits for the Bash. It needs `interrupt()`, which kills the command while the queued steer survives and runs once, or `stopTask(taskId)`, which works only after `task_started`. §2.4's Send now changes from "push `now`" to "push, then interrupt or stop the task".
- `'next'` during a hold: S1 shows the read signal (condition 1) and a single read after `stopTask` (condition 3). For condition 2 it shows that an interrupt runs the steer unless it is cancelled, and that a crash loses it, so Mousse gives it back from its own record. Cancelling on Stop was not tried, so `'next'` stays a later change.

### S2: Codex native `turn/steer` (optional, one run each)

`codex app-server` 0.167.0 with a Responses mock. Mousse's managed pin, 0.162.1, was not tested.
- **`turn/steer` during a 3 s command.** It was answered at once, and the command finished. Codex then emitted `item/started` for a `userMessage` with the steer's text, and the next request carried the text after the command's output. That item is a read signal (condition 1 of §2.5).
- **`turn/steer`, then `turn/interrupt` before the command ended.** The turn ended `interrupted`. The steer was gone: no `userMessage` item, absent from the next turn's request, and no event said so (condition 2, for an interrupt). A failed turn and a thread resumed after a kill were not tried.
- **Conclusion.** Native steer stays a later change: Mousse would have to hand back an accepted, unread steer on every interrupt itself.

### S3: Pi

The real Pi 1.4.0 RPC child, started by Mousse's own launcher with Mousse's extension (test build) and bridge, against a Chat Completions mock. The stub child (`tests/harness/fixtures/pi-rpc-stub.mjs`) got the same command sequences. Event order is the order Mousse's RPC client delivers them.

1. **Abort mid-message.** Pi emits `message_end` (stop reason `aborted`, with the partial text), `turn_end`, `agent_end`, `agent_settled` with `aborted: true`, then the abort's response. The session keeps the partial assistant message, but the next request leaves it out, so the model does not see its cut-off words.
2. **`prompt` after `abort`.** Same session id, with the full history.
3. **`clear_queue`** returned two queued steers in order and emptied the queue.
4. **A `steer` and `clear_queue` written in the same tick.** `clear_queue` answered `[]` first. The steer was queued after it and reached the model at the next step. Step 2.1's wait for the steer's response is needed.
5. **`clear_queue` sent the moment `tool_execution_end` arrived** (10 runs). Pi had always taken the steer already: its user `message_start` came before the `clear_queue` response (`[]`) every time.
6. **`abort` and `clear_queue` written together.** `agent_settled` arrived before both responses, and `clear_queue` still returned the steer: an abort does not empty Pi's queue.
7. **A continuation `prompt` with an abort right behind it.** The prompt was answered `started` and its user message entered the session. No model request went out, and the run settled with `aborted: true`. The steer's text is then in Pi's history, though the model never read it.
8. **Abort while Mousse's gate held a tool call.** Pi sends `tool_execution_start` about 1 ms after `message_end`, before the gate. The abort waited for the gate, then the call ended "Operation aborted" without running. Pi wrote that result into the session, so the next `prompt` worked: its request had the call and its result.
9. **Several queued steers.** Pi does not join them: three steers became three user messages, each with its own model request.
10. **Steers sent during a running tool** waited for it. Pi started both calls of the message together, so no call was skipped.
11. **A native steer sent the moment `turn_end` arrived** was in the next request 0 of 40 times. Pi sent that request 1.2–3.4 ms (median 1.6) after `turn_end` reached the client. A steer sent at `tool_execution_end` instead also made it 0 of 40 times.
12. **Retries.** Two failed attempts, then a success: three `agent_end`, then one `agent_settled` after all of them, and nothing after it (3 of 3). An abort during a 4 s backoff gave `auto_retry_end` (`success: false`) and `agent_settled` (`aborted: true`) within 1 ms, and no further request.

**Where the stub differs from Pi**, which PR 4's tests depend on:
- It streams nothing: a prompt gives only `agent_start`, `agent_end` and `agent_settled`.
- `steer` is answered with no disposition and is never queued or delivered, and `clear_queue` returns only its configured list.
- `abort` answers even when idle.
- It writes the abort's response before `agent_settled` (Pi writes `agent_settled` first), and its `agent_settled` has no `aborted` flag.
- It has no retries.

Conclusion against §3.2:
- **The cut works as written.** An abort ends the reply and leaves the session usable, and the settlement barrier holds: one `agent_settled` per prompt, also through retries and an abort in the backoff.
- **The `turn_end` release missed every time here**, so the release-condition cut runs for nearly every held steer, at the cost of one aborted request start each.
- **Sending at the last `tool_execution_end` does not help** (0 of 40), so that later improvement is not worth doing.
- **The stub needs the behaviour listed above** before the §3.4 lifecycle tests can catch the races they are written for.

### S4: timing on `start` providers

Every event was timestamped when read from the CLI's stdout: Codex's through Mousse's own `CodexAppServerClient`, Grok's ACP lines off the same pipe Mousse's ACP connection reads. Commands of 0, 0.05, 0.2, 0.5 and 1 s were mixed. A pair is a tool result followed by the next start of the same response.

| | Codex app-server 0.167.0 | Grok 1.0.77 over ACP (Mousse's launch arguments) |
|---|---|---|
| Sample | 432 commands in 72 responses of 6; 216 pairs | 250 calls in 50 responses of 5; 200 consecutive pairs |
| How a response's calls run | All at once (`parallel_tool_calls: true` for every model name tried) | All at once |
| (a) gap from a result to the next start | Max **G = 65.7 ms** (median 47.5, p99 65.1). In 189 pairs no other command of the response was open. | No start arrived after a result: each later call's `tool_call` came 15–1055 ms before the earlier call's result. **G = 0.** |
| (b) how late a start notification is | Always after the command began: 21–24 ms for commands that end at once (their start and result arrive together, 214 of 432), 73–135 ms for longer ones. Max **135 ms**. | Never late: `tool_call` arrives 14–43 ms before the command starts, `in_progress` 7–21 ms before. |
| (c) later calls reported before the first finishes | No. Nothing arrives before a command runs, and its start comes late, so Codex stays `start`. | Yes: every call of a response is announced before any runs. |
| `STEER_SETTLE_MS` = 2 × G + 100 ms | **232 ms** | **100 ms** |
| Best effort may ship (1 s or less) | **Yes** | **Yes**, for Grok |

- **Cursor:** not run. It needs an account, and its CLI is not installed here.
- **Antigravity:** not run. It needs an account.
- **Codex: (b) matters more than (a).** A command can run for up to about 135 ms before Mousse hears of it, at any point in a turn, not only after a result. After a result, the 232 ms window covers it. A steer released while the model writes can still meet such a command, which is case (b) of the Codex row in §2.3.1.
- **Grok behaves like an `announce` provider.** Its `tool_call` comes before its permission request (answered at once in the spike, as Mousse does when no approval is asked). This holds for Grok only; other ACP agents were not measured.
- **These are observed values on an idle machine,** not a maximum.

## 7. Decisions

1. **Best effort is the default for Codex, ACP agents and Cursor** (decided 2026-11-11, after the spike results).
   - **Best effort:** a held steer goes in shortly after a command (`STEER_SETTLE_MS`: 232 ms on Codex, 100 ms on Grok) when the model shows nothing, or as soon as it writes. A command that starts inside that window, or whose start Mousse has not heard of yet, can still be cut.
   - **Strict:** a held steer waits until the agent's whole turn ends, or Send now. It never cuts a command it held for, but it can wait a long time.

   Both ship as a per-instance setting. A provider whose gaps were not measured (Cursor, until it can be run) still follows the §6 pass rule before best effort ships for it.

Kept from earlier rounds: the progress line keeps "Running Bash…" and the wait shows on the Steer block; no Send now shortcut; agents cannot Send now another thread's command; the marks read "Stopped" and "Interrupted".

## 8. Council round 1 responses

Verdicts: Opus, Sol and Fable each requested changes, with no blockers. Each finding is listed with what changed or why it was not taken. Revision 3 adjusts some of these answers; see §9.

### Agreed by the reviewers

| Finding | Response |
|---|---|
| A subagent's own tool calls count as foreground (Opus 2, Sol 4, Fable 1) | **Fixed.** `foregroundTools` filters by ownership: it walks `parentCallId` / `activity.parentId` and excludes any call under a subagent or background call (§0, §2.2). An unresolvable parent holds. Tests: a nested Bash, a backgrounded Agent, and a root Bash with the subagent's child Bash (§2.12). |
| The safe-point race between decision and cut (Sol 1, Fable 2) | **Mitigated; the guarantee is now labelled best effort (§9, Sol 1).** §2.3 is a boundary contract: holds start at the announcement where providers give one; `start` providers release only after output or a window; every adapter checks `mayCut` at dispatch, after any await. Strict release is the per-provider option that removes early release. |
| Pi's poll cannot follow the table without a non-taking read (Opus 1, Fable 3) | **Fixed.** `peekSteer()` and `drainSteerEntry({ expect })` (§2.2). Pi holds during a tool; the native drain happens only at `turn_end`. |
| Pi needs a serialized lane and an operation generation (Sol 3, Opus 4, Fable Q4) | **Fixed**, with the generation rule corrected in revision 3 (§9). |
| Pi matches by `includes` (Fable 8, Sol Q4) | **Fixed.** Order plus exact text, and the prompt is matched by its operation (§3.2). |
| Acceptance is not per token (Sol 2) | **Fixed**, with the acceptance point corrected in revision 3 (§2.6, §9). |
| Send now as a distinct command bound to the run, a generation and item ids, with a durable receipt (Sol 5, Fable 6, Opus Q5) | **Fixed**, with durability and the field's lifetime completed in revision 3 (§2.9, §9). |
| Codex: hold or native first (Opus 3, Sol Q2; Fable Q2 for native) | **Hold from the start** (§2.5). Native `turn/steer` is a later change, gated on S2's four conditions. |
| The mark's data path (Sol 6) | **Fixed** (§4.3, §4.4). |
| The `agent` cause, and the writer for `provider` (Opus 7, Fable 9) | **Fixed.** `agent` added; `provider` dropped; crash and restart are told apart by `previousCrashed`. |

### Also folded in

| Finding | Response |
|---|---|
| If `now` only moves Bash to the background, Send now must still stop it (Opus 5) | **Fixed.** `stopTask(taskId)` (§2.4). |
| A cut that ends a foreground `delegate_task` (Opus 6) | **Fixed** (§2.8, last row). |
| SPEC edits (Opus 8, Fable 7) | **Fixed** (§5.1). |
| Windows evidence (Opus 9, Sol 7, Fable 8) | **Fixed:** a win32 `piShell` test, Windows hands-on steps, and §3.5. |
| Trim scope (Opus 10, Sol 7) | **Fixed.** No search, export, Bridge or CLI rendering of the mark; no CLI command. |
| Split PR A (Fable 10) | **Fixed:** PRs 1–4 and C. |
| `'next'` as S1's first question (Fable 5) | **Fixed**, and its use narrowed in revision 3 (§2.4, §9). |
| Wrong citation for a background Bash (Fable 5) | **Fixed.** |
| `clear_queue` texts matching no steer (Fable 8) | **Fixed:** handed back as text. |
| Pi during retrying and compaction (Fable 8) | **Fixed:** retrying cuts, compaction holds. |
| A rollback needs the provider's identity (Fable 10) | **Fixed:** the adapter's `steerBoundary: 'none'`. |
| Missing test rows (Fable 10) | **Fixed.** |
| Hands-on for Codex and Pi as a gate (Fable 10) | **Fixed.** |
| A pending approval for A never releases a running B (Sol Q3) | **Fixed.** |
| Codex's native error path (Opus 11) | **Moot.** |
| The doc's file path (Opus) | **Fixed.** |

### Not taken in round 1

| Finding | Why not |
|---|---|
| Codex: native `turn/steer` first (Fable Q2) | Two of three reviewers and the user chose the hold. Fable's conditions are kept as the gate for the later native change (§2.5). |
| A provider-side mechanism that cannot interrupt a newly started tool, for every provider now (Sol 1) | Not available for every provider. Revision 3 answers this with the best-effort label and strict release (§9). |
| Keep the CLI `/steer-now` (Opus 10) | Trimmed on instruction. It can be added later on the same command. |
| Bring the Codex PR in once S2 is written up (Fable 10) | Moot: Codex no longer depends on S2. |

## 9. Council round 2 responses

Verdicts: Sol, Opus and Fable each requested changes, targeted rather than a redesign. Revision 4 adjusts some of these answers (the Pi settlement, the `turn_end` cut and the S4 rule); see §10.

### Majors

| Finding | Response |
|---|---|
| **Pi generation rule drops ownership evidence** (Sol 2, Opus 1) | **Fixed** (§3.2): <ul><li>The generation now voids only lane effects: late `prompt`/`abort` responses, starting a continuation, settling a newer run.</li><li>Native-steer responses and user `message_start` events are applied whatever the generation, until the aborted run's settlement. Only then can a `queued` entry move to `cutHeld`.</li><li>Pi's events are untagged, so the aborted run's settlement is told apart by stream order: `runSeq` counts `agent_end`s, and the cut records the open run. Responses are matched by RPC id.</li><li>S3 item 12 checks the bracketing.</li><li>Tests: A's OK and `message_start` arriving after B raised the generation; A already `queued`; an old settlement during a later cut.</li></ul> |
| **A person's steer released at Pi's `turn_end` can wait a whole reply** (Fable 3) | **Fixed** (§3.2): <ul><li>Rule: an assistant `message_start` while a person's entry is still `queued` starts the cut for it.</li><li>S3 item 11 measures how often the release misses.</li><li>A lifecycle test covers it.</li></ul> |
| **The acceptance point saves before the text** (Fable 1, Opus 8) | **Fixed** (§2.6): <ul><li>`sink.steerAccepted(text, token)` is the single acceptance step: text and ids in one `persist`, then that token's rows are dropped.</li><li>`steerTaken` is only an in-memory note.</li><li>A kill between the two brings the steer back once (test).</li><li>Carried inbox rows keep their drain-time ownership mark, so rule 4 cannot redeliver them during an outstanding drain (this reverses revision 2).</li></ul> |
| **`peekSteer` misses disk-only, remote and Send now inputs** (Fable 2, Sol 3, Opus 4) | **Fixed** (§2.2, "What the peek reads"): <ul><li>The peek refreshes the queue from disk and applies the drain's scan and question rule.</li><li>Remote turns get a non-taking `externalPeekSteer`.</li><li>The peek reads `steerNow` and pending `steer_now` journal entries, including during Pi compaction.</li><li>A force is consumed only for the matching run, generation and still-held items.</li><li>The cross-process test keeps the tool running forever and asserts the cut before any result.</li></ul> |
| **The `steerNow` field has no run and is never cleared** (Opus 2) | **Fixed** (§2.9): <ul><li>The field carries `runId` and is honoured only for that run.</li><li>Every path that leaves `steering` strips it: `demoteSteerItems`, `dropSteerItems`, the `steer-followup` enqueue and the pause follow-up.</li><li>Test: Send now, Stop, re-steer into a new run; nothing is forced.</li></ul> |
| **Send now's "one transaction" spans two stores** (Sol 4) | **Fixed** (§2.9): <ul><li>A `steer_now` intent commits with the receipt and events in the run database (`queue_commands`, new op), and is applied idempotently to `queue.json` under the queue lock, following `queueJournal.ts`.</li><li>Recovery: the next queue change, boot repair, or the owner's held poll.</li><li>The outcome is `steer.now_applied` or `steer.now_stale`, as thread events the window shows.</li><li>Tests: a crash before the file write, and one after it but before the `applied` mark; a stale request recovered after its run ended.</li></ul> |
| **The settle window does not meet the never-kill request** (Sol 1) | **Addressed as the user directed** (§2.3): <ul><li>The doc is written as a best-effort guarantee, labelled plainly in the summary and §2.3.1, and round-1 Sol 1 is no longer called fixed (§8).</li><li>Strict release is a documented per-instance option: Codex, ACP agents and Cursor hold until the provider's turn ends, or Send now (§2.3.2). Either default ships without a redesign.</li><li>"Model output" means text or reasoning of a new model response; tool output never counts.</li><li>Any tool event restarts the window.</li><li>S4 has a pass rule.</li><li>The residual table adds a command already running whose start notification has not arrived, and text between two commands.</li><li>Deterministic tests cover text between consecutive tools and a delayed start notification.</li><li>The choice of default is open question 1.</li></ul> |

### Minors

| Finding | Response |
|---|---|
| A subagent that cannot be moved loops (Fable 4) | **Fixed.** A `notMovable` tool-event patch makes `foregroundTools` count it; test (§2.4, §2.12). |
| The wait line during the window (Fable 5) | **Fixed.** It keeps the last tool's name (§2.9). |
| S4 pass rule (Fable 6, Opus 7) | **Fixed** (§6). Rule: twice the largest measured gap, plus 100 ms, capped at 1 s. A provider over the cap stays `none` or ships strict. Opus proposed twice the p99; the largest is used because it is the stricter of the two at the sample size required. |
| When the hold generation rises (Opus 5) | **Fixed** (§0, §2.9): it rises when the held item set changes, not when the waited-for tool changes or a hand-back resumes the hold. A stale click returns the button to "Send now". |
| ACP agents and Cursor are tokenless and accept before the cancel (Opus 3, Fable 1) | **Fixed** (§2.7): <ul><li>PR 3 moves them to `peekSteer`, `drainSteerEntry({ expect: 'cut' })` and `returnSteer`, with acceptance after the re-prompt is accepted.</li><li>They stay `none` until then.</li><li>Their hand-back limits after the cancel are stated.</li><li>§2.6 names the tokenless path's users.</li></ul> |
| `'next'` vs `'now'` (Opus 6, Fable Q2, Sol Q2) | **Fixed** (§2.4): <ul><li>`'next'` is never pushed at release.</li><li>It may be used only during a hold, as a later change.</li><li>Only if S1 proves a read signal, what Stop, an interrupt and a crash do with an unread message, and a Send now that does not send twice.</li><li>After release: `now` with `mayCut`.</li></ul> |
| "Root Bash and a child Bash" wording (Sol) | **Fixed:** "the subagent's child Bash" (§2.12). |
| The tokenless path with several outstanding drains (Sol) | **Fixed** (§2.6): no adapter on the contract may use it. |
| A window that never receives `heldSteer` (Fable Q3) | **Fixed** (§2.9): no button there, so no caller. A cross-process click about an entry with no queue item is recorded `stale` at once (Opus Q3). |
| Send now during Pi compaction (Sol 3) | **Fixed** (§3.1): the request is read during the compaction and forces the cut when it ends. |

### Not taken in round 2

| Finding | Why not |
|---|---|
| Release needs a provider handshake, or no early release at all, for the never-kill request (Sol 1, strict reading) | Not as the default yet. The user has not chosen between best effort and strict, so the doc ships both: best effort as the written default, labelled as such, and strict as a per-instance option that implements Sol's rule (no early release on `start` providers). The default is open question 1. |
| `STEER_SETTLE_MS` from twice the p99 (Opus 7) | Replaced by twice the largest measured gap. It is stricter at the sample size required, and it is easier to state as a pass rule. |
| Refuse cross-process Send now until the read path exists (Sol Q3 alternative) | Not needed: the held poll now reads the field and the journal (§2.2, §2.9). |
| Let the owner read the database control directly, instead of the queue field (Sol 4 alternative) | The queue-journal pattern was chosen. It is the existing pattern for durable queue changes, and the owner already refreshes the queue file on every poll. The owner reads pending journal entries only as a recovery path. |

## 10. Council round 3 responses

Verdicts: Opus and Fable approved. Sol requested changes on one Pi race. The minors below came with the approvals and are folded in.

### Major

| Finding | Response |
|---|---|
| **Pi's `turn_end` cut is triggered by an event, so it can miss** (Sol). The round-2 rule fired on an assistant `message_start` while a person's entry was `queued`. If the assistant start arrives before the native `steer`'s OK (the entry is still `sending`), or both arrive in one stdout chunk, no later event fires and the steer waits a whole reply. | **Fixed** (§3.2, "Release at `turn_end`"): <ul><li>The trigger is a **condition**: while an assistant reply that started after the native send is open, and a person's entry from that send is `sending` or `queued`, the cut runs.</li><li>It is evaluated at the assistant `message_start` (which records `replyStartedSince` on each unread entry) and again when the native send's response is applied in the lane, after any consumption evidence that came first.</li><li>Pi's RPC client dispatches a chunk's events before it resolves the response (`rpcClient.ts:77-84`, `:196-205`), so the one-chunk case is ordered.</li><li>A cut for a `sending` entry starts at once; step 2.1 waits for the OK, and stops with no abort if Pi read the steer meanwhile. A user `message_start` can now take a `sending` entry (ownership table, matching).</li><li>Tests (§3.4): **(a)** the assistant start before the OK with a reply that never ends; **(b)** both in one chunk, in either order; a `sending` entry taken before its OK; a tool announced while the cut waits (`mayCut` false).</li><li>§3.1 states the same condition.</li></ul> |

### Minors

| Finding | Response |
|---|---|
| The Pi cut's settlement is attributed by counting `agent_end`, which a retry emits several times | **Fixed** (§3.2): the settlement barrier is the first `agent_settled` after the `abort` request; `runSeq` is gone. The lane starts a cut only after the previous cut's barrier, so no other prompt can settle in between. S3 item 12 now asks about retries and an abort during backoff (§3.3). Test: several `agent_end` before one `agent_settled` (§3.4). |
| The wait for the barrier has no deadline | **Fixed** (§3.2, steps 2.4–2.5 and Give-back): one `INTERRUPT_DEADLINE_MS` covers the abort and the barrier; missing it gives the steers back. Test (§3.4). |
| S4 measures the gap at the provider, which hides notification lag | **Fixed** (§6): gap (a) is measured at arrival in Mousse's adapter; (b) is a check on (a). The rule reads: `STEER_SETTLE_MS` = 2 × G + 100 ms; over 1 s, the adapter does not ship best effort (it stays `none` or ships strict), rather than being capped. |
| "Sending…" can stick when the hold is cleared without a `steer.now_*` event | **Fixed** (§2.9, §2.10): the button also leaves "Sending…" when `heldSteer` clears or its `holdGeneration` changes. Renderer test (§2.12). |
| When the hold generation resets is not stated | **Fixed** (§0): it is per run and only rises, including across a Codex `turn/start` inside the same run. |
| Send now's binding ignores items with no `steerRunId` | **Fixed** (§2.9, Apply): such an item counts when the click's run is the thread's active run. Test (§2.12). A journal entry that reaches `failed` now also appends `steer.now_stale` (§2.9, test in §2.12). |
| Strict mode reads as if it held every steer | **Fixed** (§2.2, §2.3.2): the window follows tool events the same way in both modes; strict only keeps an **already held** steer held until the boundary. A steer arriving after the window closed cuts in both modes. Test in `commandPolicy.test.ts` (§2.12). |
| A missing `externalPeekSteer` is ambiguous | **Fixed** (§2.2, "What the peek reads"): the whole turn falls back to `steerBoundary: 'none'`. |
| ACP agents and Cursor have no strict-boundary drain | **Fixed** (§2.7): at the provider turn's end the adapter reports `boundary()` and drains with `expect: 'native'`; the steer goes in as the next prompt or run with no cancel. One strict-boundary test per adapter. |

Also in revision 4, for consistency: the ownership table, §3.1 and the `turn_end` test now use the barrier and the condition wording, and §9 points here.

### Not taken in round 3

None.
