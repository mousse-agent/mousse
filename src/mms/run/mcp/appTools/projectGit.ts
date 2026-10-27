import { Type, type Tool } from '@earendil-works/pi-ai'
import type { GitService } from '../../../git/GitService'
import { isPathInsideCwd } from '../../../orchestrator/toolPathSafety'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type AppToolTurn, type Availability, type MousseTool, type ToolOutcome } from './types'

/** The project's repository, read by `git_status` and `git_diff`. */
export type ProjectGit = Pick<GitService, 'getStatus' | 'getDiff'>

/** The pi-ai definitions of the project git tools, as the pi loop has always sent them. */
export function projectGitToolDefinitions(): Tool[] {
  return [
    {
      name: 'git_status',
      description: 'Get git status for the project repository.',
      parameters: Type.Object({})
    },
    {
      name: 'git_diff',
      description: 'Get a git diff for one file.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative file path.' }),
        staged: Type.Optional(Type.Boolean({ description: 'Whether to diff staged changes.' }))
      })
    }
  ]
}

/**
 * Runs `git_status` or `git_diff` in `projectRoot`; errors are results, never throws. A `git_diff`
 * path outside the project is refused.
 */
export async function runProjectGitTool(git: ProjectGit, name: string, args: Record<string, unknown>, projectRoot: string): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === 'git_status') {
      const status = await git.getStatus(projectRoot)
      return { text: JSON.stringify(status, null, 2), isError: false }
    }
    if (name === 'git_diff') {
      const path = String(args.path ?? '')
      if (!path.trim()) return { text: 'A file path is required.', isError: true }
      if (!isPathInsideCwd(path, projectRoot)) return { text: `Path is outside the project: ${path}`, isError: true }
      const diff = await git.getDiff(projectRoot, path, args.staged === true)
      return { text: diff || '(no diff)', isError: false }
    }
    return { text: `Unknown git tool: ${name}`, isError: true }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}

/** Where the git tools may run: in a project, on a Build turn or a definition's turn (its grants decide). */
function availability(name: string, turn: AppToolTurn): Availability {
  if (!turn.settingsEnabled(name)) return disabledInSettings(name)
  if (!turn.projectPath) return 'No project root selected for project tools.'
  if (!turn.modeFacts.build && !turn.definition && !turn.trusted) return `Tool "${name}" is available in Build mode and to agents granted it.`
  return true
}

/**
 * `git_status` and `git_diff` as app tools (PR 4 §6), so a definition granted them keeps them over
 * the Mousse MCP server on a runtime with its own loop. A definition's grants decide each call (the
 * registry's definition gate); other turns may use them in Build mode, as in the pi loop. Registered
 * only where the host reads the repository (the MCP server's host): the pi loop runs its own copies.
 */
export function projectGitTools(host: AppToolHost): MousseTool[] {
  const git = host.projectGit
  if (!git) return []
  return projectGitToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'reads',
    class: 'read',
    available: (turn) => availability(tool.name, turn),
    describe: () => `Tool ${tool.name}`,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      const projectPath = ctx.turn.projectPath
      if (!projectPath) return { text: 'No project root selected for project tools.', isError: true }
      const event = { kind: 'build_tool_call' as const, title: `Tool ${tool.name}`, summary: 'Called a local project tool.', details: [`Tool: ${tool.name}`] }
      ctx.timeline?.emit(event, 'start')
      const result = await runProjectGitTool(git, tool.name, args, projectPath)
      ctx.timeline?.emit({ ...event, kind: 'build_tool_result', summary: result.isError ? 'The tool returned an error.' : 'The tool returned successfully.', response: truncateForDisplay(result.text) }, 'complete')
      return result
    }
  }))
}
