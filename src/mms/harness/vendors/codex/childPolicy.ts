import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BotAuthority } from '../../../../shared/bots/personal/authority'
import { entriesBeside } from '../../../bots/grants/compile'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ChildTurnPolicy } from '../../adapter'
import type { AskForApproval, SandboxMode, SandboxPolicy } from './protocol'

/**
 * What a turn's mode, permission mode and delegation policy decide about Codex's sandbox and approvals: one of Codex's
 * sandbox modes, or (a bot's commands without file access) the named permission profile its thread config defines
 * (`codexBotSandboxConfig`). Codex takes one or the other, never both.
 */
export type CodexTurnPolicy =
  | { approvalPolicy: AskForApproval; sandbox: SandboxMode; sandboxPolicy: SandboxPolicy; permissions?: undefined }
  | { approvalPolicy: AskForApproval; permissions: string; sandbox?: undefined; sandboxPolicy?: undefined }

/**
 * The sandbox and approval policy of one Codex turn, used for `thread/start` / `thread/resume` and
 * again for `turn/start`, so a resumed thread cannot keep an older policy.
 *
 * - A plan turn and a read-only (`shared`) child run in the read-only sandbox with the approval
 *   policy `on-request`; Mousse answers each request that reaches it with a denial itself
 *   (`CodexProviderService.serve`), so a request never waits in a thread nobody watches.
 * - Ask before acting and Auto-accept edits run `untrusted` in the read-only sandbox (Codex's
 *   Supervised profile): every command that is not known to be safe and every patch asks Mousse.
 *   Mousse never sends a `workspaceWrite` policy on an interactive turn, whose empty roots would
 *   narrow what Codex's own full-access profile means.
 * - Full access is Codex's own full-access profile: `never` ask, no sandbox.
 * - A bot's turn (`bot`) asks like Ask before acting (`untrusted`), and the bot's authority answers.
 *   Without "run commands" it has no command tool at all (`CODEX_COMMAND_FEATURES` off) in the read-only sandbox. With
 *   it and without file access, its commands run under Mousse's permission profile (`CODEX_BOT_PROFILE`): they read
 *   only the system's own programs and the bot's folders and write only the bot's folders. With file access, in the
 *   `workspaceWrite` sandbox over every folder but Mousse's own data (`codexBotSandbox`). Never any network.
 *
 * Nothing here edits the user's Codex configuration or their MCP servers.
 */
export function codexTurnPolicy(mode: 'plan' | 'default', child: ChildTurnPolicy | undefined, permissionMode: PermissionMode, bot?: CodexBotSandbox): CodexTurnPolicy {
  if (mode === 'plan' || child?.readOnly === true)
    return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (bot?.shell && bot.confined) return { approvalPolicy: 'untrusted', permissions: CODEX_BOT_PROFILE }
  if (bot?.shell)
    return {
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [...bot.writableRoots], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    }
  if (bot) return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (permissionMode === 'full')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
}

/** What a bot's grant decides about its Codex sandbox (`codexTurnPolicy`). */
export interface CodexBotSandbox {
  /** The bot holds "run commands" (`shell`). */
  shell: boolean
  /** The bot's files folder, its scratch folder and the folders it may change. */
  writableRoots: string[]
  /**
   * Commands without file access (`CODEX_BOT_PROFILE`): beside Codex's `:minimal` (the system's own programs and
   * libraries) and `writableRoots`, they read only these: the folders granted for reading, and the Codex package that
   * runs them (its sandbox starts Codex's own executable again inside). Absent with file access: the `workspaceWrite`
   * sandbox, which reads every file.
   */
  confined?: { readable: string[] }
}

/** The kernel's own file systems: never a writable root (Codex's sandbox keeps `/dev/null` writable itself). */
const KERNEL_FOLDERS: ReadonlySet<string> = new Set(['/proc', '/sys', '/dev'])

/**
 * The platforms where a bot's commands without file access run under `CODEX_BOT_PROFILE`. Codex's permission profiles
 * are enforced by its Linux (bubblewrap) and macOS (Seatbelt) sandboxes; on Windows they keep the `workspaceWrite`
 * sandbox, which reads every file.
 */
const CONFINED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux', 'darwin'])

/**
 * A bot's Codex sandbox from its authority: with `shell`, writable are its files folder, its
 * scratch folder and the folders granted for writing (`BotAuthority.workspace.writeRoots`, which
 * holds the files folder), and nothing else. Without file access (on Linux and macOS) reading is held to those, the
 * folders granted for reading and the system's own programs too (`confined`). With file access (`workspace.computer`,
 * bot-architecture.md §3.7) writing is the whole file system but Mousse's own data: every entry beside the way down to
 * it (`entriesBeside`), and the files and scratch folders inside it. `codexPackage`: the folder of the Codex package
 * that runs the turn (`codexPackageOf`).
 */
export function codexBotSandbox(bot: Partial<Pick<BotAuthority, 'tools' | 'workspace'>>, codexPackage?: string, platform: NodeJS.Platform = process.platform): CodexBotSandbox {
  const shell = bot.tools?.has('shell') === true
  const workspace = bot.workspace
  if (!shell || !workspace) return { shell, writableRoots: [] }
  const mine = [...(workspace.files !== undefined ? [workspace.files] : []), workspace.scratch]
  const computer = workspace.computer
  const writeRoots = workspace.writeRoots ?? (workspace.access === 'write' ? workspace.roots : [])
  const roots = computer
    ? workspace.roots.flatMap((root) => entriesBeside(root, [computer.closed])).filter((root) => !KERNEL_FOLDERS.has(root))
    : writeRoots
  const writableRoots = [...new Set([...roots, ...mine])]
  if (computer || !CONFINED_PLATFORMS.has(platform)) return { shell, writableRoots }
  const readable = [...new Set([...workspace.roots.filter((root) => !writeRoots.includes(root)), ...(codexPackage ? [codexPackage] : [])])]
  return { shell, writableRoots, confined: { readable } }
}

