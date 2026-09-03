export type ModeType = 'primary' | 'subagent' | 'all'

export interface ModePermissionValue {
  mode?: string
}

export interface ModeDescriptor {
  id: string
  name: string
  description: string
  mode: ModeType
  prompt: string
  permission?: Record<string, string | Record<string, string>>
  tools?: Record<string, boolean>
  model?: string
  color?: string
  hidden?: boolean
  scope: string
  source: string
  path: string
}

export const DEFAULT_MODE_IDS = ['agent', 'plan', 'build'] as const
export type BuiltInModeId = typeof DEFAULT_MODE_IDS[number]

export const TOOL_PERMISSION_MAP: Record<string, string> = {
  read: 'read',
  grep: 'grep',
  find: 'glob',
  ls: 'list',
  write: 'edit',
  edit: 'edit',
  bash: 'bash',
  git_status: 'read',
  git_diff: 'read',
  ask_user: 'question',
  present_plan: 'question',
  show_document: 'read',
}

export function toolToPermissionKey(toolName: string): string {
  return TOOL_PERMISSION_MAP[toolName] ?? toolName
}

export function isPermissionAllowed(
  permission: Record<string, string | Record<string, string>> | undefined,
  permissionKey: string,
  toolName?: string
): boolean {
  if (!permission) return true
  const entry = permission[permissionKey]
  if (entry === undefined) {
    const wildcard = permission['*']
    if (typeof wildcard === 'string') return wildcard !== 'deny'
    return true
  }
  if (typeof entry === 'string') return entry !== 'deny'
  if (typeof entry === 'object' && toolName) {
    const specific = (entry as Record<string, string>)[toolName] ?? (entry as Record<string, string>)['*']
    if (typeof specific === 'string') return specific !== 'deny'
  }
  return true
}

export function isToolAllowedForMode(descriptor: ModeDescriptor | undefined, toolName: string): boolean {
  if (!descriptor) return true
  if (descriptor.tools && typeof descriptor.tools[toolName] === 'boolean') {
    return descriptor.tools[toolName] === true
  }
  const key = toolToPermissionKey(toolName)
  return isPermissionAllowed(descriptor.permission, key, toolName)
}

export function allowsOrchestrationForMode(descriptor: ModeDescriptor | undefined): boolean {
  if (!descriptor) return false
  if (descriptor.permission && descriptor.permission['task'] !== undefined) {
    const taskPerm = descriptor.permission['task']
    if (typeof taskPerm === 'string') return taskPerm !== 'deny'
    return true
  }
  return descriptor.id === 'agent'
}
