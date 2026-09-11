import { spawn, type ChildProcess } from 'node:child_process'
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
import type { BrowserBrokerConfig } from './ports'
import { createFilesystemArtifactPort, createFilesystemJournalPort } from './defaultPorts'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
  request?: BrowserWorkerRequest
}

export class BrowserBroker {
  private child: ChildProcess | null = null
  private decoder = new WorkerFrameDecoder()
  private pending = new Map<string, Pending>()
  private writeStream: NodeJS.WritableStream | null = null
  private capabilities: CapabilityReport | null = null
  private started = false
  private starting: Promise<CapabilityReport> | null = null
  private readonly artifacts
  private readonly journal
  private inProcessStop: (() => void) | null = null

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

  async start(): Promise<CapabilityReport> {
    if (this.starting) return this.starting
    if (this.started) return this.capabilities!
    this.starting = this.startInternal()
    try { return await this.starting } finally { this.starting = null }
  }

  private async startInternal(): Promise<CapabilityReport> {
    this.started = true
    try {
      if (this.config.transport === 'in-process') await this.startInProcess()
      else await this.startChildProcess()
      const id = 'init_' + randomUUID()
      const response = await this.sendRaw({
        kind: 'init', version: 1, id,
        profileRoot: resolve(this.config.profileRoot),
        browserRoot: resolve(this.config.browserRoot),
        artifactRoot: resolve(this.config.artifactRoot)
      }, 30_000) as unknown as { kind?: string; capabilities?: CapabilityReport; error?: { message?: string } }
      if (response.kind === 'init_err') fail('setup_required', response.error?.message ?? 'Browser worker init failed')
      if (!response.capabilities) fail('setup_required', 'Browser worker did not report capabilities')
      this.capabilities = response.capabilities
      return this.capabilities
    } catch (error) {
      this.started = false
      this.capabilities = null
      this.inProcessStop?.()
      this.inProcessStop = null
      const child = this.child
      if (child?.pid) {
        try { child.kill() } catch { /* cleanup best effort */ }
        await new Promise<void>((resolveDone) => {
          if (child.exitCode !== null) return resolveDone()
          child.once('exit', () => resolveDone())
          setTimeout(resolveDone, 1_000)
        })
      }
      this.child = null
      this.writeStream = null
      throw error
    }
  }

  async call(request: BrowserWorkerRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BrowserWorkerResponse> {
    if (!this.started) await this.start()
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
      for (const item of resolved) {
        if (!isAbsolute(item.path) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > 100 * 1024 * 1024) {
          return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifact grant is invalid' } }
        }
        try {
          const resolvedPath = await realpath(item.path)
          const details = await stat(resolvedPath)
          if (!details.isFile() || details.size !== item.byteLength) throw new Error('invalid staged artifact')
        } catch {
          return { version: 1, id: validated.id, ok: false, error: { code: 'artifact_denied', message: 'Upload artifact path is unavailable' } }
        }
      }
      workerRequest = { ...validated, params: { ...validated.params, action: { ...action, resolvedArtifacts: resolved } } }
    }
    const raw = await this.sendRaw(workerRequest, options.timeoutMs ?? this.config.requestTimeoutMs ?? 60_000, options.signal)
    return validateBrowserWorkerResponse(raw)
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error('Browser broker closed'), { code: 'worker_disconnected' }))
    }
    try {
      if (this.writeStream) await this.sendRaw({ kind: 'shutdown', version: 1, id: 'shutdown_' + randomUUID() }, 5_000)
    } catch { /* ignore */ }
    this.inProcessStop?.()
    this.inProcessStop = null
    const child = this.child
    if (child?.pid) {
      try { child.kill() } catch { /* ignore */ }
      await new Promise<void>((resolveDone) => {
        if (child.exitCode !== null) return resolveDone()
        child.once('exit', () => resolveDone())
        setTimeout(resolveDone, 1_000)
      })
      this.child = null
    }
    this.writeStream = null
    this.started = false
  }

  private async startChildProcess(): Promise<void> {
    const modulePath = this.config.workerModulePath
    if (!modulePath || !existsSync(modulePath)) {
      fail('setup_required', 'Browser worker module path is not available. Root must inject a bundled Electron-free worker entry.')
    }
    const child = spawn(process.execPath, [modulePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...(process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS ? { MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS: process.env.MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS } : {}),
        // The app hosts MMS inside Electron; its executable must launch this child as Node.
        ELECTRON_RUN_AS_NODE: '1',
        MOUSSE_BROWSER_WORKER: '1'
      }
    })
    this.child = child
    this.writeStream = child.stdin
    child.stderr?.on('data', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.once('exit', () => this.onDisconnect())
    child.once('error', () => this.onDisconnect())
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
      output.end()
    }
    void runBrowserWorkerHost(input, output)
  }

  private onData(chunk: Buffer): void {
    this.decoder.push(chunk)
    for (const frame of this.decoder.shiftAll()) {
      if (!frame || typeof frame !== 'object') continue
      const id = (frame as { id?: unknown }).id
      if (typeof id !== 'string') continue
      const pending = this.pending.get(id)
      if (!pending) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
      pending.resolve(frame)
    }
  }

  private onDisconnect(): void {
    const ownerPid = this.child?.pid
    this.started = false
    this.writeStream = null
    this.child = null
    if (ownerPid) void cleanupOwnedBrowserProcesses(resolve(this.config.browserRoot), ownerPid)
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.request?.method === 'act') {
        pending.resolve({
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
        })
      } else {
        pending.reject(Object.assign(new Error('Browser worker disconnected'), { code: 'worker_disconnected' }))
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
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(Object.assign(new Error('Browser worker request timed out'), { code: 'timeout' }))
        }, timeoutMs),
        ...(isBrowserWorkerRequest(value) ? { request: value } : {})
      }
      if (signal) {
        pending.signal = signal
        pending.onAbort = () => {
          try { this.writeStream?.write(encodeWorkerFrame({ kind: 'cancel', id })) } catch { /* ignore */ }
          this.pending.delete(id)
          clearTimeout(pending.timer)
          reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        }
        if (signal.aborted) {
          pending.onAbort()
          return
        }
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pending.set(id, pending)
      this.writeStream.write(encodeWorkerFrame(value), (error) => {
        if (error) {
          this.pending.delete(id)
          clearTimeout(pending.timer)
          reject(error)
        }
      })
    })
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
      } catch { /* stale or concurrently removed process record */ }
    }
  }
}
