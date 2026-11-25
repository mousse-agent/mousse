import type { BotMcpTool, BotQuickCalls } from '../../../shared/bots/personal/authority'
import { refusalText } from '../../run/mcp/appTools/refusal'

/**
 * The budgets of a bot's chat for its foreground calls that may take a while (`BotQuickCalls`; docs/bots.md, "Quick calls
 * in the chat"): the web, a bound service's read and the owner's MCP tools. The chat has one slot, so none of them may
 * keep it long: a longer job is work's (`work_start`).
 */

/** Longest one foreground call of a chat turn may run. */
export const BOT_CHAT_CALL_MS = 15_000
/** Longest all of a chat turn's foreground calls may run together. */
export const BOT_CHAT_TOOL_MS = 45_000
/** Longest text of one such call's result the chat is given; the rest is cut, and the cut is said. */
export const BOT_CHAT_RESULT_CHARS = 32_000

const STEERED = Symbol('steered')
const DEADLINE = Symbol('deadline')

export interface ChatQuickCallsOptions {
  /** `BOT_CHAT_CALL_MS` unless given (tests). */
  callMs?: number
  /** `BOT_CHAT_TOOL_MS` unless given (tests). */
  turnMs?: number
  /** Monotonic milliseconds. */
  now?: () => number
  /** Whether an MCP tool is known to only read (`BotQuickCalls.mcpReadOnly`). */
  mcpReadOnly(tool: BotMcpTool): boolean
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} seconds`

/** One chat turn's quick calls: what they spent, and the calls known to only read that run now. */
export class ChatQuickCalls implements BotQuickCalls {
  private spentMs = 0
  private readonly reading = new Set<AbortController>()
  private readonly callMs: number
  private readonly turnMs: number
  private readonly now: () => number

  constructor(private readonly options: ChatQuickCallsOptions) {
    this.callMs = options.callMs ?? BOT_CHAT_CALL_MS
    this.turnMs = options.turnMs ?? BOT_CHAT_TOOL_MS
    this.now = options.now ?? (() => performance.now())
  }

  mcpReadOnly(tool: BotMcpTool): boolean {
    return this.options.mcpReadOnly(tool)
  }

  /** The owner wrote while the turn runs: every call known to only read stops now; any other goes on to its end. */
  steered(): void {
    for (const controller of this.reading) controller.abort(STEERED)
  }

  async run<T extends { text: string; isError?: boolean }>(input: { tool: string; readOnly: boolean; signal: AbortSignal; call(signal: AbortSignal): Promise<T> }): Promise<T | { text: string; isError: true; callState?: 'uncertain' }> {
    const left = this.turnMs - this.spentMs
    if (left <= 0) {
      return {
        text: refusalText('work_required', `This turn has used its ${seconds(this.turnMs)} for calls in the chat, so ${input.tool} didn't run. Hand the rest to work with work_start: it has the time.`, { fix: 'work_start' }),
        isError: true
      }
    }
    const ms = Math.min(this.callMs, left)
    const own = new AbortController()
    if (input.readOnly) this.reading.add(own)
    const timer = setTimeout(() => own.abort(DEADLINE), ms)
    timer.unref?.()
    const started = this.now()
    try {
      const call = input.call(AbortSignal.any([input.signal, own.signal]))
      // What comes after the cut is dropped, a failure too.
      call.catch(() => undefined)
      const cut = new Promise<unknown>((resolve) => {
        if (own.signal.aborted) resolve(own.signal.reason)
        else own.signal.addEventListener('abort', () => resolve(own.signal.reason), { once: true })
      })
      const first = await Promise.race([call.then((done) => ({ done }), (error: unknown) => ({ error })), cut.then((reason) => ({ reason }))])
      // A result that settles because the cut stopped it is the cut's, never the call's own words.
      if (!own.signal.aborted) {
        if ('error' in first) throw first.error
        if ('done' in first) return bounded(first.done)
      }
      const reason = own.signal.reason
      if (reason === STEERED) {
        return {
          text: refusalText('cancelled', `Stopped: your owner wrote while ${input.tool} ran, and nothing came of it. Read what they wrote first; call it again only if it is still needed.`, { retry: 'after_change' }),
          isError: true
        }
      }
      const which = ms < this.callMs ? `this turn's ${seconds(this.turnMs)} for calls in the chat` : `the ${seconds(this.callMs)} a call in the chat may take`
      if (input.readOnly) {
        return {
          text: refusalText('work_required', `${input.tool} ran past ${which}, so it was stopped and nothing came of it. Hand this job to work with work_start: it has the time.`, { fix: 'work_start' }),
          isError: true
        }
      }
      // It may have changed something: it was sent, and its time ran out before it answered.
      return {
        text: refusalText('uncertain', `${input.tool} was sent and ran past ${which}, so it can't be told whether it went through. Don't call it again from the chat: tell your owner, and check first or hand it to work with work_start.`, { fix: 'work_start' }),
        isError: true,
        callState: 'uncertain'
      }
    } finally {
      clearTimeout(timer)
      this.reading.delete(own)
      this.spentMs += this.now() - started
    }
  }
}

/** A result within `BOT_CHAT_RESULT_CHARS`. */
function bounded<T extends { text: string }>(outcome: T): T {
  if (outcome.text.length <= BOT_CHAT_RESULT_CHARS) return outcome
  return { ...outcome, text: `${outcome.text.slice(0, BOT_CHAT_RESULT_CHARS)}\n[${outcome.text.length - BOT_CHAT_RESULT_CHARS} more characters were cut]` }
}
