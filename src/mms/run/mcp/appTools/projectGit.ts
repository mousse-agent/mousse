import { Type, type Tool } from '@earendil-works/pi-ai'
import { runProjectGitTool } from '../../../git/scopedRead'
import type { AgentRuntimePolicy } from '../../../../shared/agents/execution'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type AppToolTurn, type Availability, type MousseTool, type ToolOutcome } from './types'


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

export { runProjectGitTool, type ProjectGitScope } from '../../../git/scopedRead'

/**
 * A personal bot's `git_status` or `git_diff`: on the thread or project it names (the registry already held a thread to
 * what the bot may reach; it reaches every project). Read as from a folder the bot does not own: Git metadata there is
 * not trusted, and nothing outside the folder is read or shown.
 */
async function botGit(host: AppToolHost, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const threadId = typeof args.threadId === 'string' && args.threadId.trim() ? args.threadId : undefined
  const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId : undefined
  if (Boolean(threadId) === Boolean(projectId)) return { text: 'Name exactly one of threadId (one of your owner\'s threads) and projectId (one of their projects).', isError: true }
  const folder = host.gitFolderOf?.(threadId ? { threadId } : { projectId: projectId! })
  if (!folder) return { text: threadId ? `Thread ${threadId} has no folder to read.` : `There is no project ${projectId}.`, isError: true }
  const { threadId: _thread, projectId: _project, ...rest } = args
  return runProjectGitTool(name, rest, { projectPath: folder, roots: [folder], writable: true })
}

/**
 * Whether a definition's agent can write in its roots (its workspace, or scripts): then Git
 * metadata there may be its own, and the git tools do not trust it.
 */
export function definitionWritesRoots(policy: Pick<AgentRuntimePolicy, 'workspace' | 'script'>): boolean {
  return policy.workspace.mode !== 'read_only' || policy.script.enabled
}

/**
 * Where the git tools may run: in a project, on a Build turn or a definition's turn (its grants decide). A personal bot's
 * turn has no project of its own: it names one of its owner's threads or projects, and holds the tools with "use your
 * threads" (the registry checks its grant and what it may reach).
 */
function availability(name: string, turn: AppToolTurn): Availability {
  if (!turn.settingsEnabled(name)) return disabledInSettings(name)
  if (turn.bot) return true
  if (!turn.projectPath) return 'No project root selected for project tools.'
  if (!turn.modeFacts.build && !turn.definition && !turn.trusted) return `Tool "${name}" is available in Build mode and to agents granted it.`
  return true
}

/** What a personal bot names: a thread of its owner's (its checkout) or a project (its folder). */
const BOT_TARGET = {
  threadId: { type: 'string', description: 'One of your owner\'s threads (thread_list): its worktree, else its project folder.' },
  projectId: { type: 'string', description: 'Or one of your owner\'s projects (thread_list\'s projects): its folder.' }
} as const

/** The bot's listing of each git tool: the same tool on a thread or project it names, read-only. */
const BOT_GIT: Record<string, { description: string; properties: Record<string, unknown>; required?: string[] }> = {
  git_status: {
    description: 'Get the Git status of one of your owner\'s threads (its worktree, else its project folder) or projects. Name exactly one of threadId and projectId. It only reads.',
    properties: { ...BOT_TARGET }
  },
  git_diff: {
    description: 'Get the Git diff of one file in one of your owner\'s threads (its worktree, else its project folder) or projects. Name exactly one of threadId and projectId. It only reads.',
    properties: { ...BOT_TARGET, path: { type: 'string', description: 'Relative file path.' }, staged: { type: 'boolean', description: 'Whether to diff staged changes.' } },
    required: ['path']
  }
}

/**
 * `git_status` and `git_diff` as app tools (PR 4 §6), so a definition granted them keeps them over
 * the Mousse MCP server on a runtime with its own loop. A definition's grants decide each call (the
 * registry's definition gate); other turns may use them in Build mode, as in the pi loop. Registered
 * only where the host reads the repository (the MCP server's host): the pi loop runs its own copies.
 */
export function projectGitTools(host: AppToolHost): MousseTool[] {
  if (!host.projectGit) return []
  return projectGitToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    botDescription: BOT_GIT[tool.name]?.description,
    botInputSchema: BOT_GIT[tool.name] ? { type: 'object', properties: BOT_GIT[tool.name]!.properties, ...(BOT_GIT[tool.name]!.required ? { required: BOT_GIT[tool.name]!.required } : {}) } : undefined,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'reads',
    class: 'read',
    available: (turn) => availability(tool.name, turn),
    describe: () => `Tool ${tool.name}`,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      if (ctx.turn.bot) return botGit(host, tool.name, args)
      const projectPath = ctx.turn.projectPath
      if (!projectPath) return { text: 'No project root selected for project tools.', isError: true }
      const event = { kind: 'build_tool_call' as const, title: `Tool ${tool.name}`, summary: 'Called a local project tool.', details: [`Tool: ${tool.name}`] }
      ctx.timeline?.emit(event, 'start')
      // A definition's reads stay in its roots (the gate holds the project path inside them); any
      // other turn's stay in the project.
      const definition = ctx.turn.definition?.policy
      const roots = definition ? definition.workspace.canonicalRoots : [projectPath]
      const result = await runProjectGitTool(tool.name, args, { projectPath, roots, writable: definition ? definitionWritesRoots(definition) : false })
      ctx.timeline?.emit({ ...event, kind: 'build_tool_result', summary: result.isError ? 'The tool returned an error.' : 'The tool returned successfully.', response: truncateForDisplay(result.text) }, 'complete')
      return result
    }
  }))
}
