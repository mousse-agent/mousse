import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { isInsidePath } from '../../files/pathGuard'
import {
  currentFolderEnvironment,
  sensitiveFolderHolding,
  type FolderRuleEnvironment
} from '../../files/sensitiveFolders'
import { portableRepository } from '../dispatch/repository'
import { matchProject, type ProjectIdentity } from './projectMatch'
import { withoutStandingRules } from '../../orchestrator/UserQuestionService'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { dispatchMethod } from '../../protocol/handlers'
import { NetError, type NodeId } from '../../../shared/net'
import { REMOTE_MESSAGE_IMAGES_MAX_CHARS } from './RemoteApi'
import type { PermissionMode } from '../../../shared/permissionMode'
import { newestMessages } from '../../protocol/transcriptPaging'
import { ROUTED_SNAPSHOT_MESSAGE_BYTES } from '../../../shared/bridge/routed'
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

type RemoteImage = { name: string; mimeType: string; data?: string }

/**
 * A queued item as a remote reader sees it: images keep their name and type but not their data,
 * which can be megabytes each.
 */
export function withoutImageData<T extends { images?: unknown }>(item: T): T {
  if (!Array.isArray(item?.images)) return item
  return {
    ...item,
    images: (item.images as RemoteImage[]).map((image) => ({
      name: image.name,
      mimeType: image.mimeType
    }))
  }
}

/**
 * Messages as a remote reader sees them: the newest images keep their data until
 * `REMOTE_MESSAGE_IMAGES_MAX_CHARS` is used up, and every older image keeps only its name and
 * type, so a remote snapshot or event stays small however many images the thread holds.
 */
export function withImageBudget<T extends { images?: unknown }>(items: T[]): T[] {
  let remaining = REMOTE_MESSAGE_IMAGES_MAX_CHARS
  const trimmed = items.slice()
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const item = trimmed[index]
    if (!Array.isArray(item?.images)) continue
    const images = (item.images as RemoteImage[]).slice()
    for (let at = images.length - 1; at >= 0; at -= 1) {
      const image = images[at]
      const size = typeof image.data === 'string' ? image.data.length : 0
      if (size <= remaining) {
        remaining -= size
      } else {
        // Once one image does not fit, every older one goes without data too.
        remaining = 0
        images[at] = { name: image.name, mimeType: image.mimeType }
      }
    }
    trimmed[index] = { ...item, images }
  }
  return trimmed
}

/** Trims image data from a thread event's payload before it is shown to a remote reader. */
export function remoteThreadEventData(data: unknown): unknown {
  const body = data as {
    message?: { images?: unknown }
    messages?: Array<{ images?: unknown }>
    items?: Array<{ images?: unknown }>
  }
  if (!body || typeof body !== 'object') return data
  return {
    ...body,
    ...(body.message ? { message: withImageBudget([body.message])[0] } : {}),
    ...(Array.isArray(body.messages) ? { messages: withImageBudget(body.messages) } : {}),
    ...(Array.isArray(body.items) ? { items: body.items.map(withoutImageData) } : {})
  }
}

/** How long a project's repository identity is reused before its repository is read again. */
const IDENTITY_TTL_MS = 5 * 60_000
/** Projects looked at for one match; a profile with more is matched against the first ones. */
const MATCH_PROJECT_LIMIT = 256

/**
 * A Windows network or device path (`\\host\share`, `\\?\C:\x`, `\\.\pipe\x`). Resolving one makes
 * this computer reach out to a host the caller names, and the lookup blocks until it answers.
 */
