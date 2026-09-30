# Chat UX — Backend-Authoritative Turn State (Revised Plan)

## 1. Context / Why

Confirmed root cause: no canonical turn state. Renderer re-derives "AI working" via heuristics over `message.streaming|incomplete|thinking.status` in `OrchestratorChat.tsx:111-158` and imperative `loading` boolean toggled by `isTurnActive()` probes + `threads:activity` reconciliation. Backend truth (`turn-started/completed` in `server.ts:274-313`, `ThreadSession.activeTurn`) is swallowed at `protocolEventBridge.ts:230-237` and never reaches renderer. Two chat surfaces diverge (`OrchestratorChat` Zustand vs `MousseAgentChat` local state).

Outcome: orchestrator owns explicit per-turn state machine and pushes `TurnState` snapshot. Spinner = `fn(phase)`, no heuristics/probes. Both chats share same model.

## 2. Goals / Non-Goals

Goals: single source of truth for spinner vs streaming vs awaiting-input; snapshot-correct on thread switch; deterministic `stopped/failed` finalization.

Non-Goals: persisting turn state (ephemeral only), changing `ThreadActivityState` external contract, changing queue semantics.

## 3. Canonical Types — `src/shared/types.ts`

Near `ThreadActivityState` (631):

```ts
export type TurnPhase =
  | 'idle' | 'queued' | 'thinking' | 'streaming'
  | 'tool_running' | 'awaiting_input' | 'finalizing'
  | 'completed' | 'stopped' | 'failed'

export interface TurnState {
  threadId: string
  turnId: string | null
  phase: TurnPhase
  activeMessageId?: string
  startedAt?: string
  updatedAt: string
  error?: string
}
export type TurnStateSnapshot = Record<string, TurnState>
```

Authority rule: `TurnState.phase` is spinner/streaming truth. Per-message `streaming/incomplete` become presentational only. `ThreadActivityState` stays sidebar contract, derived from `TurnPhase` + background agents (not independent).

Derivation (in `ThreadRuntimeManager.ts:23-30` fold):

```
turnPhase -> baseActivity: idle/queued/thinking/streaming/tool_running/finalizing => processing
                           awaiting_input => awaiting_input
                           completed/stopped/failed/idle => idle
then deriveThreadActivity(baseActivity, agents) -> final ThreadActivityState
```

## 4. Backend — Ephemeral State Machine

### 4.1 `OrchestratorService.ts`

Add `private turnStates = new Map<string, TurnState>()`.

Add `private setTurnPhase(threadId, phase, patch?)` — mutates map, sets `updatedAt=now`, keeps `turnId/activeMessageId/startedAt`, emits `this.emit('turn-state', state)`. All transitions reuse existing branches; no new branching:

- `executeTurn` entry (~1953): `queued -> thinking` (also covers accepted queue claim)
- `handleStreamingThinkingEvent start` (1447) / `addStreamingAssistantMessage` (1380): `thinking` / `streaming (+activeMessageId)`
- `handleStreamingToolEvent` start/complete (1485+): `tool_running` then back to `streaming|thinking`
- `questions.pending` via `server.ts:~359` wiring: `awaiting_input`
- `abort` path (2076-2106): `stopped` (retain partial text, `incomplete=true`)
- `ConnectionRetriesExhausted` (2067-2073): `failed` (+error)
- normal completion (2132-2219): `finalizing -> completed` (persist then `completed`)
- `ThreadSession.load/bindThread` restores `idle` (never resurrect stale phase after restart)
- `markThreadDeleted` clears entry

Add `getTurnState(threadId)` + `getTurnSnapshot()` for snapshot path. Keep `isTurnActive()` for CLI/channels runtimes; mark `// retained for non-GUI callers`.

### 4.2 `ThreadSession.ts`

No durable fields. Add transient `turnId/activeMessageId` mirror OR just read from `OrchestratorService.turnStates`. Keep `activeTurn: ActiveTurnControl|null` as underlying signal; `isTurnActive()` stays.

### 4.3 `src/mms/protocol/server.ts`

