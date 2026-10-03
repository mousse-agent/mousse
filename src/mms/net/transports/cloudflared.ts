import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { LookupFunction } from 'node:net'
import type { Clock, InboundInfo, Listener, Transport, TransportAddon, TransportStatus } from '../contracts'
import type { Route } from '../../../shared/net/identity'
import { NetError } from '../../../shared/net/errors'
import { DirectTransport } from './direct'
import { ProcessSupervisor, runBinary } from './runtime/process'
import { systemClock } from '../clock'
import { dialWebSocketBytes } from './runtime/websocket'

export type CloudflaredSettings = { binary?: string; startupMs?: number; mode: 'quick' } | { binary?: string; startupMs?: number; mode: 'named'; tunnelId: string; hostname: string; credentialsFile: string }
export class CloudflaredTransport implements Transport {
  readonly id = 'cloudflared'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: true, needsAccount: false }
  private readonly direct: DirectTransport
  private child?: ProcessSupervisor
  private directory?: string
  private listener?: Listener
  private listenTask?: Promise<Listener>
  private owner?: (stream: Duplex, info: InboundInfo) => void
  private endpoint?: string
  private registered = false
  private statusValue: TransportStatus = { state: 'disabled', routes: [] }
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  constructor(private readonly settings: CloudflaredSettings, private readonly profileDir: string, private readonly clock: Clock = systemClock, private readonly qaLookup?: LookupFunction) {
    this.direct = new DirectTransport({ enabled: true, host: '127.0.0.1', port: 0, clock })
    if (settings.mode === 'named') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settings.tunnelId) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(settings.hostname) || settings.hostname.length > 253 || !settings.hostname.includes('.')) throw new NetError('bad_request', 'Invalid named tunnel settings.')
      this.traits.needsAccount = true
    }
  }
  async provision(): Promise<void> {
    if (this.statusValue.state === 'ready') return
    this.changed('provisioning')
    try {
      await runBinary(this.settings.binary ?? 'cloudflared', ['--version'])
      if (this.settings.mode === 'named') {
        const info = await stat(this.settings.credentialsFile)
        if (!info.isFile() || info.size > 64 * 1024 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error()
      }
      await this.direct.provision(); this.changed('ready')
    } catch { this.changed('failed', 'Install cloudflared and provide accessible private credentials for a named tunnel.'); throw new NetError('route_unreachable', 'Cloudflare Tunnel setup failed.') }
  }
  status(): TransportStatus { return structuredClone(this.statusValue) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(state: TransportStatus['state'], detail?: string): void {
    this.statusValue = { state, routes: state === 'ready' && this.endpoint ? [{ transport: this.id, address: this.endpoint, priority: 30 }] : [], ...(detail ? { detail, lastError: { code: 'route_unreachable' as const, message: detail } } : {}) }
    for (const listener of this.listeners) listener(this.status())
  }
  async listen(accept: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    if (this.listenTask) { if (this.owner !== accept) throw new NetError('conflict'); return this.listenTask }
    if (this.statusValue.state !== 'ready') throw new NetError('route_unreachable')
    this.owner = accept; this.listenTask = this.startListener(accept)
    try { return await this.listenTask } catch (error) { await this.closeListener(); throw error }
  }
  private async startListener(accept: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> {
    this.listener = await this.direct.listen((raw, info) => accept(raw, { ...info, transport: this.id }))
    const origin = new URL(this.direct.status().routes[0].address); origin.protocol = 'http:'; origin.pathname = '/'
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 })
    this.directory = await mkdtemp(join(this.profileDir, 'net-cloudflared-'))
    const configPath = join(this.directory, 'config.yml')
    const config = this.settings.mode === 'quick' ? '{}\n' : `tunnel: ${JSON.stringify(this.settings.tunnelId)}\ncredentials-file: ${JSON.stringify(this.settings.credentialsFile)}\ningress:\n  - hostname: ${JSON.stringify(this.settings.hostname)}\n    service: ${JSON.stringify(origin.toString())}\n  - service: http_status:404\n`
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' })
    const common = ['tunnel', '--config', configPath, '--no-autoupdate', '--metrics', '127.0.0.1:0', '--protocol', 'http2', '--loglevel', 'info']
    const args = this.settings.mode === 'quick' ? [...common, '--url', origin.toString()] : [...common, 'run', this.settings.tunnelId]
    this.endpoint = this.settings.mode === 'named' ? `wss://${this.settings.hostname}/mousse-net` : undefined
    this.child = new ProcessSupervisor({ binary: this.settings.binary ?? 'cloudflared', args, cwd: this.directory, clock: this.clock,
      state: state => { this.registered = false; if (this.settings.mode === 'quick') this.endpoint = undefined; this.changed(state) },
      line: line => {
        if (this.settings.mode === 'quick') {
          const found = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)(?=[\s/|]|$)/.exec(line)
          if (found) this.endpoint = `wss://${found[1]}/mousse-net`
        }
        if (line.includes('Registered tunnel connection')) this.registered = true
        if (this.endpoint && this.registered) this.changed('ready')
      } })
    await new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => { off(); reject(new NetError('deadline_exceeded', 'Cloudflare Tunnel did not become ready.')) }, this.settings.startupMs ?? 60_000)
      const off = this.onStatus(status => {
        if (status.state === 'ready' && status.routes.length) { timer.cancel(); off(); resolve() }
        else if (status.state === 'failed') { timer.cancel(); off(); reject(new NetError('route_unreachable', 'Cloudflare Tunnel stopped.')) }
      })
      this.child!.start()
    })
    return { close: () => this.closeListener() }
  }
  markAuthenticated(raw: Duplex): void { this.direct.markAuthenticated(raw) }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (route.transport !== this.id) throw new NetError('bad_request')
    const url = new URL(route.address)
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.pathname !== '/mousse-net' || url.search) throw new NetError('bad_request', 'Invalid Cloudflare route.')
    if (this.qaLookup) return dialWebSocketBytes(url, signal, this.qaLookup)
    return this.direct.dial({ ...route, transport: 'direct' }, signal)
  }
  private async closeListener(): Promise<void> {
    await this.child?.stop(); this.child = undefined
    await this.listener?.close(); this.listener = undefined
    if (this.directory) await rm(this.directory, { recursive: true, force: true }); this.directory = undefined
    this.endpoint = undefined; this.registered = false; this.listenTask = undefined; this.owner = undefined
    if (this.statusValue.state !== 'disabled') this.changed('ready')
  }
  async teardown(): Promise<void> { await this.closeListener(); await this.direct.teardown(); this.changed('disabled') }
}

export const cloudflaredAddon: TransportAddon = {
  manifest: { id: 'cloudflared', kind: 'transport', displayName: 'Cloudflare Tunnel', traits: { canListen: true, canDial: true, readsPlaintext: true, needsAccount: false }, settingsSchema: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'quick' }, binary: { type: 'string', minLength: 1, maxLength: 4096 }, startupMs: { type: 'integer', minimum: 1000, maximum: 120000 } } },
    { type: 'object', additionalProperties: false, required: ['mode', 'tunnelId', 'hostname', 'credentialsFile'], properties: { mode: { const: 'named' }, binary: { type: 'string', minLength: 1, maxLength: 4096 }, startupMs: { type: 'integer', minimum: 1000, maximum: 120000 }, tunnelId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' }, hostname: { type: 'string', minLength: 3, maxLength: 253 }, credentialsFile: { type: 'string', minLength: 1, maxLength: 4096 } } }
  ] }, setupSteps: [{ title: 'Install cloudflared', detail: 'Use a quick tunnel or an explicitly configured tunnel in your own account. Mousse never changes existing tunnel configuration or DNS.', command: 'cloudflared --version' }] },
  create: (settings, context) => new CloudflaredTransport(settings as CloudflaredSettings, context.profileDir, context.clock)
}
