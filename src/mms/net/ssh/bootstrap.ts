import { createHash, randomInt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isId, NetError, type InviteId, type NodeId, type Signed } from '../../../shared/net'
import type {
  SshBeginResult,
  SshCheckResult,
  SshInstalledView,
  SshOwner,
  SshPlan,
  SshPrerequisite,
  SshRecordView,
  SshSetupStatus,
  SshTrustResult,
  SshUndoResult,
  SshUpdateResult
} from '../../../shared/net/local'
import { mousseVersion } from '../../appVersion'
import type { EnrollmentService } from '../enrollment/service'
import {
  parseSshEndpoint,
  sshDialArguments,
  sshKnownHostsPath,
  type SshEndpoint
} from '../transports/ssh'
import { retrieveHostKey } from './hostKey'
import {
  ApprovalStore,
  ManifestStore,
  newManifestId,
  type SshManifest,
  type StepRecord
} from './journal'
import {
  judgeHostKey,
  removeTrustedName,
  writeTrustedKey,
  type HostKeyJudgement,
  type OfferedKey
} from './knownHosts'
import { buildPlan, defaultDaemonPort, PREREQUISITE, STEP_TITLES } from './plan'
import { RemoteHost, SshRefusal, type ResolvedSsh, type SshContext } from './remote'
import { runProcess } from './runner'
import {
  assetName,
  assetUrl,
  checksumsUrl,
  catFileScript,
  cliScript,
  configureAddonScript,
  fetchScript,
  installDirectory,
  INSTALL_RELATIVE,
  joinScript,
  launcherContent,
  launcherOwner,
  launcherPath,
  lingerDisableScript,
  lingerEnableScript,
  lingerShowScript,
  listInstallsScript,
  parseSections,
  PLAIN_PATH,
  probeScript,
  reconcileInstallScript,
  removeInstallScript,
  removeLauncherScript,
  restartServiceScript,
  startServiceScript,
  unitPath,
  uploadScript,
  verifyExtractScript,
  VERSION,
  writeLauncherScript
} from './scripts'

/** What the bootstrap needs from `NetService`; every call keeps `NetService`'s own gates and queue. */
export interface SshBootstrapHost {
  profileDir: string
  inviteNode(name: string): Promise<{ invite: string; inviteId: InviteId }>
  inviteOutcome(invite: InviteId): ReturnType<EnrollmentService['inviteOutcome']>
  revokeInvite(invite: InviteId): void
  revokeNode(node: NodeId): Promise<void>
  /** A loopback listener for the join only: never persisted, closed when the join ends. */
  openEnrollmentListener(): Promise<{ port: number; close(): Promise<void> }>
  /** Stores the peer's signed routes and starts dialing it. */
  adoptRoutes(signed: Signed, node: NodeId): void
  peerOpen(node: NodeId): boolean
  knownNode(node: NodeId): boolean
}

export interface SshBootstrapOptions {
  binary(): string | undefined
  userKnownHosts?: string
  sshAdd?: string
  sshDirectory?: string
  fetch?: typeof fetch
  version?: () => string
  /** Tests throw from here to stop the process at a named point. */
  fault?(point: string): void
  pollMs?: number
  openWaitMs?: number
  routesWaitMs?: number
  serviceWaitMs?: number
}

const KEY_TTL_MS = 10 * 60_000
const FORWARDING_PROBE_PORT = 1
const MISSING_SSH = 'The ssh command was not found. Install OpenSSH to add this machine.'

/** A fault hook threw: behave as if the process died here, writing nothing more. */
class SetupCrash extends Error {}
/** The evidence is missing or contradictory: stop with the reason and offer no automatic revocation. */
class Interrupted extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function tail(text: string): string {
  const last = text
    .replace(/[^\x20-\x7e\n]/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  return (last ?? '').slice(0, 300)
}
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unexpected error.'
}
function json(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text.trim() || 'null') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
/** The last JSON object on stdout; some commands print a line of text first. */
function lastJson(text: string): Record<string, unknown> | undefined {
  for (const line of text.trim().split('\n').reverse()) {
    const value = json(line)
    if (value) return value
  }
  return json(text)
}
/** Names go to `--name` on the machine: same rules as the CLI, and nothing a fish login shell rewrites. */
export function validDeviceName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.trim() === name &&
    // `--name <value>` is parsed by the CLI's own flag parser: a leading dash would read as a flag.
    !name.startsWith('-') &&
    Array.from(name).length <= 64 &&
    !/[\x00-\x1f\x7f\\]/u.test(name)
  )
}

interface RunState {
  controller: AbortController
  step?: string
  progress?: string
}
interface RunContext {
  m: SshManifest
  remote: RemoteHost
  signal: AbortSignal
  state: RunState
  save(): Promise<void>
}
interface StepDefinition {
  id: string
  applies(m: SshManifest): boolean
  resource(m: SshManifest): string
  /** Read-only work that produces the before-state; the intent record is written after it. */
  prepare?(ctx: RunContext): Promise<{ before?: unknown; scratch?: unknown }>
  /** The machine already shows this step done (after a crash or a lost reply). */
  reconcile?(ctx: RunContext, record: StepRecord): Promise<boolean>
  run(
    ctx: RunContext,
    scratch: unknown,
    record: StepRecord
  ): Promise<{ after?: unknown; result?: string; state?: 'done' | 'skipped' }>
}

interface KeyEntry {
  offered: OfferedKey
  fingerprint: string
  resolved: ResolvedSsh
  at: number
}
interface CheckEntry {
  result: SshCheckResult
  at: number
}

export class SshBootstrap {
  private readonly manifests: ManifestStore
  private readonly approvals: ApprovalStore
  private readonly keys = new Map<string, KeyEntry>()
  private readonly checks = new Map<string, CheckEntry>()
  private readonly runs = new Map<string, RunState & { done: Promise<void> }>()
  private busy = false
  private closed = false
  constructor(
    private readonly host: SshBootstrapHost,
    private readonly options: SshBootstrapOptions
  ) {
    this.manifests = new ManifestStore(host.profileDir)
    this.approvals = new ApprovalStore(host.profileDir)
  }

