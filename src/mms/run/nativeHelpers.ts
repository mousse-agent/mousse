import { createHash } from 'node:crypto'
import type { NativeHelperRuntime, NativeHelperState } from '../../shared/types'
import type { StreamingLlmToolEvent } from '../harness/turnEvents'
import type { AppToolTurn } from './mcp/appTools/types'
import { nativeHelperRules, nativeHelperRuntime, type NativeHelperRules } from './adapters/nativeHelperRuntimes'

/**
 * Native helpers (docs/plans/tool-api.md §2.7): the helpers a provider runtime starts on its own inside a Mousse run,
 * such as Codex's helper threads or Claude Code's Agent subagents. Mousse mirrors each as a watch-only thread made at
 * provider ingestion, and decides here which helper a tool event or a Mousse tool call belongs to.
 *
 * Mirroring creates no authority. A call Mousse can tie to a helper (trusted attribution) runs as that helper, with
 * delegable authority only; a call it cannot tie to anyone while a helper may be running is unattributed and gets the
 * same. Only a call tied to the hosting run itself keeps the run's full authority.
 */

export { nativeHelperRuntime }

/** An agent id that can end a thread id as it is: what the runtimes use (UUIDs, `toolu_…`). Anything else is not mirrored. */
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The mirror thread's id: fixed by the hosting thread, the provider instance, the runtime session and the runtime's agent
 * id, and ending in the agent id. The same helper seen again (more work, a restart that reads it again) lands on the same
 * thread; a helper of another session never does. Undefined for an agent id that cannot end a thread id.
 */
export function nativeMirrorThreadId(input: { hostThreadId: string; instanceId: string; sessionEpoch: string; agentId: string }): string | undefined {
  if (!SAFE_AGENT_ID.test(input.agentId)) return undefined
  const scope = createHash('sha256').update(`${input.hostThreadId}\n${input.instanceId}\n${input.sessionEpoch}`).digest('hex').slice(0, 12)
  return `native-${scope}-${input.agentId}`
}

/** The runtime session a binding's agent ids belong to: a new driver, home or signed-in account is another session. */
export function nativeSessionEpoch(binding: { driver: string; homeId: string; accountGeneration: number }): string {
  return `${binding.driver}:${binding.homeId}:${binding.accountGeneration}`
}

/** What one tool event of a hosting run means for its helpers. */
export type HelperRoute =
  /** Not a helper's: the hosting run's own call. */
  | { kind: 'host' }
  /** A helper's row opened (a launch, or more work for one): its mirror is made or reopened. */
  | { kind: 'start'; agentId: string; parentAgentId?: string; description?: string; agentType?: string }
  /** The open row of a helper said more about it (Claude Code starts an Agent call before its arguments are in). */
  | { kind: 'describe'; agentId: string; description?: string; agentType?: string }
  /** A helper's row closed. `sendTo`: the id the runtime addresses the agent by, when it said. */
  | { kind: 'end'; agentId: string; state: Exclude<NativeHelperState, 'running'>; summary?: string; sendTo?: string }
  /** A call the helper made: it goes to the helper's own log, its parent link dropped when that link is the helper row. */
  | { kind: 'call'; agentId: string; event: StreamingLlmToolEvent }

/** How a helper row's completion reads: never `done` for a row the runtime closed without saying how it ended. */
function endState(event: StreamingLlmToolEvent): Exclude<NativeHelperState, 'running'> {
  const activity = event.activity as { status?: string; interruptedBy?: string } | undefined
  if (activity?.status === 'failed') return 'failed'
  if (activity?.status === 'interrupted') return activity.interruptedBy === 'stop' ? 'stopped' : 'unknown'
  return 'done'
}

/**
 * Follows one hosting thread's tool events and says which helper each belongs to. Codex reports a helper as a row whose
 * call id is `helper:<thread id>` (one per episode of work), with the helper's own calls under it. Claude Code reports
 * an Agent call whose id is the `parent_tool_use_id` of every frame its subagent sends. A helper inside a helper (Claude)
 * is a call in the outer helper's log and a helper of its own, under the outer one.
 */
export class NativeHelperRouter {
  /** The helper each known call belongs to: a helper's own row maps to that helper, a call it made to it as well. */
  private readonly owner = new Map<string, string>()
  /** Call ids of helper rows (Codex has one per episode), by agent. */
  private readonly rows = new Map<string, Set<string>>()
  /** Calls the hosting run made itself. Kept per run: `beginRun` clears them. */
  private readonly hostCalls = new Set<string>()
  /** Helpers whose row is open now. */
  private readonly open = new Set<string>()
  /** Helper rows whose start was reported. */
  private readonly startedRows = new Set<string>()
  private readonly waiters = new Set<() => void>()

  /** What differs between runtimes (`nativeHelperRules`). */
  readonly rules: NativeHelperRules

