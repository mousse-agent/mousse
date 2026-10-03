import type { ParsedArgs } from '../parseArgs'
import { isIP } from 'node:net'
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { flagString } from '../parseArgs'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { writeOutput } from '../output'
import { NODE_CAPABILITIES, type NodeCapability } from '../../shared/net/capabilities'
import { NET_ERRORS, isNetErrorCode, type NetErrorCode } from '../../shared/net/errors'
import { isId } from '../../shared/net/ids'

export const NET_HELP = `Usage:
  mousse-cli net init [--name <name>] [--listen [--host <IP>] [--port <port>]]
  mousse-cli net status
  mousse-cli net doctor
  mousse-cli net protect
  mousse-cli net unlock
  mousse-cli net transports
  mousse-cli net transport configure <id> --settings-file <path> [--disable]

Commands use the selected profile's daemon-owned network identity.
init explicitly creates the identity and makes this node the authority.
The direct listener stays off unless --listen is given. --host defaults to
127.0.0.1; --port defaults to 0 (an automatically selected port).
status reports public identity, sessions, routes, queues and last errors.
doctor checks reachability and clock health and names the failing layer.
protect encrypts an existing plain identity store. unlock opens an encrypted
store after restart. Both read a nonempty passphrase at a no-echo prompt or
from piped stdin; passphrase arguments and flags are rejected. Piped input
uses its exact UTF-8 contents (at most 4096 bytes), including whitespace;
use printf to avoid adding an unintended newline.
transports lists the available in-tree add-ons and selected listener status.
transport configure validates and persists a JSON settings file; --disable
stops the selected listener. Settings must satisfy the listed add-on schema.
Direct listeners remain opt-in. Configuration never accepts secret tokens.
`

export const BRIDGE_HELP = `Usage:
  mousse-cli bridge invite [--ttl 10m] [--name <name>] [--caps read,chat,write]
  mousse-cli bridge join [mj1_<payload>] [--name <name>] [--protect] [--invite-file <path>]
  mousse-cli bridge nodes
  mousse-cli bridge revoke <node-id>
  mousse-cli bridge rename <node-id> <name>

Only the current authority can invite, revoke or rename nodes.
revoke and rename require the nod_ identifier shown by bridge nodes.
Invite output is a secret. join without an argument reads it at a no-echo
prompt, or from piped stdin, to keep it out of shell history. A lost response
can be retried with the same invite; the daemon retains the same node keys.
Relay invitations require a protected profile. --protect prepares a blank
join profile and reads its passphrase with hidden or piped input. With piped
--protect input, supply --invite-file (a private regular file) or an invite
argument; stdin is reserved for the passphrase. An unfinished protected join
profile cannot be initialized as a fresh authority.
Use --profile <profile> to choose the daemon profile.
`

type NetMethod = 'net.transport.list' | 'net.transport.configure' | 'net.init' | 'net.status' | 'net.doctor' | 'net.protect' | 'net.unlock' | 'bridge.invite' | 'bridge.join' | 'bridge.nodes' | 'bridge.revoke' | 'bridge.rename'
export interface NetCliRequest { method: NetMethod; params: Record<string, unknown>; promptInvite?: boolean; promptPassphrase?: boolean }
export interface NetCliIO { emit(value: unknown, text: string): void; readInvite?: () => Promise<string>; readPassphrase?: () => Promise<string> }
export type NetCliClient = Pick<DaemonClient, 'request'>

class NetCliArgumentError extends Error { readonly code = 'bad_request' }
function invalid(message: string): never { throw new NetCliArgumentError(message) }
function name(value: string | undefined): string {
  if (!value || value.trim() !== value || Array.from(value).length > 256 || /[\x00-\x1f\x7f]/.test(value)) invalid('A name must contain 1–256 characters without control characters or surrounding spaces.')
  return value
}
function stringFlag(args: ParsedArgs, key: string): string | undefined {
  if (!args.flags.has(key)) return undefined
  const value = flagString(args.flags, key)
  if (!value) invalid(`--${key} requires a value.`)
  return value
}
export function parseInviteTtl(value = '10m'): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!match) invalid('--ttl requires a duration such as 30s, 10m, 1h or 1d.')
  const milliseconds = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 0)
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 7 * 86_400_000) invalid('--ttl must be positive and at most 7 days.')
  return milliseconds
}
function invite(value: string): string {
  if (!/^mj1_[A-Za-z0-9_-]+$/.test(value) || value.length > 64 * 1024) invalid('Expected a valid mj1_ invite string.')
  return value
}
function passphrase(value: string): string {
  if (!value.length || Buffer.byteLength(value, 'utf8') > 4096 || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid('A passphrase must contain 1–4096 bytes of valid UTF-8 input.')
  return value
}

/** Read a bounded regular file through its open descriptor; never follow a symlink or print its contents/path. */
function readBoundedFile(path: string, limit: number, privateFile: boolean): string {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit || (privateFile && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) invalid('The invitation file must be a private regular file owned by this account.')
    const bytes = Buffer.alloc(limit + 1); let used = 0
    while (used <= limit) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count }
    if (used > limit) invalid('The input file exceeds its size limit.')
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)) } finally { bytes.fill(0) }
  } catch (error) { if (error instanceof NetCliArgumentError) throw error; return invalid('I could not read the bounded input file.') }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Validate every argument before connecting to the daemon or creating keys. */
