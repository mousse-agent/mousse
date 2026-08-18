import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Tool } from '@earendil-works/pi-ai'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import { countLineEdits } from '../../shared/lineEditStats'
import { readFile } from 'fs/promises'
import { modeRegistry } from '../modes/ModeRegistry'

/**
 * Pi coding-agent built-in tools (read, bash, edit, write, grep, find, ls).
 * Loaded from @earendil-works/pi-coding-agent at runtime so we avoid bundling
 * the full package (which is shimmed in electron-vite for unrelated imports).
 */

export type PiToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls'

export type PiToolSet = 'all' | 'readonly' | 'coding'

const ALL_TOOL_NAMES: readonly PiToolName[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls'
]

const READONLY_TOOL_NAMES: readonly PiToolName[] = ['read', 'grep', 'find', 'ls']

const CODING_TOOL_NAMES: readonly PiToolName[] = ['read', 'bash', 'edit', 'write']

/** Legacy Mousse build-tool names → Pi SDK names */
const LEGACY_ALIASES: Record<string, PiToolName | 'run_command'> = {
  read_file: 'read',
  write_file: 'write',
  list_dir: 'ls',
  run_command: 'run_command'
}

type AgentToolLike = Tool & {
  label?: string
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: string; text?: string }>
    details?: unknown
    isError?: boolean
  }>
}

type PiToolsModule = {
  createAllTools: (cwd: string) => Record<PiToolName, AgentToolLike>
  createReadOnlyTools: (cwd: string) => AgentToolLike[]
  createCodingTools: (cwd: string) => AgentToolLike[]
}

let toolsModulePromise: Promise<PiToolsModule> | null = null

function resolvePiToolsEntryUrl(): string {
  // Package exports only "."; walk node_modules for the tools entry (works in
  // Electron, vitest, and when import.meta.resolve is unavailable).
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(
      dir,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'core',
      'tools',
      'index.js'
    )
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'Could not locate @earendil-works/pi-coding-agent tools. Is the package installed?'
  )
}

function loadPiToolsModule(): Promise<PiToolsModule> {
  if (!toolsModulePromise) {
    toolsModulePromise = (async () => {
      const toolsEntry = resolvePiToolsEntryUrl()
      const mod = (await import(toolsEntry)) as PiToolsModule
      if (typeof mod.createAllTools !== 'function') {
        throw new Error('pi-coding-agent tools module missing createAllTools')
      }
      return mod
    })()
  }
  return toolsModulePromise
}

function toolNamesForSet(set: PiToolSet): readonly PiToolName[] {
  if (set === 'readonly') return READONLY_TOOL_NAMES
  if (set === 'coding') return CODING_TOOL_NAMES
  return ALL_TOOL_NAMES
}

function contentToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

export class PiCodingTools {
  private toolsByCwd = new Map<string, Record<PiToolName, AgentToolLike>>()

  constructor(private lineEditStats?: LineEditStatsStore) {}

  isPiTool(name: string): boolean {
    if ((ALL_TOOL_NAMES as readonly string[]).includes(name)) return true
    return name in LEGACY_ALIASES
  }

  async getToolDefinitions(cwd: string, set: PiToolSet = 'all'): Promise<Tool[]> {
    const tools = await this.getToolsForCwd(cwd)
    return toolNamesForSet(set).map((name) => {
      const tool = tools[name]
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      } satisfies Tool
    })
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
    toolCallId = 'mousse',
    signal?: AbortSignal
  ): Promise<{ text: string; isError: boolean }> {
    try {
      const tools = await this.getToolsForCwd(cwd)
      const resolved = this.resolveCall(name, args)
      if (!resolved) {
        return { text: `Unknown Pi coding tool: ${name}`, isError: true }
      }

      const tool = tools[resolved.name]
      if (!tool) {
        return { text: `Pi tool not available: ${resolved.name}`, isError: true }
      }

      let beforeContent: string | undefined
      if (resolved.name === 'write' || resolved.name === 'edit') {
        const path = typeof resolved.args.path === 'string' ? resolved.args.path : ''
        if (path) {
          try {
            beforeContent = await readFile(join(cwd, path), 'utf8')
          } catch {
            beforeContent = ''
          }
        }
      }

      // Forward turn cancellation into the SDK tool. In particular, the bash tool uses
      // this signal to terminate the entire spawned process tree instead of allowing a
      // command to keep modifying the repository after the user presses Stop.
      const result = await tool.execute(toolCallId, resolved.args, signal)
      const text = contentToText(result.content) || '(empty tool result)'

      if ((resolved.name === 'write' || resolved.name === 'edit') && beforeContent !== undefined) {
        const path = typeof resolved.args.path === 'string' ? resolved.args.path : ''
        if (path) {
          try {
            const after = await readFile(join(cwd, path), 'utf8')
            this.lineEditStats?.record('orchestrator', countLineEdits(beforeContent, after))
          } catch {
            // ignore stats failures
          }
        }
      }

      return { text, isError: result.isError === true }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private resolveCall(
    name: string,
    args: Record<string, unknown>
  ): { name: PiToolName; args: Record<string, unknown> } | null {
    if ((ALL_TOOL_NAMES as readonly string[]).includes(name)) {
      return { name: name as PiToolName, args }
    }

    const alias = LEGACY_ALIASES[name]
    if (!alias) return null

    if (alias === 'run_command') {
      const command = String(args.command ?? '').trim()
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : []
      const full = [command, ...cmdArgs].filter(Boolean).join(' ')
      return { name: 'bash', args: { command: full } }
    }

    if (alias === 'ls' && typeof args.path === 'string') {
      return { name: 'ls', args: { path: args.path } }
    }

    if (alias === 'read' || alias === 'write') {
      return { name: alias, args }
    }

    return { name: alias, args }
  }

  private async getToolsForCwd(cwd: string): Promise<Record<PiToolName, AgentToolLike>> {
    const existing = this.toolsByCwd.get(cwd)
    if (existing) return existing

    const mod = await loadPiToolsModule()
    const tools = mod.createAllTools(cwd)
    this.toolsByCwd.set(cwd, tools)
    return tools
  }
}

export function piToolSetForMode(mode: string | { type: string }, projectPath?: string): PiToolSet | null {
  if (typeof mode === 'string') {
    const desc = modeRegistry.getModeSync(mode, { projectPath })
    if (desc) {
      const editDenied = desc.permission?.['edit'] === 'deny'
      const bashDenied = desc.permission?.['bash'] === 'deny'
      if (editDenied || bashDenied) return 'readonly'
      return 'all'
    }
    if (mode === 'plan') return 'readonly'
    if (mode === 'build' || mode === 'agent') return 'all'
    return 'all'
  }
  if (typeof mode === 'object' && mode.type === 'skill') return 'all'
  return null
}
