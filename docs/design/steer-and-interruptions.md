# Steer waits for commands, Pi cuts in, and cut-off turns are marked

Status: design, revision 2, after council round 1 (responses in §8). Nothing here is built yet. Code references are checked against `master` at `6d846d9ec`. The orchestrator is `src/mms/orchestrator/OrchestratorService.ts`; "`OS.ts:N`" below means that file.

## Summary

Three related changes to how a running turn takes a person's message:

1. **A steer waits for a running command.** While the model writes or thinks, Steer still cuts in at once (#873). While a foreground tool of the turn's own agent is announced or running (Bash, an edit, an MCP call), the steer is held until the tool's result is recorded, then goes in. Background shells, subagents and everything a subagent runs are never waited on. The Steer block says what it waits for ("Waits for Bash") and offers **Send now**, which stops the tool and delivers at once. There is no automatic timeout. §2.3 states exactly what is guaranteed: Mousse never sends a cut while it knows of a foreground tool, and it checks again at the moment it sends; a tool the provider starts inside the remaining delivery window, which the spikes measure, can still be cut.
2. **Pi cuts in like the others.** Today a Pi steer is read only at Pi's next step, so a long reply runs to its end first. Pi will abort the reply, keep what it wrote and the results of finished tools, and continue the same turn with the steer, taken once. During a tool, Pi waits as in item 1. This also fixes #368 (a steer at Pi's last step is lost).
3. **A mark on cut-off turns.** A turn that a Stop, a restart or a crash ended gets a short muted word in its header ("Stopped", "Interrupted"). A steer's cut and Send now do not count.

