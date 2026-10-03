import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ThreadDataStore, executionThreadId } from '../../data/ThreadDataStore'
import type { ProjectManager } from '../../data/ProjectManager'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { ThreadWorkspaceManager } from '../../workspace/ThreadWorkspaceManager'
import { NetError, isId } from '../../../shared/net'
import type { ExecutionRecord } from '../../net/contracts'
import type { ActiveBot } from '../registry'
import type { AuthorizedMention, PlannedBotOutput } from '../admission'
import { same } from '../../net/store/database'
export interface MmsBotMaterializerOptions {
  profileId: string; profileHome: string; threads: ThreadDataStore; projects: ProjectManager
  fault?(point: string): void
}
export interface MaterializedBotWorkspace { threadId: string; workspaceId: string; scratchRoot: string; projectRoot?: string }
export function botThreadKey(profileId: string, scope: string, bot: string, trigger: string): string { return `net-bot/v1/${profileId}/${scope}/${bot}/${trigger}` }
/** Actual standalone MMS threads and local owned scratch; remote requests never select filesystem paths. */
export class MmsBotMaterializer {
  readonly profileHome: string
  constructor(readonly options: MmsBotMaterializerOptions) { this.profileHome = realpathSync(options.profileHome) }
  plannedIds(mention: AuthorizedMention): Pick<PlannedBotOutput,'backingThreadId'|'workspaceId'> {
    const key = botThreadKey(this.options.profileId, mention.bot.space, mention.bot.bot, mention.envelope.id)
    return { backingThreadId: executionThreadId(key), workspaceId: executionThreadId(`${key}/workspace`) }
  }
  materialize(record: ExecutionRecord, bot: ActiveBot): MaterializedBotWorkspace {
    const binding = record.binding
    if (record.state !== 'accepted' || !binding || binding.profileId !== this.options.profileId || !isId('event', record.trigger) || record.scope !== bot.space || record.target !== bot.bot || binding.definitionRevision !== bot.definitionRevision || binding.profileDigest !== bot.profileDigest) throw new NetError('forbidden')
    const key = botThreadKey(this.options.profileId, record.scope, record.target, record.trigger)
    if (binding.backingThreadId !== executionThreadId(key) || binding.workspaceId !== executionThreadId(`${key}/workspace`)) throw new NetError('conflict')
    this.options.fault?.('bots.materialize.beforeThread')
    const thread = this.options.threads.ensureExecutionThread(key, binding.visibilityEpoch === undefined ? 'Bot execution' : 'Private bot execution')
    if (thread.id !== binding.backingThreadId) throw new NetError('conflict')
    this.options.fault?.('bots.materialize.afterThread')
    const threadRoot = realpathSync(this.options.threads.getThreadDir(thread.id)), local = relative(this.profileHome, threadRoot)
    if (!local || local.startsWith('..') || local.startsWith('/')) throw new NetError('forbidden')
    const root = join(threadRoot, 'bot-workspaces')
    this.directory(root); const scratchRoot = join(root, binding.workspaceId); this.directory(scratchRoot)
    this.options.fault?.('bots.materialize.afterDirectory')
    const markerPath = join(scratchRoot, '.net-bot-workspace.json'), expected = { v: 1, profileId: this.options.profileId, execution: record.id, threadId: thread.id, workspaceId: binding.workspaceId, compartment: binding.compartment }
    if (existsSync(markerPath)) {
      if (lstatSync(markerPath).isSymbolicLink() || !lstatSync(markerPath).isFile() || !same(JSON.parse(readFileSync(markerPath, 'utf8')), expected)) throw new NetError('conflict')
    } else {
      if (readdirSync(scratchRoot).length) throw new NetError('conflict', 'Unmarked nonempty workspace requires owner recovery.')
      atomicWriteJsonSync(markerPath, expected, { mode: 0o600 })
    }
    this.options.fault?.('bots.materialize.afterMarker')
    // Existing manager owns the thread context; chat deliberately has no project/Git context.
    new ThreadWorkspaceManager(threadRoot).unboundExecutionContext(thread.id)
    let projectRoot: string | undefined
    if (bot.profile === 'reader') {
      const project = bot.projectId && this.options.projects.getProject(bot.projectId)
      if (!project || !existsSync(project.path)) throw new NetError('repo_not_bound')
      projectRoot = realpathSync(project.path)
    } else if (bot.projectId !== undefined) throw new NetError('forbidden')
    return { threadId: thread.id, workspaceId: binding.workspaceId, scratchRoot, ...(projectRoot ? { projectRoot } : {}) }
  }
  assertProjectCurrent(bot: ActiveBot, workspace: MaterializedBotWorkspace): void {
    if (bot.profile === 'reader') {
      const project = bot.projectId && this.options.projects.getProject(bot.projectId)
      if (!project || realpathSync(project.path) !== workspace.projectRoot) throw new NetError('repo_not_bound')
    } else if (workspace.projectRoot !== undefined) throw new NetError('forbidden')
  }
  private directory(path: string): void {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new NetError('forbidden')
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    if (realpathSync(path) !== path) throw new NetError('forbidden')
  }
}
