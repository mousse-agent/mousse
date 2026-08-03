/**
 * CLI MMS client access.
 * Normal commands always connect to the daemon via LocalMmsClient.
 * Daemon ownership is only via `cli/daemonOwner.ts` used by `service run`.
 */

import type { CliGlobals } from './parseArgs'
import { resolveMousseHome } from './paths'
import { exitWithError } from './output'
import { connectDaemonClient, type DaemonClient } from './daemonClient'

export interface MmsContext {
  homeDir: string
  /** Protocol client to the daemon (required for all normal CLI commands). */
  client: DaemonClient
}

/**
 * Open MMS for normal CLI commands: ensure daemon is running and connect as client.
 * Never acquires an owner lease.
 */
export async function openMms(globals: CliGlobals): Promise<MmsContext> {
  const homeDir = resolveMousseHome(globals.homeDir || undefined)
  try {
    const client = await connectDaemonClient({ homeDir })
    if (globals.provider || globals.model) {
      const partial: Record<string, unknown> = { provider: {} }
      if (globals.provider) {
        ;(partial.provider as Record<string, unknown>).llmProvider = globals.provider
      }
      if (globals.model) {
        ;(partial.provider as Record<string, unknown>).model = globals.model
      }
      await client.request('settings.set', { partial })
    }
    if (globals.apiKey && globals.provider) {
      await client.request('providers.setApiKey', {
        providerId: globals.provider,
        apiKey: globals.apiKey
      })
    }
    return { homeDir, client }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    exitWithError(message, globals.mode || 'text')
    throw err
  }
}

export async function resolveThreadId(
  ctx: MmsContext,
  globals: CliGlobals
): Promise<string | null> {
  if (globals.sessionId) {
    return globals.sessionId
  }
  if (globals.continueSession) {
    const res = await ctx.client.request<{ threads: { id: string; settledAt?: string }[] }>(
      'threads.list'
    )
    const open = res.threads.find((t) => !t.settledAt)
    return open?.id ?? null
  }
  return null
}

/** Ensure daemon has hydrated the thread session (snapshot). */
export async function loadOrchestratorThread(
  ctx: MmsContext,
  threadId: string | null
): Promise<void> {
  if (!threadId) return
  await ctx.client.request('thread.snapshot', { threadId })
}

export async function closeMmsContext(ctx: MmsContext): Promise<void> {
  await ctx.client.close()
}
