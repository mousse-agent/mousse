import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { cloudflaredEnv } from './runtime'

const LOGIN_URL = 'https://dash.cloudflare.com/argotunnel'
const TRANSFER_URL = 'https://login.cloudflareaccess.org/'
const LOGIN_MS = 5 * 60_000
const ADMIN_MS = 30_000
const MAX_OUTPUT = 128 * 1024
const ACCOUNT_OR_ZONE = /^[0-9a-f]{32}$/i
export const CLOUDFLARE_TUNNEL_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function cloudflareHostname(value: string): boolean {
  const labels = value.split('.')
  return value.length <= 253 && labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label))
}

export type CloudflareAccount = { accountId: string; zoneId: string }

function isolatedEnv(scratch: string): NodeJS.ProcessEnv {
  const env = { ...cloudflaredEnv(), HOME: scratch, USERPROFILE: scratch }
  if (process.platform !== 'win32') return env
  const drive = parse(scratch).root
  return { ...env, HOMEDRIVE: drive.slice(0, -1), HOMEPATH: `\\${scratch.slice(drive.length)}` }
}

function loginUrl(text: string): string | undefined {
  try {
    const url = new URL(text.trim())
    if (url.origin === 'https://dash.cloudflare.com' && url.pathname === '/argotunnel' &&
        !url.username && !url.password && !url.hash) return url.href
  } catch { /* cloudflared also prints instructions */ }
  return undefined
}

export function cloudflareEdge(text: string): { index: number; connected: boolean } | undefined {
  try {
    const { message, connIndex } = JSON.parse(text) as { message?: unknown; connIndex?: unknown }
    if (typeof message !== 'string' || typeof connIndex !== 'number' ||
        !Number.isInteger(connIndex) || connIndex < 0 || connIndex > 255) return undefined
    if (message === 'Registered tunnel connection') return { index: connIndex, connected: true }
    if (message === 'Connection terminated' || message.startsWith('Retrying connection in up to '))
      return { index: connIndex, connected: false }
  } catch { /* Unrelated output is not an edge event. */ }
  return undefined
}

type CommandOutput = { stdout: string; stderr: string }

export class CloudflareCli {
  private readonly config: string
  private readonly certificate: string

  constructor(
    private readonly binary: string,
    private readonly scratch: string
  ) {
    this.config = join(scratch, 'config.yml')
    this.certificate = join(scratch, '.cloudflared', 'cert.pem')
  }

  private command(
    args: string[],
    signal: AbortSignal,
    options: { loginLine?: (url: string) => void; secret?: string } = {}
  ): Promise<CommandOutput> {
    return new Promise((resolve, reject) => {
      const env = isolatedEnv(this.scratch)
      // Let the Mousse window open the validated URL in the user's browser profile.
      if (options.loginLine) {
        for (const key of Object.keys(env)) {
          if (key.toUpperCase() === 'PATH') delete env[key]
        }
        env.PATH = ''
      }
      if (options.secret) env.TUNNEL_CREATE_SECRET = options.secret
      const child = execFile(this.binary, [
        'tunnel', '--config', this.config, '--no-autoupdate', '--output', 'json',
        '--origincert', this.certificate, ...args
      ], {
        cwd: this.scratch,
        env,
        windowsHide: true,
        signal,
        timeout: options.loginLine ? LOGIN_MS : ADMIN_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT
      }, (error, stdout, stderr) => {
        void exited.then(() => {
          if (error) reject(new Error('Cloudflare did not finish the request. Try again.'))
          else resolve({ stdout, stderr })
        })
      })
      const exited = new Promise<void>((done) => child.once('close', () => done()))
      if (options.loginLine && child.stderr) {
        const lines = createInterface({ input: child.stderr })
        lines.on('line', (line) => {
          const url = loginUrl(line)
          if (url && !signal.aborted) options.loginLine?.(url)
        })
      }
    })
  }

