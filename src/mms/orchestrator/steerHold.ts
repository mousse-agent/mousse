import type { HarnessCaps } from '../../shared/harness/types'
import type { HeldSteer } from '../../shared/types'
import { STEER_SETTLE_MS, steerDelivery, type SteerDelivery } from '../run/CommandPolicy'
import type { ForegroundTool } from '../run/transcript/TranscriptAssembler'

/**
 * One turn's steer hold (docs/design/steer-and-interruptions.md §2.2, §2.3, §2.9): what the turn is doing that decides
 * whether a pending steer cuts in now or waits for a foreground tool, the release window after a tool on a `start`
 * provider, the hold generation a Send now click names, and the forces Send now asked for. It takes nothing and saves
 * nothing: the orchestrator reads it on every peek and drain, and the adapter checks `mayCut` right before its cut.
 */

/** A pending steer's facts as the decision needs them. */
export interface PendingSteerFacts {
  /** A person's message is among them: it must reach the model now or once the tool ends. */
  person: boolean
  /** Identity of each pending entry (its queue item id, or one given to an entry with none). */
  keys: string[]
  /** The queue items among them, for `HeldSteer.itemIds`. */
  itemIds: string[]
}

/** A Send now request the hold has not consumed yet. */
export interface SteerForce {
  holdGeneration: number
  requestId: string
  /** The held items the click named; every one must still be held. Empty: an owner-process click about entries with no item. */
  itemIds: string[]
  /**
   * False while the request is not recorded yet (this process's click, before its command committed): it is kept and
   * never applied, so a command is never stopped without a receipt, a journal entry and its audit event.
   */
  ready?: boolean
}

export interface SteerHoldOptions {
  caps: Pick<HarnessCaps, 'steer' | 'steerBoundary'>
  /** `runs.steerRelease[instance] === 'strict'`. */
  strict: boolean
  /** The turn's foreground tools now, leaving out the calls a person is asked about. */
  foreground: (waitingOnPerson: ReadonlySet<string>) => ForegroundTool[]
  /**
   * One of the turn's own (root) calls asks the person a question no call reported (`awaiting`): Mousse asks it for
   * its own tools (`ask_user`, a quick action's or a relayed tool's approval). Like a reported one, it means the turn
   * waits for a person, so a steer goes in and answers it. A subagent's question never counts.
   */
  asking?: () => boolean
  /** The release window after the last foreground tool (`start` providers). */
  settleMs?: number
  /**
   * How long a compaction holds a steer at most: past it, one whose end was never reported holds nothing. Unset: until
   * its end (a bot's turn sets it, so a note never waits for the whole dispatch).
   */
  compactionLimitMs?: number
  now?: () => number
}

export interface SteerDecision {
  delivery: SteerDelivery
  /** The hold a click was shown for: set while the decision is `hold`, and for a forced cut. */
  holdGeneration?: number
  forced: boolean
  tools: ForegroundTool[]
}

const sameSet = (a: ReadonlySet<string>, b: readonly string[]): boolean => a.size === b.length && b.every((key) => a.has(key))

export class SteerHold {
  private readonly waitingOnPerson = new Set<string>()
  /** When a tool event of the turn last arrived; undefined until the first. */
  private lastToolEventAt: number | undefined
  /** A model response began after the last tool event, and wrote: the release window is closed. */
  private responseSinceTool = false
  private outputSinceTool = false
  private atBoundary = false
  /** The provider compacts its context: a steer waits for it, and never stops it (§3.1). */
  private compactingNow = false
  /** When the compaction started (`compactionLimitMs`). */
  private compactingSince: number | undefined
  /** Only ever rises within a run (§0). */
  private generation = 0
  private heldKeys: Set<string> | undefined
  private heldSince: string | undefined
  /** The hold a drain took, so a hand-back of the same steers resumes it in the same generation. */
  private released: { keys: Set<string>; generation: number } | undefined
  /** The last tool the hold named: kept while the release window is open after its result. */
  private lastWaitsFor: { name: string; detail?: string } | undefined
  /** Send now requests not yet consumed. */
  private readonly forces: SteerForce[] = []
  /** Every request id this hold was given: a click replayed with the same id is not checked (or reported) again. */
  private readonly requestIds = new Set<string>()
  /** The generation a valid Send now forced; the next drain takes it. */
  private forcedGeneration: number | undefined
  /** Drains made under a force: they may always cut. */
  private readonly forcedTokens = new Set<string>()
  private readonly settleMs: number
  private readonly now: () => number

  constructor(private readonly options: SteerHoldOptions) {
    this.settleMs = options.settleMs ?? STEER_SETTLE_MS
    this.now = options.now ?? Date.now
  }

