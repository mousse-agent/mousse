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
import { APPROVALS_REFUSED_MESSAGE } from '../../../shared/harness/types'
import { acpPermissionKey, actionOf } from '../../../shared/permissionKeys'
import { permissionModeAllows, type PermissionAction, type PermissionMode } from '../../../shared/permissionMode'
import type { ApprovalTag, UserQuestionService } from '../../orchestrator/UserQuestionService'

/**
 * What the agent asks of the user: tool permissions, and (where the preset offers client fs) file
 * reads and writes inside the workspace.
 */

/** The turn a request belongs to, read when the request arrives. */
export interface AcpRequestScope {
  threadId?: string
  cwd?: string
  /** The turn's approvals policy, from its prompter: `never` refuses writes and questions without asking. */
  readonly approvals?: 'never'
  /** The permission mode of the turn running now; absent outside a turn (everything asks). */
  permissionMode?: PermissionMode
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
  /**
   * The chosen option id; undefined when the user picked nothing (dismissed, timed out).
   * `approval` says what kind of action is asked about, so who may answer is decided by
   * `canAnswerApproval` (the options are all once-only: `allow_once` allows, `reject_once` rejects).
   */
  choose(request: { threadId: string; title: string; options: ClassifiedOption[]; approval: Pick<ApprovalTag, 'action' | 'permissionKey' | 'tool' | 'reason'> }): Promise<string | undefined>
}

export { APPROVALS_REFUSED_MESSAGE, QUESTIONS_REFUSED_MESSAGE } from '../../../shared/harness/types'

/** The prompter of a run whose policy is `approvals: 'never'`: nobody is asked, every request is denied. */
export function refusingPrompter(): PermissionPrompter {
  return { approvals: 'never', choose: async () => undefined }
}

export function questionsPrompter(questions: UserQuestionService): PermissionPrompter {
  return {
    async choose({ threadId, title, options, approval }) {
      const answers = await questions.requestAnswers([{
        id: 'permission', prompt: title,
        options: options.map((option) => ({ id: option.optionId, label: option.label }))
      }], threadId, {
        approval: {
          ...approval,
          options: options.map((option) => ({
            id: option.optionId,
            decision: option.kind === 'allow_once' ? 'allow' : 'reject',
            ...(option.kind === 'allow_once' ? { scope: 'once' as const } : {})
          }))
        }
      })
      const answer = answers.permission
      return typeof answer === 'string' ? answer : undefined
    }
  }
}

/** The run's approvals policy; a preset that has a launch flag for it (Grok) maps it there. Permission modes decide what is asked. */
export type PermissionApprovals = 'ask' | 'grants' | 'never'

/**
 * `session/request_permission`, under the turn's permission mode. Full access answers with the
 * agent's once-only allow option without asking; Auto-accept edits does the same for a tool call
 * that changes files (`edit`, `delete`, `move`) and asks for anything else; Ask asks. A turn whose
 * approvals are `never` (a refusing prompter) rejects with the once-only reject option without
 * asking, whatever the mode. The user picks one of the options the preset shows, and only the agent's
 * once-only options are shown: a native "always" or "session" option would let the agent remember the
 * decision past this thread's mode (Mousse records "Always for this thread" itself). A request outside
 * a turn asks. An answer that matches no shown option, or a stopped turn, is `cancelled`.
 */
export async function answerPermission(
  prompter: PermissionPrompter,
  scope: AcpRequestScope,
  request: RequestPermissionRequest,
  options: { label: string; classify: ClassifyOption }
): Promise<RequestPermissionResponse> {
  const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const shown = request.options
    .map(options.classify)
    .filter((option): option is ClassifiedOption => option !== null && option.scope === 'once')
  if (scope.aborted() || !scope.threadId || !shown.length) return cancelled
  if (prompter.approvals === 'never') {
    const pick = shown.find((option) => option.kind === 'reject_once')
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : cancelled
  }
  const permissionKey = acpPermissionKey(request.toolCall.kind)
  const action = actionOf(permissionKey)
  if (permissionModeAllows(scope.permissionMode ?? 'ask', action)) {
    const pick = shown.find((option) => option.kind === 'allow_once')
    if (pick) return { outcome: { outcome: 'selected', optionId: pick.optionId } }
  }
  const answer = await prompter.choose({
    threadId: scope.threadId,
    title: request.toolCall.title ?? `Allow ${options.label} to run this tool?`,
    options: shown,
    // The agent's own description of the call is its fingerprint, with the call's title: the kind alone names no
    // tool (a read-only and a destructive MCP tool are both `other`). A request whose `rawInput` is missing or
    // empty (`{}`, a string) describes nothing, so it has no fingerprint, no grant and no rule.
    approval: {
      action,
      permissionKey,
      tool: {
        name: request.toolCall.kind ?? 'other',
        input: isDescribed(request.toolCall.rawInput) ? { title: request.toolCall.title ?? null, rawInput: request.toolCall.rawInput } : undefined,
        ...(scope.cwd ? { cwd: scope.cwd } : {})
      }
    }
  })
  if (scope.aborted()) return cancelled
  const selected = shown.find((option) => option.optionId === answer)
  return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : cancelled
}

/** A call description that says something: a non-empty object. */
function isDescribed(rawInput: unknown): rawInput is Record<string, unknown> {
  return typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput) && Object.keys(rawInput).length > 0
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
  if (scope.approvals === 'never') throw new Error(APPROVALS_REFUSED_MESSAGE)
  // Edits go ahead under Auto-accept edits and Full access; a write outside a turn asks.
  if (!permissionModeAllows(scope.permissionMode ?? 'ask', 'edit')) {
    const answer = await questions.requestAnswers([{
      id: 'write', prompt: `Allow ${label} to write ${relative(scope.cwd!, path)}?`,
      options: [{ id: 'allow', label: 'Allow this edit' }, { id: 'reject', label: 'Reject' }]
    }], scope.threadId, {
      approval: {
        action: 'edit',
        permissionKey: acpPermissionKey('edit'),
        options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
        tool: { name: 'fs/write_text_file', input: { path: request.path, content: request.content }, ...(scope.cwd ? { cwd: scope.cwd } : {}) }
      }
    })
    if (answer.write !== 'allow') throw new Error(`${label} file write was rejected`)
  }
  scope.throwIfAborted()
  const approvedPath = workspacePath(scope, request.path)
  mkdirSync(dirname(approvedPath), { recursive: true })
  writeFileSync(approvedPath, request.content, 'utf8')
  return {}
}
