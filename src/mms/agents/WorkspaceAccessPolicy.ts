import { realpathSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentWorkspacePolicy } from '../../shared/agentEpisodes'

const READ_TOOLS = new Set(['read', 'read_file', 'ls', 'list_dir', 'find', 'grep'])
// A read-only agent may start subagents; `delegateTask` lets it start only read-only (shared) ones, and
// `integrate_delegation` (which merges into the workspace) stays out.
const DELEGATION_TOOLS = new Set(['delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'list_delegations', 'create_subagent', 'create_subagents', 'list_subagents', 'recall_subagent'])

/** Internal capability: callers cannot manufacture this object over JSON/RPC. */
export interface AgentToolAccess {
  allows(tool: string): boolean
  execute<T>(tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T>
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Resolve every existing component, including junctions; a lexical prefix is not authority. */
export function assertEpisodePath(root: string, input: string): string {
  const owned = realpathSync.native(root)
  const target = resolve(root, input)
  if (!inside(owned, target)) throw new Error('Tool path escapes the episode workspace')
  let current = target
  while (true) {
    try {
      lstatSync(current)
      if (!inside(owned, realpathSync.native(current))) throw new Error('Tool path follows a link outside the episode workspace')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (relative(owned, current) === '') break
    const parent = dirname(current)
    if (parent === current) throw new Error('Episode workspace ownership changed')
    current = parent
  }
  return target
}

export function createAgentToolAccess(policy: AgentWorkspacePolicy, root: string,
  writer?: <T>(run: () => Promise<T>) => Promise<T>): AgentToolAccess {
  const allows = (tool: string): boolean => policy.access === 'write' || READ_TOOLS.has(tool) || DELEGATION_TOOLS.has(tool)
  return {
    allows,
    async execute(tool, args, run) {
      if (!allows(tool)) throw new Error(`Tool ${tool} is prohibited by read-only episode access`)
      for (const key of ['path', 'file_path', 'filePath', 'directory', 'dir']) {
        if (typeof args[key] === 'string') assertEpisodePath(root, args[key] as string)
      }
      if (READ_TOOLS.has(tool)) assertEpisodePath(root, typeof args.path === 'string' ? args.path : '.')
      return policy.access === 'write' && writer ? writer(run) : run()
    }
  }
}