/**
 * The folder of the Codex package `binary` belongs to: two levels above the real executable (`<package>/bin/codex`, or
 * an npm install's `<package>/bin/codex.js`). Its sandbox runs Codex's own executable again for each command, so a
 * confined bot's profile must let it be read. Undefined when it can't be resolved.
 */
export function codexPackageOf(binary: string | undefined): string | undefined {
  if (!binary) return undefined
  try {
    return dirname(dirname(realpathSync.native(binary)))
  } catch {
    return undefined
  }
}

/**
 * Codex's features that give the model a command tool, as `codex features list` names them (Codex 0.162.1): its shell
 * and its unified exec. A bot turn without "run commands" starts with both off, so it has no command tool at all: Codex
 * would otherwise run the read-only commands it trusts (`cat`, `ls`, `grep`, …) without asking anyone, in a sandbox that
 * reads every file.
 */
export const CODEX_COMMAND_FEATURES: readonly string[] = ['shell_tool', 'unified_exec']

/**
 * Codex's features that add a tool no bot turn may have, whatever it holds, as `codex features list` names them (Codex
 * 0.162.1). Each runs or reads without an approval the bot's authority could answer, or reaches past what Mousse holds
 * the bot to; the owner's own Codex config may switch any of them on, and the thread config switches them off again.
 * Codex ignores a name it does not know.
 * - `view_image`: opens any image by its path, with no approval and outside every sandbox (Mousse's own data included).
 * - `image_generation`: makes images and saves them where Codex keeps them.
 * - `multi_agent`, `multi_agent_v2`: subagents (`spawn_agent` and the rest of `collaboration`), threads Mousse does not
 *   hold to the bot's authority.
 * - `apps`, `plugins`, `remote_plugin`, `skill_mcp_dependency_install`: ChatGPT apps, plugins and the MCP servers they
 *   bring, whose tools run under Codex's rules.
 * - `hooks`: the owner's own commands, run on Codex's events.
 * - `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `in_app_browser`, `computer_use`: Codex's own
 *   browser and control of the computer's screen, beside Mousse's browser and its switch.
 * - `memories`: what Codex remembers from the owner's other sessions.
 * - `code_mode`, `code_mode_only`: a JavaScript `exec` that calls the other tools.
 * - `request_permissions_tool`: asks for more sandbox permissions.
 * - `default_mode_request_user_input`, `send_message_to_user_async`: questions and messages to a person, who is not there.
 * - `goals`, `sleep_tool`, `tool_suggest`, `skill_search`: goals Codex follows on its own, waiting, and suggestions.
 */
export const CODEX_BOT_FEATURES_OFF: readonly string[] = [
  'view_image',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'hooks',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'memories',
  'code_mode',
  'code_mode_only',
  'request_permissions_tool',
  'default_mode_request_user_input',
  'send_message_to_user_async',
  'goals',
  'sleep_tool',
  'tool_suggest',
  'skill_search'
]

/**
 * The name of the permission profile a confined bot's commands run under, defined in its thread config
 * (`codexBotSandboxConfig`), which wins over a profile of that name in the user's own Codex config.
 */
export const CODEX_BOT_PROFILE = 'mousse-bot'

/** A value of Codex's thread config, as JSON. */
type CodexConfigValue = string | boolean | string[] | { [key: string]: CodexConfigValue }

/**
 * The thread config of a bot turn: every feature of `CODEX_BOT_FEATURES_OFF` off, and its sandbox. Without "run
 * commands": every command tool off too (`CODEX_COMMAND_FEATURES`). With it and confined: `CODEX_BOT_PROFILE`, reading
 * Codex's `:minimal` and `confined.readable`, writing `writableRoots`, with no network. Otherwise the same
 * `workspaceWrite` sandbox as its turns (`codexTurnPolicy`). Either way nothing in the user's `config.toml` widens it
 * while the thread loads.
 */
export function codexBotSandboxConfig(sandbox: CodexBotSandbox): Record<string, CodexConfigValue> {
  return { ...Object.fromEntries(CODEX_BOT_FEATURES_OFF.map((feature) => [`features.${feature}`, false])), ...codexBotSandboxOnly(sandbox) }
}

function codexBotSandboxOnly(sandbox: CodexBotSandbox): Record<string, CodexConfigValue> {
  if (!sandbox.shell) return Object.fromEntries(CODEX_COMMAND_FEATURES.map((feature) => [`features.${feature}`, false]))
  if (sandbox.confined) {
    const filesystem: Record<string, string> = { ':minimal': 'read' }
    for (const root of sandbox.confined.readable) filesystem[root] = 'read'
    for (const root of sandbox.writableRoots) filesystem[root] = 'write'
    return { [`permissions.${CODEX_BOT_PROFILE}`]: { filesystem, network: { enabled: false } } }
  }
  return {
    'sandbox_workspace_write.writable_roots': [...sandbox.writableRoots],
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    'sandbox_workspace_write.exclude_slash_tmp': true
  }
}
