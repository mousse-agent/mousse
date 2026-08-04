import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { NativeContextBoundary, ThreadAction } from '../../shared/threadActions'
import type { ConversationBranchId } from '../../shared/workspace'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { changedPaths, git, MOUSSE_COMMIT_ENV, requireClean, tryGit } from './git'

export interface RunThreadActionOptions {
  threadId: string
  turnId: string
  conversationBranchId: ConversationBranchId
  workspacePath: string
  presentationMessageStart: number
  presentationMessageEnd: number
  nativeContextBoundary: NativeContextBoundary
  signal?: AbortSignal
}

export class ActionExecutionError extends Error {
  constructor(readonly action: ThreadAction, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ActionExecutionError'
  }
}

export class ThreadActionService {
  private readonly actionsPath: string
  private readonly journal: ThreadJournal

  constructor(private readonly threadDirectory: string) {
    this.actionsPath = join(threadDirectory, 'actions.json')
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ThreadAction[] {
    if (!existsSync(this.actionsPath)) return []
    return JSON.parse(readFileSync(this.actionsPath, 'utf8')) as ThreadAction[]
  }

  get(actionId: string): ThreadAction | undefined {
    return this.list().find((action) => action.id === actionId)
  }

  latest(branchId: ConversationBranchId): ThreadAction | undefined {
    return this.list().filter((action) => action.conversationBranchId === branchId).at(-1)
  }

  replace(actions: ThreadAction[]): void {
    atomicWriteJsonSync(this.actionsPath, actions)
  }

  async runCheckpointedAction<T>(
    options: RunThreadActionOptions,
    mutate: () => Promise<T> | T
  ): Promise<{ result: T; action: ThreadAction }> {
    return withGitMutationLocks(
      this.threadDirectory,
      options.workspacePath,
      'thread-action',
      async () => {
        requireClean(options.workspacePath, 'Thread workspace')
        const startSha = git(options.workspacePath, ['rev-parse', 'HEAD'])
        const actions = this.list()
        const action: ThreadAction = {
          id: randomUUID(),
          turnId: options.turnId,
          conversationBranchId: options.conversationBranchId,
          parentActionId: actions.filter((item) => item.conversationBranchId === options.conversationBranchId).at(-1)?.id,
          presentationMessageStart: options.presentationMessageStart,
          presentationMessageEnd: options.presentationMessageEnd,
          nativeContextBoundary: options.nativeContextBoundary,
          startSha,
          endSha: startSha,
          commits: [],
          childIntegrations: [],
          changedPaths: [],
          externalEffects: [],
          reversible: true,
          state: 'running',
          createdAt: new Date().toISOString()
        }
        actions.push(action)
        this.replace(actions)
        this.journal.append({
          operationId: action.id,
          operationType: 'action-checkpoint',
          state: 'running',
          expectedPreState: { startSha, branch: git(options.workspacePath, ['branch', '--show-current']) }
        })
        try {
          const result = await mutate()
          this.checkpoint(options.workspacePath, action, 'completed')
          this.replace(actions)
          return { result, action }
        } catch (error) {
          try {
            this.checkpoint(options.workspacePath, action, 'failed')
          } catch (checkpointError) {
            action.state = 'failed'
            action.externalEffects.push({
              kind: 'unknown',
              description: `Partial checkpoint failed: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`,
              reversible: false
            })
          }
          this.replace(actions)
          throw new ActionExecutionError(action, error)
        }
      },
      options.signal
    )
  }

  private checkpoint(
    workspacePath: string,
    action: ThreadAction,
    state: 'completed' | 'stopped' | 'failed'
  ): void {
    action.state = 'checkpointing'
    git(workspacePath, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
    const staged = !tryGit(workspacePath, ['diff', '--cached', '--quiet']).ok
    if (staged) {
      git(workspacePath, ['commit', '--no-verify', '-m', `mousse: checkpoint turn ${action.turnId}`], MOUSSE_COMMIT_ENV)
    }
    const endSha = git(workspacePath, ['rev-parse', 'HEAD'])
    action.endSha = endSha
    action.commits = action.startSha === endSha
      ? []
      : git(workspacePath, ['rev-list', '--reverse', `${action.startSha}..${endSha}`]).split(/\r?\n/).filter(Boolean)
    action.changedPaths = changedPaths(workspacePath, action.startSha, endSha)
    action.state = state
    action.completedAt = new Date().toISOString()
    this.journal.append({
      operationId: action.id,
      operationType: 'action-checkpoint',
      state: 'completed',
      details: { actionState: state, startSha: action.startSha, endSha, commits: action.commits }
    })
  }
}
