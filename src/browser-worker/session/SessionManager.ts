import type { BrowserWorkerRequest } from '../../shared/browser/types'
import { resolveCertifiedBrowser } from '../binary/resolver'
import { fail } from '../errors'
import { optionalBoolean, optionalString, requiredId } from '../util'
import { browserNavigationUrl } from '../../shared/browser/validation'
import { ManagedSession } from './Session'
import { WorkspaceLockBusyError } from '../lifecycle/lock'
import { chromeForTestingPlatform } from '../binary/platform'

export interface WorkerInitConfig {
  profileRoot: string
  browserRoot: string
  artifactRoot: string
  chromeExtraArgs?: string[]
}

export interface CapabilityReport {
  ready: boolean
  backend: 'managed-chromium'
  setupRequired: boolean
  transport: 'remote-debugging-pipe'
  platform: string
  version?: string
  protocolVersion?: string
  product?: string
  revision?: string
  sha256?: string
  capabilities: {
    remoteDebuggingPipe: true
    headless: boolean
    screenshots: boolean
    accessibility: boolean
    oopif: 'supported'
    openShadowDom: true
    closedShadowDom: 'unsupported'
    modelEvaluate: false
    actions: {
      coordinateTargeting: true
      boundedPointerDrag: true
      artifactUpload: true
      quarantinedDownloads: true
      noProgressLimiter: true
      persistentWorkspaceRecovery: true
    }
  }
  message: string
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly opening = new Set<ManagedSession>()
  private capabilities: CapabilityReport
  private executablePath?: string
  private browserVersion = ''
  private closing = false
  private closed = false
  private closeAllWork: Promise<void> | null = null

  constructor(private readonly config: WorkerInitConfig) {
    const resolution = resolveCertifiedBrowser(config.browserRoot)
    this.executablePath = resolution.executablePath
    this.browserVersion = resolution.metadata?.version ?? ''
    this.capabilities = {
      ready: resolution.status === 'ready',
      backend: 'managed-chromium',
      setupRequired: resolution.status !== 'ready',
      transport: 'remote-debugging-pipe',
      platform: (() => { try { return chromeForTestingPlatform() } catch { return process.platform } })(),
      version: resolution.metadata?.version,
      protocolVersion: resolution.metadata?.probe?.protocolVersion,
      product: resolution.metadata?.probe?.product,
      revision: resolution.metadata?.revision,
      sha256: resolution.metadata?.sha256,
      capabilities: {
        remoteDebuggingPipe: true,
        headless: true,
        screenshots: resolution.status === 'ready',
        accessibility: resolution.status === 'ready',
        oopif: 'supported',
        openShadowDom: true,
        closedShadowDom: 'unsupported',
        modelEvaluate: false,
        actions: {
          coordinateTargeting: true,
          boundedPointerDrag: true,
          artifactUpload: true,
          quarantinedDownloads: true,
          noProgressLimiter: true,
          persistentWorkspaceRecovery: true
        }
      },
      message: resolution.message
    }
  }

  report(): CapabilityReport {
    return this.capabilities
  }

  getActiveCount(): number {
    return this.sessions.size + this.opening.size
  }

  async handle(request: BrowserWorkerRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.closing || this.closed) fail('cancelled', 'Browser worker is shutting down')
    if (request.method === 'session.open') return this.open(request.profileId, request.params, signal)
    const sessionId = requiredId(request.params.sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) fail('session_closed', 'Unknown browser session')
    if (session.profileId !== request.profileId) fail('profile_mismatch', 'Session is bound to a different profile')
    const result = await session.handle(request.method, request.params, signal)
    if (request.method === 'session.close') {
      this.sessions.delete(sessionId)
    }
    return result ?? { ok: true }
  }

  async closeAll(): Promise<void> {
    if (this.closeAllWork) return this.closeAllWork
    if (this.closed && this.sessions.size === 0 && this.opening.size === 0) return
    this.closing = true
    this.closeAllWork = this.closeAllOwned().finally(() => {
      if (!this.closed) this.closeAllWork = null
    })
    return this.closeAllWork
  }

  private async closeAllOwned(): Promise<void> {
    const remaining: ManagedSession[] = []
    const errors: Error[] = []
    const sessions = new Set<ManagedSession>([...this.sessions.values(), ...this.opening])
    await Promise.all([...sessions].map(async (session) => {
      try {
        await session.close()
        this.sessions.delete(session.id)
        this.opening.delete(session)
      } catch (error) {
        remaining.push(session)
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }))
    if (remaining.length > 0) {
      throw errors[0] ?? new Error(`Failed to close ${remaining.length} managed browser session(s)`)
    }
    this.closed = true
  }

  private async open(profileId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closing || this.closed) fail('cancelled', 'Browser worker is shutting down')
    if (!this.capabilities.ready || !this.executablePath) fail('setup_required', this.capabilities.message)
    const persistent = optionalBoolean(params.persistent) === true
    const workspaceId = optionalString(params.workspaceId, 160)
    if (persistent && !workspaceId) fail('invalid_action', 'Persistent sessions require a workspaceId')
    if (workspaceId && !/^[a-zA-Z0-9:_-]+$/.test(workspaceId)) fail('invalid_action', 'workspaceId is not an identifier')
    let url: string | undefined
    if (params.url !== undefined) url = browserNavigationUrl(params.url)
    const session = new ManagedSession({
      profileId,
      browserRoot: this.config.browserRoot,
      artifactRoot: this.config.artifactRoot,
      executablePath: this.executablePath,
      browserVersion: this.browserVersion,
      chromeExtraArgs: this.config.chromeExtraArgs
    }, {
      persistent,
      workspaceId,
      runId: optionalString(params.runId, 160),
      threadId: optionalString(params.threadId, 160)
    })
    this.opening.add(session)
    try {
      const record = await session.start(url, signal)
      if (signal?.aborted || this.closing || this.closed) {
        await session.close()
        fail('cancelled', 'Session open cancelled')
      }
      this.opening.delete(session)
      this.sessions.set(session.id, session)
      const observation = await session.observe({ tabId: session.listTabs()[0]?.id, includeScreenshot: false })
      if (this.closing || this.closed) {
        this.sessions.delete(session.id)
        await session.close()
        fail('cancelled', 'Session open cancelled')
      }
      return { session: record, observation }
    } catch (error) {
      this.opening.delete(session)
      this.sessions.delete(session.id)
      try {
        await session.close()
      } catch (closeError) {
        this.sessions.set(session.id, session)
        throw closeError
      }
      if (error instanceof WorkspaceLockBusyError) fail('policy_denied', error.message)
      throw error
    }
  }
}