  constructor(readonly runtime: NativeHelperRuntime) {
    this.rules = nativeHelperRules(runtime)
  }

  /** A new run of the hosting thread starts: the calls of the last one are no longer this run's. */
  beginRun(): void {
    this.hostCalls.clear()
  }

  /** Helpers whose row is open. */
  openHelpers(): string[] {
    return [...this.open]
  }

  /** The agent a helper row's call id stands for, or undefined. */
  private helperRow(event: StreamingLlmToolEvent): string | undefined {
    const activity = event.activity as { kind?: string; nativeId?: string; toolName?: string } | undefined
    if (!event.callId || activity?.kind !== 'subagent') return undefined
    return this.rules.helperRow(event, activity)
  }

  route(event: StreamingLlmToolEvent): HelperRoute {
    const callId = event.callId
    // A helper row's later events (its completion) may no longer carry the fields that named it.
    const row = this.helperRow(event) ?? (callId ? this.rowOf(callId) : undefined)
    const parentAgent = event.parentCallId ? this.owner.get(event.parentCallId) : undefined
    try {
      if (row !== undefined && callId) {
        // The helper's row in its parent's log (the host's, or the outer helper's for a nested one).
        if (!this.rows.has(row)) this.rows.set(row, new Set())
        this.rows.get(row)!.add(callId)
        this.owner.set(callId, row)
        if (event.phase === 'start') {
          const activity = event.activity as { description?: string; agentType?: string } | undefined
          const described = { ...(activity?.description ? { description: activity.description } : {}), ...(activity?.agentType ? { agentType: activity.agentType } : {}) }
          // The same row started again: Claude Code reports the call first, then again once its arguments are in.
          if (this.open.has(row) && this.startedRows.has(callId)) return { kind: 'describe', agentId: row, ...described }
          this.startedRows.add(callId)
          this.open.add(row)
          return {
            kind: 'start',
            agentId: row,
            ...(parentAgent && parentAgent !== row ? { parentAgentId: parentAgent } : {}),
            ...described
          }
        }
        if (event.phase === 'complete') {
          const activity = event.activity as { background?: boolean; status?: string; summary?: string; nativeId?: string } | undefined
          // The launch of a background agent completes the call, not the agent: its row stays open.
          if (this.rules.launchOnly(activity)) return { kind: 'host' }
          this.open.delete(row)
          const sendTo = this.rules.sendTo(activity, row)
          return { kind: 'end', agentId: row, state: endState(event), ...(activity?.summary ? { summary: activity.summary } : {}), ...(sendTo ? { sendTo } : {}) }
        }
        return { kind: 'host' }
      }
      const agent = parentAgent ?? (callId ? this.owner.get(callId) : undefined)
      if (agent !== undefined && callId) {
        this.owner.set(callId, agent)
        // Directly under the helper row: a top-level call in the helper's own log.
        const underRow = event.parentCallId && this.rows.get(agent)?.has(event.parentCallId)
        if (underRow) {
          const { parentCallId: _row, ...own } = event
          return { kind: 'call', agentId: agent, event: own }
        }
        return { kind: 'call', agentId: agent, event }
      }
      if (callId) this.hostCalls.add(callId)
      return { kind: 'host' }
    } finally {
      if (callId) for (const wake of [...this.waiters]) wake()
    }
  }

  /** The hosting run ended: a helper still open ended without the runtime saying how. */
  endRun(): string[] {
    const left = [...this.open]
    this.open.clear()
    return left
  }

  /** Who made a call, by the runtime's id of it: `host`, a helper's agent id, or undefined while it is unknown. */
  ownerOf(callId: string): 'host' | { agentId: string } | undefined {
    if (this.hostCalls.has(callId)) return 'host'
    const agent = this.owner.get(callId)
    return agent !== undefined ? { agentId: agent } : undefined
  }

  /** Whether `agentId` is a helper this thread's runs started. */
  knows(agentId: string): boolean {
    return this.rows.has(agentId)
  }

  /** Whether any helper was ever seen on the thread. */
  hasHelpers(): boolean {
    return this.rows.size > 0
  }

  private rowOf(callId: string): string | undefined {
    const agent = this.owner.get(callId)
    return agent !== undefined && this.rows.get(agent)?.has(callId) ? agent : undefined
  }

  /** Resolves once the call is known, or after `ms` (false then). */
  waitForCall(callId: string, ms: number): Promise<boolean> {
    if (this.ownerOf(callId) !== undefined) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (known: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(known)
      }
      const check = (): void => {
        if (this.ownerOf(callId) !== undefined) done(true)
      }
      const timer = setTimeout(() => done(false), ms)
      timer.unref?.()
      this.waiters.add(check)
    })
  }
}