`wireOrchestratorEvents(203-379)`: subscribe `turn-state -> ring.push('turn.state', state, threadId)`. Replace 4x `setActivity()` calls (274-300) by `publishDerivedActivity` driven from phase (call `runtimeManager.setActivity(threadId, baseActivityFromPhase)`). Keep `turn.steered/questions.cleared` ring pushes only if needed; remove `turn.started/completed/interrupted/aborted` pushes (superseded by `turn.state`). Extend `snapshotThread` to include `turnState` + `turnSnapshot`.

### 4.4 `ThreadRuntimeManager.ts:184-207`

`setActivity` stays but caller becomes `setTurnPhase` path. `publishDerivedActivity` already folds agents via `deriveThreadActivity`. Add `setTurnStatePhase(threadId, phase)-> setActivity(threadId, base)` wrapper. `getActivitySnapshot()` unchanged (still authoritative for sidebar).

## 5. Bridge — `src/main/mms/protocolEventBridge.ts`

Map `turn.state -> orchestrator:turn-state` (per-thread) and new `turns.state -> turns:state` full snapshot (mirror `activity` handling at 216-229). Delete swallow-only branch `case 'turn.*': return true` at 230-237. Keep presentation filtering (`isSelected` not needed for turn — broadcast per-thread + snapshot).

## 6. Main IPC — `src/main/ipc/registerGuiIpc.ts`

- Add `turnStateTracker: Map<string, TurnState>` analogous to `threadActivityTracker`.
- On `event.type==='turn.state'`: merge into tracker, `broadcast('orchestrator:turn-state', state)` + `broadcast('turns:state', snapshot)`.
- On `activity.snapshot`: reconcile but do not derive turn (turn is authority).
- Remove optimistic `setThreadActivity(threadId,'processing')` in `runSend:282` — rely on daemon `queued->thinking`; keep rollback on `catch` -> `idle` only for send failure.
- Keep `orchestrator:isTurnActive` handler (374) for backward compat; add `turn:getSnapshot` if needed for initial paint. Remove `turn.started/completed` busy-id logic (215-230) — replaced by turn-state.

## 7. Renderer — Store

`src/renderer/stores/appStore.ts`:

- Add `turnStates: TurnStateSnapshot`, `setTurnState(s: TurnState)`, `applyTurnSnapshot(map)`.
- Keep `loading` one release behind as deprecated alias (`setLoading` delegates to `turnStates` idle check) or remove after Phase 1 flag; do NOT break `switchToThread:275` `loading:false` — map to `turnStates[activeThreadId]?.phase ?? 'idle'`.
- Update `upsertMessage` guard (180-187) comment: no longer load-bearing.
- Persist key unchanged (no turn state persisted).

`src/renderer/App.tsx:147-220`: wire `window.mousse.turn.onTurnState` / `onTurnSnapshot` (preload) into store.

`src/preload/index.ts:144`: add `turn:{ onTurnState, onSnapshot, getSnapshot }`.

## 8. Shared Helpers — new `src/renderer/utils/turnState.ts`

Pure, tested:

```ts
isResponseActive = p => ['queued','thinking','streaming','tool_running','finalizing'].includes(p)
showPreThinking = (phase, hasThinking) => phase==='queued' || (phase==='thinking' && !hasThinking)
isStreamingMessage = (phase, msgId, activeId) => phase==='streaming' && msgId===activeId
isAwaitingInput = p => p==='awaiting_input'
toActivity = p => (p==='awaiting_input'?'awaiting_input': isResponseActive(p)?'processing': p==='completed'?'completed':'idle')
```

Consumed by both chats.

## 9. Phase 1 — Orchestrator Chat

`OrchestratorChat.tsx`:

- Delete `timelineState` heuristic (111-158), `turnActivityRequestRef` (107), `refreshTurnActive` (288-310) and its `useEffect` (308-310), `loading/activeThreadActivity` selectors.
- Derive `phase = selectTurnPhase(activeThreadId)` + `activeMessageId` from store, `responseActive=isResponseActive(phase)`, `showPreThinking=...`.
- `sendMessage:402,427,434,442` remove `isTurnActive` probes; keep `setLoading(true)` only if keeping alias, else no-op (daemon will push `queued`).
- `ResponseWork.tsx / PreThinkingBlock / ComposerFooter / ChatMessageContent:148-154`: props from helpers; add distinct `awaiting_input` affordance (not spinner).
- Keep `pendingQuestions` modal but spinner now from `awaiting_input` phase (completes UX gap: phase finally has producer).