  async login(signal: AbortSignal, onUrl: (url: string) => void): Promise<CloudflareAccount> {
    await writeFile(this.config, '{}\n', { mode: 0o600, flag: 'wx' })
    await this.command(['login', '--loginURL', LOGIN_URL, '--callbackURL', TRANSFER_URL], signal, {
      loginLine: onUrl
    })
    const info = await stat(this.certificate).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_OUTPUT)
      throw new Error('Cloudflare did not return a sign-in certificate. Try signing in again.')
    const pem = await readFile(this.certificate, 'utf8')
    const encoded = /^-----BEGIN ARGO TUNNEL TOKEN-----\s+([\w+/=\s]+?)\s+-----END ARGO TUNNEL TOKEN-----$/m.exec(pem)?.[1]
    if (!encoded) throw new Error('Cloudflare returned an unreadable sign-in certificate.')
    try {
      const { accountID, zoneID, apiToken } = JSON.parse(Buffer.from(encoded, 'base64').toString()) as Record<string, unknown>
      if (typeof accountID === 'string' && ACCOUNT_OR_ZONE.test(accountID) &&
          typeof zoneID === 'string' && ACCOUNT_OR_ZONE.test(zoneID) && typeof apiToken === 'string' && apiToken)
        return { accountId: accountID.toLowerCase(), zoneId: zoneID.toLowerCase() }
    } catch { /* The certificate contains a credential, so never return parser details. */ }
    throw new Error('Cloudflare did not authorize a domain. Choose a domain and sign in again.')
  }

  private async find(name: string, signal: AbortSignal): Promise<string | undefined> {
    const { stdout } = await this.command(['list', '--name', name, '--output', 'json'], signal)
    let results: unknown
    try { results = JSON.parse(stdout) } catch { /* Report a fixed message below. */ }
    // cloudflared serializes its nil slice as null when no tunnels match.
    if (results === null) return undefined
    if (!Array.isArray(results)) throw new Error('Cloudflare returned an unreadable tunnel list.')
    const matching = results.filter((row) => row?.name === name)
    if (!matching.length) return undefined
    if (matching.length === 1 && typeof matching[0].id === 'string' && CLOUDFLARE_TUNNEL_ID.test(matching[0].id))
      return matching[0].id
    throw new Error('Cloudflare returned more than one matching tunnel.')
  }

  async createOrRecover(name: string, secret: string, signal: AbortSignal): Promise<string> {
    const existing = await this.find(name, signal)
    if (existing) return existing
    await this.command(['create', name], signal, { secret }).catch(() => undefined)
    signal.throwIfAborted()
    const created = await this.find(name, signal)
    if (created) return created
    throw new Error('Cloudflare could not create the tunnel. Try again.')
  }

  async token(tunnelId: string, accountId: string, expectedSecret: string, signal: AbortSignal): Promise<string> {
    const { stdout } = await this.command(['token', tunnelId], signal)
    const token = stdout.trim()
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9+/=]+$/.test(token)) throw new Error()
      const { a, t, s } = JSON.parse(Buffer.from(token, 'base64').toString()) as Record<string, unknown>
      if (a === accountId && t === tunnelId && s === expectedSecret) return token
    } catch { /* No token or parser details should leave the daemon. */ }
    throw new Error('The existing Cloudflare tunnel does not match this setup.')
  }

  async route(tunnelId: string, label: string, signal: AbortSignal): Promise<string> {
    const result = await this.command(['route', 'dns', tunnelId, label], signal)
    for (const line of `${result.stderr}\n${result.stdout}`.split('\n')) {
      try {
        const log = JSON.parse(line) as { message?: string; tunnelID?: string }
        if (log.tunnelID !== tunnelId || typeof log.message !== 'string') continue
        const hostname = (/^Added CNAME (\S+) which will route to this tunnel$/.exec(log.message)?.[1]
          ?? /^(\S+) is already configured to route to your tunnel$/.exec(log.message)?.[1])?.toLowerCase()
        if (hostname?.startsWith(`${label}.`) && cloudflareHostname(hostname)) return hostname
      } catch { /* Some CLI output is plain text. */ }
    }
    throw new Error('Cloudflare did not return an address for the selected domain.')
  }
}