  private version(): string {
    return (this.options.version ?? mousseVersion)()
  }
  private context(): SshContext {
    return {
      binary: this.options.binary() ?? 'ssh',
      knownHosts: sshKnownHostsPath(this.host.profileDir),
      userKnownHosts: this.options.userKnownHosts ?? join(homedir(), '.ssh', 'known_hosts')
    }
  }
  private remote(endpoint: string, signal?: AbortSignal): RemoteHost {
    return new RemoteHost(this.context(), endpoint, signal)
  }
  private scratch(): string {
    return join(this.manifests.directory(), 'scratch')
  }
  private files(resolved: ResolvedSsh) {
    const context = this.context()
    return {
      mousse: context.knownHosts,
      user: context.userKnownHosts,
      global: resolved.globalKnownHosts
    }
  }
  /** Writes to `ssh_known_hosts` read, change and replace the file; one at a time. */
  private writes: Promise<unknown> = Promise.resolve()
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work)
    this.writes = result.catch(() => {})
    return result
  }
  /** Takes the one-operation guard synchronously, before any await, or says it is taken. */
  private reserve(): boolean {
    if (this.closed || this.busy || this.runs.size) return false
    this.busy = true
    return true
  }
  private crash(point: string): void {
    try {
      this.options.fault?.(point)
    } catch (cause) {
      throw new SetupCrash('Simulated crash.', { cause })
    }
  }

  /** A setup that was running when the process died is shown as interrupted. */
  async start(): Promise<void> {
    for (const m of await this.manifests.list())
      if (m.phase === 'running' && !this.runs.has(m.id)) {
        m.phase = 'interrupted'
        m.error = 'Mousse stopped while this setup was running.'
        await this.manifests.write(m)
      }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const run of this.runs.values()) run.controller.abort()
    await Promise.allSettled([...this.runs.values()].map((run) => run.done))
  }

  // ---------------------------------------------------------------- check

  /**
   * Two phases, and the trust boundary sits between them. Phase 1 only reads `ssh -G` and retrieves
   * the host key; it never authenticates and never runs a command on the machine. Phase 2 runs only
   * once the key is trusted.
   */
  async check(host: string, signal?: AbortSignal): Promise<SshCheckResult> {
    const endpoint = parseSshEndpoint(host)
    if (!endpoint)
      return {
        ok: false,
        phase: 'untrusted',
        host,
        prerequisites: [],
        problem: 'invalid_host',
        detail: 'Enter the machine as [user@]host[:port], or a host name from your ~/.ssh/config.'
      }
    const remote = this.remote(host, signal)
    let resolved: ResolvedSsh
    try {
      resolved = await remote.resolve()
    } catch (error) {
      return this.refusal(host, error)
    }
    const retrieved = await retrieveHostKey(this.context(), endpoint, host, this.scratch(), signal)
    if (!retrieved.ok)
      return {
        ok: false,
        phase: 'untrusted',
        host,
        resolved: { hostname: resolved.hostname, port: resolved.port, user: resolved.user },
        prerequisites: [],
        problem: retrieved.problem,
        detail: retrieved.detail
      }
    this.keys.set(host, {
      offered: retrieved.offered,
      fingerprint: retrieved.fingerprint,
      resolved,
      at: Date.now()
    })
    const judgement = await judgeHostKey(retrieved.offered, this.files(resolved))
    const hostKey = this.hostKeyView(retrieved.offered, retrieved.fingerprint, judgement)
    const publicResolved = {
      hostname: resolved.hostname,
      port: resolved.port,
      user: resolved.user
    }
    if (judgement.state === 'revoked')
      return {
        ok: false,
        phase: 'untrusted',
        host,
        resolved: publicResolved,
        hostKey,
        prerequisites: [],
        problem: 'host_key_revoked',
        detail: 'This host key is marked @revoked in a known_hosts file, so Mousse will not use it.'
      }
    if (judgement.state !== 'trusted')
      return {
        ok: false,
        phase: 'untrusted',
        host,
        resolved: publicResolved,
        hostKey,
        prerequisites: []
      }
    const result = await this.probe(host, remote, publicResolved, hostKey, endpoint, signal)
    this.checks.set(host, { result, at: Date.now() })
    return result
  }

  private refusal(host: string, error: unknown): SshCheckResult {
    if (error instanceof NetError && error.code === 'cancelled') throw error
    const kind = error instanceof SshRefusal ? error.kind : 'unreachable'
    return {
      ok: false,
      phase: 'untrusted',
      host,
      prerequisites: [],
      problem:
        kind === 'proxy_refused'
          ? 'proxy_refused'
          : kind === 'invalid_host'
            ? 'invalid_host'
            : 'unreachable',
      detail: error instanceof SshRefusal ? error.message : messageOf(error)
    }
  }

  private hostKeyView(
    offered: OfferedKey,
    fingerprint: string,
    judgement: HostKeyJudgement
  ): NonNullable<SshCheckResult['hostKey']> {
    return {
      type: offered.type,
      fingerprint,
      state: judgement.state,
      ...(judgement.changed ? { changed: judgement.changed } : {}),
      ...(judgement.stale ? { stale: judgement.stale } : {}),
      ...(judgement.knownByOtherTypes ? { knownByOtherTypes: judgement.knownByOtherTypes } : {})
    }
  }

  /** Is a key or agent identity available to this daemon? It may run without `SSH_AUTH_SOCK`. */
  private async keysPrerequisite(): Promise<SshPrerequisite> {
    const agent = await runProcess(this.options.sshAdd ?? 'ssh-add', ['-l'], {
      timeoutMs: 5000,
      env: process.env
    }).catch(() => undefined)
    const agentOk = agent?.code === 0
    let keyFile = false
    try {
      keyFile = (await readdir(this.options.sshDirectory ?? join(homedir(), '.ssh'))).some((name) =>
        /^id_[A-Za-z0-9_]+$/u.test(name)
      )
    } catch {
      keyFile = false
    }
    return {
      name: PREREQUISITE.keys,
      ok: agentOk || keyFile,
      ...(agentOk || keyFile
        ? {}
        : {
            remedy:
              'Create a key with ssh-keygen -t ed25519 and install it on the machine, or start ssh-agent and run ssh-add. A daemon started by systemd or a launch agent may not see SSH_AUTH_SOCK; a key file in ~/.ssh works without it.'
          })
    }
  }

  private async probe(
    host: string,
    remote: RemoteHost,
    resolved: { hostname: string; port: number; user: string },
    hostKey: NonNullable<SshCheckResult['hostKey']>,
    endpoint: SshEndpoint,
    signal?: AbortSignal
  ): Promise<SshCheckResult> {
    const base = { host, resolved, hostKey, phase: 'probed' as const }
    const keys = await this.keysPrerequisite()
    let run
    try {
      run = await remote.run(probeScript(), { timeoutMs: 45_000 })
    } catch (error) {
      if (error instanceof SshRefusal) return this.refusal(host, error)
      throw error
    }
    if (run.missing)
      return {
        ...base,
        ok: false,
        prerequisites: [keys],
        auth: 'unreachable',
        problem: 'unreachable',
        detail: MISSING_SSH
      }
    if (run.code !== 0 || run.timedOut) {
      const stderr = run.stderr
      if (/Permission denied/i.test(stderr))
        return {
          ...base,
          ok: false,
          prerequisites: [keys],
          auth: 'denied',
          copyId: `ssh-copy-id${resolved.port !== 22 ? ` -p ${resolved.port}` : ''} ${resolved.user}@${resolved.hostname}`,
          detail: `${host} did not accept any SSH key or agent identity. Mousse never asks for a password.`
        }
      if (/Host key verification failed|HOST IDENTIFICATION/i.test(stderr))
        return {
          ...base,
          phase: 'untrusted',
          ok: false,
          prerequisites: [],
          problem: 'host_key_failed',
          detail: `Host key verification failed for ${host}. Check the host key again.`
        }
      return {
        ...base,
        ok: false,
        prerequisites: [keys],
        auth: 'unreachable',
        problem: 'unreachable',
        detail: run.timedOut
          ? `Connection to ${host} timed out.`
          : `SSH to ${host} failed: ${tail(stderr) || `exit ${run.code}`}`
      }
    }
    const s = parseSections(run.stdout)
    const [os = '', arch = ''] = (s.get('uname') ?? '').split(/\s+/u)
    const home = s.get('home') ?? ''
    const launcherText = s.get('launcher') ?? ''
    const markerId = launcherOwner(launcherText)
    const cliPath = s.get('cli') || undefined
    const manifests = await this.manifests.list()
    const owned = markerId
      ? manifests.find((m) => m.id === markerId && m.cli.owner === 'managed')
      : undefined
    const managedCli = !!cliPath && !!owned && cliPath === launcherPath(home)
    const versionText = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u.exec(s.get('version') ?? '')?.[1]
    const service = json(s.get('service') ?? '')
    const startup = service?.startup as { installed?: boolean } | undefined
    const serviceInstalled = startup?.installed === true || service?.running === true
    const running = service?.running === true
    const net = json(s.get('net') ?? '')
    const tools = new Set((s.get('tools') ?? '').split('\n').map((line) => line.trim()))
    const unitExists = s.get('unit') === 'yes'
    const availableKb = Number((s.get('df') ?? '').split(/\s+/u)[3])
    const lingerText = /Linger=(yes|no)/u.exec(s.get('linger') ?? '')?.[1] as
      'yes' | 'no' | undefined
    const installed: SshInstalledView = {
      cli: cliPath
        ? {
            owner: managedCli ? 'managed' : 'external',
            ...(versionText ? { version: versionText } : {}),
            path: cliPath
          }
        : { owner: 'none' },
      service: serviceInstalled
        ? {
            owner: managedCli && owned?.service.owner === 'managed' ? 'managed' : 'external',
            state: running ? 'running' : 'stopped'
          }
        : { owner: 'none' }
    }
    const installing = installed.cli.owner === 'none'
    const prerequisites: SshPrerequisite[] = [
      keys,
      await this.forwardingPrerequisite(endpoint, signal)
    ]
    if (installing) {
      const supported = os === 'Linux' && arch === 'x86_64'
      prerequisites.push(
        {
          name: PREREQUISITE.system,
          ok: supported,
          ...(supported
            ? {}
            : {
                remedy:
                  os === 'Darwin'
                    ? 'Install Mousse on that Mac first; Mousse can then add it from here.'
                    : `${os} ${arch} has no Mousse command-line build to install.`
              })
        },
        {
          name: PREREQUISITE.release,
          ok: VERSION.test(this.version()) && this.version() !== '0.0.0',
          remedy: 'Development builds cannot install a release on another machine.'
        },
        {
          name: PREREQUISITE.home,
          ok: PLAIN_PATH.test(home),
          remedy: 'The home directory path has characters Mousse cannot use. Install by hand.'
        },
        {
          name: PREREQUISITE.downloader,
          ok: tools.has('curl') || tools.has('wget'),
          remedy: 'Install curl or wget on the machine, or upload will be used instead.',
          // Without either, the file is sent over SSH from this computer.
          ...(tools.has('curl') || tools.has('wget') ? {} : { indeterminate: true })
        },
        {
          name: PREREQUISITE.checksum,
          ok: tools.has('sha256sum') || tools.has('shasum'),
          remedy: 'Install coreutils (sha256sum) or perl shasum on the machine.'
        },
        {
          name: PREREQUISITE.systemd,
          ok: tools.has('systemctl'),
          remedy:
            'Mousse starts as a systemd user service. Without systemd, run mousse-cli service start after each reboot.'
        },
        {
          name: PREREQUISITE.disk,
          ok: Number.isFinite(availableKb) && availableKb >= 500 * 1024,
          remedy: 'Free some disk space in the home directory (the unpacked app is about 400 MB).'
        },
        {
          name: PREREQUISITE.launcher,
          ok: launcherText.trim() === '',
          remedy: 'Move or remove ~/.local/bin/mousse-cli, then check again.'
        }
      )
    }
    if (unitExists && !serviceInstalled)
      prerequisites.push({
        name: PREREQUISITE.unit,
        ok: false,
        remedy:
          'A mousse-mms.service unit exists that Mousse did not install. Remove it or check why the service is not enabled.'
      })
    const okEverything = prerequisites.every((item) => item.ok || item.indeterminate) && !net?.self
    void signal
    return {
      ...base,
      ok: okEverything,
      auth: 'ok',
      os,
      arch,
      home,
      installed,
      ...(net?.self
        ? {
            enrolled: true,
            ...(typeof (net.self as { node?: unknown }).node === 'string'
              ? { hostNode: (net.self as { node: string }).node }
              : {})
          }
        : {}),
      ...(lingerText ? { linger: lingerText } : {}),
      prerequisites
    }
  }

  /**
   * A throwaway `ssh -W` to a closed port: `administratively prohibited` means sshd forbids TCP
   * forwarding; `connect failed` means forwarding was allowed and nothing listens, which passes.
   */
  private async forwardingPrerequisite(
    endpoint: SshEndpoint,
    signal?: AbortSignal
  ): Promise<SshPrerequisite> {
    const context = this.context()
    const stdin = new PassThrough()
    const result = await runProcess(
      context.binary,
      sshDialArguments({
        endpoint,
        port: FORWARDING_PROBE_PORT,
        knownHosts: context.knownHosts,
        userKnownHosts: context.userKnownHosts,
        // The refusal reason is logged at INFO; this run has no session, so nothing else leaks.
        logLevel: 'INFO'
      }),
      { stdin, timeoutMs: 15_000, signal }
    ).catch(() => undefined)
    stdin.destroy()
    const text = result?.stderr ?? ''
    if (/administratively prohibited/i.test(text))
      return {
        name: PREREQUISITE.forwarding,
        ok: false,
        remedy: 'Set AllowTcpForwarding yes (or local) for this user in sshd_config on the machine.'
      }
    return {
      name: PREREQUISITE.forwarding,
      ok: true,
      ...(/connect failed/i.test(text) ? {} : { indeterminate: true })
    }
  }

  // ---------------------------------------------------------------- trust

  /**
   * Writes the host key Mousse itself read, only after the person confirmed its fingerprint. The
   * renderer never supplies key material: the fingerprint must match the daemon's own copy. A
   * changed key needs an explicit acknowledgement; a revoked one is always refused. Only Mousse's
   * known_hosts file is written, never the user's or a system file.
   */
  async trust(input: {
    host: string
    fingerprint: string
    acknowledgeChanged?: boolean
  }): Promise<SshTrustResult> {
    const entry = this.keys.get(input.host)
    if (!entry || Date.now() - entry.at > KEY_TTL_MS)
      return {
        ok: false,
        state: 'unknown',
        detail: 'Check the machine again; its host key was not read recently.'
      }
    if (entry.fingerprint !== input.fingerprint)
      return {
        ok: false,
        state: 'unknown',
        detail: 'That fingerprint is not the key Mousse read from the machine. Nothing was saved.'
      }
    const judgement = await judgeHostKey(entry.offered, this.files(entry.resolved))
    if (judgement.state === 'revoked')
      return {
        ok: false,
        state: 'revoked',
        detail: 'This host key is marked @revoked. Mousse will not trust it.'
      }
    if (judgement.state === 'changed' && input.acknowledgeChanged !== true)
      return {
        ok: false,
        state: 'changed',
        detail: 'The host key changed. Confirm the change explicitly to replace the saved key.'
      }
    await this.serialized(() =>
      writeTrustedKey(
        sshKnownHostsPath(this.host.profileDir),
        entry.offered,
        judgement.state === 'changed'
      )
    )
    return { ok: true, state: 'trusted' }
  }

  /** The Mousse file is complete for every approved endpoint, so the dial needs no lookup of its own. */
  private async ensureLine(host: string): Promise<KeyEntry> {
    const entry = this.keys.get(host)
    if (!entry || Date.now() - entry.at > KEY_TTL_MS)
      throw new NetError('conflict', 'The host key was not read recently.')
    const judgement = await judgeHostKey(entry.offered, this.files(entry.resolved))
    if (judgement.state !== 'trusted')
      throw new NetError('conflict', 'The host key is not trusted.')
    await this.serialized(() =>
      writeTrustedKey(sshKnownHostsPath(this.host.profileDir), entry.offered, false)
    )
    return entry
  }

  // ---------------------------------------------------------------- plan

  private fresh(host: string): SshCheckResult | undefined {
    const entry = this.checks.get(host)
    return entry && Date.now() - entry.at <= KEY_TTL_MS ? entry.result : undefined
  }

  plan(input: { host: string; name: string; port?: number }): SshPlan {
    const check = this.fresh(input.host)
    if (!check || check.phase !== 'probed')
      return { steps: [], blocked: [{ name: 'Check', remedy: 'Check the machine first.' }] }
    if (!validDeviceName(input.name))
      return {
        steps: [],
        blocked: [
          {
            name: 'Device name',
            remedy:
              'Use 1–64 characters, without control characters, a backslash, a leading dash or surrounding spaces.'
          }
        ]
      }
    return buildPlan(check, {
      name: input.name,
      port: input.port ?? defaultDaemonPort(input.host),
      version: this.version()
    })
  }

  // ---------------------------------------------------------------- list / status

  private view(m: SshManifest): SshRecordView {
    return {
      id: m.id,
      endpoint: m.endpoint,
      ...(m.node ? { node: m.node } : {}),
      phase: m.phase,
      owner: m.cli.owner as SshOwner,
      ...(m.cli.version ? { version: m.cli.version } : {}),
      recoverable: m.phase !== 'done' && m.phase !== 'running',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    }
  }
  async list(): Promise<{ records: SshRecordView[] }> {
    return { records: (await this.manifests.list()).map((m) => this.view(m)) }
  }
  async status(id: string): Promise<SshSetupStatus> {
    const m = await this.manifests.read(id)
    if (!m) throw new NetError('bad_request')
    const run = this.runs.get(id)
    const lingerCommand = m.lingerSkipped
      ? `sudo loginctl enable-linger ${m.resolved.user}`
      : undefined
    return {
      id,
      phase: run ? 'running' : m.phase,
      ...(run?.step ? { step: run.step } : {}),
      ...(run?.progress ? { progress: run.progress } : {}),
      ...(m.error && !run ? { error: m.error } : {}),
      ...(m.node ? { node: m.node } : {}),
      recoverable: !run && m.phase !== 'done' && m.phase !== 'running',
      ...(lingerCommand ? { lingerCommand } : {}),
      steps: m.steps.map((s) => ({ step: s.step, state: s.state }))
    }
  }

  // ---------------------------------------------------------------- setup

  async begin(input: { host: string; name: string; port?: number }): Promise<SshBeginResult> {
    // Reserved before the first await: two requests entering together cannot both start.
    if (!this.reserve())
      return { error: 'Another remote machine operation is running. Wait for it to finish.' }
    try {
      return await this.beginReserved(input)
    } finally {
      this.busy = false
    }
  }

  private async beginReserved(input: {
    host: string
    name: string
    port?: number
  }): Promise<SshBeginResult> {
    const check = this.fresh(input.host)
    if (!check || check.phase !== 'probed' || !check.resolved || !check.home || !check.installed)
      return { error: 'Check the machine first.' }
    if (!validDeviceName(input.name))
      return {
        error:
          'The device name must be 1–64 characters without control characters, a backslash or a leading dash.'
      }
    const port = input.port ?? defaultDaemonPort(input.host)
    const plan = buildPlan(check, { name: input.name, port, version: this.version() })
    if (plan.blocked?.length)
      return { error: `Cannot start: ${plan.blocked.map((item) => item.name).join('; ')}.` }
    let entry: KeyEntry
    try {
      entry = await this.ensureLine(input.host)
    } catch (error) {
      return { error: messageOf(error) }
    }
    const { installed, home } = check
    const managedCli = installed.cli.owner === 'none'
    const managedService = installed.service.owner === 'none'
    const version = this.version()
    const id = newManifestId()
    const m: SshManifest = {
      id,
      endpoint: input.host,
      resolved: check.resolved!,
      name: input.name,
      daemonPort: port,
      home,
      ...(check.os ? { os: check.os } : {}),
      phase: 'running',
      cli: managedCli
        ? {
            owner: 'managed',
            version,
            path: launcherPath(home),
            installDir: installDirectory(home, version),
            launcherBefore: null
          }
        : {
            owner: 'external',
            ...(installed.cli.version ? { version: installed.cli.version } : {}),
            path: installed.cli.path!
          },
      service: managedService
        ? { owner: 'managed', unitPath: unitPath(home), unitExistedBefore: false }
        : { owner: 'external', unitExistedBefore: true },
      ...(check.linger ? { lingerBefore: check.linger } : {}),
      hostKey: { hostname: entry.offered.name, fingerprint: entry.fingerprint },
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await this.manifests.write(m)
    this.launch(m, (ctx) => this.execute(ctx))
    return { id }
  }

  async cancel(id: string): Promise<SshSetupStatus> {
    this.runs.get(id)?.controller.abort()
    await this.runs.get(id)?.done
    return this.status(id)
  }

  async retry(id: string): Promise<SshSetupStatus> {
    if (!this.reserve()) throw new NetError('conflict')
    try {
      const m = await this.manifests.read(id)
      if (!m) throw new NetError('bad_request')
      if (m.phase === 'done' || m.phase === 'running') throw new NetError('conflict')
      this.launch(m, (ctx) => this.execute(ctx))
    } finally {
      this.busy = false
    }
    return this.status(id)
  }

  private launch(m: SshManifest, work: (ctx: RunContext) => Promise<void>): void {
    const controller = new AbortController()
    const state: RunState & { done: Promise<void> } = { controller, done: Promise.resolve() }
    const ctx: RunContext = {
      m,
      remote: this.remote(m.endpoint, controller.signal),
      signal: controller.signal,
      state,
      save: () => this.manifests.write(m)
    }
    this.runs.set(m.id, state)
    state.done = work(ctx)
      .catch(() => {})
      .finally(() => {
        this.runs.delete(m.id)
      })
  }

  private async execute(ctx: RunContext): Promise<void> {
    const { m } = ctx
    try {
      m.phase = 'running'
      delete m.error
      await ctx.save()
      for (const definition of this.steps()) await this.runStep(ctx, definition)
      m.phase = 'done'
      await ctx.save()
    } catch (error) {
      // A crash writes nothing more: the manifest stays `running` and shows as interrupted.
      if (error instanceof SetupCrash) return
      if (ctx.signal.aborted || (error instanceof NetError && error.code === 'cancelled')) {
        m.phase = 'cancelled'
        delete m.error
        // The command in flight may still finish on the machine; Retry and Undo reconcile it.
        for (const step of m.steps) if (step.state === 'pending') step.state = 'unknown'
      } else if (error instanceof Interrupted) {
        m.phase = 'interrupted'
        m.error = error.message
      } else {
        m.phase = 'failed'
        m.error = messageOf(error)
      }
      await ctx.save().catch(() => {})
    }
  }

  /** Intent on disk before the first change, completion after; both through atomic renames. */
  private async runStep(ctx: RunContext, definition: StepDefinition): Promise<void> {
    const { m } = ctx
    if (!definition.applies(m)) return
    const existing = m.steps.find((step) => step.step === definition.id)
    if (existing && (existing.state === 'done' || existing.state === 'skipped')) return
    ctx.state.step = definition.id
    ctx.state.progress = STEP_TITLES[definition.id]
    if (existing && definition.reconcile && (await definition.reconcile(ctx, existing))) {
      existing.state = 'done'
      existing.result = 'Already in place.'
      await ctx.save()
      return
    }
    const prepared = (await definition.prepare?.(ctx)) ?? {}
    const record: StepRecord = {
      step: definition.id,
      resource: definition.resource(m),
      ...(prepared.before !== undefined ? { before: prepared.before } : {}),
      startedAt: Date.now(),
      state: 'pending'
    }
    m.steps = [...m.steps.filter((step) => step.step !== definition.id), record]
    await ctx.save()
    let outcome
    try {
      outcome = await definition.run(ctx, prepared.scratch, record)
    } catch (error) {
      if (error instanceof SetupCrash) throw error
      record.state = ctx.signal.aborted ? 'unknown' : 'failed'
      record.result = messageOf(error)
      await ctx.save().catch(() => {})
      throw error
    }
    this.crash(`${definition.id}.afterEffect`)
    record.state = outcome.state ?? 'done'
    if (outcome.after !== undefined) record.after = outcome.after
    if (outcome.result !== undefined) record.result = outcome.result
    await ctx.save()
    this.crash(`${definition.id}.afterRecord`)
  }

  /** stdout of a remote script that must succeed, with a message naming what it was doing. */
  private async must(
    ctx: RunContext,
    script: string,
    what: string,
    options: { stdin?: string | Buffer | Readable; timeoutMs?: number } = {}
  ): Promise<string> {
    const result = await ctx.remote.run(script, {
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 120_000
    })
    if (ctx.signal.aborted) throw new NetError('cancelled')
    if (result.missing) throw new Error(MISSING_SSH)
    if (result.timedOut) throw new Error(`${what} timed out.`)
    if (result.code !== 0)
      throw new Error(
        `${what} failed${result.code === 255 ? ' (SSH)' : ''}: ${tail(result.stderr) || `exit ${result.code}`}`
      )
    return result.stdout
  }

  /** A read-only CLI call on the machine; a failure is `undefined`, never an exception. */
  private async cliJson(
    ctx: RunContext,
    step: string,
    args: string[],
    cli = ctx.m.cli.path
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await ctx.remote.run(cliScript(step, cli, [...args, '--json']), {
        timeoutMs: 60_000
      })
      return result.code === 0 ? lastJson(result.stdout) : undefined
    } catch (error) {
      if (error instanceof NetError && error.code === 'cancelled') throw error
      return undefined
    }
  }

  private async sshRow(
    ctx: RunContext
  ): Promise<{ enabled: boolean; settings: unknown } | null | undefined> {
    const listing = await this.cliJson(ctx, 'transports', ['net', 'transports'])
    if (!listing) return undefined
    const saved = listing.saved
    // A CLI that does not list its saved add-ons cannot show what setup would overwrite: unknown,
    // never "none".
    if (!Array.isArray(saved)) return undefined
    const row = saved.find((item) => (item as { id?: unknown })?.id === 'ssh') as
      { enabled: boolean; settings: unknown } | undefined
    return row ? { enabled: row.enabled, settings: row.settings } : null
  }

  private async checksumLine(version: string, signal: AbortSignal): Promise<string> {
    const get = this.options.fetch ?? fetch
    const response = await get(checksumsUrl(version), { signal })
    if (!response.ok)
      throw new Error(
        `Could not read the published checksums for Mousse ${version} (HTTP ${response.status}).`
      )
    const asset = assetName(version)
    for (const line of (await response.text()).slice(0, 1_000_000).split('\n')) {
      const match = /^([0-9a-f]{64})\s+\*?(\S+)$/iu.exec(line.trim())
      if (match && match[2] === asset) return `${match[1]!.toLowerCase()}  ${asset}\n`
    }
    throw new Error(`The published checksums have no entry for ${asset}.`)
  }

  /** The fallback when the machine cannot reach GitHub: this computer downloads, verifies and sends it. */
  private async uploadAsset(
    ctx: RunContext,
    version: string,
    directory: string,
    checksum: string
  ): Promise<void> {
    const get = this.options.fetch ?? fetch
    const response = await get(assetUrl(version), { signal: ctx.signal })
    if (!response.ok || !response.body)
      throw new Error(`Could not download Mousse ${version} (HTTP ${response.status}).`)
    await mkdir(this.scratch(), { recursive: true })
    const file = join(this.scratch(), `${ctx.m.id}.AppImage`)
    const hash = createHash('sha256')
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(file, { mode: 0o600 })
      )
      if (hash.digest('hex') !== checksum.split(/\s+/u)[0])
        throw new Error('The downloaded file does not match the published checksum.')
      await this.must(
        ctx,
        uploadScript({ directory, asset: assetName(version) }),
        'Sending the file',
        {
          stdin: createReadStream(file),
          timeoutMs: 30 * 60_000
        }
      )
    } finally {
      await rm(file, { force: true })
    }
  }

  private async installAsset(
    ctx: RunContext,
    version: string,
    directory: string,
    checksum: string
  ): Promise<void> {
    ctx.state.progress = 'Downloading on the machine'
    const fetched = await ctx.remote.run(
      fetchScript({ directory, asset: assetName(version), url: assetUrl(version) }),
      { timeoutMs: 20 * 60_000 }
    )
    if (ctx.signal.aborted) throw new NetError('cancelled')
    if (fetched.code === 21) {
      ctx.state.progress = 'The machine cannot reach GitHub; sending the file from this computer'
      await this.uploadAsset(ctx, version, directory, checksum)
    } else if (fetched.code !== 0 || fetched.timedOut || fetched.missing)
      throw new Error(
        `Downloading failed: ${fetched.missing ? MISSING_SSH : tail(fetched.stderr) || `exit ${fetched.code}`}`
      )
    ctx.state.progress = 'Checking the download and unpacking it'
    await this.must(
      ctx,
      verifyExtractScript({ directory, asset: assetName(version) }),
      'Checking the download',
      {
        stdin: checksum,
        timeoutMs: 10 * 60_000
      }
    )
  }

  /** A small file on the machine, or `undefined` when it cannot be read. */
  private async readRemoteFile(ctx: RunContext, path: string): Promise<string | undefined> {
    try {
      const result = await ctx.remote.run(catFileScript(path), { timeoutMs: 30_000 })
      return result.code === 0 ? result.stdout : undefined
    } catch (error) {
      if (error instanceof NetError && error.code === 'cancelled') throw error
      return undefined
    }
  }

  private async waitForService(ctx: RunContext): Promise<void> {
    const deadline = Date.now() + (this.options.serviceWaitMs ?? 30_000)
    let started = false
    for (;;) {
      const status = await this.cliJson(ctx, 'service-status', ['service', 'status'])
      if (status?.running === true) return
      if (
        !started &&
        (status?.startup as { installed?: boolean } | undefined)?.installed === true
      ) {
        started = true
        await ctx.remote.run(startServiceScript(ctx.m.os === 'Darwin' ? 'launchd' : 'systemd'), {
          timeoutMs: 30_000
        })
      }
      if (Date.now() >= deadline)
        throw new Error('The Mousse service did not start within 30 seconds.')
      await sleep(this.options.pollMs ?? 1000)
      if (ctx.signal.aborted) throw new NetError('cancelled')
    }
  }

  /** Node ids come only from the consumed invitation row, cross-checked with the machine when it answers. */
  private async recoverNode(
    ctx: RunContext,
    outcome: { node: NodeId; name: string }
  ): Promise<void> {
    const status = await this.cliJson(ctx, 'net-status', ['net', 'status'])
    const self = (status?.self as { node?: string } | undefined)?.node
    if (self && self !== outcome.node)
      throw new Interrupted(
        'The invitation was used by a different device than the one this machine reports. Nothing was changed or revoked automatically; check Devices.'
      )
    ctx.m.node = outcome.node
    await ctx.save()
  }

  private steps(): StepDefinition[] {
    const launcher = (m: SshManifest) => launcherPath(m.home)
    return [
      {
        id: 'install',
        applies: (m) => m.cli.owner === 'managed',
        resource: launcher,
        prepare: async (ctx) => ({
          before: { launcherBefore: null, installDir: ctx.m.cli.installDir },
          scratch: await this.checksumLine(ctx.m.cli.version!, ctx.signal)
        }),
        reconcile: async (ctx) => {
          const result = await ctx.remote.run(
            reconcileInstallScript({
              launcher: launcher(ctx.m),
              manifestId: ctx.m.id,
              directory: ctx.m.cli.installDir!
            }),
            { timeoutMs: 30_000 }
          )
          return result.code === 0 && result.stdout.includes('ready')
        },
        run: async (ctx, scratch) => {
          const { m } = ctx
          const version = m.cli.version!,
            directory = m.cli.installDir!
          await this.installAsset(ctx, version, directory, String(scratch))
          ctx.state.progress = 'Writing the launcher'
          const text = launcherContent(m.id, directory)
          await this.must(ctx, writeLauncherScript(launcher(m)), 'Writing the launcher', {
            stdin: text
          })
          // Undo removes the launcher only while it still hashes to what was written here.
          m.cli.launcherSha = sha256(text)
          return {
            after: { launcher: launcher(m), installDir: directory, launcherSha: m.cli.launcherSha }
          }
        }
      },
      {
        id: 'service',
        applies: (m) => m.service.owner === 'managed',
        resource: (m) => m.service.unitPath ?? unitPath(m.home),
        prepare: async () => ({ before: { unitExistedBefore: false } }),
        reconcile: async (ctx) => {
          const status = await this.cliJson(ctx, 'service-status', ['service', 'status'])
          return (
            status?.running === true &&
            (status.startup as { installed?: boolean } | undefined)?.installed === true
          )
        },
        run: async (ctx) => {
          // `service install` enables and starts the unit; a following `service start` would fail.
          await this.must(
            ctx,
            cliScript('service-install', ctx.m.cli.path, ['service', 'install', '--headless']),
            'Installing the service'
          )
          await this.waitForService(ctx)
          // What `service install` wrote; Undo uninstalls the service only while the unit still matches.
          const unit = await this.readRemoteFile(
            ctx,
            ctx.m.service.unitPath ?? unitPath(ctx.m.home)
          )
          if (unit !== undefined) ctx.m.service.unitSha = sha256(unit)
          return { after: { unitPath: ctx.m.service.unitPath, unitSha: ctx.m.service.unitSha } }
        }
      },
      {
        id: 'linger',
        applies: (m) => m.service.owner === 'managed' && m.lingerBefore === 'no',
        resource: (m) => `linger:${m.resolved.user}`,
        prepare: async (ctx) => ({ before: { lingerBefore: ctx.m.lingerBefore } }),
        reconcile: async (ctx) => {
          const result = await ctx.remote.run(lingerShowScript(ctx.m.resolved.user), {
            timeoutMs: 30_000
          })
          return /Linger=yes/u.test(result.stdout)
        },
        run: async (ctx) => {
          const result = await ctx.remote.run(lingerEnableScript(ctx.m.resolved.user), {
            timeoutMs: 60_000
          })
          if (ctx.signal.aborted) throw new NetError('cancelled')
          if (result.code === 0) {
            ctx.m.lingerEnabled = true
            return { after: { linger: 'yes' } }
          }
          // Over SSH there is no seat session, so polkit may ask for an administrator. Not fatal.
          ctx.m.lingerSkipped = true
          await ctx.save()
          return { state: 'skipped', result: tail(result.stderr) || 'loginctl refused.' }
        }
      },
      {
        id: 'join',
        applies: () => true,
        resource: (m) => `invite:${m.name}`,
        reconcile: async (ctx) => {
          const { m } = ctx
          // Every invitation this record issued, not just the latest: an older one can be the one used.
          for (const invite of issuedInvites(m)) {
            const outcome = this.host.inviteOutcome(invite)
            if (outcome.state === 'consumed') {
              await this.recoverNode(ctx, outcome)
              return true
            }
            // Not redeemed: the join did not happen. The next run issues a fresh invitation.
            if (outcome.state === 'active') this.host.revokeInvite(invite)
          }
          return false
        },
        run: async (ctx, _scratch, record) => {
          const { m } = ctx
          const issued = await this.host.inviteNode(m.name)
          // The invitation id is on disk before its text leaves this computer.
          m.inviteIds = [...issuedInvites(m), issued.inviteId]
          m.inviteId = issued.inviteId
          record.before = { inviteId: issued.inviteId }
          await ctx.save()
          let result
          for (let attempt = 0; ; attempt++) {
            const remotePort = randomInt(40000, 60001)
            const listener = await this.host.openEnrollmentListener()
            try {
              ctx.state.progress = 'Joining through a temporary tunnel'
              result = await ctx.remote.run(
                joinScript({
                  cli: m.cli.path,
                  name: m.name,
                  via: `ws://127.0.0.1:${remotePort}/mousse-net`
                }),
                {
                  stdin: issued.invite,
                  timeoutMs: 120_000,
                  reverse: { remotePort, localPort: listener.port }
                }
              )
            } finally {
              await listener.close()
            }
            if (ctx.signal.aborted) throw new NetError('cancelled')
            if (
              result.code !== 0 &&
              attempt === 0 &&
              /remote port forwarding failed/iu.test(result.stderr)
            )
              continue
            break
          }
          // The machine's command has returned, and nothing about the admission is recorded yet.
          this.crash('join.afterRemote')
          // The node id comes from this computer's own invitation row, written atomically with the
          // admission, never from what the machine prints (it could name any device). Its output is
          // only a cross-check, and a mismatch stops the setup. A lost reply is handled the same way.
          const reported = result.code === 0 ? lastJson(result.stdout)?.node : undefined
          const outcome = this.host.inviteOutcome(issued.inviteId)
          if (outcome.state === 'consumed') {
            if (reported !== undefined && reported !== outcome.node)
              throw new Interrupted(
                'The machine reported a different device than the one this invitation admitted. Nothing was approved or revoked automatically; check Devices.'
              )
            await this.recoverNode(ctx, outcome)
            return {
              after: { node: m.node },
              result:
                result.code === 0
                  ? 'Joined.'
                  : 'Joined; the reply was lost and the node was recovered.'
            }
          }
          // An unused invitation is revoked either way, so nothing can redeem it later.
          if (outcome.state === 'active') this.host.revokeInvite(issued.inviteId)
          if (reported !== undefined)
            throw new Interrupted(
              'The machine says it joined, but this computer did not see the invitation used. Nothing was approved; check Devices.'
            )
          if (result.missing) throw new Error(MISSING_SSH)
          if (/sshd refused|remote port forwarding failed/iu.test(result.stderr))
            throw new Error(
              'sshd refused the reverse forward; check AllowTcpForwarding on the machine.'
            )
          throw new Error(`Joining failed: ${tail(result.stderr) || `exit ${result.code}`}`)
        }
      },
      {
        id: 'addon',
        applies: () => true,
        resource: () => 'transport:ssh',
        prepare: async (ctx) => {
          const row = await this.sshRow(ctx)
          // A failed or unreadable listing is not "no add-on": writing over an unknown state could
          // not be undone, so nothing is changed.
          if (row === undefined)
            throw new Error(
              'Could not read the SSH settings the machine already has, so nothing was changed. Try again.'
            )
          ctx.m.transportBefore = row
          return { before: { transportBefore: ctx.m.transportBefore } }
        },
        reconcile: async (ctx) => {
          const row = await this.sshRow(ctx)
          return !!row && sameSettings(row.settings, this.settings(ctx.m)) && row.enabled
        },
        run: async (ctx) => {
          await this.must(
            ctx,
            configureAddonScript({ cli: ctx.m.cli.path }),
            'Turning on SSH access',
            {
              stdin: JSON.stringify(this.settings(ctx.m))
            }
          )
          return { after: { settings: this.settings(ctx.m) } }
        }
      },
      {
        id: 'approval',
        applies: () => true,
        resource: (m) => `approval:${m.node ?? ''}`,
        run: async (ctx) => {
          const { m } = ctx
          if (!m.node) throw new Error('The machine did not report a device id.')
          // Written here and only here: a machine cannot approve itself.
          await this.approvals.set(m.node, {
            endpoint: m.endpoint,
            fingerprint: m.hostKey.fingerprint,
            approvedAt: Date.now(),
            hostname: m.hostKey.hostname
          })
          this.crash('approval.afterApproval')
          ctx.state.progress = 'Reading the machine’s routes'
          const deadline = Date.now() + (this.options.routesWaitMs ?? 30_000)
          for (;;) {
            const routes = await this.cliJson(ctx, 'routes', ['net', 'routes'])
            const list = routes?.routes as
              Array<{ transport?: string; address?: string }> | undefined
            if (routes?.signed && list?.some((route) => route.transport === 'ssh')) {
              this.host.adoptRoutes(routes.signed as Signed, m.node)
              break
            }
            if (Date.now() >= deadline)
              throw new Error(
                'The machine has not advertised its SSH route yet. Retry in a moment.'
              )
            await sleep(this.options.pollMs ?? 1000)
            if (ctx.signal.aborted) throw new NetError('cancelled')
          }
          ctx.state.progress = 'Opening the first connection'
          const openDeadline = Date.now() + (this.options.openWaitMs ?? 30_000)
          while (!this.host.peerOpen(m.node)) {
            if (Date.now() >= openDeadline)
              throw new Error(
                `Mousse could not open a connection to ${m.name} over SSH within 30 seconds. Check the connection under Devices.`
              )
            await sleep(this.options.pollMs ?? 1000)
            if (ctx.signal.aborted) throw new NetError('cancelled')
          }
          return { after: { node: m.node } }
        }
      }
    ]
  }

  private settings(m: SshManifest): { endpoint: string; port: number } {
    return { endpoint: m.endpoint, port: m.daemonPort }
  }

  // ---------------------------------------------------------------- undo

  /**
   * Reverses the journaled steps in reverse order, each only while its resource is still Mousse's
   * and unchanged since setup, including `pending` steps whose host state shows the change was made.
   * The launcher and the service unit are compared with what setup wrote (hashes recorded when it
   * wrote them); anything the user changed is reported and left alone. Every invitation the record
   * issued is resolved from this computer's own rows, so a device admitted by a join whose reply or
   * record was lost is still revoked. The machine's data directory and device identity are never
   * deleted; the result lists the commands to remove them.
   */
  async undo(id: string): Promise<SshUndoResult> {
    if (!this.reserve()) throw new NetError('conflict')
    try {
      const m = await this.manifests.read(id)
      if (!m) throw new NetError('bad_request')
      return await this.undoLocked(m)
    } finally {
      this.busy = false
    }
  }

  /** The directory is this record's own install, under the install root and nowhere else. */
  private ownedInstall(m: SshManifest, directory: string | undefined): string | undefined {
    if (!directory || directory.includes('..')) return undefined
    const pattern = new RegExp(
      `^${m.home.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}/${INSTALL_RELATIVE.replace(/\./g, '\\.')}/[0-9A-Za-z.+-]+$`,
      'u'
    )
    return pattern.test(directory) ? directory : undefined
  }

  /** Is the launcher still what this record wrote? `unknown` when the machine did not answer. */
  private async launcherState(ctx: RunContext): Promise<'ours' | 'changed' | 'absent' | 'unknown'> {
    const { m } = ctx
    const text = await this.readRemoteFile(ctx, launcherPath(m.home))
    if (text === undefined) return 'unknown'
    if (text.trim() === '') return 'absent'
    const accepted = new Set<string>()
    if (m.cli.launcherSha) accepted.add(m.cli.launcherSha)
    for (const directory of [m.cli.installDir, m.cli.updateTarget])
      if (directory) accepted.add(sha256(launcherContent(m.id, directory)))
    return accepted.has(sha256(text)) ? 'ours' : 'changed'
  }

  private async unitState(ctx: RunContext): Promise<'ours' | 'changed' | 'absent' | 'unknown'> {
    const { m } = ctx
    const text = await this.readRemoteFile(ctx, m.service.unitPath ?? unitPath(m.home))
    if (text === undefined) return 'unknown'
    if (text.trim() === '') return 'absent'
    if (m.service.unitSha) return sha256(text) === m.service.unitSha ? 'ours' : 'changed'
    // A crash before the hash was recorded: the unit must at least run this record's binary.
    const ours = [m.cli.installDir, m.cli.updateTarget].some(
      (directory) =>
        !!directory && text.includes(`ExecStart=${directory}/squashfs-root/mousse-cli service run`)
    )
    return ours ? 'ours' : 'changed'
  }

  /**
   * Resolves every invitation this record issued. An unused one is revoked (and read again, since
   * the join may finish in between); a used one names the exact device it admitted, which is revoked
   * unless the machine reports a different identity.
   */
  private async undoJoin(
    ctx: RunContext,
    step: string,
    report: SshUndoResult['report'],
    commands: string[]
  ): Promise<void> {
    const { m } = ctx
    const admitted = new Set<NodeId>(m.node ? [m.node] : [])
    let unresolved = false,
      revokedInvite = false
    for (const invite of issuedInvites(m)) {
      let outcome = this.host.inviteOutcome(invite)
      if (outcome.state === 'active') {
        this.host.revokeInvite(invite)
        revokedInvite = true
        outcome = this.host.inviteOutcome(invite)
      }
      if (outcome.state === 'consumed') admitted.add(outcome.node)
      else if (outcome.state === 'missing') unresolved = true
    }
    if (admitted.size) {
      const status = await this.cliJson(ctx, 'net-status', ['net', 'status'])
      const self = (status?.self as { node?: string } | undefined)?.node
      for (const node of admitted) {
        if (self && self !== node && node !== m.node) {
          report.push({
            step,
            result: 'left',
            detail: `The invitation admitted device ${node}, but the machine reports ${self}. Nothing was revoked automatically.`
          })
          commands.push(
            `mousse-cli bridge revoke ${node}   # on this computer, if ${node} is the machine`
          )
          continue
        }
        await this.host.revokeNode(node)
        report.push({ step, result: 'undone', detail: `The device ${node} was revoked.` })
      }
    } else if (unresolved) {
      report.push({
        step,
        result: 'left',
        detail:
          'An invitation this setup issued can no longer be looked up, so a device it admitted cannot be ruled out. Check Devices.'
      })
    } else if (revokedInvite) {
      report.push({ step, result: 'undone', detail: 'The unused invitation was revoked.' })
    } else report.push({ step, result: 'skipped', detail: 'The invitation was never used.' })
  }

  private async undoLocked(m: SshManifest): Promise<SshUndoResult> {
    const controller = new AbortController()
    const ctx: RunContext = {
      m,
      remote: this.remote(m.endpoint, controller.signal),
      signal: controller.signal,
      state: { controller },
      save: () => this.manifests.write(m)
    }
    const report: SshUndoResult['report'] = []
    const commands: string[] = []
    const left = (step: string, detail: string, command?: string) => {
      report.push({ step, result: 'left', detail })
      if (command) commands.push(command)
    }
    const done = (step: string, detail: string) => report.push({ step, result: 'undone', detail })
    const skipped = (step: string, detail: string) =>
      report.push({ step, result: 'skipped', detail })
    const cli = m.cli.path
    const path = launcherPath(m.home)
    // Compared once, before anything is removed: the service goes only if the launcher is unchanged too.
    let launcher: Awaited<ReturnType<SshBootstrap['launcherState']>> | undefined
    const launcherNow = async () => (launcher ??= await this.launcherState(ctx))
    for (const record of [...m.steps].reverse()) {
      const step = STEP_TITLES[record.step] ?? record.step
      try {
        switch (record.step) {
          case 'approval': {
            const rows = await this.approvals.read()
            const row = m.node ? rows[m.node] : undefined
            if (!m.node || !row) skipped(step, 'No approval was saved.')
            else if (row.endpoint !== m.endpoint)
              left(step, 'The approval was changed since setup.')
            else {
              await this.approvals.remove(m.node)
              done(step, 'The SSH approval for this machine was removed.')
            }
            break
          }
          case 'addon': {
            const row = await this.sshRow(ctx)
            if (row === undefined) throw new Error('The machine did not answer.')
            if (!row || !sameSettings(row.settings, this.settings(m))) {
              if (!row) skipped(step, 'SSH access was not turned on.')
              else left(step, 'The SSH settings on the machine were changed since setup.')
              break
            }
            const before = m.transportBefore
            await this.must(
              ctx,
              configureAddonScript({ cli, disable: before ? !before.enabled : true }),
              'Restoring SSH access',
              { stdin: JSON.stringify(before ? before.settings : this.settings(m)) }
            )
            done(
              step,
              before
                ? 'The previous SSH settings were restored.'
                : 'SSH access on the machine was turned off.'
            )
            break
          }
          case 'join':
            await this.undoJoin(ctx, step, report, commands)
            break
          case 'linger': {
            // Only a journaled off-to-on change made by this setup is turned off again.
            if (!m.lingerEnabled || m.lingerBefore !== 'no') {
              skipped(step, 'Lingering was not changed by this setup.')
              break
            }
            const shown = await ctx.remote.run(lingerShowScript(m.resolved.user), {
              timeoutMs: 30_000
            })
            if (!/Linger=yes/u.test(shown.stdout)) {
              skipped(step, 'Lingering is already off.')
              break
            }
            await this.must(ctx, lingerDisableScript(m.resolved.user), 'Turning lingering off')
            done(step, 'Lingering was turned off again.')
            break
          }
          case 'service': {
            if (m.service.owner !== 'managed') {
              skipped(step, 'Mousse did not install this service, so it is left alone.')
              break
            }
            const unit = await this.unitState(ctx)
            if (unit === 'unknown') throw new Error('The machine did not answer.')
            if (unit === 'absent') {
              skipped(step, 'The service is no longer installed.')
              break
            }
            const wrapper = await launcherNow()
            if (unit === 'changed' || wrapper === 'changed' || wrapper === 'unknown') {
              left(
                step,
                unit === 'changed'
                  ? 'The service unit was changed since setup, so it is left alone.'
                  : 'The launcher was changed since setup, so the service is left alone.',
                'mousse-cli service uninstall'
              )
              break
            }
            await this.must(
              ctx,
              cliScript('service-uninstall', cli, ['service', 'uninstall', '--json']),
              'Removing the service'
            )
            done(step, 'The service was removed.')
            break
          }
          case 'install': {
            if (m.cli.owner !== 'managed' || !m.cli.installDir) {
              skipped(step, 'Mousse did not install this program, so it is left alone.')
              break
            }
            const directories = [m.cli.installDir, m.cli.updateTarget].filter(
              (directory): directory is string => !!directory
            )
            if (directories.some((directory) => !this.ownedInstall(m, directory))) {
              left(
                step,
                'The install directory in the record looks wrong, so it is left alone.',
                `rm -rf ${directories.join(' ')}`
              )
              break
            }
            const manual = `rm -f ${path} && rm -rf ${directories.join(' ')}`
            const wrapper = await launcherNow()
            if (wrapper === 'unknown') throw new Error('The machine did not answer.')
            if (wrapper === 'changed') {
              left(
                step,
                'The launcher was changed since setup, so it and the install directory are left alone.',
                manual
              )
              break
            }
            if (wrapper === 'ours') {
              const removed = await ctx.remote.run(removeLauncherScript(path, m.id), {
                timeoutMs: 30_000
              })
              if (removed.code === 3) {
                left(step, 'The launcher was changed since setup, so it is left alone.', manual)
                break
              }
              if (removed.code !== 0)
                throw new Error(tail(removed.stderr) || 'The machine did not answer.')
              if (m.cli.launcherBefore)
                await this.must(ctx, writeLauncherScript(path), 'Restoring the previous launcher', {
                  stdin: m.cli.launcherBefore
                })
            }
            for (const directory of directories)
              await this.must(ctx, removeInstallScript(directory), 'Removing the install directory')
            done(step, 'The launcher and the install directory were removed.')
            break
          }
          default:
            skipped(step, 'Nothing to undo.')
        }
      } catch (error) {
        if (error instanceof NetError && error.code === 'cancelled') throw error
        const detail = `Could not undo: ${messageOf(error)}`
        if (record.step === 'service') left(step, detail, 'mousse-cli service uninstall')
        else if (record.step === 'addon')
          left(
            step,
            detail,
            'mousse-cli net transport configure ssh --disable --settings-file <file>'
          )
        else if (record.step === 'install' && m.cli.installDir)
          left(step, detail, `rm -f ${path} && rm -rf ${m.cli.installDir}`)
        else left(step, detail)
      }
    }
    commands.push(
      'rm -rf ~/.mousse   # the machine’s Mousse data and device identity; Mousse never deletes these'
    )
    const ok = report.every((item) => item.result !== 'left')
    if (ok) {
      await this.dropKnownHost(m)
      await this.manifests.remove(m.id)
    }
    return { ok, report, commands }
  }

  /** The line is shared: remove it only when no other record or approval uses that host name. */
  private async dropKnownHost(m: SshManifest): Promise<void> {
    const others = (await this.manifests.list()).filter((other) => other.id !== m.id)
    if (others.some((other) => other.hostKey.hostname === m.hostKey.hostname)) return
    const approvals = await this.approvals.read()
    if (
      Object.entries(approvals).some(
        ([node, row]) => node !== m.node && row.hostname === m.hostKey.hostname
      )
    )
      return
    await this.serialized(() =>
      removeTrustedName(sshKnownHostsPath(this.host.profileDir), m.hostKey.hostname)
    )
  }

  // ---------------------------------------------------------------- update

  /**
   * Updates a machine Mousse installed, in this order and with no `service stop`: install the new
   * version beside the old one, rewrite the launcher, re-run `service install --headless` so the
   * unit follows it, restart, then wait for the new version to answer. On failure the launcher and
   * the unit go back to the previous install, which is kept until the new one is verified. The
   * target directory is journaled before the launcher switches, so a crash cannot strand it. A
   * machine Mousse did not install gets the command to run instead.
   */
  async update(id: string): Promise<SshUpdateResult> {
    if (!this.reserve()) throw new NetError('conflict')
    try {
      return await this.updateReserved(id)
    } finally {
      this.busy = false
    }
  }

  private async updateReserved(id: string): Promise<SshUpdateResult> {
    const m = await this.manifests.read(id)
    if (!m) throw new NetError('bad_request')
    const version = this.version()
    if (m.cli.owner !== 'managed' || !m.cli.installDir)
      return {
        ok: false,
        version,
        command: `curl -fL -o ${assetName(version)} ${assetUrl(version)}`,
        detail:
          'Mousse did not install this machine, so it is not updated from here. Update it on the machine.'
      }
    if (!VERSION.test(version) || version === '0.0.0')
      return {
        ok: false,
        detail: 'A development build cannot install a release on another machine.'
      }
    if (m.cli.version === version) return { ok: true, version, detail: 'Already up to date.' }
    const controller = new AbortController()
    const ctx: RunContext = {
      m,
      remote: this.remote(m.endpoint, controller.signal),
      signal: controller.signal,
      state: { controller },
      save: () => this.manifests.write(m)
    }
    const previous = { dir: m.cli.installDir, version: m.cli.version }
    const next = installDirectory(m.home, version)
    const path = launcherPath(m.home)
    const switchTo = async (directory: string) => {
      const text = launcherContent(m.id, directory)
      await this.must(ctx, writeLauncherScript(path), 'Writing the launcher', { stdin: text })
      m.cli.launcherSha = sha256(text)
      await this.must(
        ctx,
        cliScript('service-install', path, ['service', 'install', '--headless']),
        'Updating the service'
      )
      const unit = await this.readRemoteFile(ctx, m.service.unitPath ?? unitPath(m.home))
      if (unit !== undefined) m.service.unitSha = sha256(unit)
      await this.must(ctx, restartServiceScript(), 'Restarting the service')
    }
    const waitFor = async (expected: string) => {
      const deadline = Date.now() + (this.options.serviceWaitMs ?? 60_000)
      for (;;) {
        const status = await this.cliJson(ctx, 'service-status', ['service', 'status'], path)
        if (status?.running === true && status.version === expected) return
        if (Date.now() >= deadline)
          throw new Error(`The service did not report version ${expected}.`)
        await sleep(this.options.pollMs ?? 1000)
      }
    }
    try {
      const checksum = await this.checksumLine(version, ctx.signal)
      // Journaled before anything is written there, so Undo finds the directory after a crash.
      m.cli.updateTarget = next
      await ctx.save()
      await this.installAsset(ctx, version, next, checksum)
      try {
        await switchTo(next)
        await waitFor(version)
      } catch (error) {
        // Back to the previous install, which is still on disk.
        await switchTo(previous.dir).catch(() => undefined)
        const removed = await ctx.remote
          .run(removeInstallScript(next), { timeoutMs: 60_000 })
          .catch(() => undefined)
        if (removed?.code === 0) {
          delete m.cli.updateTarget
          await ctx.save()
        }
        throw error
      }
      m.cli.installDir = next
      m.cli.version = version
      delete m.cli.updateTarget
      await ctx.save()
      // Keep the new and the previous install; remove older ones.
      const listing = await ctx.remote.run(listInstallsScript(`${m.home}/${INSTALL_RELATIVE}`), {
        timeoutMs: 30_000
      })
      for (const name of listing.stdout.split('\n').map((line) => line.trim())) {
        const directory = `${m.home}/${INSTALL_RELATIVE}/${name}`
        if (!/^[0-9A-Za-z.+-]+$/u.test(name) || directory === next || directory === previous.dir)
          continue
        await ctx.remote.run(removeInstallScript(directory), { timeoutMs: 60_000 })
      }
      return { ok: true, version }
    } catch (error) {
      return {
        ok: false,
        version,
        detail: `The update failed and the previous version was restored: ${messageOf(error)}`
      }
    }
  }

  // ---------------------------------------------------------------- rename / approve

  /** The alias or host changed: update the record, the approval and the machine's own add-on settings. */
  async rename(id: string, endpoint: string): Promise<{ ok: boolean; detail?: string }> {
    if (!this.reserve()) throw new NetError('conflict')
    try {
      return await this.renameReserved(id, endpoint)
    } finally {
      this.busy = false
    }
  }

  private async renameReserved(
    id: string,
    endpoint: string
  ): Promise<{ ok: boolean; detail?: string }> {
    const m = await this.manifests.read(id)
    if (!m || !m.node) throw new NetError('bad_request')
    if (!parseSshEndpoint(endpoint))
      return { ok: false, detail: 'Enter the endpoint as [user@]host[:port].' }
    const entry = this.keys.get(endpoint)
    if (!entry || Date.now() - entry.at > KEY_TTL_MS)
      return { ok: false, detail: 'Check the new endpoint and confirm its host key first.' }
    if (entry.fingerprint !== m.hostKey.fingerprint)
      return {
        ok: false,
        detail:
          'The new endpoint offers a different host key than the machine this record belongs to.'
      }
    const judgement = await judgeHostKey(entry.offered, this.files(entry.resolved))
    if (judgement.state !== 'trusted')
      return { ok: false, detail: 'Confirm the host key of the new endpoint first.' }
    await this.ensureLine(endpoint)
    try {
      const controller = new AbortController()
      const ctx: RunContext = {
        m,
        remote: this.remote(endpoint, controller.signal),
        signal: controller.signal,
        state: { controller },
        save: () => this.manifests.write(m)
      }
      await this.must(ctx, configureAddonScript({ cli: m.cli.path }), 'Updating SSH access', {
        stdin: JSON.stringify({ endpoint, port: m.daemonPort })
      })
      await this.approvals.set(m.node, {
        endpoint,
        fingerprint: m.hostKey.fingerprint,
        approvedAt: Date.now(),
        hostname: entry.offered.name
      })
      m.endpoint = endpoint
      m.hostKey.hostname = entry.offered.name
      await ctx.save()
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: messageOf(error) }
    }
  }

  /**
   * A device that advertises an ssh route this computer did not set up: the same two phases, and
   * the approval is written only after the host key is trusted, a login works and the machine
   * reports the device it is being approved for.
   */
  async approve(node: NodeId, endpoint: string): Promise<SshCheckResult & { approved: boolean }> {
    if (!this.host.knownNode(node)) throw new NetError('bad_request')
    const check = await this.check(endpoint)
    const forwarding = check.prerequisites.find((item) => item.name === PREREQUISITE.forwarding)
    if (
      check.phase !== 'probed' ||
      check.auth !== 'ok' ||
      !check.hostKey ||
      (forwarding && !forwarding.ok && !forwarding.indeterminate)
    )
      return { ...check, approved: false }
    // A running Mousse on the machine names its device; a different one is not the device asked for.
    if (check.hostNode && check.hostNode !== node)
      return {
        ...check,
        approved: false,
        detail: `${endpoint} reached a machine that reports a different device than the one you are approving. Nothing was saved.`
      }
    const entry = await this.ensureLine(endpoint)
    await this.approvals.set(node, {
      endpoint,
      fingerprint: check.hostKey.fingerprint,
      approvedAt: Date.now(),
      hostname: entry.offered.name
    })
    return { ...check, approved: true }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
/** The latest invitation plus every earlier one the journal kept. */
function issuedInvites(m: SshManifest): InviteId[] {
  return [...new Set([...(m.inviteIds ?? []), ...(m.inviteId ? [m.inviteId] : [])])]
}

function sameSettings(left: unknown, right: { endpoint: string; port: number }): boolean {
  const value = left as { endpoint?: unknown; port?: unknown } | undefined
  return !!value && value.endpoint === right.endpoint && value.port === right.port
}
