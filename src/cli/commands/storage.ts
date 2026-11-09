import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { closeMmsContext, openMms } from '../mmsContext'
import { STORAGE_HELP } from '../help'

/** `mousse-cli storage export-json`: threads kept in thread.db written back as JSON, for going back to an older version. */
export async function runStorage(args: ParsedArgs): Promise<void> {
  const { globals, subcommand } = args
  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(STORAGE_HELP)
    return
  }
  if (subcommand !== 'export-json') exitWithError(`Unknown storage subcommand: ${subcommand}`, globals.mode)
  const threadId = flagString(args.flags, 'thread')
  const ctx = await openMms(globals)
  try {
    const res = await ctx.client.request<{ results: Array<{ threadId: string; exported: boolean; error?: string }> }>(
      'storage.exportThreadJson',
      threadId ? { threadId } : {}
    )
    const failed = res.results.filter((entry) => entry.error)
    writeOutput(globals.mode, {
      exported: res.results.filter((entry) => entry.exported).length,
      alreadyJson: res.results.filter((entry) => !entry.exported && !entry.error).length,
      failed
    })
    if (failed.length) process.exitCode = 1
  } finally {
    await closeMmsContext(ctx)
  }
}
