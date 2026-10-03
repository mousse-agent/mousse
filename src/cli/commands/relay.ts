import { closeSync, fstatSync, openSync, readSync, constants } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { writeOutput } from '../output'
import { RelayServer, type RelayServerOptions } from '../../mms/net/relay/server'
import { relayUrl } from '../../mms/net/relay/protocol'
import { decodeBase64 } from '../../mms/net/identity/crypto'
import { isId } from '../../shared/net/ids'

export const RELAY_HELP = `Usage:
  mousse-cli relay serve --database <path> [options]

Run an independent relay in the foreground; no profile daemon is needed.
SIGINT or SIGTERM flushes accounting, closes connections and exits.

Options:
  --host <IP>                         Bind address (default: 127.0.0.1)
  --port <0-65535>                     Bind port (default: 8787; 0 selects a free port)
  --database <path>                    Durable SQLite accounting/rendezvous database
  --public-address <ws/wss URL>        Advertised URL ending in /mousse-relay
  --allow-users <JSON file>            Array of { "user": "usr_...", "rootKey": "..." }
  --allow-nodes <JSON file>            Array of { "node": "nod_...", "signKey": "..." }
  --bytes-per-hour <integer>           Per-principal byte quota (default: 1073741824)
  --connections-per-hour <integer>     Per-principal admissions (default: 120)
  --max-connections <integer>          Concurrent connections (default: 32)
  --max-connections-per-principal <n>   Per-principal connections (default: 8)
  --maximum-queued-bytes <integer>      Per-endpoint queue limit (default: 262144)

Allow lists contain public keys only. Unlisted nodes need an enrollment rendezvous.
Non-loopback binding requires an explicit --host and a wss --public-address.
Terminate outer TLS at a reverse proxy; the relay itself serves plain WebSocket.
See docs/net/relay.md for an operator example and visibility limits.
`

function stringOption(args: ParsedArgs, name: string): string | undefined {
  if (!args.flags.has(name)) return undefined
  const value = flagString(args.flags, name)
  if (!value) throw new Error(`--${name} requires a value.`)
  return value
}

function numberOption(args: ParsedArgs, name: string, allowZero = false): number | undefined {
  const value = stringOption(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`--${name} requires ${allowZero ? 'a nonnegative' : 'a positive'} safe integer.`)
  }
  return parsed
}

function readAllowList(path: string): unknown[] {
  const limit = 64 * 1024
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Allow lists must be regular files of at most 64 KiB.')
    const bytes = Buffer.alloc(limit + 1)
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null)
      if (!count) break
      used += count
    }
    if (used > limit) throw new Error('Allow lists must be at most 64 KiB.')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)))
    if (!Array.isArray(value)) throw new Error('An allow list must be a JSON array.')
    return value
  } finally { closeSync(fd) }
}

export function prepareRelayCommand(args: ParsedArgs): RelayServerOptions {
  if (args.subcommand !== 'serve' || args.positional.length) throw new Error(RELAY_HELP)
  const allowed = new Set([
    'mode', 'host', 'port', 'database', 'public-address', 'allow-users', 'allow-nodes',
    'bytes-per-hour', 'connections-per-hour', 'max-connections',
    'max-connections-per-principal', 'maximum-queued-bytes'
  ])
  for (const key of args.flags.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown relay option --${key}.`)
  }
  const databasePath = stringOption(args, 'database')
  if (!databasePath) throw new Error('--database is required.')
  const host = stringOption(args, 'host') ?? '127.0.0.1'
  if (!isIP(host)) throw new Error('--host must be an explicit IP address.')
  const port = numberOption(args, 'port', true) ?? 8787
  if (port > 65535) throw new Error('--port must be between 0 and 65535.')
  const publicAddress = stringOption(args, 'public-address')
  if (publicAddress) {
    const url = relayUrl(publicAddress)
    if (url.search) throw new Error('--public-address must not include a node query.')
  }
  if (!publicAddress && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('--public-address is required for this bind address.')
  }
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (!loopback && (!publicAddress || new URL(publicAddress).protocol !== 'wss:')) {
    throw new Error('Non-loopback binding requires --public-address wss://<host>/mousse-relay behind TLS termination.')
  }
  const nodesPath = stringOption(args, 'allow-nodes')
  const usersPath = stringOption(args, 'allow-users')
  const allowNodes = nodesPath ? readAllowList(nodesPath).map(value => {
    const entry = value as { node?: unknown; signKey?: unknown } | null
    if (!entry || !isId('node', entry.node) || typeof entry.signKey !== 'string' ||
        Object.keys(entry).some(key => key !== 'node' && key !== 'signKey')) {
      throw new Error('Each allowed node requires only a node ID and signKey.')
    }
    decodeBase64(entry.signKey, 32)
    return { node: entry.node, signKey: entry.signKey }
  }) : []
  const allowUsers = usersPath ? readAllowList(usersPath).map(value => {
    const entry = value as { user?: unknown; rootKey?: unknown } | null
    if (!entry || !isId('user', entry.user) || typeof entry.rootKey !== 'string' ||
        Object.keys(entry).some(key => key !== 'user' && key !== 'rootKey')) {
      throw new Error('Each allowed user requires only a user ID and rootKey.')
    }
    decodeBase64(entry.rootKey, 32)
    return { user: entry.user, rootKey: entry.rootKey }
  }) : []
  return {
    databasePath: resolve(databasePath), host, port, publicAddress, allowNodes, allowUsers,
    bytesPerHour: numberOption(args, 'bytes-per-hour'),
    connectionsPerHour: numberOption(args, 'connections-per-hour'),
    maxConnections: numberOption(args, 'max-connections'),
    maxConnectionsPerPrincipal: numberOption(args, 'max-connections-per-principal'),
    maximumQueuedBytes: numberOption(args, 'maximum-queued-bytes')
  }
}

export async function runRelay(args: ParsedArgs): Promise<void> {
  const server = new RelayServer(prepareRelayCommand(args))
  let stop!: () => void
  const stopped = new Promise<void>(resolve => { stop = resolve })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await server.listen()
    const address = server.address()
    const settings = { address }
    const configure = 'mousse-cli net transport configure relay --settings-file relay-settings.json'
    writeOutput(args.globals.mode, { address, settings, configure }, () =>
      `Relay listening at ${address}\n` +
      `Save ${JSON.stringify(settings)} as relay-settings.json on each node, then run:\n  ${configure}\n`)
    await stopped
  } finally {
    try { await server.close() }
    finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  }
}