## 10. Phase 2 — Unify Subagent Chat + Prune

- `MousseAgentService.ts:1064 isTurnActive` stays; add parallel `turnStates` for `mousse-agent:*` runs mapping `MousseAgentRunState (types:655) -> TurnPhase` and bridge as `mousse-agent:turn-state`.
- `MousseAgentChat.tsx`: delete `awaitingResponse` (243-257) + `utils/agentChatMessages.ts:39-70 isAgentAwaitingResponse`. Consume same `turnState.ts` helpers.
- After both chats read phase: retire legacy IPC aliases `orchestrator:message/message-updated` duplicates of `thread-message*` (keep one release if external consumers exist, then remove), dead `awaiting_input`-only sidebar branch, `loading` field and `isTurnActive` GUI polling path (daemon handler stays for CLI).
- Collapse identical `spinner/timeline` render into `ChatMessageContent/ResponseWork` single surface.

## 11. What We Keep (Intentionally)

- `orchestrator:isTurnActive` IPC + `OrchestratorService.isTurnActive` / `ThreadSession.isTurnActive` — required by `ChannelRouter:196`, `CLI runInteractive:166`, `slash handlers:47`, `threadRuntime:56` (non-GUI).
- `ThreadActivityState` external shape — sidebar/notifications contract unchanged.
- `protocolEventBridge` activity broadcast — still used for sidebar dot (now derived, not independent).

## 12. Files Touched

`shared/types.ts` (TurnState), `mms/orchestrator/OrchestratorService.ts` (setTurnPhase), `mms/orchestrator/ThreadSession.ts` (transient mirror), `mms/protocol/server.ts` + `ThreadRuntimeManager.ts:23/184` (derive+snapshot), `main/mms/protocolEventBridge.ts:216-237`, `main/ipc/registerGuiIpc.ts:164/215/282/374`, `main/mms/PresentationState.ts` (if needed), `preload/index.ts:144`, `renderer/stores/appStore.ts:105/255/301`, `renderer/App.tsx:147`, `renderer/utils/turnState.ts` (new), `renderer/components/OrchestratorChat.tsx:111/288`, `renderer/components/MousseAgentChat.tsx:233`, `mms/agents/MousseAgentService.ts:1064`, `utils/agentChatMessages.ts`, `utils/responseTimeline.ts` (heuristic removal).

## 13. Verification

1. `npm run build` / `tsc --noEmit` clean; `npm test` (incl. `tests/opencodeCatalog.test.ts`).
2. New `tests/turnState.test.ts`: pure helper table (queued→thinking→streaming→tool_running→finalizing→completed; →stopped; →failed; →awaiting_input) + folding `deriveThreadActivity` with processing agents.
3. Manual lifecycle: send→ queued spinner persists through thinking/streaming/tool without flicker; stop mid-stream→ stopped (partial retained, spinner gone); user question→ awaiting_input affordance; connection failure→ failed; switch threads mid-turn and back→ snapshot spinner correct; same in subagent tab.
4. Grep clean break for GUI: `rg -n "refreshTurnActive|turnActivityRequestRef" src/renderer` == 0; `rg "setLoading"` only in deprecated alias shim; `isTurnActive` remains only in `src/mms` + `preload` handler.
5. Perf: thread switch no longer re-probes; snapshot is single push.

## 14. Risks & Mitigations

- Stale push after switch: `selectThread` generation guard (`registerGuiIpc:536`) already exists — apply same to `turns:state`.
- `finalizing` race with persist: emit `finalizing` before `persist(true)`, `completed` after; renderer shows spinner through finalize, not stuck.
- Notification: trigger on `phase completed` not `processing->completed` activity edge (move in `registerGuiIpc:176`).
- Rollout: ship Phase 1 behind `featureFlags` `backendTurnState` flag (read in `server.ts`), fallback to heuristic if flag off; remove flag in Phase 2.
