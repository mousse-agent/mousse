import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { ChatResourceParticipant, ChatSharedFileWriteResult, ChatSharedTerminal } from '../../../shared/chatResources'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../../../shared/browser/automation'
import type { BrowserViewerSnapshot } from '../../../shared/browser/viewer'
import { BrowserViewerService } from '../../browser/viewer/BrowserViewerService'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import { assertEpisodePath } from '../../agents/WorkspaceAccessPolicy'
import { atomicWriteFileSync } from '../../data/AtomicFs'
import { ThreadActionService, type RunThreadActionOptions } from '../../actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../../workspace/ThreadWorkspaceManager'
import { heartbeatExecutionLease, releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../../actions/GitOperationCoordinator'
import { ChatResourceError, ChatResourceService, chatFileRevision, type ChatResourceHost, type TrustedChatResourceBinding } from './ChatResourceService'

export interface ChatGroupResourceBinding {
  profileId: string
  chatId: string
  threadId: string
  workspaceRoot: string
  participants: ChatResourceParticipant[]
}

/** Uses the group's trusted shared root and the existing backing thread writer lease. */
export function createMmsChatResourceService(services: MmsProfileServices, resolveGroup: (groupId: string) => ChatGroupResourceBinding | Promise<ChatGroupResourceBinding>): ChatResourceService {
  const profileId = services.profileId
  const policy = new ExecutionPolicyService().snapshot(profileId, {
    allowedTools: [...BROWSER_AUTOMATION_TOOLS],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'write', 'external'], approvalEffects: [], maxToolCalls: 100,
    maxElapsedMs: 30 * 60_000, maxArtifactBytes: 10 * 1024 * 1024
  })
  const dimensions = new Map<string, { columns: number; rows: number }>()
  const assertBinding = async (binding: TrustedChatResourceBinding): Promise<void> => {
    const fresh = await resolveGroup(binding.groupId)
    if (fresh.profileId !== profileId || fresh.threadId !== binding.threadId || fresh.workspaceRoot !== binding.workspaceRoot || !fresh.participants.some((participant) => participant.id === binding.participant.id)) throw new ChatResourceError('resource_binding_changed', 'Group resource membership or workspace changed')
    const manager = new ThreadWorkspaceManager(services.threads.getThreadDir(binding.threadId))
    const metadata = manager.load()
    if (metadata && (metadata.lifecycle !== 'ready' || await realpath(manager.executionContext('', metadata).projectPath) !== binding.workspaceRoot)) throw new ChatResourceError('resource_owner_mismatch', 'Group workspace differs from the owned task workspace')
  }
  const browserContext = (binding: TrustedChatResourceBinding, sessionId?: string): BrowserToolContext => {
    const scope = sessionId ? services.platform.browser.sessions.trustedSessionScope({ profileId, threadId: binding.threadId, sessionId }) : undefined
    if (scope?.record.backend === 'electron-attached') throw new ChatResourceError('resource_owner_mismatch', 'Shared groups use a managed browser; attached tabs retain their GUI owner')
    const nonce = randomUUID()
    return {
      execution: { profileId, threadId: binding.threadId, ...(scope?.runId ? { runId: scope.runId } : {}),
        turnId: `chat-resource:${nonce}`, actor: { kind: 'main' }, policySnapshotId: policy.id,
        source: 'gui', cancellationId: `chat-resource:${nonce}` },
      policy, signal: new AbortController().signal, vision: true, target: { backend: 'managed-chromium' }
    }
  }
  const viewer = (binding: TrustedChatResourceBinding, sessionId: string): BrowserViewerService => new BrowserViewerService({
    sessions: services.platform.browser.sessions, context: browserContext(binding, sessionId),
    artifactResolver: (artifactId, context, id) => services.platform.browser.artifacts.describe({
      profileId, threadId: binding.threadId, ...(context.execution.runId ? { runId: context.execution.runId } : {}), sessionId: id
    }, artifactId)
  })
  const stripLease = (snapshot: BrowserViewerSnapshot): BrowserViewerSnapshot => {
    if (!snapshot.session) return snapshot
    const { controlLeaseId: _lease, ...session } = snapshot.session
    return { ...snapshot, session }
  }
  const terminal = (binding: TrustedChatResourceBinding, terminalId: string): ChatSharedTerminal => {
    const item = services.ptyManager.lookup(terminalId)
    if (!item.alive || item.threadId !== binding.threadId) throw new ChatResourceError('resource_not_found', 'Terminal is not owned by this group')
    return { id: terminalId, threadId: binding.threadId, title: 'Shared terminal', alive: true,
      ...(dimensions.get(terminalId) ?? { columns: 120, rows: 30 }) }
  }
  const read = async (binding: TrustedChatResourceBinding, path: string): Promise<string> => {
    await assertBinding(binding)
    const resolved = assertEpisodePath(binding.workspaceRoot, path)
    const info = await stat(resolved)
    if (!info.isFile() || info.size > 512 * 1024) throw new ChatResourceError('invalid_params', 'Choose a text file smaller than 512KB')
    return readFile(resolved, 'utf8')
  }
  const host: ChatResourceHost = {
    async admit(context) {
      const group = await resolveGroup(context.groupId)
      const participant = group.participants.find((item) => item.id === context.participantId)
      if (group.profileId !== profileId || group.chatId !== context.groupId || !participant) throw new ChatResourceError('membership_required', 'Participant is not a member of this group')
      const binding = { profileId, groupId: group.chatId, threadId: group.threadId, workspaceRoot: group.workspaceRoot, participant }
      await assertBinding(binding)
      return binding
    },
    browser: {
      async list(binding) {
        await assertBinding(binding)
        const records = services.platform.browser.listPublicSessions(binding.threadId).filter((session) => session.backend === 'managed-chromium')
        return Promise.all(records.map(async (session) => stripLease(await viewer(binding, session.id).snapshot({ sessionId: session.id }))))
      },
      async open(binding, url) {
        await assertBinding(binding)
        const context = browserContext(binding)
        const result = await services.platform.browser.sessions.open(context, { url, persistent: false })
        if (!result.session) throw new ChatResourceError('resource_unavailable', 'Browser did not open')
        return stripLease(await viewer(binding, result.session.id).observe({ sessionId: result.session.id }))
      },
      async observe(binding, sessionId, tabId) { await assertBinding(binding); return stripLease(await viewer(binding, sessionId).observe({ sessionId, tabId })) },
      async control(binding, sessionId, owner) {
        await assertBinding(binding)
        const current = viewer(binding, sessionId)
        return stripLease(await (owner === 'human' ? current.takeControl({ sessionId }) : current.resumeAgent({ sessionId })))
      },
      async action(binding, action) { await assertBinding(binding); return stripLease(await viewer(binding, action.sessionId).humanAction(action)) },
      async close(binding, sessionId) { await assertBinding(binding); await viewer(binding, sessionId).close({ sessionId }) }
    },
    terminal: {
      async list(binding) {
        await assertBinding(binding)
        return services.ptyManager.list(binding.threadId).map((item) => terminal(binding, item.ptyId))
      },
      async create(binding, columns, rows) {
        await assertBinding(binding)
        const directory = services.threads.getThreadDir(binding.threadId)
        const lease = tryAcquireExecutionLease(directory, { source: 'chat-shared-terminal' })
        if (!lease) throw new ChatResourceError('workspace_busy', 'The group agent is using the workspace; wait before opening a terminal')
        let createdId: string | undefined
        let actions: ThreadActionService | undefined
        let actionOptions: RunThreadActionOptions | undefined
        let startSha: string | undefined
        try {
          await assertBinding(binding)
          const metadata = new ThreadWorkspaceManager(directory).load()
          if (metadata) {
            actions = new ThreadActionService(directory)
            const latest = actions.latest(metadata.conversationBranchId)
            startSha = metadata.headSha
            actionOptions = { threadId: binding.threadId, turnId: `chat-terminal:${randomUUID()}`, actor: { kind: 'user' },
              conversationBranchId: metadata.conversationBranchId, workspacePath: binding.workspaceRoot, heldThreadLease: lease,
              presentationMessageStart: latest?.presentationMessageEnd ?? 0, presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
              nativeContextBoundary: latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' },
              externalEffects: [{ kind: 'unknown', reversible: false, description: 'Shared terminal commands may affect external services or ignored files.' }] }
            actions.beginTurn(actionOptions, startSha)
          }
          const id = services.ptyManager.create(`chat:${binding.groupId}`, binding.workspaceRoot, undefined, {
            threadId: binding.threadId,
            ownership: { assert: () => assertHeldThreadLease(directory, lease), heartbeat: () => { heartbeatExecutionLease(lease) },
              settled: async () => {
                try { if (actions && actionOptions && startSha) await actions.checkpointExistingTurn(actionOptions, startSha, 'completed') }
                finally { releaseExecutionLeaseHandle(lease) }
              } }
          })
          createdId = id
          services.threadRuntimes.registerPty(binding.threadId, id)
          dimensions.set(id, { columns, rows })
          services.ptyManager.resize(id, columns, rows)
          return terminal(binding, id)
        } catch (error) {
          if (createdId) await services.ptyManager.killAndWait(createdId)
          else {
            try { if (actions && actionOptions && startSha) await actions.checkpointExistingTurn(actionOptions, startSha, 'failed') }
            finally { releaseExecutionLeaseHandle(lease) }
          }
          throw error
        }
      },
      async output(binding, id, afterSequence) { await assertBinding(binding); terminal(binding, id); return services.ptyManager.getOutputSince(id, afterSequence) },
      async write(binding, id, data) { await assertBinding(binding); terminal(binding, id); services.ptyManager.write(id, data) },
      async resize(binding, id, columns, rows) { await assertBinding(binding); terminal(binding, id); services.ptyManager.resize(id, columns, rows); dimensions.set(id, { columns, rows }) },
      async close(binding, id) { await assertBinding(binding); terminal(binding, id); await services.ptyManager.killAndWait(id); dimensions.delete(id) }
    },
    file: {
      read,
      async write(binding, path, content, expectedRevision): Promise<ChatSharedFileWriteResult> {
        await assertBinding(binding)
        const directory = services.threads.getThreadDir(binding.threadId)
        const lease = tryAcquireExecutionLease(directory, { source: 'chat-shared-file' })
        if (!lease) throw new ChatResourceError('workspace_busy', 'The group workspace has another active writer')
        try {
          await assertBinding(binding)
          let current = ''
          try { current = await read(binding, path) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          const revision = chatFileRevision(current)
          if (revision !== expectedRevision) return { status: 'conflict', file: { path, content: current, revision } }
          const mutate = () => {
            assertHeldThreadLease(directory, lease)
            const target = assertEpisodePath(binding.workspaceRoot, path)
            atomicWriteFileSync(target, content)
          }
          const metadata = new ThreadWorkspaceManager(directory).load()
          if (metadata) {
            const actions = new ThreadActionService(directory)
            const latest = actions.latest(metadata.conversationBranchId)
            await actions.runCheckpointedAction({ threadId: binding.threadId, turnId: randomUUID(), actor: { kind: 'user' },
              conversationBranchId: metadata.conversationBranchId, workspacePath: binding.workspaceRoot, heldThreadLease: lease,
              presentationMessageStart: latest?.presentationMessageEnd ?? 0, presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
              nativeContextBoundary: latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' }
            }, mutate)
          } else mutate()
          return { status: 'saved', file: { path, content, revision: chatFileRevision(content) } }
        } finally { releaseExecutionLeaseHandle(lease) }
      }
    }
  }
  return new ChatResourceService(profileId, host)
}