  /** The provider has not adopted the hold: a steer cuts in at once, as before. */
  get adopted(): boolean {
    return (this.options.caps.steerBoundary ?? 'none') !== 'none'
  }

  /** Any tool event of the turn (a start, an update, a result): the release window starts again. */
  toolEvent(): void {
    this.lastToolEventAt = this.now()
    this.responseSinceTool = false
    this.outputSinceTool = false
    this.atBoundary = false
  }

  /**
   * Text or reasoning from the model. Only a response that began after the last tool event closes the window: its
   * start, then its first delta. A tool's own output is a tool event, never this.
   */
  modelOutput(phase: 'start' | 'delta' | 'complete'): void {
    this.atBoundary = false
    if (this.lastToolEventAt === undefined) return
    if (phase === 'start') this.responseSinceTool = true
    else if (phase === 'delta' && this.responseSinceTool) this.outputSinceTool = true
  }

  /** The provider's own turn ended and nothing runs (`TurnSink.boundary`); `false`: its next request started. */
  boundary(at = true): void {
    this.atBoundary = at
  }

  /** The provider began another turn of its own (`TurnSink.providerTurn`): the boundary is over. */
  providerTurn(): void {
    this.atBoundary = false
  }

  /** A person is asked about `callId`: it is not a foreground tool while they are. */
  awaiting(callId: string, waiting: boolean): void {
    if (waiting) this.waitingOnPerson.add(callId)
    else this.waitingOnPerson.delete(callId)
  }

  /** A compaction of the turn's context starts (`true`) or ends: while it runs, a held steer waits for it. */
  compacting(active: boolean): void {
    this.compactingNow = active
    this.compactingSince = active ? this.now() : undefined
  }

  foregroundTools(): ForegroundTool[] {
    const tools = this.options.foreground(this.waitingOnPerson)
    const limit = this.options.compactionLimitMs
    const compacting = this.compactingNow && (limit === undefined || this.now() - (this.compactingSince ?? 0) < limit)
    return compacting ? [{ callId: 'compaction', toolName: 'compaction' }, ...tools] : tools
  }

  /** The window after the last foreground tool's result is still open (`start` providers only). */
  releaseOpen(): boolean {
    // At the provider's turn end no call of that turn can start any more: there is nothing left to wait out.
    if (this.options.caps.steerBoundary !== 'start' || this.lastToolEventAt === undefined || this.outputSinceTool || this.atBoundary) return false
    return this.now() - this.lastToolEventAt < this.settleMs
  }

  get holdGeneration(): number | undefined {
    return this.heldKeys ? this.generation : undefined
  }

  /** Whether `key` is held now. */
  holds(key: string): boolean {
    return this.heldKeys?.has(key) === true
  }

  /**
   * A Send now request for this turn. It is checked at the next decision against the hold then. Idempotent: a request
   * id the hold already has (pending, or settled once) changes nothing, so a replayed click neither forces again nor
   * is reported a second time. Returns whether the request was new. A recorded copy of a request still waiting to be
   * recorded here (the queue field the journal wrote) makes it ready.
   */
  requestForce(force: SteerForce): boolean {
    if (this.requestIds.has(force.requestId)) {
      if (force.ready !== false) this.readyForce(force.requestId)
      return false
    }
    this.requestIds.add(force.requestId)
    this.forces.push(force)
    return true
  }

  /** The request is recorded (its command committed): the next decision may apply it. */
  readyForce(requestId: string): void {
    const force = this.forces.find((entry) => entry.requestId === requestId)
    if (force) force.ready = true
  }

  /** The request was not accepted (its run is not the active one): it forces nothing. */
  dropForce(requestId: string): void {
    const index = this.forces.findIndex((entry) => entry.requestId === requestId)
    if (index >= 0) this.forces.splice(index, 1)
    this.requestIds.delete(requestId)
  }

  /** A force for `requestId` is waiting to be checked. */
  forcePending(requestId: string): boolean {
    return this.forces.some((entry) => entry.requestId === requestId)
  }

  /**
   * Checks the waiting Send now requests against the hold now. Valid: the click's generation is the current hold's
   * and every item it named is still held; the next drain is then forced. Every request is settled here, once.
   * `person`: the held batch has a person's steer. Only that can be forced (`steerDelivery`: an agent's steer or a
   * notice is never forced), so a click on any other hold is stale.
   */
  settleForces(person = true): { applied: SteerForce[]; stale: SteerForce[] } {
    const applied: SteerForce[] = []
    const stale: SteerForce[] = []
    // A request not recorded yet waits; it is checked once its command committed.
    const unrecorded = this.forces.filter((force) => force.ready === false)
    const recorded = this.forces.filter((force) => force.ready !== false)
    this.forces.splice(0, this.forces.length, ...unrecorded)
    for (const force of recorded) {
      const valid = person && this.heldKeys !== undefined && force.holdGeneration === this.generation && force.itemIds.every((id) => this.heldKeys!.has(id))
      if (valid && this.forcedGeneration !== this.generation) {
        this.forcedGeneration = this.generation
        applied.push(force)
      } else if (valid) {
        // Another click for the hold already forced: nothing more to do, and it was not stale.
        applied.push(force)
      } else stale.push(force)
    }
    return { applied, stale }
  }