**Delivery guarantee, worded exactly.** Every steer is either read by the model or comes back to the thread as a message of its own; none is lost. A steer reaches the model at most once, with one exception that exists today (#881): when the daemon dies after a provider that keeps its own session (Claude Code, Codex) received a steer and before Mousse recorded that it was taken, the steer runs again after the restart, so that model can read it twice.

## 0. Terms

- **Own call:** a tool call of the turn's own agent: no `parentCallId`, or a parent chain that never reaches a subagent call or a background call.
- **Foreground tool:** an own call that is announced or running, whose result the turn waits for. Not foreground: a call waiting for an approval or a question; a background call (`activity.background`); a subagent call (Claude's `Task`/`Agent`, Codex's `collabAgentToolCall`, Mousse's `delegate_task`); a wait-only tool (`WAIT_TOOL_NAMES`, `src/mms/run/transcript/TranscriptAssembler.ts:71`); and any call whose parent chain reaches one of these.
- **Announced:** the provider has said a tool call is coming, before it runs. Claude Code sends `content_block_start` for a `tool_use` while the model still writes the call's input (`turnFrames.ts:157`). Pi sends the call inside the assistant message that ends before `tool_execution_start`. Codex, ACP agents and Cursor say nothing until the tool starts.
- **Writing:** the model streams text or thinking, or a request is in flight and no foreground tool is announced or running (the #874 steps `waiting`, `reasoning` and `retrying`, and the phases `thinking` and `streaming`).
- **Held steer:** a steer the orchestrator accepted (its Steer block shows) and has not handed to the provider, because a foreground tool is announced or running.
- **Cut:** the provider's current reply is ended so the turn can go on with the steer (#873).
- **Hold generation:** a number the turn raises each time a new hold begins, so a Send now click names the hold it was shown for.

## 1. Today

### 1.1 How a steer reaches a turn

- A steer is a queue item promoted to `steering` (`promoteQueueItem`, `OS.ts:7900-7979`; `deliverPromotedItem`, `:8148`), or a composer steer made into such an item. It shows at once as a Steer block in the running reply (`steer-group.tsx`, grouped by `metadata.steered` in `groupMessagesIntoTurns`, `message-list.tsx:737-774`).
- The turn reads it through `TurnControl.drainSteerEntry` (`src/mms/harness/adapter.ts:226-245`), built in `executeTurn` (`OS.ts:11470-11513`). Each drain has a token. The provider calls `steerTaken(token)` when it has the text, or `returnSteer(text, token)` when it cannot use it, which puts the entries back in front of newer steers.
- `drainEntry` sets `cut` when any entry is a person's message (`OS.ts:11487-11490`).
- **Acceptance is not per token today.** `steerTaken(token)` only deletes the token from an in-memory map (`OS.ts:11495`). `sink.steerAccepted(text)` saves every id in `session.drainedExternalSteerIds` as accepted (`OS.ts:11454-11463`), and `acknowledgeDrainedSteers` drops all of their queue rows (`OS.ts:12035-12054`). The `nativeMessages` path does the same (`OS.ts:11400-11412`). Carried inbox rows are marked taken at drain time (`drainSteerForSession`, `OS.ts:11974`), not when the provider takes them. With two drains outstanding (Claude can drain A, wait up to 5 s to move subagents, and drain B in the next poll), accepting A also acknowledges B, and a crash before B is read loses B.
- Unread steers: a Stop hands them back to the front of the queue (`returnUnreadSteerItems`, `OS.ts:8058`); a turn that ends makes them a `steer-followup` turn (SPEC §14.7); a restart puts a steer the provider never accepted first in the queue (`returnOrphanedSteers`, `OS.ts:12520`, #881).
- `drainSteerForSession` already holds some steers back: an agent's steer waits while a question is open (`OS.ts:11962-11968`). The new hold is the same kind of rule.

### 1.2 Per provider

| Provider | `steer` capability | A person's steer now | A running command |
|---|---|---|---|
| Claude Code (live session) | `interrupt_restart` (`drivers/claudeCode/adapter.ts:45`) | Polled every 100 ms (`ClaudeSubscriptionProviderService.ts:2613-2623`). `LiveSession.steer` (`liveSession.ts:763-809`) calls `backgroundTasks()` with no argument, waits up to 5 s, then pushes the text with `priority: 'now'`. | Ends. #874's check saw a 40 s command end at the steer. The SDK (0.3.291) says the no-argument `backgroundTasks()` moves Bash to the background too, so whether it was killed or moved is spike S1's question. |
| Claude Code (no live session) | same | Pushes the text and calls `query.interrupt()`, then resumes the session with it (`:2463-2469`, `:2780-2794`). | Ends. |
| Codex | `native` (`drivers/codex/adapter.ts:77-95`) | Cut: `turn/interrupt`, then the next `turn/start` carries it (`CodexProviderService.ts:2933-2967`); taken only once that `turn/start` is accepted (`cutHeld`, `cutStarting`, `handBack`, `:2939-2943`, `:3036-3039`). Other steers use `turn/steer` (`:2918-2932`). | Ends by the interrupt. |
| Pi (RPC engine, every `pi:*` instance) | `native` (`drivers/pi/engines/rpc.ts:34-50`) | Drained only at Pi's `turn_end` and sent as RPC `steer`, not awaited (`pi/engine.ts:1923-1936`). Taken when a user `message_start` whose text *includes* the steer arrives (`:1943-1951`). `cut` is ignored. | Not ended: tools are over by `turn_end`. |
| ACP agents (generic, Antigravity, Grok) | `interrupt_restart` (`acp/capabilities.ts:11-21`) | `session/cancel` at once, then a new prompt "Additional guidance: …" (`acp/session.ts:788-852`). | Ends, if the agent's cancel stops it. |
| Cursor | `interrupt_restart` (`drivers/cursor/adapter.ts:12-24`) | `active.cancel()`, then a new run with the guidance (`cursor/session.ts:524-556`). | Ends. |

## 2. Item 1: a steer waits for a running command

### 2.1 Behaviour

| The turn is | A person's steer | An agent's steer or a subagent notice |
|---|---|---|
| Writing or thinking | Cut now (#873). | As today: native on a `native` provider; on Claude, pushed `now`. |
| At a step boundary the provider reports (Pi's `turn_end`) | Sent natively; nothing to cut. | Native, as today. |
| A foreground tool is announced or running | **Held** until every foreground tool has its result and the release rule (§2.3) holds. | Held on an `interrupt_restart` provider. On a `native` provider: native, as today (it waits for the tool by itself). |
| Only background work runs (background calls, subagents and their own calls, wait-only tools) | Cut now. A foreground subagent is first moved to the background where the provider can do that (§2.4). | As today. |
| A call waits for an approval or a question, and no other foreground tool runs | Cut now. The steer answers it as the person, as today (`autoRejectPendingForThread`, #873). | Waits, and never answers it (existing rule, `OS.ts:11962-11968`). |
| Pi compacts its context | Held ("Waits for compaction"). A steer never stops a compaction. | Held. |
| Set up, stopping, ending or paused | Unchanged (`steerWhenStarted`, `sendNowAfterTurn`, `sendNowIdle`, `steer-late`). | Unchanged. |

- **Send now** on a held steer stops the running tool and delivers at once (a cut).
- **No automatic timeout.** A long build keeps running; the person decides.
- **Several steers** sent while one is held join it: one Steer block, one wait line, one input (the drain joins them, `OS.ts:11490`).
- A long tool input being written (a big Write) counts as announced on Claude: the block reads "Waits for Write" until the call has run and its result is in.
- The rules apply to a remote turn's steers (`externalDrainSteer`, `OS.ts:11477`) and to steers from the CLI, Bridge and `thread_steer`.

### 2.2 Where the decision lives

The orchestrator decides, once, from stored and reported state. Adapters report tool calls, report boundaries, and check again before they send a cut. No provider name appears in run or orchestrator code (SPEC invariant 8).

**The policy** (`src/mms/run/CommandPolicy.ts`, pure):

```ts
export type SteerDelivery = 'cut' | 'native' | 'hold'
export function steerDelivery(
  caps: ProviderCapabilities,
  turn: { foreground: number; settling: boolean; atBoundary: boolean; forced: boolean },
  steer: { person: boolean }
): SteerDelivery
```

| | `forced` (Send now) | `foreground > 0` or `settling` | `atBoundary` | otherwise (writing) |
|---|---|---|---|---|
| person, `steerBoundary` not `none` | `cut` | `hold` | `native` | `cut` |
| agent or notice, `steer: 'native'` | (never forced) | `native` | `native` | `native` |
| agent or notice, `steer: 'interrupt_restart'` | (never forced) | `hold` | `native` | `cut` (as today) |
| any, `steerBoundary: 'none'` | today's behaviour (`cut` for a person, else the capability) | | | |

- `steer.person` is known from the pending entries without taking them (the peek below), so the decision is made before any drain.
- `hold` takes nothing: the entries stay in `turn.pendingSteer` and the queue (`steering`).
- `native` means "deliver with the provider's own steer". On Pi it happens only at the boundary; on Codex for agents' steers it is today's `turn/steer`.
- A drain mixing a person's and an agent's steer is decided as a person's.

**A new capability, `steerBoundary`** (`ProviderCapabilities`, read by `steerDelivery`): when the adapter reports a tool call. `announce` (Claude Code, Pi): before it runs. `start` (Codex, ACP agents, Cursor): when it starts. `none`: the adapter has not adopted the contract, and the provider keeps today's behaviour. This is also the per-provider rollback (§6): setting an adapter back to `none` restores today's behaviour for that provider, which can cut commands, and the guarantee is then not claimed for it.

**`TurnControl` additions** (`src/mms/harness/adapter.ts:226`):

```ts
/** What a drain now would do, without taking anything. undefined: nothing pending. */
peekSteer?(): { delivery: SteerDelivery; holdGeneration?: number } | undefined
/** drainSteerEntry, but takes only when the current decision is `expect`; otherwise takes nothing. */
drainSteerEntry?(opts?: { expect?: SteerDelivery | SteerDelivery[] }): { text: string; token: string; cut?: boolean } | undefined
/** The check at dispatch, called right before the adapter sends a cut for `token`. false: hand the drain back and wait. */
mayCut?(token: string): boolean
```

- `peekSteer` is the non-taking read: Pi's poll uses it to follow the table (§3.2), and every adapter uses it to stay idle while a steer is held.
- `mayCut(token)` returns true when the drain is forced, or when the orchestrator knows of no foreground tool and is not settling. When it returns false, the adapter calls `returnSteer(text, token)` and the hold resumes.
- `drainSteerEntry()` with no options keeps its meaning for adapters that have not adopted the contract (`steerBoundary: 'none'`).

**Counting foreground tools.** The transcript assembler already tracks the turn's running calls (`activeToolCallMessageIds`, used by `isBlockedOnWait`, `TranscriptAssembler.ts:611-626`), and stores each call's parent (`activity.parentId`, from `parentCallId`, `:397-404`). A new `foregroundTools(): Array<{ callId; toolName; detail? }>` returns the open **own** calls (§0) that are not excluded. It walks each call's parent chain, so a Bash that a subagent runs never counts, whether the subagent is in the foreground or was moved to the background. A call whose parent chain cannot be resolved (an ACP agent that names no parent) counts as the turn's own: it may hold, never cut.

Every adapter already sends `start` and `complete` tool events with a `callId` (Claude `tool_use`/`tool_result`, `turnFrames.ts:157-207`; Codex `item/started`/`item/completed`; Pi `tool_execution_start`/`end`; ACP `tool_call`/`tool_call_update`; Cursor `tool-call-started`/`completed`). For the hold, three more facts are reported:
- Claude: the call's `start` is sent at `content_block_start`, before the call runs (it already is).
- Pi: an assistant message that ends with tool calls opens those calls as announced (a `start` with `announced: true`) before `tool_execution_start`.
- Pi: `turn_end` reports a boundary (`TurnSink.boundary()`, new), which sets `atBoundary` until the next model output.

**The hold's state.** While `pendingSteer` holds entries that `steerDelivery` holds, the orchestrator sets `TurnState.heldSteer` (§2.8). When they are drained, handed back or the turn ends, it clears it. It lives in memory, like `step`.

### 2.3 Safe release and the guarantee

The decision and the cut are separate steps: the adapter sends the cut after the drain, sometimes after an await (Claude waits up to 5 s per subagent background move, `liveSession.ts:769-779`; Codex queues the cut behind its `steering` chain, `CodexProviderService.ts:2955-2965`). A tool can start in between. So the contract has three parts.

1. **The hold starts at the announcement**, where the provider gives one (`steerBoundary: 'announce'`): a Claude `tool_use` block streaming, or a Pi assistant message ending with tool calls.
2. **Release needs evidence for `start` providers.** For Codex, ACP agents and Cursor, a count of zero after a tool's result does not show that no other tool is about to start: two commands from one model response start one after the other. So the hold stays (`settling`) after the last result until either the provider sends model output (a text or thinking delta) after that result, or `STEER_SETTLE_MS` passes with no new tool start. The first value is 500 ms; spike S4 sets it from measurement.
3. **The check at dispatch.** Every adapter calls `mayCut(token)` as the last step before the provider's cut request:
   - Claude: inside `LiveSession.steer`, after the background moves and `afterCancel()`, just before `push` (`liveSession.ts:782-793`);
   - Codex: inside `cut()`'s `steering` step, before `turn/interrupt` (`CodexProviderService.ts:2957-2964`);
   - Pi: before `abort` (§3.2);
   - ACP agents and Cursor: before `session/cancel` / `active.cancel()`.

   If it returns false, the adapter hands the drain back. The orchestrator learns of a new tool through the same tool events, so a tool that started during the 5 s background move is seen here.

**What is guaranteed.** Mousse never sends a cut while it knows of a foreground tool that is announced, running or, on a `start` provider, may follow within the settle window. What remains is a tool the provider starts after Mousse's last look and before the cut request reaches the provider:

| Provider | What remains | How it closes |
|---|---|---|
| Claude Code | A `tool_use` whose `content_block_start` is still in the pipe when `now` is pushed. Claude Code runs a call only after its input is complete, so this needs a call with a tiny input announced within the pipe latency. S1 measures it. | If S1 shows `priority: 'next'` is read at the next tool-result boundary and cancels nothing, the release after a tool uses `'next'` while no model output has been seen since the result (§2.4). |
| Codex | A command that starts after the settle window and before `turn/interrupt` lands. S4 measures it. | Native `turn/steer`, which Codex reads after the command, as a later change gated on S2 (§2.5). |
| ACP agents, Cursor | As Codex. | None in this design; the providers have no tool-safe steer. |
| Pi | A tool whose call arrives in a `message_end` that crosses the `abort` request. Pi checks its abort signal before it runs a tool, so the tool is refused at its start rather than ended while running. S3 confirms. | Native `steer` at the boundary, which this design already uses. |

Send now and Stop end tools by design; this guarantee is about steers only.

### 2.4 Claude Code

- **Hold:** `steerBoundary: 'announce'`. Nothing drains while a foreground `tool_use` is open. `collectSteer` (`ClaudeSubscriptionProviderService.ts:2440`) asks `peekSteer()` and drains with `expect: 'cut'` only.
- **Release:** when the `tool_result` frame arrives (`turnFrames.ts:207`), the call completes; the next poll drains with `cut: true`. `LiveSession.steer` does the background moves, waits for `afterCancel()`, calls `mayCut(token)`, and only then pushes `priority: 'now'`. Claude Code has the tool's result in its conversation by then, so the cut only ends the request that follows.
- **Background moves change.** `LiveSession.steer` stops calling `backgroundTasks()` with no argument, which the SDK says also moves a foreground Bash. It calls `backgroundTasks(toolUseId)` once for each foreground subagent call still open. When it throws (background tasks are disabled for the session) or returns false, that subagent counts as a foreground tool and the steer is handed back and held: a subagent is then waited on rather than ended. The 5 s wait (`STEER_BACKGROUND_MOVE_MS`) stays.
- **Send now:** drains forced and pushes `now` with no background move. If S1 shows that `now` only moves the Bash to the background (a `detachedToolCall` or "running in the background" result), Send now then calls `stopTask(taskId)` (SDK 0.3.291 `Query.stopTask`) for that task, with the task id from the result (`claudeActivity.ts:381`). The command is stopped either way; the button's words do not change.
- **No live session:** the same hold through `drainEntry`; `mayCut` before `query.interrupt()`.

**Spike S1** (hands-on, the real Claude Code CLI against a local fake Messages server, fake key, isolated home, no sign-in), in this order:
1. `priority: 'next'`: pushed while a foreground Bash runs, is it read right after that call's result, in the same turn, with nothing cancelled? Pushed while the model writes text with no tool, is it read before the turn ends or only after (as a new turn)? Does Claude echo the pushed id when it reads it (`push` returns the id, `liveSession.ts:741-756`), so it can serve as the read signal?
2. `priority: 'now'` during a foreground Bash, with and without the no-argument `backgroundTasks()` before it: killed, or moved to the background?
3. `now` with two foreground tools running in parallel.
4. Consecutive tools: two Bash calls from one response; a steer released between them.
5. A delayed announcement: a `tool_use` with a one-word input, steered at the moment the previous result lands; measure the gap between `content_block_start` reaching Mousse and the call starting.
6. A tool that starts while `backgroundTasks(id)` is awaited.
7. `detachedToolCall`: what `now` does to a running WebFetch or WebSearch (the SDK says they step aside; `claudeActivity.ts:369-374` shows that row as interrupted).
8. `backgroundTasks(id)` when background tasks are disabled.

Adoption rule for `'next'`: if item 1 shows it is read at the next tool boundary, cancels nothing and is echoed by id, the release after a tool pushes `'next'` while no model output has been seen since the result, and `now` otherwise. If not, `now` with `mayCut` as above.

### 2.5 Codex: the hold from the start

- **Mechanism:** `steerBoundary: 'start'`. A person's steer is held while a command, MCP call or web search runs and while settling. Then the existing #873 cut runs: `mayCut`, `turn/interrupt`, and the next `turn/start` carries the text, taken only when that start is accepted (`cutHeld`, `cutStarting`, `handBack`). The command's output is already in Codex's history by then.
- **Send now:** a forced drain goes through the same cut while the command runs, so `turn/interrupt` ends it. No new state.
- **Agents' steers and notices** keep today's `turn/steer` path. That path is unchanged here; its acceptance moves to the token rule in §2.6.
- **Cost:** one `turn/interrupt` and `turn/start` round trip after the command, and the start of the model's next request is wasted.
- **Later change, gated on S2:** native `turn/steer` for a person's steer during a command. It can only replace the hold once S2 shows all of these:
  1. an event that proves Codex read the steered text;
  2. what Stop, a failed turn, `turn/interrupt` and a thread resumed after a daemon kill do with a steer Codex accepted and has not read;
  3. a way for Send now to reach a steer already sent (an adapter control bound to the hold generation and item ids, §2.8);
  4. acceptance per token (§2.6).

### 2.6 Acceptance per token (a prerequisite)

Before any hold, a steer is accepted per drain, so taking one drain never acknowledges another:

- Each entry in `drained` (`OS.ts:11472`) keeps the item ids and the carried inbox rows of that drain.
- `steerTaken(token)` becomes the acceptance point. In one step it saves those item ids in `nativeContext.acceptedSteerItemIds`, drops those queue rows (`dropSteerItems` with those ids only), and marks those inbox rows taken (`inbox.markSteerTaken`, moved here from drain time).
- `sink.steerAccepted(text, token)` appends the transcript text and sets the `waiting` step; it no longer saves or acknowledges anything by itself. A runtime that reports acceptance without a token (`nativeMessages`) keeps today's blanket rule, which is only correct with one drain outstanding; adapters that adopt the contract pass tokens.
- `returnSteer(text, token)` unmarks only that token's inbox rows (as today).
- Tests: A and B drained separately; A taken; then Stop, a failed continuation, a provider crash and a daemon restart each leave B unread and bring it back once.

This change alters no behaviour on its own and lands first (§6).

### 2.7 ACP agents and Cursor

- `steerBoundary: 'start'`; held while a tool runs and while settling; then `mayCut` and the existing cancel and re-prompt. Send now cancels at once, as today.
- ACP events are sparse: an agent that never sends `completed` for a call keeps the steer held until the turn ends (it then runs as a follow-up turn) or Send now. The hold never outlives the turn.
- Only Grok marks subagent calls ("subagent: …", `acp/session.ts:684`); other ACP calls count as foreground.

### 2.8 Exactly once across every end

A held steer has not been drained, so it is an unread steer, and every existing path already handles it. With §2.6, a drained steer is accepted only by its own token.

| Event | Held (not drained) | Drained, not taken | Taken |
|---|---|---|---|
| **Stop** | `returnUnreadSteerItems` puts it first in the queue, shown there; its Steer block copy is hidden (`withdrawSteerEchoes`). Nothing runs it until the person sends again (#873). | The provider hands it back (`returnSteer` / `handBack`); then as held. | Kept. |
| **Turn ends** (the tool's result ended it, or the provider failed) | Becomes a `steer-followup` turn, shown once as its prompt (SPEC §14.7). | Handed back, then as held. | Kept. |
| **Usage-limit pause** | Unread: queued as a follow-up behind the pause (SPEC §16.4). | Handed back, then as held. | Kept. |
| **Restart (#881)** | `steering` on disk, not accepted: `returnOrphanedSteers` puts it first; the startup drain runs it once, after the cut-off turn. | Same. A provider that resumes its own session may have it: the documented at-least-once case. | Its id is in `acceptedSteerItemIds`: dropped. |
| **Provider crash** | Turn fails: as "turn ends". | `died` paths hand back (Pi `engine.ts:1862`, Codex `handBack`, Claude `returnSteer`). | Kept. |
| **Double steer** (same item twice) | #845 / #873 id guarantees: a second promotion of an item already pending returns `ok` and does nothing (`OS.ts:7915-7919`). | Same (`drainedExternalSteerIds`). | Same. |
| **Batching** (several steers while held) | All stay pending; one drain takes them, one token. | One token restores them all, in order. | Taken together. |
| **Separate drains** (A, then B) | — | Each token is handed back or taken alone (§2.6). | Only that token's ids are saved. |
| **Send now: stale, double, cross-process** | §2.9. | — | — |
| **A tool starts between drain and cut** | — | `mayCut` is false: handed back, held again. | — |
| **An approval appears while held** | That call waits for a person; if no other foreground tool runs, the steer cuts and answers it as today. A pending approval for A never releases a running B. | — | — |
| **An approval is granted while the steer is on its way** | — | The call becomes running: `mayCut` is false, the steer is held again. | — |
| **A cut ends a foreground `delegate_task` call** | — | — | The call returns at once with the delegation's ids (SPEC §14.2), so a cut rarely meets it. If it does, the delegation is already a stored row: the child keeps running, and its result reaches the parent through the inbox (`child_result`, rule 4: a wake run, or a steer notice once the run ends). A repeated call by the model returns `title_taken` with the existing subagent, so no second child starts. |

### 2.9 Send now: protocol and state

- **`TurnState.heldSteer`** (`src/shared/types.ts:1513`), in memory like `step`:
  ```ts
  heldSteer?: { waitsFor: string; detail?: string; tools: number; since: string; holdGeneration: number; itemIds: string[] }
  ```
  `waitsFor` is the oldest foreground tool's display name (the #874 rule, `turn-progress.tsx:72-77`), or "compaction"; `detail` is its first input line (`inputDetail`, `:79-90`); `itemIds` are the held queue items. It travels in `turn-state` events, the resnapshot (`resnapshotTurnState`) and Bridge snapshots; older clients ignore it.
- **`steer_now`**, a new run-engine control command (SPEC §4):
  ```ts
  { kind: 'steer_now'; threadId; clientRequestId; runId; holdGeneration: number; itemIds: string[] }
  ```
  - It names a run. A run that is not the active run returns `ignored` (`run_not_active`) and appends `command.ignored`.
  - A repeated `clientRequestId` replays its receipt and does nothing (invariant 6).
  - Accepted, it writes in one transaction: the receipt, a `steer.now_requested` event `{ runId, holdGeneration, itemIds }`, an `agent.action`-style audit event (`steered_run`, `{ now: true }`), and on each named queue item that is still `steering` for that run, `steerNow: { holdGeneration, requestId }` (a new optional `QueuedMessage` field, under the queue lock).
  - The process that runs the turn reads the field at its next drain (`drainSteerForSession` refreshes the queue from disk, `OS.ts:11981`), so a turn that another live process runs is reached the same way.
  - That process honours it only when the turn's current hold generation equals `holdGeneration` and the named items are still held. It then forces the hold: the whole held group goes now, in one drain. Otherwise it clears the field and records `steer.now_stale`. The click reached no command, and the window sees the hold line it already shows, or none.
  - A held entry with no queue item (text a provider handed back) is forced through the generation alone, in the owning process.
- **Stale and double clicks:** a click shown for generation g that arrives once that steer went in (and a newer steer is held behind a newer command, generation g+1) matches nothing and stops nothing. A second click with a new `clientRequestId` finds the generation consumed and is a no-op. A second click with the same id replays the receipt.
- **Who may:** the people who may steer the thread (GUI, Bridge peers with the `chat` capability, through `orchestrator.steerNow`). Agents may not: `thread_steer` has no `now`, so an agent never ends another thread's command. There is no CLI command in this design (scope, §8).

### 2.10 UI

The Steer block (`steer-group.tsx`) gets one line while the turn's `heldSteer` names items that the block shows:

```
                                   ↪ Steer · Waits for Bash · Send now
                                   ┌──────────────────────────────┐
                                   │ actually use pnpm, not npm   │
                                   └──────────────────────────────┘
```

- "Waits for Bash" is muted, in the existing `.steer-group-label` style. Tooltip: "Goes in when Bash finishes" and the command (`npm test`). With several tools: "Waits for 2 tools", and the tooltip lists them.
- "Send now" is a quiet text button like `.chat-run-interrupted-action` (no fill, hover background). Tooltip: "Stop Bash and send now". After the click it reads "Sending…" and is disabled until the line clears or a stale result arrives.
- When the steer goes in, the line clears; the reply continues below the block. There is no "Delivered" state.
- No edge bars, no accent fill, no new colour. The button is focusable, with the accessible name "Send steer now, stops Bash". There is no keyboard shortcut.
- A held steer is `steering`, which the queue list already hides (`useThreadQueue.ts:448-452`). The composer's "Steered" notice (`OrchestratorChat.tsx:461-481`) is unchanged.

### 2.11 Fit with #874, #880 and #872

- **#874 progress line:** it keeps "Running Bash…"; the wait shows only on the Steer block, which sits just above the line in the live turn. The line's tooltip adds "Your steer goes in when it finishes." Once the steer is taken, `steerAccepted` sets the `waiting` step as today, which #880 shows as "Thinking…".
- **#880 thinking line:** unaffected while held. A cut during a live thought ends that thought row as written; the next thought is a new row.
- **#872 Done:** a held steer does not end the turn, so the thread stays Working; Done is recorded when the turn ends. No change.

### 2.12 Tests

Each new test must fail on the code before its change.

- `tests/run/commandPolicy.test.ts`: every row of the `steerDelivery` table, including `steerBoundary: 'none'`. `tests/run/capabilityReaders.test.ts`: `steerBoundary` → `steerDelivery`, and `steer` gains `steerDelivery` as a reader.
- `tests/run/transcriptAssembler.test.ts`: `foregroundTools` excludes background, subagent, wait-only and approval-waiting calls. Ownership cases:
  - a foreground Agent with a nested Bash: nothing holds;
  - the same Agent moved to the background: nothing holds;
  - a root Bash and a child Bash together: only the root Bash holds, and the steer goes in when the root Bash ends, while the child Bash runs on;
  - a call whose parent cannot be resolved: holds.
- `tests/run/queueSteerExactlyOnce.test.ts`, with a fake adapter on each `steerBoundary`. These are deterministic interleavings:
  - a steer during a tool is not drained, and is drained after the result and the release rule;
  - two consecutive tools with the steer between them (`start`: held through settling; `announce`: held by the second announcement);
  - a tool that starts between drain and cut: `mayCut` is false and the steer is held again;
  - a delayed start notification (the `start` event arrives after the cut is requested): the documented window, asserted as a cut;
  - a mixed batch (a person's and an agent's steer while a question is open);
  - a pending approval for one call while another runs, and an approval granted while the steer is on its way;
  - Stop while held; the turn ends while held; a usage-limit pause while held;
  - three steers batched;
  - separate drains A and B, A taken, then each kind of end (§2.6);
  - Send now forces a drain;
  - Send now with a stale generation, twice with different ids, and twice with the same id;
  - Send now through the queue-item field from another process.
- `tests/run/restartRecovery.test.ts`: a new kill point while a steer is held. The run ends `interrupted`, and the steer runs once after it.
- `tests/claudeLiveSessions.test.ts`:
  - no push while a `tool_use` is open, from `content_block_start` to its `tool_result`;
  - a push after the result, with `mayCut` checked after the background move;
  - a Bash that starts during the move hands the steer back;
  - `backgroundTasks(id)` is called only for subagent calls, and the no-argument form never;
  - when `backgroundTasks(id)` throws, the steer is held;
  - Send now pushes `now` during the tool, then `stopTask` when the result says it moved to the background.
- `tests/run/codexAdapter.test.ts` with a new fixture `steer-during-command`: `item/started` for a command, the steer held, `item/completed`, settling, `turn/interrupt`, then `turn/start` with the text, taken on its acceptance. Send now during the command interrupts at once.
- A new scenario `tests/run/scenarios/steer-mid-tool/` (SPEC §13.6 lists "steer mid-tool"; only `steer-mid-turn` exists): every adapter keeps the tool's result and reads the steer after it.
- Renderer: `tests/renderer/steerGroupHeld.test.ts` (the line, the tooltip, Send now, "Sending…", the line clearing, a stale result), `tests/renderer/turnProgress.test.ts` (the tooltip sentence), `tests/resnapshotTurnState.test.ts` (`heldSteer` survives a resnapshot).
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
   - two commands in a row from one response;
   - Send now.
3. Pi: a `pi:*` instance pointed at a local mock OpenAI-compatible server: the §3.4 hands-on list.

ACP agents and Cursor are checked by hand only if they can run with no account; otherwise the PR says so.

### 2.13 Risks

- **A tool that never reports its end** (a sparse ACP agent, a lost `complete`) keeps the steer held until the turn ends. Mitigations: Send now; the turn's end turns the steer into a follow-up; the assembler's end-of-turn `unfinished` close clears the count.
- **A long build delays the steer by minutes.** This is by design: the line names what it waits for, and Send now is one click.
- **A misclassified tool** waits rather than being cut (an unmarked subagent, an unresolvable parent, a background shell not marked `background`). The failure is a delay, never a lost command.
- **The residual window** in §2.3 remains until S1 (Claude's `'next'`) and S2 (Codex native) allow tool-safe delivery.
- **The settle window** delays a steer on `start` providers by up to `STEER_SETTLE_MS` after a command when the model sends no output.
- **Run-engine queue ordering:** unchanged. Held steers stay where #873 put them.

## 3. Item 2: Pi cuts in like the others

### 3.1 Behaviour

| Pi is | A person's steer |
|---|---|
| Writing or thinking (an assistant message streams, no tool call announced) | **Cut:** the reply is aborted. The text already shown stays as written, above the Steer block, and finished tool results stay. The same turn goes on with the steer. |
| At `turn_end` (no request yet) | Native `steer`, as today: Pi reads it at the step that starts now. |
| A tool call is announced or runs | Held (§2). Send now: a cut (Pi's abort ends the tool, §3.5). |
| Retrying (`auto_retry_start`) | Cut: the abort also cancels the backoff (`engine.ts:1565`). |
| Compacting (`compaction_start`) | Held until `compaction_end`. |
| After `agent_end` | Unchanged: `steer()` refuses (`engine.ts:1625`) and the text becomes the next turn. |

Agents' steers and subagent notices keep Pi's native next-step path; they never cut.

### 3.2 Mechanism (`src/mms/harness/pi/engine.ts`)

**One lane.** Every control operation of a turn runs through one serialized lane (a promise chain on the turn), and each waits for Pi's response before the next starts: a native `steer`, `clear_queue`, `abort`, the continuation `prompt`, and Stop. Pi's RPC child does not serialize input lines itself (`rpc-mode.js:644-645` in Pi 1.4.0), so the order is enforced here. The `turn_end` native send, which is fire-and-forget today (`:1923-1935`), joins the lane.

**An operation generation.** `turn.opGen` rises on each cut and on Stop. Each lane operation records the generation it started under. A response, an `agent_settled` or a user `message_start` that arrives for an older generation changes nothing: it cannot accept a steer, start a continuation or settle the turn. Stop raises the generation first, so a pending continuation never starts after a Stop.

**Ownership of each steer.** Every entry the engine holds is in exactly one state, and each transition is one event:

| State | Entered by | Left by |
|---|---|---|
| `drained` | `drainSteerEntry` (token kept) | the lane sends it (`sending`), or a Stop or crash hands it back |
| `sending` | native `steer` request sent | Pi's response: OK → `queued`; error → handed back |
| `queued` | Pi accepted the native steer | its user `message_start` → `taken`; `clear_queue` returns it → `cutHeld`; `agent_settled` of an aborted run → `cutHeld` (§step 2.5) |
| `cutHeld` | the cut takes it | the continuation `prompt` is accepted → `taken`; Stop, crash, refused prompt → handed back |
| `taken` | `steerTaken(token)`, `sink.steerAccepted(text, token)` | — |

**Matching by order and token.** Pi delivers queued steers in the order it received them. A user `message_start` is matched to the oldest `queued` entry, by exact text, not `includes` (`:1946` changes). The continuation `prompt` is matched by its lane operation (its response, under its generation), never by the text of a `message_start`, so a queued steer whose text appears inside the prompt is never counted as taken by it. S3 checks whether Pi joins several queued steers into one user message. If it does, the match takes the oldest entries whose joined text equals the message, in order.

**The cut**, for a drain with `cut: true` while Pi is writing:
1. Set `turn.phase = 'cutting'`, raise `opGen`, and hold the drained entry in `cutHeld`. From here no native `steer` is sent; the poll only peeks.
2. On the lane:
   1. wait for any native `steer` already in `sending` to get its response;
   2. `clear_queue`. Each returned text matched to a `queued` entry, in order, moves to `cutHeld` with its token. A returned text that matches no entry is handed back as text (`returnSteer(text)`), as Stop does (`:1559-1563`), so nothing in Pi's queue is dropped;
   3. `mayCut(token)`. If false (a tool call was announced meanwhile), skip the abort, return to `running`, and hand the cut entries back (the hold resumes);
   4. `abort`, with deadline `INTERRUPT_DEADLINE_MS`;
   5. on `agent_settled` for this generation, any entry still `queued` (Pi took it from its queue and never showed it) moves to `cutHeld`. Every entry is now `taken` or `cutHeld`; nothing is left in between;
   6. `prompt` with the `cutHeld` texts joined in order, in the same process and session.
3. The aborted message's text stays as written: the aborted `message_end` (skipped today, `:1977`) closes the current text segment (`streams.text.break()`), the split Codex makes (`drivers/codex/adapter.ts:196-202`).
4. When the `prompt` response for this generation is OK, every `cutHeld` entry becomes `taken` (`steerTaken(token)`, then `sink.steerAccepted(text, token)`), the phase goes back to `running`, and `awaitingModel = true`.
5. **Give-back:** a Stop (`stopTurnOnce`, `:1540-1574`), a crash (`died`, `:1862`), a refused or failed `prompt`, or an `abort` that misses its deadline hands every `cutHeld` entry back with `returnSteer(text, token)`, once each (`cutHeld.splice(0)`). A Stop during the cut wins: the steer is back first in the queue.

**#368: the turn's end.** At the final `agent_end`, before the engine lets `agent_settled` settle the turn (`:2081-2088`), the lane waits for any native `steer` in `sending`, sends `clear_queue`, and hands back each `queued` entry, so it runs once as the next turn and Pi's queue holds nothing. Only then does the turn settle.

### 3.3 Spike S3 (before code: the stub Pi child and the real Pi 1.4.0 child against a local mock model)

1. After `abort` in the middle of a message, does Pi's session keep the partial assistant message, nothing, or the whole message? Mousse's transcript keeps what was shown either way. If Pi drops it, the model does not see its own cut-off words, as with Claude Code.
2. Does `prompt` after `abort` continue the same session with its full history (expected: `thread.warm` stays set, `:1477-1480`)?
3. Does `clear_queue` return steers that are queued and unread, in order? What does it return for a steer whose `steer` request has not been answered yet?
4. A native steer paused before Pi queues it, then `clear_queue`: which comes first?
5. A steer Pi took from its queue whose user `message_start` Mousse has not read when `clear_queue` answers.
6. `agent_settled` arriving before the `clear_queue` response.
7. Stop while the continuation `prompt` is being checked.
8. An abort after an assistant message with tool calls and before `tool_execution_start`. Does the next `prompt` work, given an assistant tool call with no result (some model APIs refuse it), and is the tool refused at its start?
9. Does Pi join several queued steers into one user message?
10. While a tool runs, does a native `steer` wait for it, and does it skip tool calls not started yet? Not needed here (Mousse holds during tools); it decides whether a later change may send natively during tools.

### 3.4 Tests

- `tests/harness/piRpcLifecycle.test.ts` (stub Pi):
  - a cut while writing keeps the shown text and continues the same turn, and the steer is taken once;
  - a Stop during each step of the cut gives the steer back once, and a late `prompt` response or `agent_settled` for the old generation starts nothing;
  - a failed `prompt` gives the steer back;
  - an `abort` that misses its deadline gives the steer back and ends the turn as a Stop would;
  - two cuts in a row;
  - a cut while a native steer is `sending`, and while one is `queued`;
  - the S3 interleavings 4–7 as deterministic tests;
  - matching: repeated identical steers, a steer whose text is part of another, and the continuation prompt not matching a queued steer;
  - a steer during retrying cuts, and one during compaction holds.
- #368: a steer at the last step comes back once, and `clear_queue` was sent before the turn settled. With the real Pi child, as #368 asks, in `tests/harness/piRpcProcess.test.ts` ("Pi RPC engine with the real Pi child").
- `tests/run/scenarios/steer-mid-turn`: Pi now splits the reply at the steer like the others; the scenario's Pi exception from #873 is removed.
- Windows: the `piShell` win32 case in §2.12.
- **Hands-on gate:** a `pi:*` instance against a local mock OpenAI-compatible server:
  - a steer while writing;
  - a steer during a `sleep`;
  - Send now during the `sleep`, also on Windows with `ping -n 60 127.0.0.1`, leaving no `ping` process;
  - a steer at the last step (#368).

### 3.5 Risks

- **Pi's abort on Windows.** Pi's shell runs detached only off Windows (`extension/shell.ts:193`), so on Windows Pi's abort may not end a command's children. If the win32 test shows a surviving tree, Send now then ends the tool's tree with the same tree kill Stop uses (the thread's process groups and descendants, `pi/descendants.ts`). The POSIX process-group evidence is not taken as Windows evidence.
- **A Pi version whose `abort` leaves the session unusable** would end the turn. Mitigation: a failed `prompt` hands the steer back and the turn ends as stopped; the steer runs next.
- **More aborts mean more partial requests billed.** The other providers already have this trade-off.

## 4. Item 3: a mark on cut-off turns

### 4.1 Does it help?

Yes, for turns that ended early; no for steer cuts.

- A turn that a Stop, a restart or a crash ended looks finished when you scroll back: "Worked for 7s", then a reply that stops. Nothing says the agent did not finish, so a reader can take half-done work (a half-run migration, an edit plan with no edits) as done. The latest such turn has the "Run interrupted · Continue" notice, but only while its in-memory phase is `stopped`: until the next turn, or until the next restart (#881). Earlier turns show nothing.
- A steer cut is not an ending. The turn goes on in the same row, and the Steer block already shows where the person cut in. With Steer cutting in by default, almost every steered turn would carry the mark, and it would say nothing new. With item 1, a steer no longer ends a command it knows of, so it leaves no half-done tool behind. When Send now stops a command, that command's row already reads interrupted (`format-tool.ts:78-86`), and the turn itself went on.

The mark counts a Stop (by a person or by an agent in another thread), a restart and a crash. It does not count steer cuts, Send now, usage-limit pauses (they have their own line), failures (they show their error) or a bot's wall.

### 4.2 What it says and where

The mark goes in the turn header, after the duration, in the same muted style (`.turn-work-label`, `message-list.tsx:242-295`):

```
Worked for 7s · Stopped ──────────────────────────────
Worked for 41s · Interrupted ─────────────────────────
```

| Cause | Mark | Tooltip |
|---|---|---|
| `user` | Stopped | "You stopped this turn before it finished." |
| `agent` | Stopped | "An agent in another thread stopped this turn." |
| `daemon_restart` | Interrupted | "Mousse restarted during this turn." |
| `crash` | Interrupted | "Mousse quit during this turn." For an `uncertain` run, the tooltip adds "May have run: bash". |

- One word. No icon, no colour change, no edge bar. It is not a button: Continue stays on the live notice only.
- **Every** cut-off turn gets it, the latest included. The one exception is while the live "Run interrupted" notice shows for that same turn: the two would sit a few lines apart and say the same thing.
- A subagent's turns follow the same rule in its own thread. Bot chats show no turn headers and are unaffected.
- `provider` (the reconciler's rule 2 ending a run with no terminal event, `Reconciler.ts:180`) is not marked in this design: nothing writes a transcript line for it, and the reconciler never touches transcripts (§8, Opus 7 and Fable 9).

### 4.3 Data path

**Writers.** The system line that a turn's end writes today gains two fields: `turnId` (the run id) and `turnEnd: { cause: 'user' | 'agent' | 'daemon_restart' | 'crash'; tools?: string[] }`. No new message is added, and there is no schema change (they are fields in a `ChatMessage` row's JSON).
- **Stop path** (`OS.ts:11738`): the cause is `daemon_restart` for a shutdown abort, and none for a bot wall (no mark). Otherwise it is `agent` when the run's outcome has `stopRequestedBy: 'agent'` (`src/mms/run/types.ts:74`), else `user`. The line is written after the terminal write (`markRunTerminal`, `:11741`), so the cause is read from the run's stored outcome, which records `agent` (`RunEngine.ts:1162-1174`).
- **Boot path** (`writeRestartTranscripts`, `OS.ts:2614`): the cause is `crash` when the boot found that the previous daemon crashed (`daemonEpochs.begin`'s `previousCrashed`, `RunEngine.ts:839`), else `daemon_restart`. For `uncertain` runs it adds `tools` from the restart note. The boot records `crashed` on each `restart.transcript_pending` marker's payload (an event payload, no schema change). A marker from an older build has no field and reads as `daemon_restart`.

**Normalisation** (`src/renderer/chat/adapters/mousseToUI.ts:344-373`). A system message with `turnEnd`, or an older line whose text is exactly `'Turn stopped.'` (cause `user`) or `RESTART_INTERRUPTED_TEXT` (`restartNote.ts:88`, cause `daemon_restart`, restart wording), is emitted as a hidden marker: a `UIMessage` with `role: 'system'`, its `turnId`, and `metadata.turnEnd`. It is reused by identity like the other rows (`reuseUIMessages`), so an unchanged marker keeps its object. Today system lines pass through without the field, and the grouping drops them.

**Grouping** (`groupMessagesIntoTurns`, `message-list.tsx:737-774`):
- A marker is attached to the turn whose user message has the same `turnId` (the run id), wherever the marker sits in the list. A marker written at boot after newer turns therefore still lands on its own turn.
- A marker with no `turnId` (an older line) attaches to the turn it falls inside, by position.
- The turn gets `end?: { messageId; cause; tools? }`, cached per marker message, so its identity follows the marker's.

**Reuse.** `sameTurn` (`message-list.tsx:776-780`) also compares `a.end === b.end`. A marker that arrives after a snapshot, or is updated, then re-renders its turn instead of being discarded by `reuseTurns`.

**Scope.** Only the transcript reads the mark. The CLI, search, export and Bridge rendering are follow-ups (§8). Bridge carries the fields already, because they are on stored messages.

### 4.4 Tests

- `tests/renderer/turnInterruptedMark.test.ts`, through the whole pipeline (`ChatMessage[]` → `mousseToUIMessages` → `groupMessagesIntoTurns` → `reuseTurns` → the rendered `TurnRow`):
  - each cause and its tooltip;
  - no mark for a steered turn, a paused turn, a failed turn or a bot wall;
  - the latest turn's mark hidden while its notice shows, and shown after;
  - the older-text fallback;
  - a marker arriving after a snapshot re-renders its turn;
  - a marker written after newer turns lands on its own turn by `turnId`;
  - an unchanged marker keeps the memoised row.
- `tests/run/continueAfterRestart.test.ts`: the restart line carries `turnEnd` with `crash` or `daemon_restart`, and a third boot does not add a second one.
- `tests/run/stopThread.test.ts`: a person's Stop writes `cause: 'user'` and the turn id; an agent's `thread_interrupt` writes `cause: 'agent'`.
- Hands-on (real app captures before and after, for the PR):
  - Stop a turn, send another: the first reads "Stopped";
  - kill the dev daemon mid-turn, restart, send another: the first reads "Interrupted", with the tooltip.

### 4.5 Risks

Small. The renderer reads an optional field. A wrong cause shows a wrong word and never loses data.

## 5. Related work (checked against `6d846d9ec`)

- **Already done:** none of these three. #873 (cut-in), #874 (progress line), #880 (thinking line), #881 (restart cut-offs) and #872 (Done) are the base.
- **Will collide:** #871 (Teams message authors, open) changes `OrchestratorService.ts`, `QueuedMessages.tsx` and `src/shared/types.ts`. Its author field on queue items must carry through `returnUnreadSteerItems`, `steerNow` and the held state. Land after #871, or rebase on it.
- **Issues:** §3.2 fixes #368. #514 (Continue on interrupted runs) is separate: the mark adds no action. #546 (shortcuts) is unaffected: Send now has no shortcut.

### 5.1 SPEC edits (made in the PR that builds each part)

- **§4:** add `steer_now` to `RunCommand`, with its receipt, the `run_not_active` ignore, and the events `steer.now_requested` and `steer.now_stale`.
- **§13.2:**
  - `native` no longer says "only the pi loop does this"; it covers Codex and Pi.
  - Replace "User steers are delivered the same way whatever the value; the capability decides only whether reconciler rule 4 may push a delegation notice" with the rule that `steerDelivery` reads `steer` and `steerBoundary` for a person's steer.
  - Add `steerBoundary` with its reader.
- **§13.3:** add `steerDelivery`.
- **§13.4:** the Pi row is the RPC engine (`native`, `announce`).
- **§13.6:** add the `steer-mid-tool` scenario.
- **§14.3:** say that rule 4 is unchanged. Notices still wait on `interrupt_restart` providers while a run is live, although the hold would now make pushing them safe; that is out of scope.
- **§14.7 "Unread steers":** a held steer is an unread steer. Add acceptance per token and Send now.
- **§12.5 step 5:** the restart line carries `turnEnd` (`crash` or `daemon_restart`).

## 6. Rollout

Spikes first, then small PRs in order. Each run-engine PR is Tier 5 and goes through the council's code gate.

1. **Spikes S1–S4**, no product code. A short note is added to this document with what each one showed. S4 is the start-provider timing (Codex app-server with a mock model, and one ACP agent if one runs with no account): the gap between a command's `item/completed` and the next `item/started` from the same response, and how late a start notification can be. It sets `STEER_SETTLE_MS`. S2 (Codex native) is optional now; it only gates the later Codex change.
2. **PR 1: acceptance per token** (§2.6). No change in behaviour.
3. **PR 2: the core hold with Claude Code:**
   - `steerDelivery`, `steerBoundary`, `peekSteer`, `mayCut`;
   - `foregroundTools` with ownership;
   - `TurnState.heldSteer` and `steer_now` (engine, protocol, queue field);
   - the Steer block line and Send now;
   - Claude's targeted background moves, `mayCut`, and `stopTask`;
   - SPEC §4, §13.2, §13.3, §14.3, §14.7.

   The other providers stay `steerBoundary: 'none'` (today's behaviour) until their PR.
4. **PR 3: Codex, ACP agents and Cursor** on the hold (`start`, settling, `mayCut`), with the Codex fixture and SPEC §13.6.
5. **PR 4: Pi cut-in** (§3) on top of PR 2, with Pi at `announce`. Closes #368.
6. **PR C: the mark** (§4). Independent; it can land first. Tier 4.

There is no setting. If a release shows a provider whose tool events are unreliable, that adapter goes back to `steerBoundary: 'none'`, and its behaviour is today's again. That provider then makes no promise about commands until it is fixed.

## 7. Open questions

For the user:
1. None of the earlier four is still open. The answers kept: the progress line keeps "Running Bash…" and the wait shows on the Steer block; no Send now shortcut; agents cannot Send now another thread's command; the marks read "Stopped" and "Interrupted".
2. **New:** on Codex, ACP agents and Cursor, a steer can wait up to `STEER_SETTLE_MS` (about half a second) after a command when the model shows nothing yet. Is that acceptable as the price of not cutting the next command?

For the council, round 2:
1. Is the release rule for `start` providers (output seen, or a settle window) enough, given the measured gaps from S4?
2. If S1 shows `'next'` behaves, is using it only at the release after a tool, with `now` otherwise, the right split?
3. Is carrying Send now on the queue item (`steerNow`) the right cross-process route, or should Send now be refused for turns another process runs?

## 8. Council round 1 responses

Verdicts: Opus, Sol and Fable each requested changes, with no blockers. Each finding is listed with what changed or why it was not taken.

### Agreed by the reviewers

| Finding | Response |
|---|---|
| A subagent's own tool calls count as foreground (Opus 2, Sol 4, Fable 1) | **Fixed.** `foregroundTools` filters by ownership: it walks `parentCallId` / `activity.parentId` and excludes any call under a subagent or background call (§0, §2.2). An unresolvable parent holds. Tests for a nested Bash, a backgrounded Agent, and a root Bash with a child Bash (§2.12). |
| The safe-point race between decision and cut (Sol 1, Fable 2) | **Fixed, with the remaining window stated.** §2.3 is a boundary contract: the hold starts at the announcement where providers give one; `start` providers release only after output or a settle window; every adapter checks `mayCut` at dispatch, after awaits. The summary no longer claims "never": it says what is guaranteed, and the per-provider window that remains and how it closes. S1 and the new S4 cover consecutive tools, delayed start notifications, and a tool that starts during a background move. |
| Pi's poll cannot follow the table without a non-taking read (Opus 1, Fable 3) | **Fixed.** `peekSteer()` and `drainSteerEntry({ expect })` on `TurnControl` (§2.2). Pi during a tool is `hold`, not `native`; the native drain happens only at `turn_end` (`atBoundary`). The note on `steer.person` being known before the drain is in §2.2. |
| Pi needs a serialized lane and an operation generation (Sol 3, Opus 4, Fable Q4) | **Fixed.** One lane for native send, `clear_queue`, `abort`, the continuation `prompt` and Stop; `opGen` voids late responses; an ownership state per entry; every `turn.steers` entry is settled before the `prompt` (§3.2). The S3 list and tests cover the interleavings named (§3.3, §3.4). |
| Pi matches by `includes` (Fable 8, Sol Q4) | **Fixed.** Order plus exact text for queued steers, and the continuation prompt matched by its lane operation, never by text (§3.2). Tests for repeated and substring texts. |
| Acceptance is not per token (Sol 2) | **Fixed.** §2.6, as its own first PR. The exactly-once wording in the summary now names the at-least-once window #881 documents. |
| Send now: a distinct command bound to the run, a generation and item ids, with a durable receipt (Sol 5, Fable 6, Opus Q5) | **Fixed.** `steer_now { runId, holdGeneration, itemIds }`, receipt per `clientRequestId`, `ignored` for a run that is not active, a stale generation recorded as `steer.now_stale`, and the cross-process route through the queue item (§2.9). |
| Codex: hold or native first (Opus 3, Sol Q2; Fable Q2 for native) | **Hold from the start** (§2.5). Native `turn/steer` for a person's steer is a later change, gated on S2's four conditions. This also removes the `nativeSent` state, the Send now gap (Sol 5) and the "sent, unconfirmed" column (Fable 4). |
| The mark's data path (Sol 6) | **Fixed.** The marker is carried through `mousseToUIMessages`, attached by run id, and included in `sameTurn`; the full-pipeline tests are in §4.3 and §4.4. |
| The `agent` cause, and the writer for `provider` (Opus 7, Fable 9) | **Fixed.** `agent` reads "Stopped" with its own tooltip, taken from the run's stored outcome. **`provider` is dropped**: nothing writes a line for it, and adding a transcript writer to the reconciler's rule 2 is out of scope. A follow-up can read the cause from the run by `turnId`. Crash and restart are told apart by `previousCrashed` on the boot marker; older lines use the restart wording. |

### Also folded in

| Finding | Response |
|---|---|
| If `now` only moves Bash to the background, Send now must still stop it (Opus 5) | **Fixed.** `stopTask(taskId)` after the push (§2.4). The button's words do not change. |
| A cut that ends a foreground `delegate_task` (Opus 6) | **Fixed.** §2.8's last row: the delegation is a stored row, the child keeps running, and its result reaches the parent through the inbox; a repeated call returns `title_taken`. |
| SPEC edits (Opus 8, Fable 7) | **Fixed.** §5.1, including §14.3 unchanged and §12.5. |
| Windows evidence (Opus 9, Sol 7, Fable 8) | **Fixed.** A win32 `piShell` test (tree ended, output kept, no stale events), Windows hands-on steps for Claude and Pi, and §3.5 on Pi's shell not detaching on Windows. |
| Trim scope (Opus 10, Sol 7) | **Fixed.** No search, export, Bridge rendering or CLI reading of the mark, and no CLI slash command or CLI wait line. |
| Split PR A (Fable 10) | **Fixed.** PR 1 (acceptance), PR 2 (core hold and Claude), PR 3 (Codex, ACP, Cursor), PR 4 (Pi), PR C (the mark). |
| `'next'` as S1's first question; more S1 cases (Fable 5) | **Fixed.** S1 item 1, with an adoption rule; parallel tools, `detachedToolCall`, and a disabled `backgroundTasks` are added. |
| Wrong citation for a background Bash (Fable 5) | **Fixed.** `claudeActivity.ts:234` is the subagent case. A `run_in_background` Bash returns its result at once, so it never holds and needs no citation. |
| `clear_queue` texts matching no steer (Fable 8) | **Fixed.** They are handed back as text, as Stop does (§3.2 step 2.2). |
| Pi during retrying and compaction (Fable 8) | **Fixed.** Retrying cuts; compaction holds (§3.1). |
| A rollback needs the provider's identity (Fable 10) | **Fixed.** Rollback is the adapter's `steerBoundary: 'none'`, so no provider name reaches the policy. |
| Missing test rows: pause while held, mixed batch, long Write input (Fable 10) | **Fixed.** In §2.8 and §2.12; a long Write reads "Waits for Write" (§2.1). |
| Hands-on for Codex and Pi as a gate (Fable 10) | **Fixed.** §2.12 and §3.4, with a mock model and no accounts. |
| Pending approval for A never releases a running B; agents' steers never answer approvals (Sol Q3) | **Fixed.** Stated in §2.1 and §2.8, with tests. |
| Codex's native error path is described wrongly (Opus 11) | **Moot.** The native path for a person's steer is gone. |
| The doc's file path (Opus, preamble) | **Fixed.** The orchestrator path is stated once at the top, and line numbers follow `6d846d9ec`. |

### Not taken

| Finding | Why not |
|---|---|
| Codex: native `turn/steer` first (Fable Q2, Fable 4's conditions) | Two of three reviewers and the user's call chose the hold. Native has no Send now route without new adapter state, and its exactly-once depends on unknown Codex behaviour. Fable's conditions are kept, word for word, as the gate for the later native change (§2.5). |
| A provider-side mechanism that cannot interrupt a newly started tool, for every provider now (Sol 1) | Not available for every provider in this design. Claude's `'next'` depends on S1, Codex native is deferred, and ACP agents and Cursor have none. The design instead states the window that remains per provider and how each one closes (§2.3), and does not claim more. |
| Keep the CLI `/steer-now` (Opus 10) | Trimmed on instruction: the feature does not need it, and a person who steers from the CLI can Stop. It can be added later on the same `steer_now` command. |
| Bring the Codex PR in once S2 is written up (Fable 10, ordering) | Moot under the hold: Codex no longer depends on S2, so it ships in PR 3 with ACP agents and Cursor. |
| Fall back to an unconditional cut for unreliable providers (Sol 1, on §6) | Partly taken. The rollback still exists, because a provider with broken tool events would otherwise hold steers until the turn ends. It now says plainly that it restores today's behaviour and withdraws the guarantee for that provider (§6). |