function isNetworkOrDevicePath(path: string): boolean {
  return process.platform === 'win32' && /^[\\/]{2}/.test(path)
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Adapts the actual profile services, never a client-supplied ingress/profile/path. */
export class MmsRemoteBackend implements RemoteBackendPort {
  /** Repository identity per project path, null for a folder that is not a Git repository. */
  private readonly identities = new Map<string, { at: number; identity: ProjectIdentity | null }>()
  constructor(
    private readonly services: MmsProfileServices,
    private readonly revision: () => number = () => 0,
    /** Where this computer keeps credentials and settings (the user's home, the platform, tool folders). */
    private readonly folderRules: () => FolderRuleEnvironment = currentFolderEnvironment
  ) {}
  async execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>, caller?: { node: NodeId }): Promise<unknown> {
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
    if (method === 'orchestrator.answerQuestions' || method === 'orchestrator.dismissQuestions') {
      // A remote caller may only settle a question that belongs to the thread it names. A saved
      // request another client already settled still names its thread, so the caller learns who
      // answered first instead of a bare refusal; any other thread or an unknown id gets no detail.
      if (
        this.services.questions.getRequest(params.requestId as string)?.threadId !== params.threadId
      )
        return { ok: false }
    }
    if (method === 'projects.open') return mmsJson(this.openProject(params.path))
    if (method === 'projects.match') return mmsJson(await this.matchProject(params))
    const composer = await this.composer(method, params)
    if (composer !== undefined) return mmsJson(composer)
    if (method === 'threads.create') return mmsJson(await this.createThread(params, caller))
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
   * Creates the thread as the local protocol does, then records the device that asked (and its own
   * project id) on it, so every device that lists this machine's threads can show where it began.
   */
  private async createThread(params: Record<string, unknown>, caller?: { node: NodeId }): Promise<unknown> {
    const { startedFromProjectId, ...create } = params
    const result = (await dispatchMethod({ mms: this.services, globalSequence: this.revision }, 'threads.create', create)) as
      { thread: { id: string } } & Record<string, unknown>
    if (!caller) return result
    const thread = this.services.threads.updateThreadMeta(
      result.thread.id,
      { startedFrom: { node: caller.node, ...(typeof startedFromProjectId === 'string' ? { projectId: startedFromProjectId } : {}) } },
      { touch: false }
    )
    this.services.events.broadcast('threads:updated', { threads: this.services.threads.listAllThreads() })
    return { ...result, thread }
  }
  /**
   * Which of this machine's projects is the same Git repository as the one described: an id, or
   * nothing. Read-only; only ids leave this machine, never a path. Identities are cached by path
   * for a few minutes, so a profile's repositories are read once per window of use.
   */
  private async matchProject(params: Record<string, unknown>): Promise<{ projectId?: string }> {
    const now = Date.now()
    const candidates: Array<{ id: string; identity: ProjectIdentity | null }> = []
    for (const [path, held] of this.identities) if (now - held.at > IDENTITY_TTL_MS) this.identities.delete(path)
    for (const project of this.services.projects.listProjects().slice(0, MATCH_PROJECT_LIMIT)) {
      let held = this.identities.get(project.path)
      if (!held || now - held.at > IDENTITY_TTL_MS) {
        let identity: ProjectIdentity | null = null
        try {
          const { roots, remotes } = await portableRepository(project.path)
          identity = { roots, remotes }
        } catch {
          // Not a Git repository, or not readable: it never matches.
        }
        held = { at: now, identity }
        this.identities.set(project.path, held)
      }
      candidates.push({ id: project.id, identity: held.identity })
    }
    const projectId = matchProject(
      { roots: params.roots as string[], remotes: (params.remotes as string[] | undefined) ?? [] },
      candidates
    )
    return projectId ? { projectId } : {}
  }
  /**
   * Registers an existing directory on this machine as a project. The path comes from another
   * machine, so it must be absolute, exist, be a directory, and not lie inside the Mousse home
   * (which holds keys and every profile's data) or contain it (a user's home folder holds it). A
   * directory is never created. Refusals answer `{ ok: false, error }` so the reason survives a
   * mutating RPC.
   */
  private openProject(path: unknown): { ok: true; project: unknown } | { ok: false; error: string } {
    const refuse = (error: string) => ({ ok: false as const, error })
    if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
      return refuse('Enter the full path of a folder.')
    if (isNetworkOrDevicePath(path.trim()))
      return refuse('Network and device paths cannot be opened from another computer.')
    if (!isAbsolute(path)) return refuse('Enter the full path of a folder, starting from the root.')
    const lexical = resolve(path)
    if (dirname(lexical) === lexical) return refuse('Pick a folder, not the root of the disk.')
    let real: string
    try {
      real = realpathSync.native(lexical)
      if (isNetworkOrDevicePath(real))
        return refuse('Network and device paths cannot be opened from another computer.')
      if (!statSync(real).isDirectory()) return refuse('That path is a file, not a folder.')
    } catch {
      return refuse('That folder does not exist on this computer.')
    }
    const s = this.services
    for (const home of [s.getProfileHomeDir(), s.getHomeDir()]) {
      let realHome = home
      try {
        realHome = realpathSync.native(home)
      } catch {
        // A home that cannot be resolved is still compared by its own path.
      }
      const homes = [home, realHome],
        folders = [lexical, real]
      // Inside the data folder, or a folder that holds it: file tools may edit anything below the
      // project folder, so a thread there could change the keys and databases without asking.
      if (homes.some((root) => folders.some((folder) => isInsidePath(folder, root) || isInsidePath(root, folder))))
        return refuse('That folder is part of the Mousse data folder, or contains it.')
    }
    // The user's credentials and settings (SSH keys, cloud sign-ins, keychains, browser profiles), and so the home
    // folder and everything above it: a thread there could read or change them without asking.
    const holding = sensitiveFolderHolding([lexical, real], this.folderRules())
    if (holding)
      return refuse(
        `That folder holds ${holding}, or is inside or above a folder that does, so it cannot be opened from another computer.`
      )
    const project = s.projects.openProject(real)
    s.events.broadcast('projects:updated', s.projects.listProjects())
    return { ok: true, project }
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
          // As the local handler does: a model hidden, or an instance the thread's project turned off, is refused.
          const projectId = s.threads.getThread(threadId)?.projectId
          s.harness?.resolveStored(override, {
            purpose: 'composer',
            scope: projectId ? { kind: 'project', projectId } : { kind: 'device' }
          })
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
      providers: (await s.harness?.llmProviders({ kind: 'device' })) ?? [],
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
  /**
   * What a reader is given on opening a thread. `newestOnly` is for another computer of the user: a
   * long transcript is cut to its newest 16 MiB (`earlier` says where the rest begins, and
   * `thread.messages` pages it), where a phone's snapshot is whole and fails past its bound.
   */
  snapshot(
    threadId: string,
    maximumBytes = 25 * 1024 * 1024,
    options: { newestOnly?: boolean; deviceLimit?: PermissionMode } = {}
  ): unknown {
    const s = this.services,
      thread = s.threads.listAllThreads().find((thread) => thread.id === threadId)
    if (!thread) throw new NetError('stream_unknown', 'Thread not found.')
    const pause = s.orchestrator.getTurnState(threadId).pause
    const shown = withImageBudget(s.orchestrator.getMessages(threadId))
    const kept = options.newestOnly
      ? newestMessages(shown, ROUTED_SNAPSHOT_MESSAGE_BYTES)
      : { messages: shown, earlier: undefined }
    return mmsJson(
      {
        thread,
        messages: kept.messages,
        ...(kept.earlier ? { earlier: kept.earlier } : {}),
        queue: s.orchestrator.listQueue(threadId).map(withoutImageData),
        // A phone's cards have no "Always for this thread"; another computer's keep it where its limit allows the rule.
        pendingQuestions: options.deviceLimit
          ? s.questions.listPendingForDevice(threadId, options.deviceLimit)
          : s.questions.listPendingForThread(threadId).map(withoutStandingRules),
        activeTurn: {
          active: s.orchestrator.isTurnActive(threadId),
          running: s.orchestrator.isActiveTurnRunning(threadId),
          // A run that hit a usage limit: when it resets and whether it continues by itself. Absent otherwise.
          ...(pause ? { paused: { runId: pause.runId, until: pause.until, estimated: pause.estimated, autoResume: pause.autoResume, ...(pause.stale ? { stale: true } : {}), ...(pause.limitKind ? { limitKind: pause.limitKind } : {}) } } : {})
        },
        revision: this.revision()
      },
      maximumBytes
    )
  }
  isActive(threadId: string): boolean {
    const o = this.services.orchestrator
    const engine = this.services.runEngine
    // A turn counts from the moment it is admitted (before it marks its run starting), and a queued run counts
    // once its `turn.start` is claimed: the person's turn is on its way even when no check below sees it running.
    return (
      o.isTurnActive(threadId) ||
      o.isActiveTurnRunning(threadId) ||
      o.isChannelTurnActive(threadId) ||
      engine.getActiveRun(threadId) !== null ||
      engine.store.listQueuedRuns(threadId).some((run) => engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'turn.start' && effect.status === 'running'))
    )
  }
  async stop(threadId: string): Promise<unknown> {
    // The same inventory check as `execute`: a remote caller reaches only this profile's threads.
    if (!this.services.threads.listAllThreads().some((thread) => thread.id === threadId))
      throw new NetError('stream_unknown', 'Thread is outside this profile inventory.')
    try {
      return await this.services.orchestrator.stopThread(threadId, 'remote')
    } catch (error) {
      // The remote run was aborted already; a failure to reach the subagents is not the caller's error.
      console.warn('remote stop could not reach the subagents of a thread', { threadId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
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
        onUserInputAccepted: control.onAccepted,
        ...(extras.mode !== undefined ? { mode: extras.mode } : {}),
        ...(extras.images?.length ? { images: extras.images } : {})
      })
    )
  }
}
