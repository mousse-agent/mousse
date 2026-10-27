import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type {
  PermissionOption,
  PermissionOptionKind,
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

/** How long an agent's permission choice lasts, as far as Mousse can tell. */
export type PermissionScope = 'once' | 'session' | 'persistent' | 'unknown'

/** One option of a permission request, as Mousse offers it. */
export interface ClassifiedOption {
  optionId: string
  kind: PermissionOptionKind
  label: string
  scope: PermissionScope
}

/** A preset's view of an option: how to label it and how long it lasts; `null` hides it. */
export type ClassifyOption = (option: PermissionOption) => ClassifiedOption | null

/** The agent's own options, as it labels them (presets that know their agent's options). */
export const keepOption: ClassifyOption = (option) => ({
  optionId: option.optionId,
  kind: option.kind,
  label: option.name,
  scope: option.kind === 'allow_once' || option.kind === 'reject_once' ? 'once' : 'unknown'
})

/**
 * Any other agent: "always" may outlive this session (some agents keep it for the whole project),
 * so it says so and is never picked for the user.
 */
export const classifyGenericOption: ClassifyOption = (option) => {
  switch (option.kind) {
    case 'allow_once':
    case 'reject_once':
      return { optionId: option.optionId, kind: option.kind, label: option.name, scope: 'once' }
    case 'allow_always':
      return { optionId: option.optionId, kind: option.kind, label: 'Always allow (the agent may remember this beyond this session)', scope: 'persistent' }
    case 'reject_always':
      return { optionId: option.optionId, kind: option.kind, label: option.name, scope: 'persistent' }
    default:
      return { optionId: option.optionId, kind: option.kind, label: option.name, scope: 'unknown' }
  }
}

/**
 * Asks the user to pick one option of a permission request. Today it asks through the thread's
 * questions (`DriverContext.questions`); a turn bridge replaces only this.
 */
export interface PermissionPrompter {
  /**
   * `never`: the run refuses every tool that needs approval (`RunPolicy.approvals`), so a runtime
   * answers each request with its denial and never calls `choose`. Absent: ask.
   */
  readonly approvals?: 'never'
  /** The chosen option id; undefined when the user picked nothing (dismissed, timed out). */
  choose(request: { threadId: string; title: string; options: ClassifiedOption[] }): Promise<string | undefined>
}

/** What a runtime tells its model when a run refuses tools that need approval. */
export const APPROVALS_REFUSED_MESSAGE = 'Tools that need approval are refused here.'

/** The prompter of a run whose policy is `approvals: 'never'`: nobody is asked, every request is denied. */
export function refusingPrompter(): PermissionPrompter {
  return { approvals: 'never', choose: async () => undefined }
}

export function questionsPrompter(questions: UserQuestionService): PermissionPrompter {
  return {
    async choose({ threadId, title, options }) {
      const answers = await questions.requestAnswers([{
        id: 'permission', prompt: title,
        options: options.map((option) => ({ id: option.optionId, label: option.label }))
      }], threadId)
      const answer = answers.permission
      return typeof answer === 'string' ? answer : undefined
    }
  }
}

/** The run's approvals policy: ask the user, or answer for them with a once-only option. */
export type PermissionApprovals = 'ask' | 'grants' | 'never'

/**
 * `session/request_permission`. The user picks one of the options the preset shows; `grants`
 * allows and `never` rejects with a once-only option, never an "always" one (`never` also comes
 * from a refusing prompter). Anything else, an answer that matches no shown option, or a stopped
 * turn is `cancelled`.
 */
export async function answerPermission(
  prompter: PermissionPrompter,
  scope: AcpRequestScope,
  request: RequestPermissionRequest,
  options: { label: string; classify: ClassifyOption; approvals?: PermissionApprovals }
): Promise<RequestPermissionResponse> {
  const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const shown = request.options.map(options.classify).filter((option): option is ClassifiedOption => option !== null)
  if (scope.aborted() || !scope.threadId || !shown.length) return cancelled
  const approvals = options.approvals ?? prompter.approvals ?? 'ask'
  if (approvals !== 'ask') {
    const kind: PermissionOptionKind = approvals === 'grants' ? 'allow_once' : 'reject_once'
    const pick = shown.find((option) => option.kind === kind)
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : cancelled
  }
  const answer = await prompter.choose({ threadId: scope.threadId, title: request.toolCall.title ?? `Allow ${options.label} to run this tool?`, options: shown })
  if (scope.aborted()) return cancelled
  const selected = shown.find((option) => option.optionId === answer)
  return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : cancelled
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
