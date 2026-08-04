import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { closeMmsContext, openMms } from '../mmsContext'
import { exitWithError, writeOutput } from '../output'

async function resolveThreadId(client: { request<T>(method: string, params?: unknown): Promise<T> }, requested?: string): Promise<string> {
  if (requested) return requested
  const result = await client.request<{ threads: Array<{ id: string; settledAt?: string }> }>('threads.list')
  const open = result.threads.filter((thread) => !thread.settledAt)
  if (open.length !== 1) throw new Error(`--session is required when ${open.length} open threads are available.`)
  return open[0].id
}

export async function runThreadActionCommand(args: ParsedArgs): Promise<void> {
  const context = await openMms(args.globals)
  try {
    const threadId = await resolveThreadId(context.client, args.globals.sessionId)
    const status = await context.client.request<{ journalGeneration?: number }>('workspace.getStatus', { threadId })
    const expectedJournalGeneration = status.journalGeneration ?? 0
    let result: unknown
    switch (args.command) {
      case 'workspace':
        result = status
        break
      case 'publish': {
        const targetBranch = flagString(args.flags, 'target') ?? args.positional[0]
        if (!targetBranch) exitWithError('publish requires --target <branch>.', args.globals.mode)
        result = await context.client.request('publish.start', { threadId, targetBranch, expectedJournalGeneration })
        break
      }
      case 'undo':
        result = await context.client.request('actions.undoLatest', { threadId, expectedJournalGeneration })
        break
      case 'redo':
        result = await context.client.request('actions.redo', { threadId, expectedJournalGeneration })
        break
      case 'fork': {
        const actionId = flagString(args.flags, 'action')
        if (!actionId) exitWithError('fork requires --action <id>.', args.globals.mode)
        result = await context.client.request('actions.fork', {
          threadId,
          actionId,
          name: flagString(args.flags, 'name'),
          expectedJournalGeneration
        })
        break
      }
      case 'operation': {
        if (args.subcommand !== 'abort') exitWithError('operation requires the abort subcommand.', args.globals.mode)
        const operationId = args.positional[0] ?? flagString(args.flags, 'operation')
        if (!operationId) exitWithError('operation abort requires an operation id.', args.globals.mode)
        result = await context.client.request('operations.abort', { threadId, operationId, expectedJournalGeneration })
        break
      }
      default:
        throw new Error(`Unsupported thread action command: ${args.command}`)
    }
    writeOutput(args.globals.mode, result, (value) => JSON.stringify(value, null, 2))
  } finally {
    await closeMmsContext(context)
  }
}
