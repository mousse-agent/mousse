import { existsSync } from 'node:fs'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { BotAuthority, NormalisedCall } from '../../../shared/bots/personal/authority'
import { checkMessage } from '../../../shared/bots/personal/walls'
import type { NativeToolTable, NeutralTool } from '../../../shared/harness/tools'
import type { ClassifiedOption, ClassifyOption } from './permissions'

/**
 * A bot's turn on an ACP agent that asks Mousse for its tools (Antigravity): every permission request and client file
 * request is answered by the bot's authority, the same check (walls and asks) as the other runtimes. Nobody is asked.
 *
 * Not checked here, so they run: what the agent runs without asking Mousse (its own reads and searches, when it does
 * not request permission for them), the MCP servers of the user's own agent setup, and a request of a kind no bot
 * permission names (`other`, none), such as an MCP tool. Mousse's own tools and the relay check the bot themselves.
 */

/** The ACP tool kinds for each neutral tool, for a bot policy's allowlist. */
export const ACP_NATIVE_TOOLS: NativeToolTable = Object.freeze({
  read: ['read'],
  list: ['read'],
  search: ['search'],
  edit: ['edit', 'delete', 'move'],
  write: ['edit'],
  shell: ['execute'],
  web_fetch: ['fetch'],
  web_search: ['fetch']
})

/** The neutral tool an ACP tool kind is checked as; undefined for a kind that names no checkable tool. */
function neutralOf(kind: string | null | undefined): NeutralTool | undefined {
  switch (kind) {
    case 'read': return 'read'
    case 'search': return 'search'
    case 'edit':
    case 'delete':
    case 'move': return 'edit'
    case 'execute': return 'shell'
    case 'fetch': return 'web_fetch'
    default: return undefined
  }
}

/**
 * `session/request_permission` in a bot's turn: allowed once when the bot's authority allows the call, rejected once
 * otherwise. `think`, and a kind with no neutral tool (`other`, none), are allowed unchecked.
 * The paths the agent names (`locations`) and its own description of the call (`rawInput`) are the call's arguments.
 */
export function answerBotPermission(
  bot: Pick<BotAuthority, 'check'>,
  request: RequestPermissionRequest,
  classify: ClassifyOption,
  onRefused?: (reason: string) => void
): RequestPermissionResponse {
  const shown = request.options
    .map(classify)
    .filter((option): option is ClassifiedOption => option !== null && option.scope === 'once')
  const pick = (kind: 'allow_once' | 'reject_once'): RequestPermissionResponse => {
    const option = shown.find((entry) => entry.kind === kind)
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  const kind = request.toolCall.kind
  const tool = neutralOf(kind)
  if (!tool) return pick('allow_once')
  const rawInput = request.toolCall.rawInput
  const described = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {}
  const paths = (request.toolCall.locations ?? []).map((location) => location.path).filter((path): path is string => typeof path === 'string' && path.length > 0)
  // Every path the call names must be allowed, each on its own.
  const calls: NormalisedCall[] = paths.length
    ? paths.map((path) => ({ kind: 'builtin', tool, nativeName: kind ?? 'other', args: { ...described, path } }))
    : [{ kind: 'builtin', tool, nativeName: kind ?? 'other', args: described }]
  for (const call of calls) {
    const check = bot.check(call)
    if (!check.ok) {
      onRefused?.(checkMessage(check))
      return pick('reject_once')
    }
  }
  return pick('allow_once')
}

/** A client file request in a bot's turn: an error with the reason when the bot's authority does not allow it. */
export function checkBotFileRequest(bot: Pick<BotAuthority, 'check'>, request: { access: 'read' | 'write'; path: string }): void {
  const tool: NeutralTool = request.access === 'read' ? 'read' : existsSync(request.path) ? 'edit' : 'write'
  const nativeName = request.access === 'read' ? 'fs/read_text_file' : 'fs/write_text_file'
  const check = bot.check({ kind: 'builtin', tool, nativeName, args: { path: request.path } })
  if (!check.ok) throw new Error(checkMessage(check))
}
