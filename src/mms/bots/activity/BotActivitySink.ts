import type { BotAllowedObserver, NormalisedCall } from '../../../shared/bots/personal/authority'
import type { BotChip } from '../../../shared/bots/personal/chat'
import { chipForCall, rollUpChips, type BotChipCall, type BotChipContext } from '../../../shared/bots/personal/chips'
import { stableStringify } from '../../run/json'
import type { BotActivityContext, BotActivitySink } from '../seams'

/**
 * Activity chips in the daemon (Bot Phase 1 §5.8). Every call a bot's authority allows lands here
 * (`observer`, wired into `createBotAuthority`'s `onAllowed`): it is kept for its dispatch and shown
 * at once as a live chip (`bots.activity`, at most four a second per activation). App tools report
 * their results (`onAppResult`) for outcome chips. When the dispatch settles, `drain` rolls its calls
 * up into the chips of the message row and clears the live chip. Nothing is stored: a daemon that
 * restarts mid-dispatch loses that dispatch's chips, not its message.
 */

export interface BotActivityEvent {
  botId: string
  activationId: string
  /** Null: the activation shows no live chip any more. */
  chip: BotChip | null
}

export interface BotActivitySinkOptions {
  /** Sends `bots.activity`. Must not throw. */
  emit(event: BotActivityEvent): void
  /** Where the bot's files folder and scratch folder are, and the owner's home, for highlights. */
  chipContext?(ctx: BotActivityContext): BotChipContext
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/** At most one live chip per activation in this long (four a second). */
export const BOT_ACTIVITY_MIN_INTERVAL_MS = 250

/**
 * One call is checked at several points (locked Claude: PreToolUse, canUseTool and the app-tool
 * registry; Pi: its gate and the registry), and each allowed check reports it. The same tool with
 * the same input within this long of its first report, in one dispatch, is that same call.
 */
export const BOT_ACTIVITY_SAME_CALL_MS = 5_000

interface DispatchActivity {
  ctx: BotActivityContext
  chipContext: BotChipContext
  calls: BotChipCall[]
  /** When each call (tool and input) was first reported, to count a call checked several times once. */
  seen: Map<string, number>
}

interface LiveState {
  botId: string
  lastAt: number
  chip?: BotChip
  pending?: BotChip
  timer?: unknown
}

/** A call as the chips read it: the neutral or app-tool name and its arguments. */
export function chipCallOf(call: NormalisedCall): { tool: string; input: unknown } {
  switch (call.kind) {
    case 'builtin':
    case 'app':
      return { tool: call.tool, input: call.args }
    case 'mcp':
      return { tool: 'mcp', input: { server: call.server, tool: call.tool } }
    case 'skill':
      return { tool: 'skill', input: { skill: call.skill } }
  }
}

export class BotActivityLog implements BotActivitySink {
  private readonly dispatches = new Map<string, DispatchActivity>()
  /** The dispatch an activation's calls belong to now: app tools know only the activation. */
  private readonly current = new Map<string, string>()
  private readonly live = new Map<string, LiveState>()

  constructor(private readonly options: BotActivitySinkOptions) {}

  /** The `onAllowed` observer of one dispatch's authority. */
  observer(ctx: BotActivityContext): BotAllowedObserver {
    return (call) => this.onAllowed(ctx, chipCallOf(call))
  }

  onAllowed(ctx: BotActivityContext, call: { tool: string; input: unknown }): void {
    try {
      const dispatch = this.dispatch(ctx)
      const key = `${call.tool}\u0000${stableStringify(call.input ?? null)}`
      const at = this.now()
      const first = dispatch.seen.get(key)
      if (first !== undefined && at - first < BOT_ACTIVITY_SAME_CALL_MS) return
      dispatch.seen.set(key, at)
      dispatch.calls.push({ tool: call.tool, input: call.input })
      const chip = chipForCall(call.tool, call.input, dispatch.chipContext)
      if (chip) this.show(ctx, chip)
    } catch (error) {
      // An observer of the authority never fails the call it watched.
      console.warn('[bots] could not record activity', { activationId: ctx.activationId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * An app tool returned. App tools know their activation but not the dispatch: an empty
   * `dispatchId` means the activation's current one (its authority allowed the call just before).
   */
  onAppResult(ctx: BotActivityContext, tool: string, result: unknown): void {
    const dispatchId = ctx.dispatchId || this.current.get(ctx.activationId)
    const dispatch = dispatchId ? this.dispatches.get(dispatchId) : undefined
    if (!dispatch) return
    const call = [...dispatch.calls].reverse().find((entry) => entry.tool === tool && entry.result === undefined)
    if (call) call.result = result
    else dispatch.calls.push({ tool, input: undefined, result })
  }

  drain(dispatchId: string): BotChip[] {
    const dispatch = this.dispatches.get(dispatchId)
    if (!dispatch) return []
    this.dispatches.delete(dispatchId)
    const { activationId, botId } = dispatch.ctx
    if (this.current.get(activationId) === dispatchId) {
      this.current.delete(activationId)
      this.clearLive(activationId, botId)
    }
    return rollUpChips(dispatch.calls, dispatch.chipContext)
  }

  /** The activation's live chip now, for `bots.chat.list`. */
  liveChip(activationId: string): BotChip | undefined {
    return this.live.get(activationId)?.chip
  }

  private dispatch(ctx: BotActivityContext): DispatchActivity {
    let dispatch = this.dispatches.get(ctx.dispatchId)
    if (!dispatch) {
      dispatch = { ctx: { ...ctx }, chipContext: this.options.chipContext?.(ctx) ?? {}, calls: [], seen: new Map() }
      this.dispatches.set(ctx.dispatchId, dispatch)
    }
    this.current.set(ctx.activationId, ctx.dispatchId)
    return dispatch
  }

  /** Shows `chip` now, or when the activation's last one is a quarter of a second old (the latest wins). */
  private show(ctx: BotActivityContext, chip: BotChip): void {
    const now = this.now()
    const state = this.live.get(ctx.activationId) ?? { botId: ctx.botId, lastAt: -Infinity }
    this.live.set(ctx.activationId, state)
    state.chip = chip
    const wait = state.lastAt + BOT_ACTIVITY_MIN_INTERVAL_MS - now
    if (wait <= 0 && state.timer === undefined) {
      state.lastAt = now
      this.emit({ botId: ctx.botId, activationId: ctx.activationId, chip })
      return
    }
    state.pending = chip
    if (state.timer !== undefined) return
    state.timer = this.setTimer(() => {
      state.timer = undefined
      const pending = state.pending
      state.pending = undefined
      if (!pending || this.live.get(ctx.activationId) !== state) return
      state.lastAt = this.now()
      this.emit({ botId: state.botId, activationId: ctx.activationId, chip: pending })
    }, Math.max(0, wait))
  }

  private clearLive(activationId: string, botId: string): void {
    const state = this.live.get(activationId)
    if (!state) return
    if (state.timer !== undefined) this.clearTimer(state.timer)
    this.live.delete(activationId)
    this.emit({ botId, activationId, chip: null })
  }

  private emit(event: BotActivityEvent): void {
    try {
      this.options.emit(event)
    } catch (error) {
      console.warn('[bots] could not send activity', { activationId: event.activationId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(fn, ms)
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) this.options.clearTimer(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** The sink `MmsProfileServices` hands to `BotEngine` and the bot app tools. */
export function createBotActivitySink(options: BotActivitySinkOptions): BotActivityLog {
  return new BotActivityLog(options)
}