  /** What a drain of `pending` would do now. Undefined `pending`: nothing waits. */
  decide(pending: PendingSteerFacts | undefined): SteerDecision | undefined {
    if (!pending) return undefined
    const tools = this.adopted ? this.foregroundTools() : []
    const forced = this.forcedGeneration !== undefined && this.forcedGeneration === this.generation && this.heldKeys !== undefined
    // The turn waits for a person's answer and no other tool runs: nothing can start until they answer, so neither the
    // window nor strict release keeps the steer back. It cuts, and answers the ask (§2.1).
    const asking = this.askingOnly(tools)
    const delivery = steerDelivery(this.options.caps, {
      foreground: tools.length,
      releaseOpen: this.adopted && !asking && this.releaseOpen(),
      strict: this.options.strict,
      held: this.heldKeys !== undefined && !asking,
      atBoundary: this.atBoundary,
      forced
    }, { person: pending.person })
    return { delivery, forced: forced && delivery === 'cut', tools, ...(delivery === 'hold' || forced ? { holdGeneration: this.generation } : {}) }
  }

  /**
   * The decision is `hold`: the held steers are `pending.keys`. A new hold, or a steer joining one, raises the
   * generation; the same steers handed back resume the hold they left. Returns what windows show.
   */
  hold(pending: PendingSteerFacts, tools: ForegroundTool[], runId: string | undefined): HeldSteer {
    if (!this.heldKeys) {
      const resumed = this.released && sameSet(this.released.keys, pending.keys)
      if (!resumed) this.generation++
      this.heldSince = new Date(this.now()).toISOString()
    } else if (!sameSet(this.heldKeys, pending.keys)) {
      this.generation++
    }
    this.released = undefined
    this.heldKeys = new Set(pending.keys)
    const oldest = tools[0]
    if (oldest) this.lastWaitsFor = { name: oldest.toolName, ...(oldest.detail ? { detail: oldest.detail } : {}) }
    // No call of the turn runs and the window after the last one has closed: strict release keeps the steer for the
    // provider's turn end, so the line says that, not the name of a tool that finished.
    const turnEnd = tools.length === 0 && !this.releaseOpen()
    const waits = this.lastWaitsFor ?? { name: 'tool' }
    return {
      waitsFor: turnEnd ? 'turn' : waits.name,
      ...(turnEnd ? { untilTurnEnd: true } : waits.detail ? { detail: waits.detail } : {}),
      tools: tools.length,
      ...(tools.length > 1 ? { toolList: tools.map((tool) => ({ name: tool.toolName, ...(tool.detail ? { detail: tool.detail } : {}) })) } : {}),
      since: this.heldSince ?? new Date(this.now()).toISOString(),
      holdGeneration: this.generation,
      itemIds: pending.itemIds,
      ...(runId ? { runId } : {})
    }
  }

  /** A drain took the pending steers under `token`. A forced drain may always cut; the hold is over until a hand-back. */
  drained(token: string, forced: boolean): void {
    if (forced) {
      this.forcedTokens.add(token)
      this.forcedGeneration = undefined
    }
    if (this.heldKeys) this.released = { keys: this.heldKeys, generation: this.generation }
    this.heldKeys = undefined
    this.heldSince = undefined
  }

  /** Nothing is pending any more (it went in, or it left the turn): the hold is over. */
  clear(): void {
    this.heldKeys = undefined
    this.heldSince = undefined
    this.forcedGeneration = undefined
  }

  /** The check at dispatch (`TurnControl.mayCut`). */
  mayCut(token: string): boolean {
    if (this.forcedTokens.has(token)) return true
    if (!this.adopted) return true
    const tools = this.foregroundTools()
    return tools.length === 0 && (this.askingOnly(tools) || !this.releaseOpen())
  }

  /** A person is asked about a call (or Mousse asks them for one of its own tools), and no foreground tool runs besides. */
  private askingOnly(tools: ForegroundTool[]): boolean {
    return tools.length === 0 && (this.waitingOnPerson.size > 0 || this.options.asking?.() === true)
  }
}
