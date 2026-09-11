import { randomUUID } from 'node:crypto'
import type { BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { ArtifactReference } from '../../../shared/execution/types'
import type {
  BrowserViewerClient,
  BrowserViewerContext,
  BrowserViewerHumanAction,
  BrowserViewerHistoryEntry,
  BrowserViewerSnapshot
} from '../../../shared/browser/viewer'
import type { BrowserObservation, BrowserSessionRecord } from '../../../shared/browser/types'
import { BrowserAutomationError, BrowserSessionManager } from '../automation/BrowserSessionManager'

export interface BrowserViewerServiceOptions {
  sessions: BrowserSessionManager
  context?: BrowserViewerContext
  artifactResolver?: (artifactId: string, context: BrowserViewerContext, sessionId: string) => Promise<ArtifactReference | undefined> | ArtifactReference | undefined
  now?: () => string
}

export class BrowserViewerService implements BrowserViewerClient {
  private readonly historyBySession = new Map<string, BrowserViewerHistoryEntry[]>()
  private readonly listeners = new Set<(snapshot: BrowserViewerSnapshot) => void>()
  private readonly now: () => string
  private current: BrowserViewerSnapshot = { mode: 'managed', tabs: [], connection: 'disconnected', history: [], artifacts: [], updatedAt: new Date().toISOString() }

  constructor(private readonly options: BrowserViewerServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  subscribe(listener: (snapshot: BrowserViewerSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => this.listeners.delete(listener)
  }

  async snapshot(input: { sessionId?: string } = {}): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    const records = this.options.sessions.list(context)
    const session = this.selectSession(records, input.sessionId)
    const observation = session && session.lifecycle !== 'closed' ? this.options.sessions.latestObservation(context, session.id) : undefined
    const snapshot = await this.toSnapshot(session, observation, session?.lifecycle === 'starting' ? 'headless-waiting' : session?.lifecycle === 'recovering' ? 'reconnecting' : undefined, context)
    return this.publish(snapshot)
  }

  async observe(input: { sessionId: string; tabId?: string }): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    try {
      const result = await this.options.sessions.observe(context, { sessionId: input.sessionId, tabId: input.tabId, includeScreenshot: Boolean(context.vision) })
      const observation = result.observation
      this.record(input.sessionId, 'observed', 'Agent observation refreshed.', observation)
      return this.publish(await this.snapshotFromContext(context, input.sessionId, observation))
    } catch (error) {
      this.recordError(input.sessionId, error)
      throw error
    }
  }

  async humanAction(input: BrowserViewerHumanAction): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    try {
      const result = await this.options.sessions.humanAct(context, input)
      this.record(input.sessionId, 'action', `Human ${input.action.type} action applied.`, result.action?.observation)
      return this.publish(await this.snapshotFromContext(context, input.sessionId, result.action?.observation))
    } catch (error) {
      this.recordError(input.sessionId, error)
      throw error
    }
  }

  async takeControl(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    try {
      const result = await this.options.sessions.control(context, input.sessionId, 'human')
      this.record(input.sessionId, 'control', 'Human control acquired; agent actions are fenced.', result.session)
      return this.publish(await this.snapshotFromContext(context, input.sessionId))
    } catch (error) {
      this.recordError(input.sessionId, error)
      throw error
    }
  }

  async resumeAgent(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    try {
      await this.options.sessions.control(context, input.sessionId, 'agent')
      this.record(input.sessionId, 'control', 'Agent control resumed; observation refreshed to fence stale input.')
      const resumedContext = { ...context, vision: true }
      const result = await this.options.sessions.observe(resumedContext, { sessionId: input.sessionId, includeScreenshot: true })
      this.record(input.sessionId, 'observed', 'Fresh observation captured after agent resume.', result.observation)
      return this.publish(await this.snapshotFromContext(resumedContext, input.sessionId, result.observation))
    } catch (error) {
      this.recordError(input.sessionId, error)
      throw error
    }
  }

  async close(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    const context = this.requireContext()
    try {
      const result = await this.options.sessions.close(context, input.sessionId)
      this.record(input.sessionId, 'closed', 'Managed browser session closed.', result.session)
      return this.publish(await this.snapshotFromContext(context, input.sessionId, undefined, result.session))
    } catch (error) {
      this.recordError(input.sessionId, error)
      throw error
    }
  }

  async history(input: { sessionId?: string } = {}): Promise<BrowserViewerHistoryEntry[]> {
    const context = this.requireContext()
    const records = this.options.sessions.list(context)
    const session = this.selectSession(records, input.sessionId)
    return session ? [...(this.historyBySession.get(session.id) ?? [])] : []
  }

  watch(sessionId?: string, intervalMs = 1_000): () => void {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try { await this.snapshot({ sessionId }) } catch (error) { if (sessionId) this.recordError(sessionId, error) }
      if (!stopped) timer = setTimeout(() => { void tick() }, Math.max(250, intervalMs))
    }
    let timer = setTimeout(() => { void tick() }, 0)
    return () => { stopped = true; clearTimeout(timer) }
  }

  private async snapshotFromContext(context: BrowserViewerContext, sessionId?: string, observation?: BrowserObservation, override?: BrowserSessionRecord): Promise<BrowserViewerSnapshot> {
    const records = this.options.sessions.list(context)
    const session = override ?? this.selectSession(records, sessionId)
    return this.toSnapshot(session, observation, undefined, context)
  }

  private async toSnapshot(session: BrowserSessionRecord | undefined, observation?: BrowserObservation, connectionOverride?: BrowserViewerSnapshot['connection'], context?: BrowserViewerContext): Promise<BrowserViewerSnapshot> {
    const history = session ? [...(this.historyBySession.get(session.id) ?? [])] : []
    const connection = connectionOverride ?? (session?.lifecycle === 'disconnected' ? 'disconnected' : session?.lifecycle === 'starting' ? 'headless-waiting' : session?.lifecycle === 'recovering' ? 'reconnecting' : 'connected')
    const artifacts: ArtifactReference[] = []
    if (observation?.screenshot && context && this.options.artifactResolver) {
      if (!session || observation.sessionId !== session.id) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser screenshot does not belong to the selected viewer session' })
      const artifact = await this.options.artifactResolver(observation.screenshot.artifactId, context, session.id)
      if (artifact) {
        if (artifact.id !== observation.screenshot.artifactId || artifact.profileId !== context.execution.profileId || artifact.runId !== context.execution.runId) {
          throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser screenshot artifact is outside the viewer execution scope' })
        }
        artifacts.push(artifact)
      }
    }
    return {
      mode: 'managed', session, tabs: observation?.tabs ?? [], observation,
      connection, controlOwner: session?.lifecycle === 'human-controlled' ? 'human' : session ? 'agent' : undefined,
      run: session && (session.threadId || session.runId) ? { profileId: session.profileId, ...(session.threadId ? { threadId: session.threadId } : {}), ...(session.runId ? { runId: session.runId } : {}) } : undefined,
      history, artifacts, updatedAt: this.now(),
      ...(session?.humanHandoff?.state === 'waiting-human' ? { message: session.humanHandoff.reason } : {})
    }
  }

  private publish(snapshot: BrowserViewerSnapshot): BrowserViewerSnapshot {
    this.current = snapshot
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  private record(sessionId: string, kind: BrowserViewerHistoryEntry['kind'], message: string, value?: BrowserToolOutput['session'] | BrowserObservation): void {
    const session = value && 'id' in value ? value : undefined
    const observation = value && 'observationId' in value ? value : undefined
    const entry: BrowserViewerHistoryEntry = { id: randomUUID(), at: this.now(), kind, message, ...(session?.runId ? { runId: session.runId } : {}), ...(session?.threadId ? { threadId: session.threadId } : {}), ...(observation?.screenshot ? { artifactIds: [observation.screenshot.artifactId] } : {}) }
    const list = this.historyBySession.get(sessionId) ?? []
    list.push(entry)
    this.historyBySession.set(sessionId, list.slice(-100))
  }

  private recordError(sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.record(sessionId, 'error', message)
  }

  private selectSession(records: BrowserSessionRecord[], sessionId?: string): BrowserSessionRecord | undefined {
    if (sessionId) return records.find((record) => record.id === sessionId)
    return records.find((record) => record.lifecycle !== 'closed') ?? records[0]
  }

  private requireContext(): BrowserToolContext {
    const resolved = this.options.context
    if (!resolved) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Browser viewer context is not configured' })
    return resolved as BrowserToolContext
  }
}
