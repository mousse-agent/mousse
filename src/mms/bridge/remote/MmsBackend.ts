import { realpathSync, statSync } from 'node:fs'
import { isLocalOnlyThread } from '../../../shared/threadLineage'
import { dirname, isAbsolute, resolve } from 'node:path'
import { isInsidePath } from '../../files/pathGuard'
import {
  currentFolderEnvironment,
  sensitiveFolderHolding,
  type FolderRuleEnvironment
} from '../../files/sensitiveFolders'
import { matchProjectWithEvidence, type ProjectIdentity } from './projectMatch'
import { repositoryIdentitiesFor } from './repositoryIdentity'
import { withoutStandingRules } from '../../orchestrator/UserQuestionService'
import type { MmsProfileServices } from '../../MmsProfileServices'
import { dispatchMethod } from '../../protocol/handlers'
import { NetError, type NodeId } from '../../../shared/net'
import { REMOTE_MESSAGE_IMAGES_MAX_CHARS } from './RemoteApi'
import { normalizePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { keepImagesWithin, messagesBefore, newestMessages, type EarlierMessages } from '../../protocol/transcriptPaging'
import { isOpenActivityRow } from '../../run/restartNote'
import { listPendingQueue } from '../../queue/ThreadMessageQueue'
import type { MessagePageResult } from '../../data/ThreadDataStore'
import { PHONE_MESSAGES_PAGE_BYTES, PHONE_SNAPSHOT_MESSAGE_BYTES, ROUTED_SNAPSHOT_MESSAGE_BYTES } from '../../../shared/bridge/routed'
import type { RemoteBackendPort, RemoteChatExtras } from './RemoteApi'
import { mmsJson } from './jsonOutput'
import type { BridgeOrdinaryMethod } from './capabilities'
import { COMPOSER_COMMANDS } from '../../../shared/composerCommands'
import { withHiddenBots } from './botReach'
import { resolveThreadProjectPath } from '../../data/resolveActiveProjectPath'
import type { ChatMessage, OrchestratorSendRequest, QueuedMessage, Thread } from '../../../shared/types'
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
    const kept = keepImagesWithin(trimmed[index] as { images?: RemoteImage[] }, remaining)
    trimmed[index] = kept.message as T
    remaining = kept.remaining
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

/** Newest pages read ahead by `warm` and not yet taken by a snapshot; each is at most 16 MiB. */
const WARM_PAGES_MAX = 4

/** Projects looked at for one match; a profile with more is matched against the first ones. */
const MATCH_PROJECT_LIMIT = 256
/** Folders read at once for a match. */
const MATCH_CONCURRENCY = 4

/**
 * A Windows network or device path (`\\host\share`, `\\?\C:\x`, `\\.\pipe\x`). Resolving one makes
 * this computer reach out to a host the caller names, and the lookup blocks until it answers.
 */
function isNetworkOrDevicePath(path: string): boolean {
  return process.platform === 'win32' && /^[\\/]{2}/.test(path)
}

/** The bytes of messages a snapshot holds: 16 MiB for another computer of the user (`newestOnly`), 8 MiB for a phone. */
function snapshotBudget(options: { newestOnly?: boolean }): number {
  return options.newestOnly ? ROUTED_SNAPSHOT_MESSAGE_BYTES : PHONE_SNAPSHOT_MESSAGE_BYTES
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Adapts the actual profile services, never a client-supplied ingress/profile/path. */
export class MmsRemoteBackend implements RemoteBackendPort {
  /** The newest page of a thread `warm` read from its database, by thread and byte budget, for the next snapshot. */
  private readonly pages = new Map<string, MessagePageResult>()
  constructor(
    private readonly services: MmsProfileServices,
    private readonly revision: () => number = () => 0,
    /** Where this computer keeps credentials and settings (the user's home, the platform, tool folders). */
    private readonly folderRules: () => FolderRuleEnvironment = currentFolderEnvironment,
    /** The highest permission mode this computer lets a device run a turn in (`net_node_policy`); absent for a build without limits. */
    private readonly deviceLimit?: (node: NodeId) => PermissionMode
  ) {}
  /**
   * The thread a caller on another device may reach: one of this profile's, and never a private one
   * (`Thread.localOnly`) or a personal bot's (`Thread.botOwned`), which answer as if they did not exist.
   * Every call that names a thread checks here.
   */
  private remoteThread(threadId: string): Thread | undefined {
    const inventory = this.services.threads.listAllThreads()
    const thread = inventory.find((candidate) => candidate.id === threadId)
    return thread && !thread.botOwned && !isLocalOnlyThread(thread, inventory) ? thread : undefined
  }
  async execute(method: BridgeOrdinaryMethod, params: Record<string, unknown>, caller?: { node: NodeId }): Promise<unknown> {
    const result = await this.executeFor(method, params, caller)
    // A thread a bot started names that bot only to a device that reaches it ("Started by a bot" otherwise).
    const shown = withHiddenBots(result, this.services.botReach?.hiddenFor(caller?.node))
    return method === 'storage.usage' ? this.withoutBotThreadNames(shown) : shown
  }
  /**
   * Disk usage as another device sees it: a personal bot's threads are its chat, never listed to a device, and are
   * named after the bot and its work, so their space is counted without a thread (as a private thread's is).
   */
  private withoutBotThreadNames(usage: unknown): unknown {
    const value = usage as { entries?: Array<{ threadId?: string }>; names?: { threads?: Record<string, string> } } | null
    if (!value || !Array.isArray(value.entries)) return usage
    const bots = new Set(this.services.threads.listAllThreads().filter((thread) => thread.botOwned).map((thread) => thread.id))
    if (!bots.size) return usage
    return {
      ...value,
      entries: value.entries.map((entry) => {
        if (!entry.threadId || !bots.has(entry.threadId)) return entry
        const { threadId: _bot, ...unattributed } = entry
        return unattributed
      }),
      ...(value.names ? { names: { ...value.names, threads: Object.fromEntries(Object.entries(value.names.threads ?? {}).filter(([id]) => !bots.has(id))) } } : {})
    }
  }
  private async executeFor(method: BridgeOrdinaryMethod, params: Record<string, unknown>, caller?: { node: NodeId }): Promise<unknown> {
    if (typeof params.threadId === 'string' && !this.remoteThread(params.threadId))
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
    const composer = await this.composer(method, params, caller)
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
  private async matchProject(
    params: Record<string, unknown>
  ): Promise<{ projectId?: string; weak?: true }> {
    // Projects are matched by the repository they are in, not by their folder: a project that is a
    // subfolder, or is reached through a link, has the identity of its repository. When two projects are
    // the same repository, the one at its top folder stands for it (else the first), so they do not
    // make each other ambiguous.
    const repositories = repositoryIdentitiesFor(this.services)
    const byRoot = new Map<string, { id: string; atTop: boolean; identity: ProjectIdentity }>()
    const candidates: Array<{ id: string; identity: ProjectIdentity | null }> = []
    const projects = this.services.projects.listProjects().slice(0, MATCH_PROJECT_LIMIT)
    // A few folders at a time: each is a Git call, and a profile may hold hundreds of projects.
    const scanned: Array<{ project: (typeof projects)[number]; identity: Awaited<ReturnType<typeof repositories.of>> }> = []
    for (let at = 0; at < projects.length; at += MATCH_CONCURRENCY)
      scanned.push(
        ...(await Promise.all(
          projects
            .slice(at, at + MATCH_CONCURRENCY)
            .map(async (project) => ({ project, identity: await repositories.of(project.path) }))
        ))
      )
    for (const { project, identity } of scanned) {
      if (!identity) {
        // Not a Git repository, or not readable: it never matches.
        candidates.push({ id: project.id, identity: null })
        continue
      }
      const atTop = await repositories.isTop(project.path, identity.root)
      const known = byRoot.get(identity.root)
      if (!known || (atTop && !known.atTop))
        byRoot.set(identity.root, { id: project.id, atTop, identity: { roots: identity.roots, remotes: identity.remotes } })
    }
    for (const entry of byRoot.values()) candidates.push({ id: entry.id, identity: entry.identity })
    const found = matchProjectWithEvidence(
      { roots: params.roots as string[], remotes: (params.remotes as string[] | undefined) ?? [] },
      candidates
    )
    // A match that rests on the root commit alone says so: the caller does not group by it.
    return found ? { projectId: found.id, ...(found.weak ? { weak: true as const } : {}) } : {}
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
    params: Record<string, unknown>,
    caller?: { node: NodeId }
  ): Promise<unknown> {
    const s = this.services,
      threadId = params.threadId as string
    switch (method) {
      case 'composer.options':
        return this.composerOptions(params.threadId as string | undefined, caller)
      case 'threads.setModel': {
        const model = params.model as { instanceId?: string; llmProvider?: string; model: string; effort?: string }
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
  private async composerOptions(threadId?: string, caller?: { node: NodeId }): Promise<unknown> {
    const s = this.services
    await s.providerAuth.init()
    const settings = s.settings.get()
    const projectPath = threadId
      ? resolveThreadProjectPath(s.projects, s.threads, threadId)
      : undefined
    // Read together: skills are optional and must not hold back the models.
    const [skills, providers] = await Promise.all([
      this.effectiveSkills(projectPath).then(
        (found) => found.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
        // Skills are optional in the composer; models still load.
        () => [] as Array<{ id: string; name: string; description: string }>
      ),
      s.harness?.llmProviders({ kind: 'device' })
    ])
    const provider = settings.provider
    return {
      providers: providers ?? [],
      defaultModel: provider?.model
        ? {
            ...(provider.instanceId ? { instanceId: provider.instanceId } : {}),
            llmProvider: provider.llmProvider,
            model: provider.model,
            ...(provider.effort ? { effort: provider.effort } : {}),
            ...(provider.name ? { name: provider.name } : {})
          }
        : null,
      modes: REMOTE_CHAT_MODES,
      // What a turn written from here runs in: this computer's default mode, and the most it lets the asking device
      // have. A window shows the stricter of the two for a thread that has no mode of its own.
      permission: {
        defaultMode: normalizePermissionMode(settings.permissions?.defaultMode),
        ...(caller && this.deviceLimit ? { limit: this.deviceLimit(caller.node) } : {})
      },
      skills,
      commands: COMPOSER_COMMANDS.filter((command) => !command.desktopOnly).map((command) => ({
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
   * Reads what the next `snapshot` of the thread needs off the event loop. A thread that is not loaded and keeps its
   * history in thread.db has its newest messages read in the read worker, as a window's newest page is, and is not
   * loaded. Any other is read whole, so the snapshot finds it in memory. `newestOnly` as for `snapshot`.
   */
  async warm(threadId: string, options: { newestOnly?: boolean } = {}): Promise<void> {
    const s = this.services
    if (!this.remoteThread(threadId) || s.orchestrator.hasSession(threadId)) return
    if (s.threads.usesThreadDb(threadId)) {
      const budget = snapshotBudget(options)
      const page = await s.threads.readMessagePage(threadId, {
        limit: Number.MAX_SAFE_INTEGER,
        maxBytes: budget,
        images: true,
        imageBudget: REMOTE_MESSAGE_IMAGES_MAX_CHARS
      })
      // A page showing work still running loads the thread after all: loading it settles work a previous daemon
      // left running.
      if (page && !page.messages.some(isOpenActivityRow)) {
        const key = `${budget}:${threadId}`
        this.pages.delete(key)
        this.pages.set(key, page)
        for (const stale of this.pages.keys()) {
          if (this.pages.size <= WARM_PAGES_MAX) break
          this.pages.delete(stale)
        }
        return
      }
    }
    await s.threads.warmThread(threadId)
  }

  /**
   * The page `warm` read for this snapshot, while it is still the thread's newest: the thread was not loaded since
   * (a loaded thread may hold what its database does not yet) and its database has not changed.
   */
  private warmPage(threadId: string, budget: number): MessagePageResult | undefined {
    const key = `${budget}:${threadId}`
    const page = this.pages.get(key)
    if (!page) return undefined
    this.pages.delete(key)
    if (this.services.orchestrator.hasSession(threadId)) return undefined
    const now = this.services.threads.threadDbPosition(threadId)
    return now && now.seq === page.seq && now.epoch === page.epoch ? page : undefined
  }

  /**
   * A phone's page of the messages before the cursor `before`, images included (within the budget a snapshot has),
   * read the way a window reads one: an index range of thread.db in the read worker when the thread is not loaded.
   * A page showing work still running loads the thread, which settles work a previous service left running.
   */
  async messagesBefore(threadId: string, before: string, limit: number): Promise<unknown> {
    if (!this.remoteThread(threadId)) throw new NetError('stream_unknown', 'Thread not found.')
    const s = this.services
    const fromDatabase = !s.orchestrator.hasSession(threadId) && s.threads.usesThreadDb(threadId)
    let page: { messages: ChatMessage[]; earlier?: EarlierMessages } | undefined = fromDatabase
      ? await s.threads.readMessagePage(threadId, { before, limit, maxBytes: PHONE_MESSAGES_PAGE_BYTES, images: true })
      : undefined
    const settle = page !== undefined && page.messages.some(isOpenActivityRow)
    if (!fromDatabase || settle) {
      await s.threads.warmThread(threadId)
      if (settle) s.orchestrator.getOrCreateSession(threadId)
      page = messagesBefore(s.orchestrator.getMessages(threadId), before, limit, PHONE_MESSAGES_PAGE_BYTES)
    }
    if (!page) throw new NetError('snapshot_required', 'That message is no longer in this thread.')
    return mmsJson({ messages: withImageBudget(page.messages), ...(page.earlier ? { earlier: page.earlier } : {}) })
  }

  /**
   * What a reader is given on opening a thread: the newest part of a long transcript, so a thread of any
   * length opens. `newestOnly` is for another computer of the user, which gets 16 MiB and pages the rest
   * with `thread.messages`; a phone gets 8 MiB. `earlier` says where the rest begins and how much is left.
   */
  snapshot(
    threadId: string,
    options: { newestOnly?: boolean; deviceLimit?: PermissionMode; reader?: string } = {}
  ): unknown {
    const s = this.services,
      found = this.remoteThread(threadId)
    // A thread a bot started names that bot to a reader that reaches it; with no reader (a stream any device may read),
    // only when every device does.
    const thread = found && withHiddenBots(found, s.botReach?.hiddenFor(options.reader))
    if (!thread) throw new NetError('stream_unknown', 'Thread not found.')
    const pause = s.orchestrator.getTurnState(threadId).pause
    const budget = snapshotBudget(options)
    // The newest page `warm` read is the same messages, image budget and `earlier` as the loaded thread would give.
    const page = this.warmPage(threadId, budget)
    const kept = page
      ? { messages: page.messages, ...(page.earlier ? { earlier: page.earlier } : {}) }
      : newestMessages(withImageBudget(s.orchestrator.getMessages(threadId)), budget)
    const queue = page
      ? listPendingQueue(s.threads.loadMessageQueue(threadId)).filter((item) => !item.internal)
      : s.orchestrator.listQueue(threadId)
    return mmsJson(
      {
        thread,
        messages: kept.messages,
        ...(kept.earlier ? { earlier: kept.earlier } : {}),
        queue: queue.map(withoutImageData),
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
      }
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
      engine.getActiveRun(threadId) !== null ||
      engine.store.listQueuedRuns(threadId).some((run) => engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'turn.start' && effect.status === 'running'))
    )
  }
  async stop(threadId: string): Promise<unknown> {
    // The same inventory check as `execute`: a remote caller reaches only this profile's threads.
    if (!this.remoteThread(threadId))
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
    if (!this.remoteThread(threadId))
      throw new NetError('stream_unknown', 'Thread not found.')
    try {
      await this.assertSkillMode(threadId, extras.mode)
    } catch (error) {
      return { text: '', silent: false, error: failure(error).error }
    }
    // Existing MMS takes an owned cross-process lease and binds this exact signal to executeTurn.
    return mmsJson(
      await this.services.orchestrator.runRemoteTurn(threadId, content, this.services.threads, {
        signal: control.signal,
        drainSteer: control.drainSteer,
        onUserInputAccepted: control.onAccepted,
        ...(extras.mode !== undefined ? { mode: extras.mode } : {}),
        ...(extras.images?.length ? { images: extras.images } : {})
      })
    )
  }
}
