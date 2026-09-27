import { spawn, type ChildProcess } from 'node:child_process'
import { browserWorkerEnvironment } from './workerEnvironment'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { validateBrowserWorkerRequest, validateBrowserWorkerResponse } from '../../shared/browser/envelope'
import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'
import { encodeWorkerFrame, WorkerFrameDecoder } from '../../browser-worker/ipc/framing'
import { runBrowserWorkerHost } from '../../browser-worker/ipc/host'
import type { CapabilityReport } from '../../browser-worker/session/SessionManager'
import { fail } from '../../browser-worker/errors'
import { stopOwnedPid } from '../../browser-worker/lifecycle/process'
import {
  rootOnlyTree,
  stopOwnedProcessTree,
  type OwnedProcessTree
} from '../../browser-worker/lifecycle/ownedTree'
import type { BrowserBrokerConfig } from './ports'
import { createFilesystemArtifactPort, createFilesystemJournalPort } from './defaultPorts'
import {
  BrowserBrokerAdmissionError,
  BrowserBrokerShutdownError,
  MAX_BROWSER_WORKER_PENDING,
  normalizeBrokerShutdownTimeoutMs,
  type BrowserBrokerPhase,
  type BrowserBrokerRemaining
} from './brokerLifecycle'

interface RawPending {
  resolveRaw: (value: unknown) => void
  rejectRaw: (error: Error) => void
  rawPromise: Promise<unknown>
  callerSettled: boolean
  resolveCaller: (value: unknown) => void
  rejectCaller: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
  request?: BrowserWorkerRequest
}

export class BrowserBroker {
  private child: ChildProcess | null = null
  private decoder = new WorkerFrameDecoder()
  private readonly rawPending = new Map<string, RawPending>()
  private writeStream: NodeJS.WritableStream | null = null
  private capabilities: CapabilityReport | null = null
  private phase: BrowserBrokerPhase = 'idle'
  private starting: Promise<CapabilityReport> | null = null
  private shutdownWork: Promise<void> | null = null
  private disconnectCleanup: Promise<void> = Promise.resolve()
  private disconnectCleanupPending = false
  private readonly disconnectedOwnerPids = new Set<number>()
  private readonly artifacts
  private readonly journal
  private inProcessStop: (() => void) | null = null
  private inProcessHost: Promise<void> | null = null
  private inProcessHostSettled = true
  private workerTree: OwnedProcessTree | null = null

  constructor(private readonly config: BrowserBrokerConfig) {
    if (!isAbsolute(config.profileRoot) || !isAbsolute(config.browserRoot) || !isAbsolute(config.artifactRoot)) {
      throw new Error('BrowserBroker requires absolute injected profileRoot, browserRoot and artifactRoot')
    }
    this.artifacts = config.artifacts ?? createFilesystemArtifactPort(config.artifactRoot)
    this.journal = config.journal ?? createFilesystemJournalPort(config.browserRoot)
  }

  get capabilityReport(): CapabilityReport | null {
    return this.capabilities
  }

  beginShutdown(): void {
    if (this.phase === 'stopped' || this.phase === 'shutting-down') return
    this.phase = 'shutting-down'
    for (const [id, pending] of this.rawPending) {
      this.sendCancel(id)
      if (!pending.callerSettled) {
        pending.callerSettled = true
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
        pending.rejectCaller(Object.assign(new Error('Browser broker is shutting down'), { code: 'cancelled' }))
      }
    }
  }

  getActiveCount(): number {
    let count = this.rawPending.size
    if (this.starting) count += 1
    if (this.child && this.child.exitCode === null) count += 1
    if (this.inProcessHost && !this.inProcessHostSettled) count += 1
    if (this.disconnectCleanupPending || this.disconnectedOwnerPids.size > 0) count += 1
    return count
  }