export function prepareNetCommand(args: ParsedArgs): NetCliRequest {
  if (args.globals.provider || args.globals.model || args.globals.apiKey || args.globals.continueSession || args.globals.sessionId || args.globals.print) invalid('Network commands do not accept chat, provider or API-key overrides.')
  const method = (args.command === 'net' && args.subcommand === 'transports' ? 'net.transport.list' : args.command === 'net' && args.subcommand === 'transport' ? 'net.transport.configure' : `${args.command}.${args.subcommand}`) as NetMethod
  const options: Partial<Record<NetMethod, string[]>> = {
    'net.transport.list': [], 'net.transport.configure': ['settings-file', 'disable'],
    'net.init': ['name', 'listen', 'host', 'port'], 'net.status': [], 'net.doctor': [], 'net.protect': [], 'net.unlock': [],
    'bridge.invite': ['ttl', 'name', 'caps'], 'bridge.join': ['name', 'protect', 'invite-file'],
    'bridge.nodes': [], 'bridge.revoke': [], 'bridge.rename': []
  }
  const permitted = options[method]
  if (!permitted) invalid('Unknown network command. Use net help or bridge help.')
  const allowed = new Set(['profile', 'mode', ...permitted])
  for (const key of args.flags.keys()) {
    if (!allowed.has(key)) invalid('Unsupported flag for this network command.')
    if (['listen', 'protect', 'disable'].includes(key)) { if (args.flags.get(key) !== true) invalid('This option is a switch; do not supply a value.') }
    else stringFlag(args, key)
  }
  const count = method === 'net.transport.configure' ? 2 : method === 'bridge.rename' ? 2 : method === 'bridge.revoke' ? 1 : method === 'bridge.join' ? undefined : 0
  if (count !== undefined && args.positional.length !== count) invalid(`${method.replace('.', ' ')} requires ${count} positional argument${count === 1 ? '' : 's'}.`)
  const params: Record<string, unknown> = {}
  if (method === 'net.transport.configure') {
    if (args.positional[0] !== 'configure' || !/^[a-z][a-z0-9.-]{0,63}$/.test(args.positional[1])) invalid('Use net transport configure <id> --settings-file <path>.')
    const file = stringFlag(args, 'settings-file')
    if (!file) invalid('--settings-file is required.')
    let settings: unknown
    try { settings = JSON.parse(readBoundedFile(file, 16 * 1024, false)) } catch { invalid('The settings file must contain a bounded UTF-8 JSON object.') }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) invalid('The settings file must contain a JSON object.')
    return { method, params: { id: args.positional[1], enabled: !args.flags.has('disable'), settings } }
  }
  if (method === 'net.protect' || method === 'net.unlock') return { method, params, promptPassphrase: true }
  if (method === 'net.init') {
    const listen = args.flags.has('listen')
    if (!listen && (args.flags.has('host') || args.flags.has('port'))) invalid('--host and --port require --listen.')
    if (listen) params.listen = true
    const host = stringFlag(args, 'host')
    if (host !== undefined) { if (!isIP(host)) invalid('--host requires an IPv4 or IPv6 address.'); params.host = host }
    const rawPort = stringFlag(args, 'port')
    if (rawPort !== undefined) {
      const port = Number(rawPort)
      if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) invalid('--port requires an integer from 0 through 65535.')
      params.port = port
    }
  }
  if (permitted.includes('name')) {
    const requested = stringFlag(args, 'name')
    if (requested !== undefined) params.name = name(requested)
  }
  if (method === 'bridge.invite') {
    params.ttlMs = parseInviteTtl(stringFlag(args, 'ttl'))
    const raw = stringFlag(args, 'caps')
    if (raw !== undefined) {
      const caps = raw.split(',')
      if (!caps.length || new Set(caps).size !== caps.length || caps.some((cap) => !NODE_CAPABILITIES.includes(cap as NodeCapability))) invalid('--caps requires distinct capabilities: read, chat, write, terminal, settings.')
      params.caps = caps
    }
  }
  if (method === 'bridge.join') {
    if (args.positional.length > 1) invalid('bridge join accepts at most one invite argument.')
    const file = stringFlag(args, 'invite-file')
    if (file && args.positional.length) invalid('Choose one invitation input.')
    if (file) params.invite = invite(readBoundedFile(file, 64 * 1024, true).trim())
    else if (args.positional.length) params.invite = invite(args.positional[0])
    const promptPassphrase = args.flags.has('protect')
    return { method, params, ...(params.invite === undefined ? { promptInvite: true } : {}), ...(promptPassphrase ? { promptPassphrase: true } : {}) }
  }
  if (method === 'bridge.revoke' || method === 'bridge.rename') {
    const node = args.positional[0]
    if (!isId('node', node)) invalid('bridge revoke and rename require a valid nod_ node identifier from bridge nodes.')
    params.node = node
    if (method === 'bridge.rename') params.name = name(args.positional[1])
  }
  return { method, params }
}

