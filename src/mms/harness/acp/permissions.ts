import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'

/**
 * What the agent asks of the user: tool permissions, and (where the preset offers client fs) file
 * reads and writes inside the workspace.
 */

/** The turn a request belongs to, read when the request arrives. */
export interface AcpRequestScope {
  threadId?: string
  cwd?: string
  /** The turn was stopped, or the connection closed. */
  aborted(): boolean
  throwIfAborted(): void
}

/** `session/request_permission`: the user picks one of the agent's options; anything else cancels. */
export async function askToolPermission(
  questions: UserQuestionService,
  scope: AcpRequestScope,
  request: RequestPermissionRequest,
  label: string
): Promise<RequestPermissionResponse> {
  if (scope.aborted() || !scope.threadId || !request.options.length) return { outcome: { outcome: 'cancelled' } }
  const answers = await questions.requestAnswers([{
    id: 'permission', prompt: request.toolCall.title ?? `Allow ${label} to run this tool?`,
    options: request.options.map((option) => ({ id: option.optionId, label: option.name }))
  }], scope.threadId)
  if (scope.aborted()) return { outcome: { outcome: 'cancelled' } }
  const answer = answers.permission
  const selected = request.options.find((option) => option.optionId === answer)
  return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
}

/** A path the agent may touch: inside the workspace, also after resolving links. */
export function workspacePath(scope: AcpRequestScope, path: string): string {
  scope.throwIfAborted()
  if (!scope.cwd || !isAbsolute(path)) throw new Error('ACP file request has no workspace')
  const root = resolve(scope.cwd)
  const target = resolve(path)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('ACP file request is outside the workspace')
  const realRoot = realpathSync(root)
  let nearest = target
  for (;;) {
    try { lstatSync(nearest); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      nearest = dirname(nearest)
    }
  }
  const realNearest = realpathSync(nearest)
  const realRel = relative(realRoot, realNearest)
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error('ACP file request resolves outside the workspace')
  }
  return target
}

/** `fs/read_text_file` inside the workspace. */
export async function readWorkspaceFile(scope: AcpRequestScope, request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const path = workspacePath(scope, request.path)
  const lines = readFileSync(path, 'utf8').split('\n')
  const from = Math.max(0, (request.line ?? 1) - 1)
  return { content: lines.slice(from, request.limit ? from + request.limit : undefined).join('\n') }
}

/** `fs/write_text_file` inside the workspace, after the user approves this edit. */
export async function writeWorkspaceFile(
  questions: UserQuestionService,
  scope: AcpRequestScope,
  request: WriteTextFileRequest,
  label: string
): Promise<WriteTextFileResponse> {
  const path = workspacePath(scope, request.path)
  if (!scope.threadId) throw new Error('ACP file write has no thread')
  const answer = await questions.requestAnswers([{
    id: 'write', prompt: `Allow ${label} to write ${relative(scope.cwd!, path)}?`,
    options: [{ id: 'allow', label: 'Allow this edit' }, { id: 'reject', label: 'Reject' }]
  }], scope.threadId)
  if (answer.write !== 'allow') throw new Error(`${label} file write was rejected`)
  scope.throwIfAborted()
  const approvedPath = workspacePath(scope, request.path)
  mkdirSync(dirname(approvedPath), { recursive: true })
  writeFileSync(approvedPath, request.content, 'utf8')
  return {}
}