/**
 * Who made a Mousse tool call that arrived under a hosting run's credential (§2.7 "Execution identity"):
 * - `host`: the run itself, or nobody else could have (no helper of it is open);
 * - `helper`: a helper, by trusted attribution: the runtime, not the model, named the call;
 * - `unattributed`: a helper may be running and nothing ties the call to the run or to one helper.
 */
export type CallAttribution =
  | { kind: 'host' }
  | { kind: 'helper'; agentId: string; mirrorThreadId?: string }
  | { kind: 'unattributed' }

/** What a runtime put in a `tools/call` request's `_meta` that names the call or the thread that made it. */
export interface CallMetaIds {
  /** Claude Code: the tool-use id of the MCP call (`claudecode/toolUseId`). */
  toolUseId?: string
  /** Codex: the Codex thread that made the call (`x-codex-turn-metadata`), when it says. */
  codexThreadId?: string
}

/**
 * The ids a runtime's `_meta` carries. Claude Code (checked in the CLI bundled with @anthropic-ai/claude-agent-sdk
 * 0.3.291) sets `claudecode/toolUseId` on every `tools/call`. Codex 0.167's binary holds an `x-codex-turn-metadata`
 * key with `threadId`, `turnId` and `callId`; its shape on an MCP request was not seen live, so it is read as an object
 * or a JSON string, and only ever narrows (`attributeCall`).
 */
export function callMetaIds(meta: unknown): CallMetaIds {
  if (!meta || typeof meta !== 'object') return {}
  const record = meta as Record<string, unknown>
  const toolUseId = typeof record['claudecode/toolUseId'] === 'string' && record['claudecode/toolUseId'] ? record['claudecode/toolUseId'] : undefined
  let codex = record['x-codex-turn-metadata']
  if (typeof codex === 'string') {
    try {
      codex = JSON.parse(codex)
    } catch {
      codex = undefined
    }
  }
  const threadId = codex && typeof codex === 'object' ? (codex as Record<string, unknown>).threadId ?? (codex as Record<string, unknown>).thread_id : undefined
  return { ...(toolUseId ? { toolUseId } : {}), ...(typeof threadId === 'string' && threadId ? { codexThreadId: threadId } : {}) }
}

const HOSTING_TURN = Symbol('hostingTurn')
const delegableViews = new WeakMap<AppToolTurn, AppToolTurn>()

/**
 * The hosting run's turn as a helper's call holds it: delegable authority only (§1.3 "Subagents"), as a Mousse subagent
 * of the run would. Owner-level tools (theme, applets, questions to the person, secrets, tasks, goals, quick actions)
 * refuse as they do for a subagent. One view per turn, so a check that compares turns still finds the live one
 * (`hostingTurn`).
 */
export function delegableTurn(turn: AppToolTurn): AppToolTurn {
  let view = delegableViews.get(turn)
  if (!view) {
    const { onPublishApplet: _applet, ...rest } = turn
    view = Object.assign({ ...rest, subagent: true }, { [HOSTING_TURN]: turn }) as AppToolTurn
    delegableViews.set(turn, view)
  }
  return view
}

/** The live turn a delegable view stands for (`delegableTurn`), or the turn itself. */
export function hostingTurn(turn: AppToolTurn): AppToolTurn {
  return (turn as AppToolTurn & { [HOSTING_TURN]?: AppToolTurn })[HOSTING_TURN] ?? turn
}

/** How long a call whose tool-use id the hosting run has not reported yet waits for it: the stream can trail the call. */
export const ATTRIBUTION_WAIT_MS = 1500

/**
 * Who made a call (`CallAttribution`). Claude Code's tool-use id, once the run's stream has reported that call, says
 * exactly: a call under a helper's Agent call is that helper's, a top-level call is the run's own. A Codex thread id
 * that names one of the run's helpers ties the call to that helper; any other Codex id is not trusted to mean the run,
 * because Mousse does not know the run's own Codex thread here. Without either, a call made while a helper is open is
 * unattributed, and one made while none is open is the run's.
 */
export async function attributeCall(router: NativeHelperRouter | undefined, ids: CallMetaIds, waitMs = ATTRIBUTION_WAIT_MS): Promise<CallAttribution> {
  // No helper was ever seen on the thread: nobody but the run could have made the call.
  if (!router || !router.hasHelpers()) return { kind: 'host' }
  if (ids.toolUseId && router.rules.attribution === 'tool_use') {
    if (router.ownerOf(ids.toolUseId) === undefined) await router.waitForCall(ids.toolUseId, waitMs)
    const owner = router.ownerOf(ids.toolUseId)
    if (owner === 'host') return { kind: 'host' }
    if (owner) return { kind: 'helper', agentId: owner.agentId }
  }
  if (ids.codexThreadId && router.rules.attribution === 'thread' && router.knows(ids.codexThreadId)) return { kind: 'helper', agentId: ids.codexThreadId }
  return router.openHelpers().length ? { kind: 'unattributed' } : { kind: 'host' }
}
