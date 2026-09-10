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
    oopif: 'unsupported'
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
  private capabilities: CapabilityReport
  private executablePath?: string
  private browserVersion = ''

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
        oopif: 'unsupported',
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

  async handle(request: BrowserWorkerRequest, signal?: AbortSignal): Promise<unknown> {
    if (request.method === 'session.open') return this.open(request.profileId, request.params, signal)
    const sessionId = requiredId(request.params.sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) fail('session_closed', 'Unknown browser session')
    if (session.profileId !== request.profileId) fail('profile_mismatch', 'Session is bound to a different profile')
    const result = await session.handle(request.method, request.params, signal)
    if (request.method === 'session.close') this.sessions.delete(sessionId)
    return result ?? { ok: true }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.close()))
  }

  private async open(profileId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.capabilities.ready || !this.executablePath) fail('setup_required', this.capabilities.message)
    const persistent = optionalBoolean(params.persistent) === true
    const workspaceId = optionalString(params.workspaceId, 160)
    if (persistent && !workspaceId) fail('invalid_action', 'persistent sessions require workspaceId')
    if (workspaceId && !/^[a-zA-Z0-9:_-]+$/.test(workspaceId)) fail('invalid_action', 'workspaceId is not an identifier')
    let url: string | undefined
    if (params.url !== undefined) url = browserNavigationUrl(params.url)
    const session = new ManagedSession({
      profileId,
      browserRoot: this.config.browserRoot,
      artifactRoot: this.config.artifactRoot,
      executablePath: this.executablePath,
      browserVersion: this.browserVersion
    }, {
      persistent,
      workspaceId,
      runId: optionalString(params.runId, 160),
      threadId: optionalString(params.threadId, 160)
    })
    try {
      const record = await session.start(url)
      if (signal?.aborted) {
        await session.close()
        fail('cancelled', 'Session open cancelled')
      }
      this.sessions.set(session.id, session)
      const observation = await session.observe({ tabId: session.listTabs()[0]?.id, includeScreenshot: false })
      return { session: record, observation }
    } catch (error) {
      await session.close().catch(() => undefined)
      if (error instanceof WorkspaceLockBusyError) fail('policy_denied', error.message)
      throw error
    }
  }
}
