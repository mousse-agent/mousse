# Steer waits for commands, Pi cuts in, and cut-off turns are marked

Status: design, for council review before any code. Written against `master` at `f7a882fda` (after #873, #874, #880, #881, #872). Nothing here is built yet.

## Summary

Three related changes to how a running turn takes a person's message:

1. **A steer never kills a running command.** While the model writes or thinks, Steer still cuts in at once (#873). While a foreground tool runs (Bash, an edit, an MCP call), the steer waits until that tool's result is recorded, then goes in at the next safe point. Background shells and subagents are never waited on. The Steer block says what it waits for ("Waits for Bash") and offers **Send now**, which stops the tool and delivers at once. There is no automatic timeout.
2. **Pi cuts in like the others.** Today a Pi steer is read only at Pi's next step, so a long reply runs to its end first. Pi will abort the reply, keep what it wrote and the results of finished tools, and continue the same turn with the steer, with the steer taken exactly once. During a tool, Pi waits as in item 1. This also fixes #368 (a steer at Pi's last step is lost).
3. **A mark on cut-off turns.** A turn that a Stop, a restart or a crash ended, and that a newer turn follows, gets a short muted mark in its header ("Stopped", "Interrupted"). A steer's cut does not count.

All three keep #873's and #881's guarantees: every steer reaches the model exactly once, or comes back to the thread once; nothing is lost.

## 0. Terms used here

- **Foreground tool:** a tool call of the turn's own agent that is running now and whose result the turn waits for. Not foreground: a call that waits for a person (an approval or a question), a background shell, a subagent (the provider's own or Mousse's), and a wait-only tool (`WAIT_TOOL_NAMES`, `src/mms/run/transcript/TranscriptAssembler.ts:71`).
- **Writing:** the model streams text or thinking, or a request is in flight with no tool running (the #874 steps `waiting`, `reasoning`, `retrying`, and the phases `thinking`, `streaming`).
- **Held steer:** a steer the orchestrator has accepted (its Steer block shows) and has not handed to the provider yet, because a foreground tool runs.
- **Cut:** the provider's current reply is ended so the turn can go on with the steer (#873).

## 1. Today

### 1.1 How a steer reaches a turn

- A steer is a queue item promoted to `steering` (`promoteQueueItem`, `OrchestratorService.ts:7900-7979`; `deliverPromotedItem`, `:8148`), or a composer steer turned into such an item. It shows at once as a Steer block in the running reply (`steer-group.tsx`, grouped by `metadata.steered` in `groupMessagesIntoTurns`, `message-list.tsx:737-774`).
- The turn reads it through `TurnControl.drainSteerEntry` (`src/mms/harness/adapter.ts:226-245`), built in `executeTurn` (`OrchestratorService.ts:11466-11509`). Each drain has a token; the provider calls `steerTaken(token)` when it has the text, or `returnSteer(text, token)` when it cannot use it, which puts the entries back in front of newer steers.
- `drainEntry` sets `cut` when any entry is a person's message (`:11483-11486`). A provider whose own steer waits for the current step cuts the reply instead (`adapter.ts:237-239`).
- Steers the turn never read: a Stop hands them back to the front of the queue (`returnUnreadSteerItems`, `:8058`); a turn that ends turns them into a `steer-followup` turn (SPEC §14.7 "Unread steers"); a restart puts a steer the provider never accepted first in the queue (`returnOrphanedSteers`, #881). Accepted ids are saved in `nativeContext.acceptedSteerItemIds` (`:11396-11404`, `:11450-11456`).
- `drainSteerForSession` already holds some steers back: an agent's steer waits while a question is open (`:11958-11963`). The new hold is the same kind of rule.

### 1.2 Per provider

| Provider | Capability `steer` | What a person's steer does now | Running command |
|---|---|---|---|
| Claude Code (live session) | `interrupt_restart` (`drivers/claudeCode/adapter.ts:45`) | Polls every 100 ms (`ClaudeSubscriptionProviderService.ts:2613-2623`). `LiveSession.steer` (`liveSession.ts:763-809`) calls `backgroundTasks()` with no argument, waits up to 5 s, then pushes the text with `priority: 'now'`. The reply row splits where the cut lands (`turnFrames.atNextMessage`). | Cut. #874's hands-on check saw the 40 s command end at the steer. The no-argument `backgroundTasks()` is documented to move Bash to the background too (SDK 0.3.291, `Query.backgroundTasks`), so why the command still ends needs a check (§2.4, spike S1). |
| Claude Code (no live session) | same | Pushes the text and calls `query.interrupt()`, then resumes the session with it (`:2463-2469`, `:2780-2794`). | Cut. |
| Codex | `native` (`drivers/codex/adapter.ts:77-95`) | A person's steer is a cut: `turn/interrupt`, then the next `turn/start` carries it (`CodexProviderService.ts:2933-2967`). It counts as taken only once that `turn/start` is accepted (`cutHeld`, `cutStarting`, `handBack`, `:2939-2943`, `:3036-3039`). Other steers use `turn/steer` (`:2918-2932`). | Cut by the interrupt. `turn/steer` alone would let it finish (checked on codex-cli 0.162). |
| Pi (RPC engine, every `pi:*` instance) | `native` (`drivers/pi/engines/rpc.ts:34-50`) | Drained only at Pi's `turn_end` and sent as RPC `steer` (`pi/engine.ts:1923-1936`). Taken when a user `message_start` with the text arrives (`:1943-1951`). `cut` is ignored. | Not cut: tools have ended by `turn_end`. |
| ACP agents (generic, Antigravity, Grok) | `interrupt_restart` (`acp/capabilities.ts:11-21`) | `session/cancel` at once, then a new prompt "Additional guidance: …" (`acp/session.ts:788-852`). | Cut, if the agent's cancel stops it. |
| Cursor | `interrupt_restart` (`drivers/cursor/adapter.ts:12-24`) | `active.cancel()`, then a new run with the guidance (`cursor/session.ts:524-556`). | Cut. |

## 2. Item 1: a steer never kills a running command

### 2.1 Behaviour

When a person steers a running turn:

| What the turn is doing | What happens |
|---|---|
| Writing or thinking, or a request is in flight | Cut now, as today (#873). |
| A foreground tool runs | The steer is held. It goes in once every foreground tool of the turn has its result, at the next safe point (§2.3 per provider). The tool's output is kept and the model reads it with the steer. |
| Only background work runs (background shells, subagents, a wait-only tool) | Cut now. Nothing is waited on. A foreground subagent is first moved to the background where the provider can do that (Claude, §2.4). |
| A tool waits for an approval or a question | Cut now. The steer answers it as today (`autoRejectPendingForThread`, #873). |
| The turn is being set up, stopped, ending or paused | Unchanged (`steerWhenStarted`, `sendNowAfterTurn`, `sendNowIdle`, `steer-late`). |

- **Send now** on a held steer stops the running tool and delivers at once (a cut).
- **No automatic timeout.** A long build keeps running; the person decides.
- **Several steers** sent while one is held join it: one Steer block, one wait line, delivered as one input (the drain joins them, `:11486`).
- **Steers that are not a person's** (an agent's steer, a subagent result notice) never kill a command either. On a provider whose steer is `native` they keep going in natively. On an `interrupt_restart` provider they are held in the same way.
- Applies to a remote turn's steers too (`externalDrainSteer`, `:11473`) and to steers from the CLI, Bridge and `thread_steer`.

### 2.2 Where the hold lives

The hold lives in the orchestrator, in one place. Adapters only report tool calls accurately.

**Decision per drain.** `drainEntry` (`OrchestratorService.ts:11471`) asks a new pure function before it drains:

```ts
// src/mms/run/CommandPolicy.ts
export type SteerDelivery = 'cut' | 'native' | 'hold'
export function steerDelivery(
  caps: ProviderCapabilities,
  turn: { foregroundTools: number; forced: boolean },
  steer: { person: boolean }
): SteerDelivery
```

| | No foreground tool | Foreground tool running | Send now (`forced`) |
|---|---|---|---|
| `caps.steer === 'native'` | person: `cut`; other: `native` | `native` (the provider's own steer waits for the tool) | `cut` |
| `caps.steer === 'interrupt_restart'` | `cut` (every steer: there is no gentler path) | `hold` | `cut` |
| `queue_only` | unchanged (the turn's end) | unchanged | unchanged |

- `hold`: `drainEntry` returns `undefined` and leaves the entries in `turn.pendingSteer` and the queue (`steering`). Nothing new is stored: a held steer is an unread steer, which every existing path already handles (§2.6).
- `native`: `drainEntry` returns the entry with `cut: false`.
- `cut`: as today, `cut: true`.
- This reuses the existing `steer` capability, so it adds no flag. `steerDelivery` becomes a second reader of `caps.steer` in `tests/run/capabilityReaders.test.ts`. Its meaning is unchanged: `native` already says "a running tool call finishes and the model sees the text at its next step" (SPEC §13.2).

**Counting foreground tools.** The transcript assembler already tracks the turn's running calls (`activeToolCallMessageIds`, used by `isBlockedOnWait`, `TranscriptAssembler.ts:611-626`). A new `foregroundTools(): Array<{ callId; toolName; detail? }>` in the same place excludes:
- calls with `activity.background` (Claude sets it for `run_in_background` and handed-off calls, `claudeActivity.ts:234`, `:436-439`);
- calls whose `activity.kind` is `subagent` (Claude's `Task`/`Agent`, Codex's `collabAgentToolCall`, Mousse's `delegate_task`);
- `WAIT_TOOL_NAMES`;
- calls waiting for an approval (the call has a pending `approval_requests` row, SPEC §17) or a question.

Every adapter already sends `start` and `complete` tool events with a `callId` (§1.2 table; Pi `tool_execution_start/end`, ACP `tool_call`/`tool_call_update`, Cursor `tool-call-started/completed`, Codex `item/started/completed`, Claude `tool_use`/`tool_result` in `turnFrames.ts:207`). No new adapter event is needed. Each adapter's tests must show that a tool's `complete` reaches the sink no later than the provider has the result.

**Releasing the hold.** The hold ends when the count drops to zero, on Send now, or when the turn ends. Adapters keep their 100 ms poll (Claude, Codex, ACP, Cursor) or their step hook (Pi), so the next poll after the tool's result drains the steer. No new wake-up is needed; 100 ms is the worst-case added delay.

**Showing the hold.** While `drainEntry` holds entries, the orchestrator sets `TurnState.heldSteer` (§2.7) and clears it when the entries are drained, handed back or the turn ends. It is in memory, like `step`.

### 2.3 The safe point

After the last foreground tool's result, the provider is either between steps (nothing in flight) or has already sent its next request. Either way, a cut then loses at most the first part of that request. No command, edit or tool output is lost. The per-provider sections say which path each one takes.

### 2.4 Claude Code

**Mechanism (hold, then cut):**
- `caps.steer` is `interrupt_restart`, so `steerDelivery` holds while a foreground tool runs. `collectSteer` (`ClaudeSubscriptionProviderService.ts:2440`) sees nothing to drain.
- When the `tool_result` frame arrives (`turnFrames.ts:207`), the call completes in the assembler; the next poll drains the steer with `cut: true` and `live.steer` pushes it with `priority: 'now'`. Claude Code then has the tool result in its conversation, so the cut only ends the request that follows.
- **`backgroundTasks` changes.** `LiveSession.steer` stops calling `backgroundTasks()` with no argument, because that also moves a foreground Bash to the background (SDK 0.3.291: "without it, backgrounds all foreground tasks … Bash commands and subagents"). It calls `backgroundTasks(toolUseId)` once for each foreground subagent call still open, so subagents are never waited on and never cut. The 5 s wait (`STEER_BACKGROUND_MOVE_MS`) stays, per call.
- **Send now** drains with `cut: true` while the tool runs and pushes `priority: 'now'`, with no background move for Bash. This is today's behaviour, which ends the command.
- The no-live-session path (`query.interrupt()`) gets the same hold through `drainEntry`; nothing else changes there.

**Spike S1 (before code, hands-on, fake Messages server, no sign-in):**
1. Does a `priority: 'now'` push during a foreground Bash end it, with and without the no-argument `backgroundTasks()` before it? (#874 saw it end; the SDK says it should move to the background.) The answer decides whether today's cut is a kill or a background move. Either way the design holds the steer, so the result changes only the Send now wording ("Stops Bash" or "Moves Bash to the background").
2. Does `priority: 'next'` deliver at the next tool-result boundary without cancelling anything? If it does, it can replace the local hold for Claude while a tool runs, with the same orchestrator decision (`native` for Claude during tools). It cannot replace the cut while writing. Keep the local hold unless S1 shows `'next'` is reliable and reports when Claude Code reads the message.

### 2.5 Codex

**Mechanism (native during a command, cut while writing):**
- `caps.steer` is `native`, so `steerDelivery` returns `native` while a foreground item runs (`commandExecution`, `mcpToolCall`, `webSearch`; Codex's helper agents are subagents and never count). `collectSteer` (`CodexProviderService.ts:2968-2976`) then sends `turn/steer`, which lets the command finish (checked on codex-cli 0.162) and joins the same turn at its next step. While writing, it stays #873's cut.
- **Taken only when read.** Today the native path calls `onSteer` before `turn/steer` returns and never calls `steerTaken` (`:2918-2932`, `:2974-2975`). The new native path:
  1. sends `turn/steer` with the drain's token remembered in a `nativeSent` list;
  2. on an RPC error, hands the entry back (`returnSteer`), as it holds text today;
  3. counts it taken (`steerTaken`, then `onSteer`, which splits the reply row) when Codex shows it read the text. Which event proves that is spike S2.1;
  4. on Stop, a failed turn or the turn's end, gives back every unconfirmed entry (`handBack` covers `nativeSent` as it covers `cutHeld`).
- **Send now** on a steer already sent with `turn/steer`: `turn/interrupt` (ends the command), then the next `turn/start` carries the text, exactly as a cut (`cutHeld`), but only if S2.2 shows Codex dropped the unread steer. If Codex keeps it, the continuation must not carry it again.
- **Race.** If the command ends between the decision and the `turn/steer` request, Codex reads the steer at the end of the reply it is writing instead of cutting it. The steer is still read once. The wait line clears when the item completes, so the person sees no stale "Waits for Bash".

**Spike S2 (before code, real codex app-server, isolated home, no sign-in on the user's account):**
1. What Codex emits when it reads a steered input (a `userMessage` item, or only the next model item).
2. What `turn/interrupt` does with a steer accepted and not yet read: dropped, kept for the next turn, or written to the thread's history.

**Fallback.** If S2 cannot answer both questions clearly, Codex uses the hold like Claude: `steerDelivery` treats it as `interrupt_restart` for a person's steer during a foreground tool, and the existing cut runs after the command. That keeps #873's proven exactly-once path at the cost of one `turn/interrupt` and `turn/start` round trip after the command. The council should confirm this order (native first, hold as fallback), since the native path is what the user asked for.

### 2.6 Pi, ACP agents, Cursor

- **Pi:** `native`. The engine already drains only at `turn_end`, which comes after the step's tools, so a steer during a tool waits. Item 2 adds the cut while writing and the Send now path.
- **ACP agents and Cursor:** `interrupt_restart`, so they hold. When the tool's `complete` arrives, the next poll drains with `cut: true` and the existing cancel and re-prompt runs. Send now cancels at once, as today.
  - ACP events are sparse: an agent that never sends a `completed` update for a call keeps the steer held until the turn ends (then it runs as a follow-up turn) or Send now. The hold never outlives the turn.
  - Only Grok marks subagent calls (titled "subagent: …", `acp/session.ts:684`); other ACP calls all count as foreground.

### 2.7 Exactly once, nothing lost

A held steer has not been drained, so it is in the same state as a steer the turn has not read yet. The table covers every way a turn can end around it.

| Event | Held steer (not drained) | Drained, not yet taken | Taken |
|---|---|---|---|
| **Stop** | `returnUnreadSteerItems` puts it back first in the queue, shown there; its Steer block copy is hidden (`withdrawSteerEchoes`). Nothing runs it until the person sends again (#873). | Provider hands it back (`returnSteer` / `handBack`); then as held. | Kept: the model had it. |
| **Turn ends** (the tool's result ended the turn, or the provider failed) | Becomes a `steer-followup` turn, shown once as its prompt (SPEC §14.7). | Handed back, then as held. | Kept. |
| **Restart (#881)** | Still `steering` on disk, not in `acceptedSteerItemIds`: `returnOrphanedSteers` puts it first and the startup drain runs it once, after the cut-off turn. | Same. A provider whose session resumes may have it already (Claude, Codex): at-least-once, as #881 states. | Id in `acceptedSteerItemIds`: dropped. |
| **Provider crash** (process dies mid-turn) | Turn fails: as "turn ends". | `died` paths hand back (Pi `engine.ts:1862`, Codex `handBack`, Claude `returnSteer`). | Kept. |
| **Double steer** (same item twice) | #845 / #873 id guarantees: the second promotion of an item already in `pendingSteer` returns `ok` and does nothing (`:7915-7919`). | Same (`drainedExternalSteerIds`). | Same. |
| **Batching** (several steers while held) | All stay in `pendingSteer`; one drain takes them all, one token, joined text. | One token restores them all, in order (`returnSteer`). | All taken together. |
| **Send now twice** | First forces the cut; the second finds nothing held and is a no-op (receipt, §2.8). | No-op. | No-op. |
| **Steer arrives as the tool ends** | Either held for one poll or cut at once; both deliver once. | — | — |
| **Approval appears while held** | The tool now waits for a person: no longer foreground; the steer cuts and answers it as today. | — | — |

The only at-least-once window is #881's existing one (a steer handed to a resuming provider when the daemon dies) and the Codex S2.2 case, which the fallback removes.

### 2.8 Protocol and state

- **`TurnState.heldSteer`** (`src/shared/types.ts:1513`), in memory like `step`:
  ```ts
  heldSteer?: { waitsFor: string; detail?: string; tools: number; since: string; delivery: 'hold' | 'native' }
  ```
  `waitsFor` is the oldest foreground tool's display name (the same `toolName` rule #874 uses, `turn-progress.tsx:72-77`); `detail` its first input line (`inputDetail`, `:79-90`); `tools` how many foreground tools run. Set and cleared by the orchestrator; travels in `turn-state` events, the resnapshot (`resnapshotTurnState`) and Bridge snapshots. Older clients ignore it.
  For `delivery: 'native'` (Codex), the steer has left Mousse; the line still reads "Waits for Bash", and it clears when the tool's `complete` arrives.
- **Send now:** `orchestrator.steerNow({ threadId, runId, clientRequestId })`.
  - A new run-engine control command `steer_now` (SPEC §4): it names a `runId`; a run that is not active returns `ignored` (`run_not_active`); a repeated `clientRequestId` replays its receipt. It writes an `agent.action`-style event for the audit (`steered_run`, `{ now: true }`).
  - The orchestrator sets `turn.steerForced = true`; `steerDelivery` then returns `cut` until the held entries drain. Nothing held: `{ ok: true, nothingHeld: true }`.
  - Allowed for the people who may steer the thread (GUI, CLI, a Bridge peer with the `chat` capability). **Not offered to agents** (`thread_steer` has no `now`): an agent never kills another thread's command.
- **CLI:** in `mousse-cli chat`, `/steer-now` next to `/steer` (`src/cli/help.ts:66`); the turn line shows `steer waits for Bash` while one is held.

### 2.9 UI

The Steer block (`steer-group.tsx`) gets one line when the turn's `heldSteer` is set and the block holds the held items:

```
                                   ↪ Steer · Waits for Bash · Send now
                                   ┌──────────────────────────────┐
                                   │ actually use pnpm, not npm   │
                                   └──────────────────────────────┘
```

- "Waits for Bash" is muted text in the existing `.steer-group-label` style. Tooltip: "Goes in when Bash finishes" and the command (`npm test`). With several tools: "Waits for 2 tools", tooltip lists them.
- "Send now" is a quiet text button like `.chat-run-interrupted-action` (no fill, hover background). Tooltip: "Stop Bash and send now". After the click it reads "Sending…" and is disabled until the line clears.
- When the steer goes in, the line clears. No "Delivered" state; the reply simply continues below the block.
- No edge bars, no accent fill, no new colour. Keyboard: the button is focusable and has an accessible name ("Send steer now, stops Bash").
- Not in the queue list: a held steer is `steering`, which the list hides (`useThreadQueue.ts:448-452`).
- The composer's "Steered" notice (`OrchestratorChat.tsx:461-481`) is unchanged.

### 2.10 Interplay with #874, #880, #872

- **#874 progress line:** keeps "Running Bash…". The brief asks whether it should read "Steer waits for Bash". Recommendation: no. The line says what the agent does; the Steer block, which sits just above it in the live turn, says what the steer does and carries Send now. Two lines saying the same thing is noise. The line's tooltip adds one sentence: "Your steer goes in when it finishes." Once the steer is taken, `steerAccepted` sets the `waiting` step as today (`:11458`), which #880 shows as "Thinking…".
- **#880 thinking line:** unaffected while held (the model is not thinking during a tool). A cut during a live thought ends the thought row as written; the next thought is a new row, as Codex already does (`streams.thinking.break()`).
- **#872 Done:** a held steer does not end the turn, so the thread stays Working; Done is recorded when the turn (with the steer's continuation) ends. No change.

### 2.11 Tests

Focused files (each new test must fail on the code before its change):
- `tests/run/commandPolicy.test.ts`: `steerDelivery` table, every row; `tests/run/capabilityReaders.test.ts` lists the new reader.
- `tests/run/transcriptAssembler.test.ts`: `foregroundTools` excludes background, subagent, wait-only and approval-waiting calls.
- `tests/run/queueSteerExactlyOnce.test.ts`, with a fake adapter that reports a long tool: steer during the tool is not drained; drained on `complete`; Stop while held puts it back first; turn end makes it a follow-up; batching of three steers; Send now forces a drain; Send now twice; an approval opening while held releases it.
- `tests/run/restartRecovery.test.ts`: a kill while a steer is held (a new kill point): the run ends `interrupted`, the steer runs once after it.
- `tests/claudeLiveSessions.test.ts`: no push while a `tool_use` is open; push after its `tool_result`; `backgroundTasks(id)` only for subagent calls, never the no-argument form; Send now pushes `now` during the tool.
- `tests/run/codexAdapter.test.ts` with a new fixture `steer-during-command`: `turn/steer` during `commandExecution`, no `turn/interrupt`; taken only on the S2.1 event; handed back on Stop before it. If the fallback is chosen, the fixture records the hold then the cut.
- A new scenario `tests/run/scenarios/steer-mid-tool/` (SPEC §13.6 lists "steer mid-tool"; only `steer-mid-turn` exists): every adapter keeps the tool's result and reads the steer after it.
- Renderer: `tests/renderer/steerGroupHeld.test.ts` (the line, the tooltip, Send now, "Sending…", the line clearing), `tests/renderer/turnProgress.test.ts` (tooltip sentence), `tests/resnapshotTurnState.test.ts` (`heldSteer` survives a resnapshot).

Hands-on (cua-driver, dev app, software rendering, isolated home, Claude Code against a local fake Messages server, no real sign-ins):
1. Steer during a 40 s `sleep`: the block shows "Waits for Bash"; the command finishes (exit 0 in its row); the steer goes in after; the reply answers it.
2. Steer while the reply is writing: cut at once, as today.
3. Steer during a foreground subagent: not waited on; the subagent keeps running in the background.
4. Send now during the `sleep`: the command row ends interrupted; the steer goes in at once.
5. Three steers during the `sleep`: one block, one line, one input.
6. Stop while held: the steer is back first in the queue; nothing runs.
7. Kill the dev daemon while held, restart: the turn reads interrupted; the steer runs once.
8. Scrolled up while held: the view does not move when the line appears or clears (#873's rule).
Codex, ACP and Cursor by hand only if their servers can run without the user's accounts; otherwise say so in the PR.

### 2.12 Risks

- **A tool that never reports its end** (sparse ACP agents, a lost `complete`) keeps the steer held until the turn ends. Mitigation: Send now; the turn's end turns it into a follow-up; the assembler's end-of-turn `unfinished` close clears the count.
- **A long build delays the steer by minutes.** By design; the line names what it waits for, and Send now is one click.
- **Misclassified tools.** A subagent that a provider does not mark as one is waited on. Fail-safe direction (it waits, never kills). A background shell not marked `background` is the same.
- **Codex S2 unknowns** decide between native and fallback; the fallback is the proven #873 path.
- **Claude S1:** if the `now` push during a tool was a background move rather than a kill, today's behaviour is less harmful than thought, but the hold is still right: the model would otherwise go on while its command still runs.
- **Run-engine queue ordering** is not changed: held steers stay where #873 put them.

## 3. Item 2: Pi cuts in like the others

### 3.1 Behaviour

| What Pi is doing | What a person's steer does |
|---|---|
| Writing or thinking (an assistant message streams, no tool open) | **Cut:** Pi's reply is aborted; the text already shown stays as written, above the Steer block; finished tool results stay; the same turn goes on with the steer. |
| Between steps (`turn_end`, no request yet) | Native `steer`, as today: Pi reads it at the step that starts now. |
| A tool runs | Waits (item 1); goes in at `turn_end` natively. Send now: a cut (Pi's abort ends the tool's process group, `extension/shell.ts:214-231`). |
| The turn ended (`agent_end`) | Unchanged: `steer()` refuses (`engine.ts:1625`) and the text becomes the next turn. |

Agents' steers and subagent notices keep Pi's native next-step path; they never cut.

### 3.2 Mechanism (`src/mms/harness/pi/engine.ts`)

1. **Poll.** The engine adds the 100 ms poll the other adapters have, active while `turn.phase === 'running'`. It calls `drainSteerEntry` only when `steerDelivery` says `cut` (the orchestrator decides, §2.2; the engine just drains). At `turn_end` it keeps today's drain for non-cut entries.
2. **Cut sequence**, with `turn.phase = 'cutting'` so `agent_end`/`agent_settled` of the aborted run do not settle the turn (`:2081-2082`):
   1. remember the drained entry (`turn.cutHeld`, with its token);
   2. `clear_queue`; any texts it returns that match `turn.steers` (steers sent natively at an earlier `turn_end` and not yet read) move into `cutHeld` in their order, so they go in with this cut rather than staying in Pi's queue;
   3. RPC `abort`, deadline `INTERRUPT_DEADLINE_MS`;
   4. keep the partial reply: the aborted `message_end` (today skipped, `:1977`) closes the current text segment as written (`streams.text.break()`), the same split Codex makes (`drivers/codex/adapter.ts:196-202`);
   5. on `agent_settled`, send RPC `prompt` with the joined `cutHeld` texts, in the same process and session;
   6. when Pi accepts the prompt (the `prompt` response, or the user `message_start` carrying the text), call `steerTaken(token)` and `sink.steerAccepted(text)` for each entry, set `phase = 'running'` and `awaitingModel = true`.
3. **Give-back.** Until step 6, every entry is in `cutHeld`. A Stop (`stopTurnOnce`, `:1540-1574`), a crash (`died`, `:1862`), a refused or failed `prompt`, or an `abort` that misses its deadline hands each back with `returnSteer(text, token)`, exactly once (`cutHeld.splice(0)` as in Codex's `handBack`). A Stop during the cut wins: the steer is back first in the queue, as for any Stop.
4. **#368.** At `agent_end`, steers still in `turn.steers` (sent at the last `turn_end`, never read) are taken back with `clear_queue` and handed back with `returnSteer`, so they run once as the next turn and Pi's queue holds nothing. This closes #368's "Done when".
5. **Matching.** Pi reports a taken steer by text (`text.includes(steer.text)`, `:1946`). Two identical steers in a row can match out of order; since both carry the same text, the result is the same. The cut path matches its own prompt by order instead (it sent one prompt for the whole `cutHeld` list).

### 3.3 Spike S3 (before code; stub Pi child and the real Pi 1.4.0 child against a local mock model)

1. After `abort` mid-message, what does Pi's session keep: the partial assistant message (with `stopReason: 'aborted'`), nothing, or the whole message? The design needs the partial text kept or dropped consistently; Mousse's transcript keeps what was shown either way. If Pi drops it, the model does not see its own cut-off words, which is acceptable (Claude Code behaves the same way after a cut).
2. Does a `prompt` after `abort` continue the same session with full history (expected, since `thread.warm` stays set, `:1477-1480`)?
3. Does `clear_queue` return steers queued natively but not read, in order?
4. While a tool runs, does a native `steer` wait for the tool (Pi's documented next-step behaviour), and does it skip tool calls not yet started? Not needed by this design (Mousse holds during tools), but it decides whether a later change may send natively during tools.

### 3.4 Tests

- `tests/harness/piRpcLifecycle.test.ts` (stub Pi): cut while writing keeps the shown text and continues the same turn; steer taken once; Stop during each step of the cut gives the steer back once; failed `prompt` gives it back; `abort` deadline missed gives it back and ends the turn as a Stop would; two cuts in a row; a cut while a native steer waits in Pi's queue merges both.
- #368: a steer at the last step comes back once, and `clear_queue` was sent. With the real Pi child as #368 asks, in `tests/harness/piRpcProcess.test.ts` ("Pi RPC engine with the real Pi child").
- `tests/run/scenarios/steer-mid-turn`: Pi now splits the reply at the steer like the others (the scenario's Pi exception, added in #873, is removed).
- Hands-on: the dev app has no fake Pi; Pi is covered by the stub and real-child tests. Say so in the PR.

### 3.5 Risks

- A Pi version whose `abort` leaves the session unusable would end the turn. Mitigation: a failed `prompt` hands the steer back and the turn ends as stopped; the steer runs next.
- More `abort`s mean more partial requests billed. Same trade-off the other providers already have.

## 4. Item 3: a mark on cut-off turns

### 4.1 Does it help?

Yes, for turns that ended early, and no for steer cuts.

- A turn that a Stop, a restart or a crash ended looks finished when you scroll back: "Worked for 7s", then a reply that stops. Nothing says the agent did not get to finish, so a reader can take half-done work (a half-run migration, an edit plan with no edits) as done. The latest such turn has the "Run interrupted · Continue" notice, but only while its in-memory phase is `stopped`, and only until the next turn or the next restart (#881). Earlier turns have nothing. A short mark fixes that.
- A steer cut is not an ending. The turn goes on in the same row, and the Steer block already shows where the person cut in. With Steer cutting in by default, almost every steered turn would carry the mark, and it would say nothing new. With item 1, a steer no longer kills a command, so a steer cut never leaves work half done. When Send now does stop a command, that command's row already reads interrupted (`format-tool.ts:78-86`); the turn itself continued.

So the mark counts: Stop, restart, crash, and a provider that ended the turn without finishing. It does not count: steer cuts, Send now, usage-limit pauses (they have their own line), failures (they show their error).

### 4.2 What it says and where

In the turn header, after the duration, in the same muted style (`.turn-work-label`, `message-list.tsx:242-295`):

```
Worked for 7s · Stopped ──────────────────────────────
Worked for 41s · Interrupted ─────────────────────────
```

| Cause (`interruptedBy`) | Mark | Tooltip |
|---|---|---|
| `user` (Stop) | Stopped | "You stopped this turn before it finished." |
| `daemon_restart` | Interrupted | "Mousse restarted during this turn." |
| crash (`interrupted` or `uncertain` at boot after an unclean exit) | Interrupted | "Mousse quit during this turn." plus, for `uncertain`, "May have run: bash". |
| `provider` | Interrupted | "The agent ended this turn before it finished." |

- One word, no icon, no colour change, no edge bar. Not a button: Continue stays on the live notice only.
- **Every** cut-off turn gets it, the latest included, except while the live "Run interrupted" notice shows for that same turn (the two would sit a few lines apart and say the same thing).
- A subagent's turns follow the same rule in its own thread. Bot chats are unaffected (they show no turn headers).

### 4.3 Data

- The system line the turn's end writes today (`addSystemMessage`, `OrchestratorService.ts:9038`, called at `:11734` for Stop and shutdown, and by `writeRestartTranscripts` at boot, `:2598-2667`) gains structured fields: `turnId` (the run id, as #881's lines already carry) and `turnEnd: { interruptedBy: 'user' | 'daemon_restart' | 'crash' | 'provider'; tools?: string[] }`. No new message; no schema change (fields on a `ChatMessage` row's JSON).
- The renderer drops system lines today. `groupMessagesIntoTurns` (`message-list.tsx:737-774`) reads `turnEnd` from a system message inside a turn and puts it on the turn; the line itself stays hidden.
- **Older threads:** a system line whose text is exactly `'Turn stopped.'` or `RESTART_INTERRUPTED_TEXT` (`restartNote.ts:88`) counts as `user` or `daemon_restart`. No migration.
- Bridge, CLI (`thread show`), search and export read the same field; the CLI prints "(stopped)" or "(interrupted)" after the turn's duration.

### 4.4 Tests

- `tests/renderer/turnInterruptedMark.test.ts`: each cause and its tooltip; none for a steered turn, a paused turn, a failed turn; the latest turn's mark hidden while its notice shows and shown after; old-text fallback.
- `tests/run/continueAfterRestart.test.ts`: the restart line carries `turnEnd`; a third boot does not add a second.
- `tests/run/stopThread.test.ts`: Stop's line carries `turnEnd: { interruptedBy: 'user' }` and the turn id.
- Hands-on: Stop a turn, send another; the first reads "Stopped". Kill the dev daemon mid-turn, restart, send another; the first reads "Interrupted" with the tooltip. Real app captures before and after for the PR.

### 4.5 Risks

- Small: a renderer-only reading of an optional field. Wrong classification shows a wrong word, never loses data.

## 5. Related work (checked against `f7a882fda`)

- **Already done:** nothing of these three. #873 (cut-in), #874 (progress line), #880 (thinking line), #881 (restart cut-offs), #872 (Done) are the base.
- **Still needed:** all of §2–§4.
- **Will collide:** #871 (Teams message authors, open) changes `OrchestratorService.ts`, `QueuedMessages.tsx` and `src/shared/types.ts`; its author field on queue items should carry through `returnUnreadSteerItems` and the new held state. Land after #871 or rebase on it.
- **Issues:** #368 is fixed by §3.2 step 4. #514 (Continue on interrupted runs) is separate; the mark here does not add an action. #546 (shortcuts) is unaffected; Send now has no shortcut in this design.

## 6. Rollout

Three PRs, each a run-engine change with its own tests, in this order:

1. **Spikes S1–S3** (no product code; a short note added to this document with what each showed). Decides Claude's `'next'`, Codex native vs fallback, and Pi's abort facts.
2. **PR A: the hold** (§2): `steerDelivery`, `foregroundTools`, `TurnState.heldSteer`, `steer_now`, Claude's targeted `backgroundTasks`, Codex native-or-fallback, ACP and Cursor through the shared hold, the Steer block line and Send now, CLI. Tier 5. Council code gate.
3. **PR B: Pi cut-in** (§3), on top of A. Closes #368. Tier 5. Council code gate.
4. **PR C: the mark** (§4). Independent of A and B; can land first. Tier 4.

No setting. A held steer is a change in timing only; if a release shows a provider whose tool events are unreliable, that provider can be set back to today's behaviour by returning `cut` from `steerDelivery` for it (one line), without touching the others.

## 7. Open questions

For the user:
1. **Progress line.** Keep "Running Bash…" with the steer's wait on the Steer block only (recommended), or also show "Steer waits for Bash" in the progress line?
2. **Send now shortcut.** None in this design (a second Ctrl+Enter is already guarded against by #873). Want one?
3. **Mark words.** "Stopped" and "Interrupted" in the turn header. Different words, or should a Stop by the person have no mark at all (only restarts and crashes)?
4. **Agents and Send now.** Agents cannot force a steer through another thread's command. Agree?

For the council:
1. Is the orchestrator the right place for the hold (one decision in `drainEntry`), rather than each adapter?
2. Codex: native `turn/steer` during commands first, with the hold as fallback if spike S2 is unclear. Or the hold from the start, for one exactly-once path across providers?
3. Is excluding approval-waiting calls from "foreground" right, given the steer then answers the approval as the person (#873)?
4. Pi: is `clear_queue` before `abort` enough to keep exactly-once when a native steer and a cut race at a step boundary?
5. `steer_now` as a new run-engine control command with its own receipt, or a flag on `steer` (`{ now: true }` with no text)?