/** Defense in depth for daemon diagnostics. Bearers and credential fields never print. */
export function publicNetOutput(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\b(?:mj1|sj1)_[A-Za-z0-9_-]+/g, '[redacted]').replace(/(https?:\/\/)[^/\s@]+@/g, '$1[redacted]@')
  if (Array.isArray(value)) return value.map(publicNetOutput)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|ticket|authorization|proof|passphrase|password|secret|privatekey|sealed|messageText|invite)(?:key)?$/i.test(key)).map(([key, child]) => [key, publicNetOutput(child)]))
  return value
}

export async function executeNetCommand(request: NetCliRequest, client: NetCliClient, io: NetCliIO): Promise<number> {
  const params = { ...request.params }
  if (request.promptInvite) {
    if (!io.readInvite) invalid('A no-echo invite input is required.')
    params.invite = invite((await io.readInvite()).trim())
  }
  if (request.promptPassphrase) {
    if (!io.readPassphrase) invalid('A no-echo passphrase input is required.')
    params.passphrase = passphrase(await io.readPassphrase())
  }
  const result = await client.request<unknown>(request.method, params)
  if (request.method === 'bridge.invite') {
    const response = result as { invite?: unknown; inviteId?: unknown; expiresAt?: unknown }
    if (!response || typeof response.invite !== 'string' || typeof response.inviteId !== 'string' || typeof response.expiresAt !== 'number') throw new Error('Invalid invite response')
    const output = { invite: invite(response.invite), inviteId: response.inviteId, expiresAt: response.expiresAt }
    io.emit(output, `mousse-cli bridge join ${output.invite}\nExpires: ${new Date(output.expiresAt).toISOString()}`)
  } else {
    const output = publicNetOutput(result)
    io.emit(output, JSON.stringify(output, null, 2))
  }
  return 0
}

export function netCliFailure(error: unknown): { code: NetErrorCode; error: string; exitCode: number } {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (error instanceof NetCliArgumentError) return { code: 'bad_request', error: error.message, exitCode: 2 }
  if (code === 'profile_not_found') return { code: 'bad_request', error: 'The selected profile does not exist. Choose an existing profile with --profile.', exitCode: 2 }
  if (code === 'profile_archived') return { code: 'bad_request', error: 'The selected profile is archived. Restore it or choose an active profile with --profile.', exitCode: 2 }
  const localCodes: Record<string, NetErrorCode> = {
    invalid_params: 'bad_request', unknown_field: 'bad_request', profile_mismatch: 'bad_request', invalid_profile_binding: 'bad_request', profile_binding_required: 'bad_request', params_too_large: 'too_large'
  }
  const safeCode = isNetErrorCode(code) ? code : typeof code === 'string' && Object.hasOwn(localCodes, code) ? localCodes[code] : 'internal'
  return { code: safeCode, error: NET_ERRORS[safeCode].message, exitCode: safeCode === 'cancelled' ? 130 : safeCode === 'bad_request' ? 2 : 1 }
}

