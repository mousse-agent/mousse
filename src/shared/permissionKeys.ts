import { toolToPermissionKey } from './modes'
import type { PermissionAction } from './permissionMode'

/**
 * Names of the classes of action a provider asks about. A key names a class, not one call: the
 * exact tool name is part of the action's fingerprint, so unifying a key never widens one approval.
 */
export const PERMISSION_KEYS = {
  claudeCommand: 'claude:command',
  claudeEdit: 'claude:edit',
  codexCommand: 'codex:command',
  codexFileChange: 'codex:fileChange',
  piCommand: 'pi:command',
  piEdit: 'pi:edit',
  mousseIntegrate: 'mousse:integrate',
  mousseMergeBack: 'mousse:merge_back'
} as const

/** The option an approval card adds so a user can allow the same request again in this thread. */
export const ALWAYS_OPTION_ID = 'allow_always'
export const ALWAYS_OPTION_LABEL = 'Always for this thread'
/** What the option does and does not do, shown next to it. */
export const ALWAYS_OPTION_NOTE = 'Always for this thread allows this exact request again, in this thread, when you are the one who sent the message. It approves the text of the request, not what it does: a command that runs scripts runs whatever they contain then. Claude\'s shell keeps its folder between calls, so the same command can run from another folder. Other commands, folders and tools still ask.'

/** Key of any other Claude tool. */
export function claudeToolKey(toolName: string): string {
  return `claude:tool:${toolName}`
}

/** Key of an ACP permission request, by the kind of the tool call. */
export function acpPermissionKey(kind: string | undefined | null): string {
  return `acp:${kind || 'other'}`
}

const ACP_EDIT_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move'])

/** Whether an ACP tool-call kind changes files. */
export function isAcpEditKind(kind: string | undefined | null): boolean {
  return Boolean(kind && ACP_EDIT_KINDS.has(kind))
}

/**
 * What a pi-loop tool does to the machine, for the permission mode: `command` (a shell command),
 * `edit` (a file change), or null for a tool that only reads. Legacy build-tool names count as the
 * pi tools they alias.
 */
export function piToolAction(toolName: string): 'command' | 'edit' | null {
  const key = toolToPermissionKey(toolName)
  if (key === 'bash' || key === 'run_command') return 'command'
  if (key === 'edit' || key === 'write_file') return 'edit'
  return null
}

/** The permission key of a pi-loop tool that is not read-only. */
export function piPermissionKey(action: 'command' | 'edit'): string {
  return action === 'command' ? PERMISSION_KEYS.piCommand : PERMISSION_KEYS.piEdit
}

/** What kind of action a permission key stands for. */
export function actionOf(key: string): PermissionAction {
  switch (key) {
    case PERMISSION_KEYS.claudeCommand:
    case PERMISSION_KEYS.codexCommand:
    case PERMISSION_KEYS.piCommand:
      return 'command'
    case PERMISSION_KEYS.claudeEdit:
    case PERMISSION_KEYS.codexFileChange:
    case PERMISSION_KEYS.piEdit:
    case PERMISSION_KEYS.mousseIntegrate:
    case PERMISSION_KEYS.mousseMergeBack:
      return 'edit'
  }
  if (key.startsWith('acp:')) {
    const kind = key.slice('acp:'.length)
    if (isAcpEditKind(kind)) return 'edit'
    return kind === 'execute' ? 'command' : 'tool'
  }
  return 'tool'
}
