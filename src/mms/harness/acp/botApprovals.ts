import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { BotAuthority } from '../../../shared/bots/personal/authority'
import { checkMessage } from '../../../shared/bots/personal/walls'
import type { NativeToolTable, NeutralTool } from '../../../shared/harness/tools'
import { PATH_ARGUMENTS } from '../../bots/authority/botAuthority'
import { mousseServerToolOf } from '../../run/mcp/attachment'
import type { McpAttachment } from '../../run/mcp/MousseMcpServer'
import type { ClassifiedOption, ClassifyOption } from './permissions'

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

/** The file arguments Antigravity sends when it doesn't include ACP locations. */
const AGY_PATH_ARGUMENTS = [...PATH_ARGUMENTS, 'TargetFile', 'AbsolutePath', 'FilePath', 'SearchPath', 'DirectoryPath', 'SourcePath', 'DestinationPath']

/** Answer only once, and route calls on the attached Mousse servers to their own grant checks. */
export function answerBotPermission(
  bot: Pick<BotAuthority, 'check'>,
  request: RequestPermissionRequest,
  classify: ClassifyOption,
  context: { cwd: string; mcp?: McpAttachment | null; toolName?: string; onRefused(reason: string): void }
): RequestPermissionResponse {
  const shown = request.options
    .map(classify)
    .filter((option): option is ClassifiedOption => option !== null && option.scope === 'once')
  const pick = (kind: 'allow_once' | 'reject_once'): RequestPermissionResponse => {
    const option = shown.find((entry) => entry.kind === kind)
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  const refuse = (reason: string) => {
    context.onRefused(reason)
    return pick('reject_once')
  }
  const call = request.toolCall
  const kind = call.kind
  const tool = neutralOf(kind)
  if (!kind || !tool) {
    if (kind === 'think') return pick('allow_once')
    const mcp = mousseServerToolOf(call.name ?? context.toolName ?? '')
    if (mcp?.exact && mcp.tool && context.mcp && (mcp.server === 'mousse' || context.mcp.relay)) return pick('allow_once')
    return refuse('Mousse could not match this request to a tool the bot can use.')
  }
  const input = call.rawInput
  const args = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const paths = new Set([
    ...(call.locations ?? []).map((location) => location.path),
    ...AGY_PATH_ARGUMENTS.map((key) => args[key])
  ].filter((path): path is string => typeof path === 'string' && path.length > 0))
  const minimumPaths = kind === 'move' ? 2 : (kind === 'read' || kind === 'edit' || kind === 'delete') ? 1 : 0
  if (paths.size < minimumPaths) return refuse('Antigravity did not provide the paths for this request.')
  for (const path of paths.size ? paths : [undefined]) {
    const check = bot.check({
      kind: 'builtin',
      tool: kind === 'edit' && path && !existsSync(resolve(context.cwd, path)) ? 'write' : tool,
      nativeName: kind,
      args: path ? { ...args, path } : args
    })
    if (!check.ok) return refuse(checkMessage(check))
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
