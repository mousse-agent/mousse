import { randomUUID } from 'node:crypto'
import type { BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { ArtifactReference } from '../../../shared/execution/types'
import type { BrowserViewerHistoryEntry, BrowserViewerHumanAction, BrowserViewerSnapshot } from '../../../shared/browser/viewer'
import type { BrowserObservation, BrowserSessionRecord } from '../../../shared/browser/types'
import { BrowserAutomationError, type BrowserSessionManager } from '../../browser/automation/BrowserSessionManager'

/**
 * A group chat's shared browser as its members see it: a snapshot of the session (its last observation,
 * who controls it, what was just done) for each call of the chat's resource methods. The group chat
 * alone uses it, until its browser moves to the general viewer (`WatchedBrowser`, issue #1052).
 */
export interface ChatBrowserSnapshotsOptions {
  sessions: BrowserSessionManager
  context: BrowserToolContext
  artifactResolver?: (artifactId: string, context: BrowserToolContext, sessionId: string) => Promise<ArtifactReference | undefined> | ArtifactReference | undefined
  now?: () => string
}

export class ChatBrowserSnapshots {
  private readonly history: BrowserViewerHistoryEntry[] = []

  private readonly now: () => string

  constructor(private readonly options: ChatBrowserSnapshotsOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async snapshot(input: { sessionId?: string } = {}): Promise<BrowserViewerSnapshot> {
    const context = this.options.context
    const session = this.selectSession(this.options.sessions.list(context), input.sessionId)
    const observation = session && session.lifecycle !== 'closed' ? this.options.sessions.latestObservation(context, session.id) : undefined
    return this.toSnapshot(session, observation, session?.lifecycle === 'starting' ? 'headless-waiting' : session?.lifecycle === 'recovering' ? 'reconnecting' : undefined)
  }

  async observe(input: { sessionId: string; tabId?: string }): Promise<BrowserViewerSnapshot> {
    const context = this.options.context
    return this.recorded(async () => {
      const result = await this.options.sessions.observe(context, { sessionId: input.sessionId, tabId: input.tabId, includeScreenshot: Boolean(context.vision) })
      this.record('observed', 'Agent observation refreshed.', result.observation)
      return this.fromContext(input.sessionId, result.observation)
    })
  }

  async humanAction(input: BrowserViewerHumanAction): Promise<BrowserViewerSnapshot> {
    return this.recorded(async () => {
      const result = await this.options.sessions.humanAct(this.options.context, input)
      this.record('action', `Human ${input.action.type} action applied.`, result.action?.observation)
      return this.fromContext(input.sessionId, result.action?.observation)
    })
  }

  async takeControl(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    return this.recorded(async () => {
      const result = await this.options.sessions.control(this.options.context, input.sessionId, 'human')
      this.record('control', 'Human control acquired; agent actions are fenced.', result.session)
      return this.fromContext(input.sessionId)
    })
  }

  async resumeAgent(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    return this.recorded(async () => {
      await this.options.sessions.control(this.options.context, input.sessionId, 'agent')
      this.record('control', 'Agent control resumed; observation refreshed to fence stale input.')
      // A fresh generation first, without making control recovery depend on a screenshot.
      const resumed = { ...this.options.context, vision: false }
      const result = await this.options.sessions.observe(resumed, { sessionId: input.sessionId, includeScreenshot: false })
      this.record('observed', 'Fresh observation captured after agent resume.', result.observation)
      return this.toSnapshot(this.selectSession(this.options.sessions.list(resumed), input.sessionId), result.observation)
    })
  }

  async close(input: { sessionId: string }): Promise<BrowserViewerSnapshot> {
    return this.recorded(async () => {
      const result = await this.options.sessions.close(this.options.context, input.sessionId)
      this.record('closed', 'Managed browser session closed.', result.session)
      return this.fromContext(input.sessionId, undefined, result.session)
    })
  }

  /** A call whose failure goes into the snapshot's history too. */
  private async recorded(work: () => Promise<BrowserViewerSnapshot>): Promise<BrowserViewerSnapshot> {
    try {
      return await work()
    } catch (error) {
      this.record('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private fromContext(sessionId: string, observation?: BrowserObservation, override?: BrowserSessionRecord): Promise<BrowserViewerSnapshot> {
    const session = override ?? this.selectSession(this.options.sessions.list(this.options.context), sessionId)
    return this.toSnapshot(session, observation)
  }

  private async toSnapshot(session: BrowserSessionRecord | undefined, observation?: BrowserObservation, connectionOverride?: BrowserViewerSnapshot['connection']): Promise<BrowserViewerSnapshot> {
    const context = this.options.context
    const connection = connectionOverride ?? (session?.lifecycle === 'disconnected' ? 'disconnected' : session?.lifecycle === 'starting' ? 'headless-waiting' : session?.lifecycle === 'recovering' ? 'reconnecting' : 'connected')
    const artifacts: ArtifactReference[] = []
    if (observation?.screenshot && this.options.artifactResolver) {
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
      history: session ? [...this.history] : [], artifacts, updatedAt: this.now(),
      ...(session?.humanHandoff?.state === 'waiting-human' ? { message: session.humanHandoff.reason } : {})
    }
  }

  private record(kind: BrowserViewerHistoryEntry['kind'], message: string, value?: BrowserToolOutput['session'] | BrowserObservation): void {
    const session = value && 'id' in value ? value : undefined
    const observation = value && 'observationId' in value ? value : undefined
    this.history.push({ id: randomUUID(), at: this.now(), kind, message, ...(session?.runId ? { runId: session.runId } : {}), ...(session?.threadId ? { threadId: session.threadId } : {}), ...(observation?.screenshot ? { artifactIds: [observation.screenshot.artifactId] } : {}) })
  }

  private selectSession(records: BrowserSessionRecord[], sessionId?: string): BrowserSessionRecord | undefined {
    if (sessionId) return records.find((record) => record.id === sessionId)
    return records.find((record) => record.lifecycle !== 'closed') ?? records[0]
  }
}
