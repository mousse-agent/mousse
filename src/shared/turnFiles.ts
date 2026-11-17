import { normalizeToolName } from './agentActivity'
import type { ReviewFileResult } from './review'
import type { ChatMessage } from './types'

/**
 * A file a thread's agent wrote, as the changed-files summary under a turn lists it, located on this computer
 * (`review.turnFile`). The daemon answers only for paths the thread's own Edit and Write calls name.
 *
 * - `missing`: nothing is at the path any more.
 * - `plain`: the file is there, but Git has no change to show for it: it is in no repository, Git ignores it, it
 *   matches the repository's last commit, or Git could not read it.
 * - `diff`: the file is in a Git repository (its own, which need not be the thread's) and differs from that
 *   repository's last commit. `version` holds both sides, as `review.file` returns them.
 */
export type TurnFileResult =
  | { kind: 'missing'; path: string }
  | { kind: 'plain'; path: string }
  | { kind: 'diff'; path: string; version: ReviewFileResult }

export interface TurnFileParams {
  threadId: string
  /** The path as the agent wrote it: absolute, or relative to the thread's folder. */
  path: string
}

const WRITING_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'write', 'writefile', 'declarefiles'])

function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  const raw = input?.file_path ?? input?.path ?? input?.filePath ?? input?.file
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * The paths a thread's Edit and Write calls wrote, as they were written (absolute, or relative to the thread's
 * folder). A typed file change lists every file it touched, without those whose change failed; an untyped call names
 * its file in its input, or on a "File:" line of its details.
 */
export function writtenFilePaths(messages: readonly ChatMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    const activity = message.activity
    if (activity?.kind === 'file_change') {
      for (const change of activity.changes) if (change.path && !change.error) paths.add(change.path)
      continue
    }
    const call = message.toolCall
    if (!call) continue
    const name = normalizeToolName(call.toolName ?? activity?.toolName, message.kind).toLowerCase().replace(/[^a-z]/g, '')
    if (!WRITING_TOOLS.has(name)) continue
    const path = filePathOf(call.input) ?? call.details.find((line) => line.startsWith('File:'))?.slice('File:'.length).trim()
    if (path) paths.add(path)
  }
  return [...paths]
}
