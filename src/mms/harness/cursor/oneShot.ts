import { harnessAppError } from '../../../shared/harness/types'
import { providerReportedError } from '../../orchestrator/providerErrors'
import { redactCursorText, type CursorHostError } from '../hosts/cursorProtocol'
import { CursorHostCallError, CursorHostExitedError, type CursorHostClient } from './hostClient'
import { CURSOR_DEFAULT_MODEL } from './session'

/**
 * One Cursor request with no tools (`DriverRuntime.oneShot`): a chat title, a pull request draft or a commit message.
 * It runs on a host of its own, which the caller ends afterwards, in an empty folder with a store of its own (both
 * removed by the caller): a new agent offered no tool and no MCP server (`noTools`, the SDK's `tools: []`), with none
 * of the user's settings layers (rules, hooks, MCP servers, plugins), never saved or resumed, one attempt (the host
 * runs the SDK's retries off). Any tool call Cursor still reports ends the request as refused. `signal` ends the host.
 */

export interface CursorOneShotInput {
  /** A host started for this request only; the caller stops it afterwards. */
  host: CursorHostClient
  apiKey: string
  /** An empty folder made for this request. */
  cwd: string
  /** A store folder made for this request. */
  storeDir: string
  /** `default` lets Cursor choose (its Auto model). */
  model: string
  system: string
  prompt: string
  signal: AbortSignal
  onActivity(): void
  label: string
  /** Cursor refused the credential. */
  markSignedOut(): void
  signInRequiredMessage: string
}

export async function runCursorOneShot(input: CursorOneShotInput): Promise<string> {
  const { host, label, signal } = input
  signal.throwIfAborted()
  let refused: Error | undefined
  const abort = () => host.kill()
  signal.addEventListener('abort', abort, { once: true })
  const failure = (error: unknown): Error => {
    if (error instanceof CursorHostCallError && error.auth) {
      input.markSignedOut()
      return harnessAppError({ code: 'signed_out', message: input.signInRequiredMessage })
    }
    if (error instanceof CursorHostCallError && error.message.trim())
      return providerReportedError(redactCursorText(error.message), { provider: 'cursor', ...(error.status !== undefined ? { status: error.status } : {}), cause: error })
    return error instanceof Error ? error : new Error(String(error))
  }
  try {
    const { agentId } = await host.request('create', {
      apiKey: input.apiKey,
      cwd: input.cwd,
      storeDir: input.storeDir,
      model: { id: input.model || CURSOR_DEFAULT_MODEL },
      mode: 'agent',
      settingSources: [],
      autoReview: true,
      noTools: true
    })
    signal.throwIfAborted()
    input.onActivity()
    const text = [input.system, input.prompt].filter((part) => part.trim()).join('\n\n')
    const { runId } = await host.request('send', { agentId, text })
    signal.throwIfAborted()
    input.onActivity()
    let reply = ''
    const end = await new Promise<{ status: string; error?: CursorHostError; transportFailure?: string } | { hostExited: true }>((resolve) => {
      host.watchRun(runId, {
        update: (update) => {
          if (refused) return
          // A tool is refused before anything else counts: the host ends, and the run with it.
          if (update.type === 'tool-call-started' || update.type === 'tool-call-completed') {
            const call = update.toolCall as { type?: unknown } | undefined
            refused = harnessAppError({ code: 'policy_unenforceable', message: `${label} tried to use a tool (${typeof call?.type === 'string' ? call.type : 'a tool'}) in a request that runs none, so Mousse stopped it.` })
            host.kill()
            return
          }
          input.onActivity()
          if (update.type === 'text-delta' && typeof update.text === 'string') reply += update.text
        },
        end: resolve
      })
    })
    if (refused) throw refused
    signal.throwIfAborted()
    if ('hostExited' in end) throw new CursorHostExitedError('while the request ran')
    if (end.status === 'error') throw failure(end.error ? new CursorHostCallError(end.error) : new Error(`${label} failed.`))
    if (end.transportFailure) throw new Error(`${label} lost its connection to Cursor (${end.transportFailure}).`)
    if (end.status !== 'finished') throw new Error(`${label} stopped the request.`)
    return reply
  } catch (error) {
    if (refused) throw refused
    if (signal.aborted) throw error
    throw failure(error)
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
