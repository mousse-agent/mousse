/**
 * A turn control on the steer hold for adapter tests (docs/design/steer-and-interruptions.md §2.2, §2.3): the real
 * `SteerHold` and `steerDelivery` decide, fed by what the adapter reports through the sink, the way the orchestrator
 * feeds them. Foreground tools are the calls the sink saw start and not end (a subagent or plan call never counts).
 * Every drain, take, hand-back and acceptance is logged in order, with the time it happened.
 */
import type { TurnControl, TurnSink } from '../../src/mms/harness/adapter'
import { SteerHold } from '../../src/mms/orchestrator/steerHold'
import { steerReleaseWindow, type SteerDelivery } from '../../src/mms/run/CommandPolicy'
import type { ForegroundTool } from '../../src/mms/run/transcript/TranscriptAssembler'
import type { HarnessCaps } from '../../src/shared/harness/types'

interface Pending {
  text: string
  key: string
  person: boolean
}

export interface HoldControl {
  ctl: TurnControl
  /** The adapter's sink, with the hold fed from it (call before handing it to the adapter). */
  wrap<S extends TurnSink>(sink: S): S
  /** A person's steer (or an agent's, `person: false`) arrives. */
  steer(text: string, options?: { person?: boolean }): void
  /** Send now on the hold shown now; the next poll forces it. */
  sendNow(): void
  /** The steer is held now (a hold generation is shown). */
  held(): boolean
  /** Drained (taken off the hold by the adapter) and not handed back yet. */
  drained(): string[]
  /** `[event, detail, ms since the control was made]` in order: drain, taken, returned, accepted, tool, text, boundary. */
  log: Array<[string, string, number]>
  /** The time of the first log entry `event:detail`, or undefined. */
  at(event: string, detail?: string): number | undefined
  pendingTexts(): string[]
  /** Runs once, right before the next `mayCut` answers: something that happens while the cut is on its way. */
  beforeMayCut: (() => void) | undefined
}

export function holdControl(
  caps: Pick<HarnessCaps, 'steer' | 'steerBoundary' | 'steerSettleMs'>,
  options: { strict?: boolean; settleMs?: number } = {}
): HoldControl {
  const startedAt = Date.now()
  const log: Array<[string, string, number]> = []
  const note = (event: string, detail: string): void => void log.push([event, detail, Date.now() - startedAt])
  const open = new Map<string, ForegroundTool & { excluded: boolean }>()
  const release = steerReleaseWindow(caps, options.strict ? 'strict' : undefined)
  const hold = new SteerHold({
    caps,
    strict: release.strict,
    foreground: (waiting) => [...open.values()].filter((tool) => !tool.excluded && !waiting.has(tool.callId)).map(({ callId, toolName, detail }) => ({ callId, toolName, ...(detail ? { detail } : {}) })),
    settleMs: options.settleMs ?? release.settleMs
  })
  const pending: Pending[] = []
  const drains = new Map<string, Pending[]>()
  let seq = 0
  let drainSeq = 0
  const facts = () =>
    pending.length ? { person: pending.some((entry) => entry.person), keys: pending.map((entry) => entry.key), itemIds: pending.map((entry) => entry.key) } : undefined
  const decide = (): { delivery: SteerDelivery; forced: boolean } | undefined => {
    const current = facts()
    if (!current) {
      hold.clear()
      return undefined
    }
    let decision = hold.decide(current)!
    if (decision.delivery === 'hold') hold.hold(current, decision.tools, 'run-1')
    if (hold.settleForces().applied.length) decision = hold.decide(current)!
    return { delivery: decision.delivery, forced: decision.forced }
  }
  const ctl: TurnControl = {
    drainSteer: () => undefined,
    heartbeat: () => {},
    peekSteer: () => {
      const decision = decide()
      return decision ? { delivery: decision.delivery, ...(hold.holdGeneration !== undefined ? { holdGeneration: hold.holdGeneration } : {}) } : undefined
    },
    drainSteerEntry: (opts) => {
      let forced = false
      if (opts?.expect !== undefined) {
        const decision = decide()
        const expected = Array.isArray(opts.expect) ? opts.expect : [opts.expect]
        if (!decision || !expected.includes(decision.delivery)) return undefined
        forced = decision.forced
      }
      if (!pending.length) return undefined
      const taken = pending.splice(0)
      const token = `drain-${++drainSeq}`
      drains.set(token, taken)
      hold.drained(token, forced)
      const text = taken.map((entry) => entry.text).join('\n')
      note('drain', text)
      return { text, token, cut: taken.some((entry) => entry.person), ...(forced ? { forced: true } : {}) }
    },
    mayCut: (token) => {
      const before = control.beforeMayCut
      control.beforeMayCut = undefined
      before?.()
      const may = hold.mayCut(token)
      note('mayCut', String(may))
      return may
    },
    steerTaken: (token) => note('taken', token ?? ''),
    returnSteer: (text, token) => {
      note('returned', text)
      const entries = token ? drains.get(token) : undefined
      if (token) drains.delete(token)
      pending.unshift(...(entries ?? [{ text, key: `returned:${++seq}`, person: true }]))
    }
  }
  const wrap = <S extends TurnSink>(sink: S): S => {
    // Own properties: callers spread a sink.
    const wrapped = { ...sink } as S
    wrapped.tool = (event) => {
      if (event.phase === 'start') {
        const activity = event.activity as { kind?: string; command?: string } | undefined
        open.set(event.callId, {
          callId: event.callId,
          toolName: event.title,
          ...(activity?.command ? { detail: activity.command } : {}),
          excluded: Boolean(event.parentCallId) || activity?.kind === 'subagent' || activity?.kind === 'plan'
        })
      } else if (event.phase === 'complete') open.delete(event.callId)
      note('tool', `${event.phase}:${event.callId}`)
      sink.tool(event)
      hold.toolEvent()
    }
    wrapped.text = (event) => {
      hold.modelOutput(event.phase)
      if (event.phase === 'delta') note('text', event.content)
      sink.text(event)
    }
    wrapped.thinking = (event) => {
      hold.modelOutput(event.phase)
      sink.thinking(event)
    }
    wrapped.toolAwaiting = (callId, waiting) => {
      note('awaiting', `${callId}:${waiting}`)
      hold.awaiting(callId, waiting)
    }
    wrapped.boundary = () => {
      note('boundary', '')
      hold.boundary()
    }
    wrapped.providerTurn = () => {
      note('providerTurn', '')
      hold.providerTurn()
    }
    wrapped.steerAccepted = (text, token) => {
      note('accepted', `${text}${token ? `@${token}` : ''}`)
      if (token) drains.delete(token)
      sink.steerAccepted(text, token)
    }
    return wrapped
  }
  const control: HoldControl = {
    beforeMayCut: undefined,
    ctl,
    wrap,
    log,
    steer: (text, steerOptions = {}) => void pending.push({ text, key: `item:${++seq}`, person: steerOptions.person !== false }),
    sendNow: () => {
      const generation = hold.holdGeneration
      if (generation === undefined) throw new Error('Send now with nothing held')
      hold.requestForce({ holdGeneration: generation, requestId: `now-${++seq}`, itemIds: [] })
    },
    held: () => hold.holdGeneration !== undefined,
    drained: () => [...drains.values()].map((entries) => entries.map((entry) => entry.text).join('\n')),
    at: (event, detail) => log.find(([name, value]) => name === event && (detail === undefined || value === detail))?.[2],
    pendingTexts: () => pending.map((entry) => entry.text)
  }
  return control
}
