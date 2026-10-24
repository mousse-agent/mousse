import type { MmsProfileServices } from '../../MmsProfileServices'
import { dispatchMethod } from '../../protocol/handlers'
import { NetError } from '../../../shared/net'
import type { RemoteBackendPort, RemoteChatExtras } from './RemoteApi'
import { mmsJson } from './jsonOutput'
import type { BridgeOrdinaryMethod } from './capabilities'
import {
  CHANNEL_COMMAND_REGISTRY,
  COMPOSER_DESKTOP_COMMANDS
} from '../../../shared/channelCommands'
import { resolveThreadProjectPath } from '../../data/resolveActiveProjectPath'
import type { OrchestratorSendRequest, QueuedMessage } from '../../../shared/types'
import { defaultIntegrationActor } from '../../../shared/integrations/actor'
import { resolveEffectiveSkills } from '../../integrations/catalog/EffectiveIntegrationResolver'

/** Chat modes a remote composer offers, as in the desktop composer's mode menu. */
const REMOTE_CHAT_MODES = ['plan', 'agent', 'build'] as const

/** A queued message without its image data, which can be megabytes. */
function queueRow(item: QueuedMessage): Record<string, unknown> {
  return {
    id: item.id,
    content: item.content,
    ...(item.mode !== undefined ? { mode: item.mode } : {}),
    images: (item.images ?? []).map((image) => ({ name: image.name, mimeType: image.mimeType })),
    enqueuedAt: item.enqueuedAt,
    order: item.order,
    intent: item.intent,
    state: item.state,
    ...(item.source ? { source: item.source } : {})
  }
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Adapts the actual profile services, never a client-supplied ingress/profile/path. */
export class MmsRemoteBackend implements RemoteBackendPort {
  constructor(
    private readonly services: MmsProfileServices,
    private readonly revision: () => number = () => 0
  ) {}
  async execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>): Promise<unknown> {
    if (
      typeof params.threadId === 'string' &&
      !this.services.threads.listAllThreads().some((thread) => thread.id === params.threadId)
    )
      throw new NetError('stream_unknown', 'Thread is outside this profile inventory.')
    if (
      typeof params.projectId === 'string' &&
      !this.services.projects.listProjects().some((project) => project.id === params.projectId)
    )
      throw new NetError('bad_request', 'Project is outside this profile inventory.')
    const composer = await this.composer(method, params)
    if (composer !== undefined) return mmsJson(composer)
    return mmsJson(
      await dispatchMethod(
        {
          mms: this.services,
          globalSequence: this.revision,
          emitEvent: (type, data) => {
            if (type === 'threads.updated') this.services.events.broadcast('threads:updated', data)
          }
        },
        method,
        params
      )
    )
  }
  /**
   * Composer methods answer here rather than through the local protocol handlers: remote callers
   * get trimmed rows (no paths, no image data), never change global settings, and receive expected
   * refusals as `{ ok: false, error }` so the reason survives a mutating RPC.
   */
  private async composer(
    method: BridgeOrdinaryMethod,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const s = this.services,
      threadId = params.threadId as string
    switch (method) {
      case 'composer.options':
        return this.composerOptions(params.threadId as string | undefined)
      case 'threads.setModel': {
        const model = params.model as { instanceId?: string; llmProvider?: string; model: string }
        try {
          // Unknown or disabled instances are refused before anything is stored.
          const override = s.providerInstances.overrideFor(model)
          const modelOverride = s.orchestrator.setThreadModelOverride(threadId, override)
          s.events.broadcast('threads:updated', { threads: s.threads.listAllThreads() })
          return { ok: true, modelOverride: modelOverride ?? null }
        } catch (error) {
          return failure(error)
        }
      }
      case 'queue.list':
        return { items: s.orchestrator.listQueue(threadId).map(queueRow) }
      case 'queue.enqueue': {
        const input: OrchestratorSendRequest = {
          content: params.content as string,
          ...(params.mode !== undefined
            ? { mode: params.mode as OrchestratorSendRequest['mode'] }
            : {}),
          ...(Array.isArray(params.images)
            ? { images: params.images as OrchestratorSendRequest['images'] }
            : {})
        }
        try {
          await this.assertSkillMode(threadId, input.mode)
          const item = s.orchestrator.enqueueAndDrain(threadId, input, 'remote')
          return {
            ok: true,
            item: queueRow(item),
            items: s.orchestrator.listQueue(threadId).map(queueRow)
          }
        } catch (error) {
          return failure(error)
        }
      }
      case 'queue.remove': {
        let removed
        try {
          removed = s.orchestrator.removeQueuedItem(threadId, params.itemId as string)
        } catch (error) {
          return failure(error)
        }
        return removed
          ? { ok: true, items: s.orchestrator.listQueue(threadId).map(queueRow) }
          : { ok: false, error: 'This message already started or is no longer queued.' }
      }
      case 'queue.reorder':
        try {
          s.orchestrator.reorderQueue(threadId, params.orderedIds as string[])
          return { ok: true, items: s.orchestrator.listQueue(threadId).map(queueRow) }
        } catch (error) {
          return failure(error)
        }
      case 'queue.promoteToSteer':
        try {
          const ok = s.orchestrator.promoteQueueItemToSteer(threadId, params.itemId as string)
          return { ok, items: s.orchestrator.listQueue(threadId).map(queueRow) }
        } catch (error) {
          return failure(error)
        }
      default:
        return undefined
    }
  }
  /** The models, default model, modes, skills and slash commands a composer offers. */
  private async composerOptions(threadId?: string): Promise<unknown> {
    const s = this.services
    await s.providerAuth.init()
    const settings = s.settings.get()
    const projectPath = threadId
      ? resolveThreadProjectPath(s.projects, s.threads, threadId)
      : undefined
    let skills: Array<{ id: string; name: string; description: string }> = []
    try {
      skills = (await this.effectiveSkills(projectPath)).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description
      }))
    } catch {
      // Skills are optional in the composer; models still load.
    }
    const provider = settings.provider
    return {
      providers: s.providerInstances.llmProviders(),
      defaultModel: provider?.model
        ? {
            ...(provider.instanceId ? { instanceId: provider.instanceId } : {}),
            llmProvider: provider.llmProvider,
            model: provider.model
          }
        : null,
      modes: REMOTE_CHAT_MODES,
      skills,
      commands: [...CHANNEL_COMMAND_REGISTRY, ...COMPOSER_DESKTOP_COMMANDS].map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.aliases ? { aliases: command.aliases } : {}),
        ...(command.argsHint ? { argsHint: command.argsHint } : {})
      }))
    }
  }
  /** The skills the desktop composer offers: the same resolution a turn applies. */
  private async effectiveSkills(projectPath?: string) {
    const snapshot = await this.services.skillsRegistry.discover({ projectPath })
    return resolveEffectiveSkills({
      snapshot,
      settings: this.services.settings.get().integrations.skills,
      actor: defaultIntegrationActor(false)
    })
  }
  /** Refuses a skill mode whose skill this composer would not offer, before anything is stored. */
  private async assertSkillMode(threadId: string, mode: unknown): Promise<void> {
    if (!mode || typeof mode !== 'object') return
    const skillId = (mode as { skillId: string }).skillId,
      s = this.services
    let skills: Awaited<ReturnType<MmsRemoteBackend['effectiveSkills']>> = []
    try {
      skills = await this.effectiveSkills(resolveThreadProjectPath(s.projects, s.threads, threadId))
    } catch {
      // Treated as no skills: the mode is refused below.
    }
    if (!skills.some((skill) => skill.id === skillId || skill.installationId === skillId))
      throw new Error('That skill is not available.')
  }
  snapshot(threadId: string, maximumBytes = 25 * 1024 * 1024): unknown {
    const s = this.services,
      thread = s.threads.listAllThreads().find((thread) => thread.id === threadId)
    if (!thread) throw new NetError('stream_unknown', 'Thread not found.')
    return mmsJson(
      {
        thread,
        messages: s.orchestrator.getMessages(threadId),
        queue: s.orchestrator.listQueue(threadId),
        pendingQuestions: s.questions.listPendingForThread(threadId),
        activeTurn: {
          active: s.orchestrator.isTurnActive(threadId),
          running: s.orchestrator.isActiveTurnRunning(threadId)
        },
        revision: this.revision()
      },
      maximumBytes
    )
  }
  async run(
    threadId: string,
    content: string,
    control: Parameters<RemoteBackendPort['run']>[2],
    extras: RemoteChatExtras = {}
  ): Promise<unknown> {
    if (!this.services.threads.listAllThreads().find((thread) => thread.id === threadId))
      throw new NetError('stream_unknown', 'Thread not found.')
    try {
      await this.assertSkillMode(threadId, extras.mode)
    } catch (error) {
      return { text: '', silent: false, error: failure(error).error }
    }
    // Existing MMS takes an owned cross-process lease and binds this exact signal to executeTurn.
    return mmsJson(
      await this.services.orchestrator.runChannelTurn(threadId, content, this.services.threads, {
        signal: control.signal,
        drainSteer: control.drainSteer,
        ...(extras.mode !== undefined ? { mode: extras.mode } : {}),
        ...(extras.images?.length ? { images: extras.images } : {})
      })
    )
  }
}
