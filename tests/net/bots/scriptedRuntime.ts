import type {
  BotRunEvents,
  BotRunRequest,
  BotRunResult,
  BotRuntimeAdapter,
  BotSpendPort
} from '../../../src/mms/net/contracts'
import { NetError, type BotProfile } from '../../../src/shared/net'
import {
  NativeReader,
  ReaderToolPort,
  readerToolDefinitions,
  type NativeBotDefinition,
  type NativeReaderModule
} from '../../../src/mms/bots/space/runtime'

export interface ScriptedRunContext {
  request: BotRunRequest
  events: BotRunEvents
  spend: BotSpendPort
}

export interface ScriptedBotRuntimeOptions {
  id?: string
  profiles?: readonly BotProfile[]
  /** Final text of a normal run. */
  answer?: string
  /** Units settled for the single reserved call. */
  units?: number
  /** Units reserved before the call (the qualified maximum). */
  maximumUnits?: number
  /** Hold every run until `release()` or, unless `stubborn`, until the run is aborted. */
  paused?: boolean
  /** Keep holding after the run is aborted; only `release()` ends the run. */
  stubborn?: boolean
  /** Replaces the default body. The reserved call is still settled with `units` afterwards. */
  script?(context: ScriptedRunContext): Promise<string>
  /** The script reserves and settles its own calls; the runtime does not. */
  spendInScript?: boolean
}

/**
 * Test-only bot runtime. It has no model path: each run reserves one spend call, runs the
 * optional script, settles `units` and returns `answer`. Pass it through `trustedQaAdapters`.
 */
export class ScriptedBotRuntime implements BotRuntimeAdapter {
  readonly id: string
  readonly runs: BotRunRequest[] = []
  readonly signals: AbortSignal[] = []
  private releases = new Set<() => void>()

  constructor(readonly options: ScriptedBotRuntimeOptions = {}) {
    this.id = options.id ?? 'mousse'
  }

  supports(profile: BotProfile): boolean {
    return (this.options.profiles ?? ['chat']).includes(profile)
  }

  release(): void {
    for (const release of [...this.releases]) release()
  }

  async run(request: BotRunRequest, events: BotRunEvents): Promise<BotRunResult> {
    this.runs.push(request)
    this.signals.push(request.signal)
    if (!this.supports(request.profile)) throw new NetError('profile_unsupported')
    if (request.signal.aborted) throw new NetError('cancelled')
    // The reported spend is exactly what this run settled, whoever settled it.
    let spent = 0
    const spend: BotSpendPort = {
      authorizeCall: (maximumUnits) => request.spend.authorizeCall(maximumUnits),
      settleCall: async (id, spentUnits) => {
        await request.spend.settleCall(id, spentUnits)
        spent += spentUnits
      },
      remainingUnits: () => request.spend.remainingUnits()
    }
    const units = this.options.units ?? 10,
      call = this.options.spendInScript
        ? { id: 'script-owned' }
        : await spend.authorizeCall(this.options.maximumUnits ?? 60)
    // A real provider answers after some latency, never within the same tick; concurrent
    // mentions rely on that gap for their outbox flushes to interleave as in production.
    if (!this.options.paused) await new Promise<void>((resolve) => setTimeout(resolve, 10))
    let late: Promise<void> | undefined
    try {
      if (this.options.paused) {
        const held = new Promise<void>((resolve) => {
          const done = () => {
            this.releases.delete(done)
            resolve()
          }
          this.releases.add(done)
          if (!this.options.stubborn) request.signal.addEventListener('abort', done, { once: true })
        })
        if (this.options.stubborn) {
          // A runtime that cannot stop reports unproven quiescence; its late usage still settles.
          late = held.then(() => spend.settleCall(call.id, units))
          late.catch(() => undefined)
          await Promise.race([
            held,
            new Promise<never>((_, reject) =>
              request.signal.addEventListener(
                'abort',
                () =>
                  // The runtime waits out a short drain before it gives up on the provider.
                  setTimeout(
                    () =>
                      reject(
                        new NetError('outcome_uncertain', 'Provider did not stop.', {
                          details: { quiesced: false }
                        })
                      ),
                    50
                  ),
                { once: true }
              )
            )
          ])
        } else await held
      }
      const text = this.options.script
        ? await this.options.script({ request, events, spend })
        : (this.options.answer ?? 'Scripted answer')
      // Known terminal spend is settled even when the run was cancelled meanwhile.
      if (!this.options.spendInScript) await (late ?? spend.settleCall(call.id, units))
      if (request.signal.aborted) throw new NetError('cancelled')
      return { text, spentUnits: spent }
    } catch (error) {
      const failure = error instanceof NetError ? error : new NetError('outcome_uncertain')
      if (failure.details && typeof failure.details === 'object' && 'quiesced' in failure.details)
        throw failure
      throw new NetError(failure.code, failure.message, {
        cause: failure,
        details: { quiesced: true }
      })
    }
  }
}

export interface ReaderAction {
  name: string
  arguments: Record<string, unknown>
}

export interface ReaderScriptOptions {
  module: NativeReaderModule
  deniedRoots: readonly string[]
  installationHome: string
  definition: NativeBotDefinition
  /** The tool calls the scripted model asks for in its first step. Defaults to one `safe_read` of `path`. */
  actions?: readonly ReaderAction[]
  /** The one file the default action reads. */
  path?: string
  answer: string
  /** Re-checks that the execution is still current (the admission service's own check). */
  current(request: BotRunRequest): void
  /** One entry per scripted model step: the tool inventory first, then the tool results it received. */
  record(step: { tools?: string[]; toolResults?: unknown[] }): void
  /** When set, each scripted model step reserves `maximumUnits` and settles `units` itself. */
  spend?: { maximumUnits: number; units: number }
}

/**
 * A script that drives the real reader dispatcher and native reader. Like the former model
 * loop, a refused or failed tool call becomes an error result; a cancelled run ends the script.
 */
export function readerScript(options: ReaderScriptOptions) {
  const actions: readonly ReaderAction[] = options.actions ?? [
    { name: 'safe_read', arguments: { path: options.path ?? '' } }
  ]
  return async ({ request, events, spend }: ScriptedRunContext): Promise<string> => {
    const abort = new AbortController(),
      signal = AbortSignal.any([request.signal, abort.signal]),
      current = () => {
        options.current(request)
        if (signal.aborted) throw new NetError('cancelled')
      },
      modelStep = async (step: { tools?: string[]; toolResults?: unknown[] }) => {
        current()
        const call = options.spend
          ? await spend.authorizeCall(options.spend.maximumUnits)
          : undefined
        options.record(step)
        if (call) await spend.settleCall(call.id, options.spend!.units)
      },
      tools = readerToolDefinitions(options.definition.readerTools).map((t) => t.name)
    await modelStep({ tools })
    const reader = new NativeReader(
      options.module,
      request.projectRoot!,
      [options.installationHome, ...options.deniedRoots],
      signal
    )
    try {
      const port = new ReaderToolPort(
        reader,
        options.definition,
        request,
        events,
        current,
        signal,
        () => abort.abort()
      )
      const results: unknown[] = []
      for (const [index, action] of actions.entries()) {
        const call = { type: 'toolCall' as const, id: `reader-${index}`, ...action }
        try {
          results.push(await port.execute(call))
        } catch (error) {
          if (signal.aborted) throw new NetError('cancelled')
          current()
          results.push({
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: error instanceof Error ? error.message : 'failed' }],
            isError: true,
            timestamp: Date.now()
          })
        }
      }
      await modelStep({ tools, toolResults: results })
      return options.answer
    } finally {
      reader.close()
    }
  }
}