  snapshotRemaining(): BrowserBrokerRemaining {
    return {
      rawPending: this.rawPending.size,
      workerAlive: Boolean(this.child && this.child.exitCode === null),
      hostRunning: Boolean(this.inProcessHost && !this.inProcessHostSettled),
      disconnectCleanup: this.disconnectCleanupPending || this.disconnectedOwnerPids.size > 0,
      phase: this.phase
    }
  }

  async start(): Promise<CapabilityReport> {
    this.assertAdmits('start')
    if (this.starting) return this.starting
    if (this.phase === 'ready' && this.capabilities) return this.capabilities
    this.starting = this.startInternal()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startInternal(): Promise<CapabilityReport> {
    this.assertAdmits('start')
    this.phase = 'starting'
    await this.ensureDisconnectCleanup()
    this.decoder.reset()
    this.capabilities = null
    try {
      if (this.config.transport === 'in-process') await this.startInProcess()
      else await this.startChildProcess()
      const id = 'init_' + randomUUID()
      const response = await this.sendRaw({
        kind: 'init', version: 1, id,
        profileRoot: resolve(this.config.profileRoot),
        browserRoot: resolve(this.config.browserRoot),
        artifactRoot: resolve(this.config.artifactRoot),
        ...(this.config.chromeExtraArgs?.length ? { chromeExtraArgs: [...this.config.chromeExtraArgs] } : {})
      }, 30_000) as unknown as { kind?: string; capabilities?: CapabilityReport; error?: { message?: string } }
      this.assertAdmits('start')
      if (response.kind === 'init_err') fail('setup_required', response.error?.message ?? 'Browser worker init failed')
      if (!response.capabilities) fail('setup_required', 'Browser worker did not report capabilities')
      this.capabilities = response.capabilities
      this.phase = 'ready'
      return this.capabilities
    } catch (error) {
      await this.reapWorkerBestEffort()
      if (this.phase === 'starting') this.phase = 'idle'
      this.capabilities = null
      throw error
    }
  }

  async call(request: BrowserWorkerRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BrowserWorkerResponse> {
    this.assertAdmits('call')
    if (this.phase === 'idle' || this.phase === 'starting') await this.start()
    this.assertAdmits('call')
    const validated = validateBrowserWorkerRequest(request)
    const decision = await this.config.policy.authorize({
      profileId: validated.profileId,
      method: validated.method,
      sessionId: typeof validated.params.sessionId === 'string' ? validated.params.sessionId : undefined,
      url: typeof validated.params.url === 'string' ? validated.params.url : undefined,
      action: validated.method === 'act' ? (validated.params.action as never) : undefined
    })
    if (!decision.allowed) {
      return {
        version: 1,
        id: validated.id,
        ok: false,
        error: { code: decision.code ?? 'policy_denied', message: decision.message ?? 'Policy denied this browser request' }
      }
    }
    if (validated.method === 'act') {
      await this.journal.append({
        at: new Date().toISOString(),
        profileId: validated.profileId,
        sessionId: String(validated.params.sessionId ?? ''),
        requestId: String(validated.params.requestId ?? validated.id),
        generation: typeof validated.params.generation === 'number' ? validated.params.generation : 0,
        phase: 'intent',
        actionType: typeof validated.params.action === 'object' && validated.params.action && 'type' in validated.params.action
          ? String((validated.params.action as { type?: unknown }).type)
          : 'unknown'
      })
    }
    let workerRequest = validated
    if (validated.method === 'act' && validated.params.action && typeof validated.params.action === 'object' && (validated.params.action as { type?: unknown }).type === 'upload') {
      const action = validated.params.action as { type: 'upload'; artifactIds: string[]; [key: string]: unknown }
      const resolver = this.artifacts.resolveReadOnly
      if (!resolver) return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifacts require an MMS grant resolver' } }
      const resolved = await resolver({ profileId: validated.profileId, sessionId: String(validated.params.sessionId ?? ''), artifactIds: action.artifactIds })
      if (resolved.length !== action.artifactIds.length || resolved.some((item, index) => item.artifactId !== action.artifactIds[index])) {
        return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifact grant is incomplete' } }
      }
      const normalized = [] as typeof resolved
      for (const item of resolved) {
        if (!isAbsolute(item.path) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > 100 * 1024 * 1024) {
          return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifact grant is invalid' } }
        }
        try {
          const resolvedPath = await realpath(item.path)
          const details = await stat(resolvedPath)
          if (!details.isFile() || details.size !== item.byteLength) throw new Error('invalid staged artifact')
          normalized.push({ ...item, path: resolvedPath })
        } catch {
          return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifact path is unavailable' } }
        }
      }
      workerRequest = { ...validated, params: { ...validated.params, action: { ...action, resolvedArtifacts: normalized } } }
    }
    const raw = await this.sendRaw(workerRequest, options.timeoutMs ?? this.config.requestTimeoutMs ?? 60_000, options.signal)
    return validateBrowserWorkerResponse(raw)
  }

  close(): Promise<void> {
    return this.shutdown()
  }

  shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.beginShutdown()
    if (this.shutdownWork) return this.shutdownWork
    if (this.phase === 'stopped' && this.getActiveCount() === 0) return Promise.resolve()
    const timeoutMs = normalizeBrokerShutdownTimeoutMs(options.timeoutMs)
    this.shutdownWork = this.runShutdown(timeoutMs).finally(() => {
      if (this.phase !== 'stopped') this.shutdownWork = null
    })
    return this.shutdownWork
  }

  private async runShutdown(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const forceAt = Date.now() + Math.floor(timeoutMs / 2)
    let forced = false
    const shutdownId = 'shutdown_' + randomUUID()
    if (this.writeStream) {
      try {
        await this.sendRaw({ kind: 'shutdown', version: 1, id: shutdownId }, Math.max(1_000, Math.min(5_000, timeoutMs)))
      } catch { /* worker may already be gone; raw pending still drains below */ }
    }
    while (this.getActiveCount() > 0) {
      const now = Date.now()
      if (now >= deadline) {
        throw new BrowserBrokerShutdownError(timeoutMs, this.snapshotRemaining(), this.phase)
      }
      if (this.rawPending.size === 0 && this.inProcessHost && !this.inProcessHostSettled) {
        this.inProcessStop?.()
      }
      if (this.rawPending.size === 0 && this.child?.stdin && this.child.exitCode === null) {
        try { this.child.stdin.end() } catch { /* already ended */ }
      }
      if (!forced && now >= forceAt) {
        forced = true
        await this.reapWorkerBestEffort()
      }
      if (this.disconnectedOwnerPids.size > 0 && !this.disconnectCleanupPending) void this.ensureDisconnectCleanup().catch(() => undefined)
      const waits: Promise<unknown>[] = [new Promise((resolve) => setTimeout(resolve, 50))]
      if (this.rawPending.size > 0) waits.push(Promise.allSettled([...this.rawPending.values()].map((item) => item.rawPromise)))
      if (this.disconnectCleanupPending) waits.push(this.disconnectCleanup)
      if (this.inProcessHost && !this.inProcessHostSettled) waits.push(this.inProcessHost)
      await Promise.race(waits)
    }
    await this.reapWorkerBestEffort()
    await this.ensureDisconnectCleanup()
    if (this.getActiveCount() !== 0) {
      throw new BrowserBrokerShutdownError(timeoutMs, this.snapshotRemaining(), this.phase)
    }
    this.writeStream = null
    this.phase = 'stopped'
  }

  private async startChildProcess(): Promise<void> {
    const modulePath = this.config.workerModulePath
    if (!modulePath || !existsSync(modulePath)) {
      fail('setup_required', 'Browser worker module path is not available. Root must inject a bundled Electron-free worker entry.')
    }
    const child = spawn(process.execPath, [modulePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: browserWorkerEnvironment()
    })
    this.child = child
    this.writeStream = child.stdin
    if (child.pid) {
      this.workerTree = rootOnlyTree(child.pid, { parentHandleAlive: child.exitCode === null, executablePath: process.execPath })
    }
    child.stderr?.on('data', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.once('exit', () => this.onDisconnect(child))
    child.once('error', () => this.onDisconnect(child))
  }

  private async startInProcess(): Promise<void> {
    const input = new PassThrough()
    const output = new PassThrough()
    this.writeStream = input
    output.on('data', (chunk: Buffer) => this.onData(chunk))
    let stopped = false
    this.inProcessStop = () => {
      if (stopped) return
      stopped = true
      input.end()
    }
    this.inProcessHostSettled = false
    this.inProcessHost = runBrowserWorkerHost(input, output).then(
      () => undefined,
      () => { this.settleDisconnected('in-process host exited') }
    ).finally(() => {
      this.inProcessHostSettled = true
    })
  }

  private onData(chunk: Buffer): void {
    this.decoder.push(chunk)
    for (const frame of this.decoder.shiftAll()) {
      if (!frame || typeof frame !== 'object') continue
      const id = (frame as { id?: unknown }).id
      if (typeof id !== 'string') continue
      const pending = this.rawPending.get(id)
      if (!pending) continue
      this.rawPending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      pending.resolveRaw(frame)
      if (!pending.callerSettled) {
        pending.callerSettled = true
        pending.resolveCaller(frame)
      }
    }
  }

  private onDisconnect(disconnectedChild: ChildProcess): void {
    if (this.child !== disconnectedChild) return
    const ownerPid = disconnectedChild.pid
    this.writeStream = null
    this.child = null
    this.workerTree = null
    if (this.phase !== 'shutting-down' && this.phase !== 'stopped') {
      this.phase = 'idle'
      this.capabilities = null
    }
    if (ownerPid) {
      this.disconnectedOwnerPids.add(ownerPid)
      void this.ensureDisconnectCleanup().catch(() => undefined)
    }
    this.settleDisconnected('Browser worker disconnected')
  }

  private settleDisconnected(message: string): void {
    for (const [id, pending] of this.rawPending) {
      this.rawPending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      if (pending.request?.method === 'act') {
        const frame = {
          version: 1,
          id,
          ok: true,
          result: {
            requestId: String(pending.request.params.requestId ?? id),
            outcome: 'unknown-effect',
            dispatched: true,
            artifactIds: [],
            code: 'worker_disconnected',
            message: 'Browser worker disconnected after action dispatch; effect is unknown'
          }
        }
        pending.resolveRaw(frame)
        if (!pending.callerSettled) {
          pending.callerSettled = true
          pending.resolveCaller(frame)
        }
      } else {
        const error = Object.assign(new Error(message), { code: 'worker_disconnected' })
        pending.rejectRaw(error)
        if (!pending.callerSettled) {
          pending.callerSettled = true
          pending.rejectCaller(error)
        }
      }
    }
  }

  private sendRaw(value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = (value as { id?: string }).id ?? randomUUID()
    return new Promise((resolve, reject) => {
      if (!this.writeStream) {
        reject(Object.assign(new Error('Browser worker is not started'), { code: 'worker_disconnected' }))
        return
      }
      if (this.rawPending.has(id)) {
        reject(Object.assign(new Error('Duplicate browser worker request id'), { code: 'invalid_action' }))
        return
      }
      if (this.rawPending.size >= MAX_BROWSER_WORKER_PENDING) {
        reject(Object.assign(new Error('Too many in-flight browser worker requests'), { code: 'invalid_action' }))
        return
      }
      if (signal?.aborted) {
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        return
      }
      let resolveRaw!: (value: unknown) => void
      let rejectRaw!: (error: Error) => void
      const rawPromise = new Promise<unknown>((res, rej) => {
        resolveRaw = res
        rejectRaw = rej
      })
      void rawPromise.catch(() => undefined)
      const pending: RawPending = {
        resolveRaw,
        rejectRaw,
        rawPromise,
        callerSettled: false,
        resolveCaller: resolve,
        rejectCaller: reject,
        ...(isBrowserWorkerRequest(value) ? { request: value } : {})
      }
      const settleCaller = (error: Error) => {
        if (pending.callerSettled) return
        pending.callerSettled = true
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
        pending.rejectCaller(error)
      }
      pending.timer = setTimeout(() => {
        this.sendCancel(id)
        settleCaller(Object.assign(new Error('Browser worker request timed out'), { code: 'timeout' }))
      }, timeoutMs)
      if (signal) {
        pending.signal = signal
        pending.onAbort = () => {
          this.sendCancel(id)
          settleCaller(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        }
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.rawPending.set(id, pending)
      this.writeStream.write(encodeWorkerFrame(value), (error) => {
        if (!error) return
        this.rawPending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
        pending.rejectRaw(error)
        if (!pending.callerSettled) {
          pending.callerSettled = true
          pending.rejectCaller(error)
        }
      })
    })
  }

  private sendCancel(id: string): void {
    try { this.writeStream?.write(encodeWorkerFrame({ kind: 'cancel', id })) } catch { /* ignore */ }
  }

  private assertAdmits(operation: string): void {
    if (this.phase === 'shutting-down' || this.phase === 'stopped') {
      throw new BrowserBrokerAdmissionError(operation, this.phase)
    }
  }

  private async reapWorkerBestEffort(): Promise<void> {
    this.inProcessStop?.()
    this.inProcessStop = null
    const child = this.child
    if (child?.pid && child.exitCode === null) {
      const tree = rootOnlyTree(child.pid, {
        parentHandleAlive: child.exitCode === null,
        executablePath: process.execPath
      })
      this.workerTree = tree
      try { await stopOwnedProcessTree(tree) } catch { /* still wait for handle exit below */ }
      await Promise.race([
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve()
          child.once('exit', () => resolve())
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 8_000))
      ])
    }
    if (this.inProcessHost && !this.inProcessHostSettled) {
      await Promise.race([
        this.inProcessHost.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ])
    }
    await this.ensureDisconnectCleanup()
  }

  private ensureDisconnectCleanup(): Promise<void> {
    if (this.disconnectCleanupPending) return this.disconnectCleanup
    if (this.disconnectedOwnerPids.size === 0) return Promise.resolve()
    const owners = [...this.disconnectedOwnerPids]
    this.disconnectCleanupPending = true
    this.disconnectCleanup = Promise.all(owners.map(async (ownerPid) => {
      await cleanupOwnedBrowserProcesses(resolve(this.config.browserRoot), ownerPid)
      this.disconnectedOwnerPids.delete(ownerPid)
    })).then(() => undefined).finally(() => {
      this.disconnectCleanupPending = false
    })
    return this.disconnectCleanup
  }
}

function isBrowserWorkerRequest(value: unknown): value is BrowserWorkerRequest {
  return !!value && typeof value === 'object' && (value as { method?: unknown }).method !== undefined
}

async function cleanupOwnedBrowserProcesses(browserRoot: string, ownerPid: number): Promise<void> {
  const root = join(browserRoot, 'user-data')
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (entry.name !== 'mousse-owned-process.json') continue
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; ownerPid?: unknown }
        if (record.ownerPid === ownerPid && typeof record.pid === 'number') await stopOwnedPid(record.pid)
      } catch (error) {
        // Invalid/stale records are irrelevant unless they claim this worker.
        let claimedOwner: unknown
        try { claimedOwner = (JSON.parse(await readFile(path, 'utf8')) as { ownerPid?: unknown }).ownerPid } catch { continue }
        if (claimedOwner === ownerPid) throw error
      }
    }
  }
}