export interface InviteInput extends NodeJS.ReadableStream { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown }
/** No readline echo, and restore terminal state on completion, cancellation or EOF. */
export function readSecret(options: { prompt: string; maxBytes: number; trim?: boolean }, input: InviteInput = process.stdin, output: Pick<NodeJS.WritableStream, 'write'> = process.stderr): Promise<string> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > 64 * 1024) return Promise.reject(new NetCliArgumentError('Invalid secret input size limit.'))
  if (input.isTTY && !input.setRawMode) return Promise.reject(new NetCliArgumentError('This terminal cannot disable echo. Pipe the secret into the command instead.'))
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(options.maxBytes)
    let length = 0
    let finished = false
    const raw = input.isRaw ?? false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      input.removeListener('data', data)
      input.removeListener('end', end)
      input.removeListener('error', failed)
      process.removeListener('SIGINT', interrupted)
      if (input.isTTY) {
        try { input.setRawMode?.(raw); output.write('\n') } catch { error ??= new NetCliArgumentError('I could not restore the terminal input mode.') }
      }
      input.pause()
      if (error) reject(error)
      else {
        try {
          const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))
          resolve(options.trim ? value.trim() : value)
        } catch { reject(new NetCliArgumentError('Secret input must contain valid UTF-8.')) }
      }
    }
    const end = () => finish()
    const failed = (error: Error) => finish(error)
    const interrupted = () => finish(Object.assign(new Error(), { code: 'cancelled' }))
    const data = (chunk: Buffer | string) => {
      for (const byte of Buffer.from(chunk)) {
        if (input.isTTY && byte === 3) { finish(Object.assign(new Error(), { code: 'cancelled' })); return }
        if (input.isTTY && (byte === 10 || byte === 13 || byte === 4)) { finish(); return }
        if (input.isTTY && (byte === 127 || byte === 8)) {
          if (length) { length--; while (length > 0 && (bytes[length] & 0xc0) === 0x80) length-- }
          continue
        }
        if (length >= bytes.length) { finish(new NetCliArgumentError('Secret input exceeds the size limit.')); return }
        bytes[length++] = byte
      }
    }
    input.on('data', data)
    input.once('end', end)
    input.once('error', failed)
    process.once('SIGINT', interrupted)
    if (input.isTTY) {
      try { input.setRawMode?.(true); output.write(options.prompt) }
      catch { finish(new NetCliArgumentError('This terminal cannot disable echo. Pipe the secret into the command instead.')); return }
    }
    input.resume()
  })
}

export function readInviteSecret(input: InviteInput = process.stdin, output: Pick<NodeJS.WritableStream, 'write'> = process.stderr): Promise<string> {
  return readSecret({ prompt: 'Invite (input hidden): ', maxBytes: 64 * 1024, trim: true }, input, output)
}
export function readPassphraseSecret(input: InviteInput = process.stdin, output: Pick<NodeJS.WritableStream, 'write'> = process.stderr): Promise<string> {
  return readSecret({ prompt: 'Passphrase (input hidden): ', maxBytes: 4096 }, input, output)
}

export async function runNet(args: ParsedArgs): Promise<void> {
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) { process.stdout.write(args.command === 'bridge' ? BRIDGE_HELP : NET_HELP); return }
  let client: DaemonClient | undefined
  try {
    const request = prepareNetCommand(args)
    if (request.promptInvite && request.promptPassphrase && !process.stdin.isTTY) invalid('Piped --protect input requires --invite-file or an invite argument; stdin carries only the passphrase.')
    // Read the bearer before daemon auto-start, so invalid input has no side effects.
    if (request.promptInvite) { request.params.invite = invite(await readInviteSecret()); request.promptInvite = false }
    if (request.promptPassphrase) { request.params.passphrase = passphrase(await readPassphraseSecret()); request.promptPassphrase = false }
    client = await connectDaemonClient({ homeDir: args.globals.homeDir || undefined, requestTimeoutMs: 60_000 })
    if (args.globals.profile) await client.request('profiles.bind', { profile: args.globals.profile })
    else {
      const status = await client.request<{ defaultProfileId: string }>('profiles.status')
      await client.request('profiles.bind', { profile: status.defaultProfileId })
    }
    process.exitCode = await executeNetCommand(request, client, { emit: (value, text) => writeOutput(args.globals.mode, value, () => text) })
  } catch (error) {
    const failure = netCliFailure(error)
    process.stderr.write(args.globals.mode === 'json' ? `${JSON.stringify({ code: failure.code, error: failure.error })}\n` : `Error [${failure.code}]: ${failure.error}\n`)
    process.exitCode = failure.exitCode
  } finally { await client?.close() }
}

export const runBridge = runNet
