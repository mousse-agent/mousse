import { NetError } from '../../../shared/net/errors'
import { parseSshEndpoint, sshPolicyOptions, type SshEndpoint } from '../transports/ssh'
import { remoteCommand } from './shellQuote'
import { runProcess, type RunResult } from './runner'

/** What `ssh -G` resolved for a host, re-validated because it comes from the user's config files. */
export interface ResolvedSsh {
  hostname: string
  port: number
  user: string
  globalKnownHosts: string[]
}

export interface SshContext {
  /** The `ssh` executable. */
  binary: string
  /** Mousse's own known_hosts file. */
  knownHosts: string
  userKnownHosts: string
}

const CONFIG_TIMEOUT_MS = 8_000
const HOSTNAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|[0-9A-Fa-f:.]+)$/u
const RESOLVED_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u

/** The refusal shown for a host whose resolved configuration needs a proxy hop. */
export class SshRefusal extends Error {
  constructor(
    readonly kind: 'proxy_refused' | 'invalid_host' | 'unreachable' | 'missing',
    message: string
  ) {
    super(message)
  }
}

export function parseSshConfiguration(text: string): Map<string, string[]> {
  const values = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const [key = '', ...rest] = line.trim().split(/\s+/u)
    if (!key) continue
    const lower = key.toLowerCase()
    values.set(lower, [...(values.get(lower) ?? []), rest.join(' ')])
  }
  return values
}

/** The same wording as the dial path: Mousse cannot hold a jump host to its host key policy yet. */
export function proxyRefusal(config: Map<string, string[]>, name: string): string | undefined {
  for (const [key, label] of [
    ['proxyjump', 'ProxyJump'],
    ['proxycommand', 'ProxyCommand']
  ] as const) {
    const value = (config.get(key) ?? []).join(' ').trim().toLowerCase()
    if (value && value !== 'none')
      return `The ssh configuration for ${name} uses ${label}, which Mousse cannot run under its host key and password policy yet. Reach the host without a jump host or proxy command.`
  }
  return undefined
}

/** Arguments that name the target the way the dial does: `-l`, `-p`, then `-- host`. */
export function targetArguments(endpoint: SshEndpoint): string[] {
  return [
    ...(endpoint.user ? ['-l', endpoint.user] : []),
    ...(endpoint.port !== undefined ? ['-p', String(endpoint.port)] : []),
    '--',
    endpoint.host
  ]
}

/**
 * Resolves a host through the user's own ssh configuration without connecting (`ssh -G`), so an
 * alias with its own HostName, Port or User works, and refuses a ProxyJump or ProxyCommand. Every
 * connecting spawn is preceded by this, with the argv it is about to use.
 */
export async function resolveSsh(
  context: SshContext,
  argv: string[],
  name: string,
  signal?: AbortSignal
): Promise<ResolvedSsh> {
  const result = await runProcess(context.binary, ['-G', ...argv], {
    timeoutMs: CONFIG_TIMEOUT_MS,
    maxBytes: 64 * 1024,
    signal
  })
  if (result.missing)
    throw new SshRefusal(
      'missing',
      'The ssh command was not found. Install OpenSSH to add this machine.'
    )
  if (result.timedOut)
    throw new SshRefusal('unreachable', `ssh took too long to read its configuration for ${name}.`)
  if (result.code !== 0)
    throw new SshRefusal(
      'invalid_host',
      `ssh could not read its configuration for ${name}: ${result.stderr.trim().split('\n').pop() ?? 'unknown error'}`
    )
  const config = parseSshConfiguration(result.stdout)
  const refusal = proxyRefusal(config, name)
  if (refusal) throw new SshRefusal('proxy_refused', refusal)
  const hostname = config.get('hostname')?.[0] ?? '',
    port = Number(config.get('port')?.[0]),
    user = config.get('user')?.[0] ?? ''
  if (!HOSTNAME.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new SshRefusal('invalid_host', `ssh resolved ${name} to an address Mousse cannot use.`)
  if (!RESOLVED_USER.test(user))
    throw new SshRefusal('invalid_host', `ssh resolved ${name} to a user name Mousse cannot use.`)
  const globalKnownHosts = (config.get('globalknownhostsfile')?.[0] ?? '')
    .split(/\s+/u)
    .map((path) => path.replace(/^"|"$/gu, ''))
    .filter(Boolean)
  return { hostname, port, user, globalKnownHosts }
}

export interface RunRemoteOptions {
  stdin?: string | Buffer | import('node:stream').Readable
  timeoutMs: number
  /** A reverse forward for the join. Without it every forward is cleared. */
  reverse?: { remotePort: number; localPort: number }
}

/** One machine reached over SSH, with the policy of PR 1's dial and `ssh -G` before the first spawn. */
export class RemoteHost {
  readonly endpoint: SshEndpoint
  private checked?: Promise<ResolvedSsh>
  constructor(
    private readonly context: SshContext,
    readonly endpointText: string,
    private readonly signal?: AbortSignal
  ) {
    const parsed = parseSshEndpoint(endpointText)
    if (!parsed) throw new NetError('bad_request', 'Invalid SSH endpoint.')
    this.endpoint = parsed
  }
  /** The argv of a remote command: policy options, `-T`, the target after `--`, then the command. */
  arguments(script: string, reverse?: RunRemoteOptions['reverse']): string[] {
    return [
      ...sshPolicyOptions({
        knownHosts: this.context.knownHosts,
        userKnownHosts: this.context.userKnownHosts,
        clearForwardings: !reverse
      }),
      ...(reverse
        ? [
            '-o',
            'ExitOnForwardFailure=yes',
            '-R',
            `127.0.0.1:${reverse.remotePort}:127.0.0.1:${reverse.localPort}`
          ]
        : []),
      '-T',
      ...targetArguments(this.endpoint),
      remoteCommand(script)
    ]
  }
  resolve(): Promise<ResolvedSsh> {
    // The configuration does not change under a run; one `-G` (which runs `Match exec`) is enough.
    return (this.checked ??= resolveSsh(
      this.context,
      [
        ...sshPolicyOptions({
          knownHosts: this.context.knownHosts,
          userKnownHosts: this.context.userKnownHosts,
          clearForwardings: true
        }),
        '-T',
        ...targetArguments(this.endpoint)
      ],
      this.endpointText,
      this.signal
    ))
  }
  async run(script: string, options: RunRemoteOptions): Promise<RunResult> {
    await this.resolve()
    return runProcess(this.context.binary, this.arguments(script, options.reverse), {
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      signal: this.signal
    })
  }
}
