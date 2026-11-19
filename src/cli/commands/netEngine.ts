import { createInterface } from 'node:readline'
import qrcode from 'qrcode-generator'
import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { formatTable, writeOutput } from '../output'
import { netCliFailure } from './net'
import { engineControl, engineLimits } from '../../mms/netEngine/limits'
import { privateRoute } from '../../mms/netEngine/routes'
import { readTicket } from '../../mms/netEngine/ticket'
import {
  NET_ENGINE_SSH_MARKER,
  type NetEngineDevice,
  type NetEngineInviteState,
  type NetEngineStatus
} from '../../shared/netEngine/local'

export const NET_ENGINE_HELP = `Usage:
  mousse-cli net-engine status
  mousse-cli net-engine devices
  mousse-cli net-engine invite [--link]
  mousse-cli net-engine join <link> [--yes]
  mousse-cli net-engine remove <device>
  mousse-cli net-engine addresses <device> <route>...
  mousse-cli net-engine routes [--lan on|off] [--tailnet on|off] [--public <host:port>] [--tunnel <url>] [--port <N>] [--test]
  mousse-cli net-engine ssh add <target> [--profile <selector> | --new <label>] [--local-profile <profile>]
  mousse-cli net-engine ssh

These drive the networking of a profile this Mousse runs, through the Mousse service on this computer, with the same
steps as Settings > Devices. --profile picks the profile, as for every command; in ssh add it names the other
computer's profile instead, and --local-profile picks this computer's.

status shows whether networking is on, this computer's identity and where it listens. devices lists the paired
computers. A <device> is a device's id, its name or the start of its identity.
invite shows a pairing code for a computer next to this one, and waits: when that computer asks to join, it asks
you to confirm. invite --link makes a link to send in a chat, and shows a six-digit code to read to the other
person another way. Both wait until the pairing finishes or you press Ctrl+C, which ends the invitation.
join opens a link made with invite --link. It lists the addresses it will contact and asks before dialling, then
asks for the code shown on the other computer. The code is read from the terminal only, never from an argument or
a pipe; without a terminal join refuses. --yes skips the address question and also needs a terminal.
remove ends a pairing on both computers.
addresses sets the addresses this computer dials a device at, replacing the ones set before: tcp://host:port,
wss://host/.../mousse-net/1, ws://127.0.0.1:port/.../mousse-net/1 for a tunnel client on this computer, or ssh://.
Without a route it clears them.
routes shows or changes where this computer can be reached: the local network, a tailnet, a port forward from the
internet (--public, the address the router forwards to) and tunnels (--tunnel, the tunnel's public URL). --port
keeps the listening port. --test checks each route from this computer. Some changes restart networking for about
a second.
ssh add adds the computer at <target> (user@host, or a name from ~/.ssh/config) over SSH, with your SSH keys or
agent. It shows the server's key fingerprint and asks you to trust it the first time. Without --profile or --new
it lists the profiles there and asks which one.
ssh (no arguments) is what ssh add runs on the other computer. It is not meant to be run by hand.
`

/** What a `net-engine` command line asks for, checked before anything connects. */
export type NetEngineCliRequest =
  | { kind: 'status' }
  | { kind: 'devices' }
  | { kind: 'invite'; link: boolean }
  | { kind: 'join'; ticket: string; yes: boolean }
  | { kind: 'remove'; device: string }
  | { kind: 'addresses'; device: string; routes: string[] }
  | { kind: 'routes'; config: NetEngineRoutesChange; test: boolean }
  | {
      kind: 'ssh-add'
      target: string
      selector?: string
      newLabel?: string
      localProfile?: string
    }
  | { kind: 'ssh-remote' }

/** A change to where this computer can be reached (`routes.config`, §7); only what the command line set. */
export interface NetEngineRoutesChange {
  lan?: boolean
  tailnet?: boolean
  public?: string[]
  tunnels?: string[]
  port?: number
}

export class NetEngineCliArgumentError extends Error {
  readonly code = 'bad_request'
}

function invalid(message: string): never {
  throw new NetEngineCliArgumentError(message)
}

const SUBCOMMANDS = ['status', 'devices', 'invite', 'join', 'remove', 'addresses', 'routes', 'ssh']
/** An SSH selector: 26 characters of `[a-z2-7]` (§3.3). */
const SELECTOR = /^[a-z2-7]{26}$/
/** An SSH target (§1.1): an optional user, then a host, an IP literal or an `~/.ssh/config` name. */
const SSH_TARGET =
  /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._][A-Za-z0-9._-]{0,252})(?::[1-9][0-9]{0,4})?$/

function onOff(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.flags.get(name)
  if (value === undefined) return undefined
  if (value === 'on') return true
  if (value === 'off') return false
  return invalid(`--${name} is on or off.`)
}

/** Every value of a flag that may be given more than once (`--public a --public b`), in order. */
function allValues(args: ParsedArgs, name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.raw.length; i++) {
    const arg = args.raw[i]!
    if (arg === `--${name}`) {
      const next = args.raw[i + 1]
      if (next === undefined || next.startsWith('-')) invalid(`--${name} needs a value.`)
      values.push(next)
      i++
    } else if (arg.startsWith(`--${name}=`)) values.push(arg.slice(name.length + 3))
  }
  return values
}

/** Reads a `net-engine` command line; nothing has run yet, so a mistake costs nothing. */
export function prepareNetEngineCommand(args: ParsedArgs): NetEngineCliRequest {
  const sub = args.subcommand
  if (!sub || !SUBCOMMANDS.includes(sub)) invalid(`Unknown net-engine command. ${NET_ENGINE_HELP}`)
  const [first, ...rest] = args.positional
  const none = (): void => {
    if (args.positional.length) invalid(`net-engine ${sub} takes no arguments.`)
  }
  switch (sub) {
    case 'status':
    case 'devices':
      none()
      return { kind: sub }
    case 'invite': {
      none()
      const link = args.flags.get('link')
      if (link !== undefined && link !== true) invalid('--link takes no value.')
      return { kind: 'invite', link: link === true }
    }
    case 'join': {
      if (!first || rest.length) invalid('net-engine join takes one link.')
      // Read here so a damaged link is refused before the service is asked anything.
      let kind: number | undefined
      try {
        kind = readTicket(first).kind
      } catch {
        invalid('This link is damaged. Ask for a new one.')
      }
      // An in-person code proves the two computers are side by side only when a camera reads it (§5).
      if (kind === 1)
        invalid('This is an in-person pairing code: scan it with Add device in Mousse. Use invite --link to pair from a terminal.')
      const yes = args.flags.get('yes')
      return { kind: 'join', ticket: first, yes: yes === true }
    }
    case 'remove':
      if (!first || rest.length) invalid('net-engine remove takes one device.')
      return { kind: 'remove', device: first }
    case 'addresses':
      if (!first) invalid('net-engine addresses takes a device, then its routes.')
      return { kind: 'addresses', device: first, routes: rest }
    case 'routes': {
      none()
      const config: NetEngineRoutesChange = {}
      const lan = onOff(args, 'lan')
      const tailnet = onOff(args, 'tailnet')
      if (lan !== undefined) config.lan = lan
      if (tailnet !== undefined) config.tailnet = tailnet
      const publics = allValues(args, 'public')
      if (publics.length)
        config.public = publics.map((value) =>
          value === 'none' ? '' : value.startsWith('tcp://') ? value : `tcp://${value}`
        ).filter(Boolean)
      const tunnels = allValues(args, 'tunnel')
      if (tunnels.length)
        config.tunnels = tunnels.filter((value) => value !== 'none').map(tunnelRoute)
      const port = flagString(args.flags, 'port')
      if (args.flags.has('port')) {
        const value = Number(port)
        if (!port || !/^[0-9]{1,5}$/.test(port) || value < 1 || value > 65535)
          invalid('--port is a port number from 1 to 65535.')
        config.port = value
      }
      const test = args.flags.get('test')
      if (test !== undefined && test !== true) invalid('--test takes no value.')
      return { kind: 'routes', config, test: test === true }
    }
    case 'ssh': {
      if (!first) return { kind: 'ssh-remote' }
      if (first !== 'add') invalid('net-engine ssh takes add <target>, or nothing.')
      const [target, ...extra] = rest
      if (!target || extra.length) invalid('net-engine ssh add takes one target.')
      if (!SSH_TARGET.test(target) || target.startsWith('-'))
        invalid('Use user@host, or a name from ~/.ssh/config.')
      // `--profile` is the global flag; in ssh add it names the other computer's profile.
      const selector = flagString(args.flags, 'profile')
      const newLabel = flagString(args.flags, 'new')
      if (args.flags.has('new') && !newLabel?.trim()) invalid('--new needs a label.')
      if (selector !== undefined && newLabel !== undefined)
        invalid('Use --profile or --new, not both.')
      if (selector !== undefined && !SELECTOR.test(selector))
        invalid("--profile takes the other computer's profile selector, as ssh add lists it.")
      const localProfile = flagString(args.flags, 'local-profile')
      return {
        kind: 'ssh-add',
        target,
        ...(selector ? { selector } : {}),
        ...(newLabel ? { newLabel: newLabel.trim() } : {}),
        ...(localProfile ? { localProfile } : {})
      }
    }
  }
  return invalid(`Unknown net-engine command. ${NET_ENGINE_HELP}`)
}

/** `https://x/...` is stored as `wss://x/mousse-net/1` (§4.3); a `wss://` route as it is. */
export function tunnelRoute(url: string): string {
  const text = url.trim()
  if (text.startsWith('wss://')) return text
  const match = /^https:\/\/([^/?#]+)\/?$/.exec(text)
  if (!match) invalid("--tunnel takes the tunnel's public https:// address.")
  return `wss://${match[1]!.toLowerCase()}/mousse-net/1`
}

// ------------------------------------------------------------------------------------------------ running

/** What a command needs from the terminal and the service; tests give their own. */
export interface NetEngineCliIO {
  emit(value: unknown, text: string): void
  /** A line of progress, on stderr. */
  say(text: string): void
  /** Whether a person is at a terminal (stdin and stdout). */
  tty: boolean
  /** Reads one line typed at the terminal, or undefined when the input ended. */
  ask(question: string): Promise<string | undefined>
  /** Settles when the service says this profile's networking changed, or the wait was ended. */
  changed(signal: AbortSignal): Promise<void>
  /** Ctrl+C. */
  interrupted: AbortSignal
}

/** The service, as the commands call it; a call may set its own wait. */
export interface NetEngineCliClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

/** The local methods the commands use: 1a's, and 1b's (`routes`, `addresses`, the link and SSH steps). */
export const NET_ENGINE_CLI_METHODS = {
  status: 'netEngine.status',
  invite: 'netEngine.invite',
  inviteCancel: 'netEngine.invite.cancel',
  approve: 'netEngine.approve',
  join: 'netEngine.join',
  joinCode: 'netEngine.join.code',
  remove: 'netEngine.remove',
  addresses: 'netEngine.addresses.set',
  routes: 'netEngine.routes.config',
  routesTest: 'netEngine.routes.test',
  sshResolve: 'netEngine.ssh.resolve',
  sshProbe: 'netEngine.ssh.probe',
  sshTrust: 'netEngine.ssh.trust',
  sshProfiles: 'netEngine.ssh.profiles',
  sshAdd: 'netEngine.ssh.add',
  sshRemote: 'netEngine.ssh.remote'
} as const

const STATE_TEXT: Record<NetEngineDevice['state'], string> = {
  connected: 'Connected',
  finishing: 'Finishing pairing',
  connecting: 'Connecting',
  offline: 'Offline',
  removing: 'Removing'
}

function deviceLine(device: NetEngineDevice): string[] {
  const state = device.notAccepted
    ? `${device.name} removed this computer's access`
    : device.unreachable === 'in'
      ? "Can't reach this computer"
      : device.unreachable === 'out'
        ? "This computer can't reach it"
        : STATE_TEXT[device.state]
  return [device.name, device.shortId, state, (device.addresses ?? []).join(' ')]
}

export function statusText(status: NetEngineStatus): string {
  const lines = [
    `Networking: ${status.on ? 'on' : status.enabled ? 'starting' : 'off'}${status.helper.text ? ` (${status.helper.text})` : ''}`
  ]
  if (status.paused) lines.push(`Paused: ${status.paused}`)
  if (status.identity) lines.push(`Identity: ${status.identity}`)
  if (status.routes?.length) lines.push(`Reachable at: ${status.routes.join(', ')}`)
  lines.push(`Devices: ${status.devices.length}`)
  if (status.approvals.length) lines.push(`Waiting for you: ${status.approvals.map((a) => a.name).join(', ')}`)
  if (status.sharedAccount)
    lines.push('Another profile of this account has networking on; it can read this one\'s keys.')
  return lines.join('\n')
}

function devicesText(devices: NetEngineDevice[]): string {
  if (!devices.length) return 'No paired computers.'
  return formatTable([['NAME', 'ID', 'STATE', 'ADDRESSES'], ...devices.map(deviceLine)])
}

/** The device a person named: its id, its name (any case) or the start of its identity; one only. */
export function findDevice(devices: NetEngineDevice[], name: string): NetEngineDevice {
  const lower = name.toLowerCase()
  const exact = devices.filter((device) => device.node === name)
  if (exact.length === 1) return exact[0]!
  const named = devices.filter((device) => device.name.toLowerCase() === lower)
  if (named.length === 1) return named[0]!
  const short = lower.length >= 4 ? devices.filter((device) => device.shortId.startsWith(lower)) : []
  if (short.length === 1) return short[0]!
  if (named.length > 1 || short.length > 1)
    invalid(`More than one device is called ${name}; use its id from net-engine devices.`)
  return invalid(`No device is called ${name}; net-engine devices lists them.`)
}

/** The UI label of a route's class (§1.2), for lists a person reads; the helper classifies for itself. */
export function routeLabel(route: string): string {
  if (route.startsWith('wss://') || route.startsWith('ws://')) return 'Tunnel'
  if (route.startsWith('ssh://')) return 'SSH'
  const match = /^tcp:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([^:/]+)):[0-9]{1,5}$/.exec(route)
  if (!match) return 'Unknown'
  if (privateRoute(route)) return 'LAN'
  const v4 = match[2] && /^[0-9.]+$/.test(match[2]) ? match[2].split('.').map(Number) : undefined
  if (v4 && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) return 'Tailnet'
  if (match[1] && /^fd7a:115c:a1e0:/i.test(match[1])) return 'Tailnet'
  return 'Internet'
}

/**
 * The ticket's destinations as the join dialog lists them (§1.3): private `tcp` literals are dialled on their own,
 * other `tcp` and `wss` only once approved, plain `ws` and `ssh` never.
 */
export function joinDestinations(ticket: string): {
  automatic: string[]
  approve: string[]
  skipped: string[]
} {
  const automatic: string[] = []
  const approve: string[] = []
  const skipped: string[] = []
  for (const route of readTicket(ticket).routes) {
    if (route.startsWith('tcp://') && privateRoute(route)) automatic.push(route)
    else if (route.startsWith('tcp://') || route.startsWith('wss://')) approve.push(route)
    else skipped.push(route)
  }
  return { automatic, approve, skipped }
}

const describe = (route: string): string => {
  const host = route.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')
  return `${host} (${routeLabel(route)})`
}

/** A QR code drawn with half blocks, two rows a line, inside a quiet zone, for a camera to read off a terminal. */
export function terminalQr(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  const margin = 2
  const dark = (row: number, col: number): boolean =>
    row >= 0 && col >= 0 && row < count && col < count && qr.isDark(row, col)
  const lines: string[] = []
  // Light modules are drawn, dark ones left as the background, so a dark terminal shows dark on light.
  for (let row = -margin; row < count + margin; row += 2) {
    let line = ''
    for (let col = -margin; col < count + margin; col++) {
      const top = !dark(row, col)
      const bottom = !dark(row + 1, col)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** A six-digit code as the dialog shows it, `123 456`. */
const spaced = (code: string): string => (/^[0-9]{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code)

async function status(client: NetEngineCliClient): Promise<NetEngineStatus> {
  return client.request<NetEngineStatus>(NET_ENGINE_CLI_METHODS.status)
}

/** Runs one prepared command; returns the exit code. */
export async function executeNetEngineCommand(
  request: NetEngineCliRequest,
  client: NetEngineCliClient,
  io: NetEngineCliIO
): Promise<number> {
  switch (request.kind) {
    case 'status': {
      const value = await status(client)
      io.emit(value, statusText(value))
      return 0
    }
    case 'devices': {
      const value = await status(client)
      io.emit(value.devices, devicesText(value.devices))
      return 0
    }
    case 'remove': {
      const device = findDevice((await status(client)).devices, request.device)
      await client.request(NET_ENGINE_CLI_METHODS.remove, { node: device.node })
      io.emit({ removed: device.node }, `Removed ${device.name}.`)
      return 0
    }
    case 'addresses': {
      const device = findDevice((await status(client)).devices, request.device)
      const value = await client.request<NetEngineStatus>(NET_ENGINE_CLI_METHODS.addresses, {
        node: device.node,
        routes: request.routes
      })
      const now = value.devices?.find((row) => row.node === device.node)
      io.emit(
        { node: device.node, addresses: now?.addresses ?? request.routes },
        request.routes.length
          ? `${device.name} is dialled at ${(now?.addresses ?? request.routes).join(', ')}.`
          : `${device.name} is found on the local network only.`
      )
      return 0
    }
    case 'routes':
      return routes(request, client, io)
    case 'invite':
      return invite(request, client, io)
    case 'join':
      return join(request, client, io)
    case 'ssh-add':
      return sshAdd(request, client, io)
    case 'ssh-remote':
      // Run by runNetEngine itself: it owns stdout and the connection.
      return invalid('net-engine ssh is run by ssh add on the other computer.')
  }
}

interface RoutesAnswer {
  routes?: unknown
  restart_needed?: boolean
  restartNeeded?: boolean
}

async function routes(
  request: Extract<NetEngineCliRequest, { kind: 'routes' }>,
  client: NetEngineCliClient,
  io: NetEngineCliIO
): Promise<number> {
  let answer: RoutesAnswer | undefined
  if (Object.keys(request.config).length)
    answer = await client.request<RoutesAnswer>(NET_ENGINE_CLI_METHODS.routes, request.config)
  const current = answer ?? (await client.request<RoutesAnswer>(NET_ENGINE_CLI_METHODS.routes, {}))
  const list = Array.isArray(current.routes)
    ? current.routes.filter((route): route is string => typeof route === 'string')
    : []
  const restarted = !!(answer?.restart_needed ?? answer?.restartNeeded)
  const tests: Array<{ route: string; ok: boolean; ms?: number; reason?: string }> = []
  if (request.test)
    for (const route of list) {
      const result = await client.request<{ ok: boolean; ms?: number; reason?: string }>(
        NET_ENGINE_CLI_METHODS.routesTest,
        { route }
      )
      tests.push({ route, ...result })
    }
  const lines = [
    list.length ? `Reachable at:\n${list.map((route) => `  ${describe(route)}  ${route}`).join('\n')}` : 'Not reachable from other computers except over SSH.'
  ]
  if (restarted) lines.push('Networking restarted to use the change.')
  for (const test of tests)
    lines.push(
      test.ok
        ? `${test.route}: works${test.ms !== undefined ? ` (${test.ms} ms)` : ''}`
        : `${test.route}: Couldn't confirm from this network`
    )
  io.emit({ routes: list, ...(restarted ? { restarted } : {}), ...(request.test ? { tests } : {}) }, lines.join('\n'))
  return 0
}

/** The invitation as the service reports it now, or undefined once it ended. */
const inviteOf = (value: NetEngineStatus, invitation: string): NetEngineInviteState | undefined =>
  value.invites?.find((open) => open.invitation === invitation)

async function invite(
  request: Extract<NetEngineCliRequest, { kind: 'invite' }>,
  client: NetEngineCliClient,
  io: NetEngineCliIO
): Promise<number> {
  const before = new Set((await status(client)).devices.map((device) => device.node))
  const created = await client.request<{
    invitation: string
    uri: string
    code?: string
    attemptsLeft?: number
    expiresAt?: number
  }>(NET_ENGINE_CLI_METHODS.invite, request.link ? { kind: 'link' } : {})
  const shown = (code?: string, left?: number): string =>
    code ? `Code: ${spaced(code)}${left !== undefined ? ` (${left} ${left === 1 ? 'try' : 'tries'} left)` : ''}` : ''
  io.emit(
    { invitation: created.invitation, uri: created.uri, ...(created.code ? { code: created.code } : {}), ...(created.attemptsLeft !== undefined ? { attemptsLeft: created.attemptsLeft } : {}), ...(created.expiresAt !== undefined ? { expiresAt: created.expiresAt } : {}) },
    request.link
      ? [
          created.uri,
          shown(created.code, created.attemptsLeft),
          'Send the link in a chat. Read the code to them another way.'
        ].filter(Boolean).join('\n')
      : [terminalQr(created.uri), 'Scan this with Add device on the other computer.'].join('\n')
  )
  let code = created.code
  let left = created.attemptsLeft
  const answered = new Set<string>()
  for (;;) {
    if (io.interrupted.aborted) {
      await client.request(NET_ENGINE_CLI_METHODS.inviteCancel, { invitation: created.invitation }).catch(() => undefined)
      io.say('The invitation ended.')
      return 130
    }
    const now = await status(client)
    // A computer that joined: its row is new.
    const joined = now.devices.find((device) => !before.has(device.node))
    if (joined) {
      io.say(`${joined.name} joined. It finishes pairing on its own.`)
      return 0
    }
    for (const approval of now.approvals) {
      if (approval.invitation !== created.invitation || answered.has(approval.request)) continue
      answered.add(approval.request)
      const answer = io.tty
        ? await io.ask(`Is ${approval.name} (${approval.device}) next to you? [y/N] `)
        : undefined
      const yes = /^y(es)?$/i.test(answer?.trim() ?? '')
      await client.request(NET_ENGINE_CLI_METHODS.approve, { request: approval.request, yes })
      if (!yes) io.say(`${approval.name} was not let in.`)
    }
    const open = inviteOf(now, created.invitation)
    if (request.link && open) {
      if (open.code && (open.code !== code || open.attemptsLeft !== left)) {
        code = open.code
        left = open.attemptsLeft
        io.say(`That code didn't work there. ${shown(code, left)}`)
      }
    }
    if (open?.ended || (now.invites && !open)) {
      io.say(
        open?.ended === 'attempts_exhausted'
          ? 'Three wrong codes. This link no longer works.'
          : 'The invitation ended.'
      )
      return 1
    }
    await io.changed(io.interrupted)
  }
}

async function join(
  request: Extract<NetEngineCliRequest, { kind: 'join' }>,
  client: NetEngineCliClient,
  io: NetEngineCliIO
): Promise<number> {
  // The code is what proves the link was not swapped: it is typed by a person, never passed in (§8).
  if (!io.tty)
    invalid(
      request.yes
        ? '--yes needs a terminal too: the code is typed there.'
        : 'net-engine join needs a terminal to type the code in (no_tty).'
    )
  const facts = readTicket(request.ticket)
  const { automatic, approve, skipped } = joinDestinations(request.ticket)
  io.say(
    [
      `Connect to ${facts.name ?? 'the computer in this link'}? It will also be able to use this computer.`,
      `It will contact: ${[...automatic, ...approve].map(describe).join(', ') || 'nothing (no address it can use)'}`,
      ...(skipped.length ? [`Skipped: ${skipped.map(describe).join(', ')}`] : [])
    ].join('\n')
  )
  if (!request.yes) {
    const answer = await io.ask('Connect? [y/N] ')
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      io.say('Nothing was sent.')
      return 1
    }
  }
  // The join stays open while it needs the code: the code goes on a second request beside it.
  const ended = new AbortController()
  const asking = (async () => {
    const tried = new Set<string>()
    while (!ended.signal.aborted) {
      const now = await status(client).catch(() => undefined)
      const pending = now?.joins?.find(
        (entry) => entry.invitation === facts.invitation && entry.codeNeeded
      )
      if (pending) {
        const key = `${pending.attemptsLeft ?? ''}`
        if (!tried.has(key)) {
          tried.add(key)
          if (pending.failed)
            io.say(
              "That code didn't work. If you typed it exactly, the link may have been swapped; get a new one another way."
            )
          let code: string | undefined
          for (;;) {
            const typed = await io.ask(
              `Type the code shown on the other computer${pending.attemptsLeft !== undefined ? ` (${pending.attemptsLeft} ${pending.attemptsLeft === 1 ? 'try' : 'tries'} left)` : ''}: `
            )
            if (typed === undefined) return
            code = typed.replace(/\s+/g, '')
            if (/^[0-9]{6}$/.test(code)) break
            io.say('The code is six digits.')
          }
          await client
            .request(NET_ENGINE_CLI_METHODS.joinCode, { invitation: facts.invitation, code })
            .catch(() => undefined)
        }
      }
      await io.changed(ended.signal)
    }
  })()
  try {
    const answer = await client.request<{ node: string; status: NetEngineStatus }>(NET_ENGINE_CLI_METHODS.join, {
      ticket: request.ticket,
      arrival: 'link',
      approved: approve
    }, engineLimits().cliJoinWaitMs)
    const row = answer.status?.devices?.find((device) => device.node === answer.node)
    io.emit({ node: answer.node }, `Paired with ${row?.name ?? facts.name ?? 'the other computer'}. The other direction finishes on its own.`)
    return 0
  } finally {
    ended.abort()
    await asking.catch(() => undefined)
  }
}

interface SshProfile {
  selector: string
  label: string
  networking?: boolean
  identity?: string
}

async function sshAdd(
  request: Extract<NetEngineCliRequest, { kind: 'ssh-add' }>,
  client: NetEngineCliClient,
  io: NetEngineCliIO
): Promise<number> {
  const wait = engineLimits().sshRequestDeadlineMs
  const resolved = await client.request<{
    route_id?: string
    routeId?: string
    user: string
    hostname: string
    port: number
    pinned?: boolean
  }>(NET_ENGINE_CLI_METHODS.sshResolve, { target: request.target }, wait)
  const routeId = resolved.routeId ?? resolved.route_id
  const host = resolved.hostname
  if (!resolved.pinned) {
    const key = await client.request<{
      key_type?: string
      keyType?: string
      sha256: string
      in_user_known_hosts?: boolean
      inUserKnownHosts?: boolean
    }>(NET_ENGINE_CLI_METHODS.sshProbe, { routeId }, wait)
    const known = key.inUserKnownHosts ?? key.in_user_known_hosts
    io.say(
      `${host}'s SSH key is ${key.keyType ?? key.key_type} SHA256:${key.sha256}${known ? ' (the same key your ~/.ssh/known_hosts has)' : ''}`
    )
    if (!io.tty) invalid('ssh add needs a terminal to confirm the key the first time (no_tty).')
    const answer = await io.ask('Trust this key? [y/N] ')
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
      io.say('Nothing was added.')
      return 1
    }
    await client.request(NET_ENGINE_CLI_METHODS.sshTrust, { routeId, sha256: key.sha256 }, wait)
  }
  let selector = request.selector
  let newLabel = request.newLabel
  if (!selector && !newLabel) {
    const listed = await client.request<{ profiles: SshProfile[]; computer?: string }>(
      NET_ENGINE_CLI_METHODS.sshProfiles,
      { routeId },
      wait
    )
    const profiles = listed.profiles ?? []
    io.say(
      [
        `Profiles of ${resolved.user} on ${listed.computer ?? host}:`,
        ...profiles.map((profile, i) => `  ${i + 1}. ${profile.label}${profile.networking ? '' : ' (networking off)'}  ${profile.selector}`),
        `  ${profiles.length + 1}. New profile`
      ].join('\n')
    )
    if (!io.tty) invalid('Name the profile with --profile <selector> or --new <label> (no_tty).')
    const pick = Number((await io.ask('Which one? ')) ?? '')
    if (Number.isInteger(pick) && pick >= 1 && pick <= profiles.length) selector = profiles[pick - 1]!.selector
    else if (pick === profiles.length + 1) {
      newLabel = (await io.ask('Label for the new profile: '))?.trim()
      if (!newLabel) invalid('A new profile needs a label.')
    } else invalid('Pick one of the numbers listed.')
  }
  const added = await client.request<{
    node?: string
    name?: string
    startsAtLogin?: boolean
    starts_at_login?: boolean
  }>(NET_ENGINE_CLI_METHODS.sshAdd, {
    routeId,
    ...(selector ? { selector } : { newLabel })
  }, wait)
  const starts = added.startsAtLogin ?? added.starts_at_login
  io.emit(
    added,
    [
      `Added ${added.name ?? host} over SSH. This computer uses it; it doesn't use this one.`,
      ...(starts === false ? [`Mousse on ${host} won't start after a restart.`] : [])
    ].join('\n')
  )
  return 0
}

// ------------------------------------------------------------------------------------------------ net-engine ssh

/**
 * `mousse-cli net-engine ssh`, what `ssh.run` starts on the other computer (§3.4): one request on stdin, the marker
 * line, then one reply line on stdout. It never starts the service: a computer where Mousse is not running answers
 * `remote_not_running`. stdout carries only the marker and the reply.
 */
export async function runNetEngineSshRemote(
  args: ParsedArgs,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  connect: typeof connectDaemonClient = connectDaemonClient
): Promise<number> {
  // Anything a login shell printed went before this line; the caller skips up to it (§3.3).
  stdout.write(`${NET_ENGINE_SSH_MARKER}\n`)
  const reply = (value: unknown): number => {
    stdout.write(`${JSON.stringify(value)}\n`)
    return 0
  }
  const limits = engineLimits()
  let request: unknown
  try {
    const line = await readRequestLine(stdin, limits.sshRemoteRequestMaxBytes, limits.sshRemoteReadMs)
    request = JSON.parse(line)
  } catch {
    return reply({ error: 'bad_request' })
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return reply({ error: 'bad_request' })
  let client: DaemonClient | undefined
  try {
    client = await connect({
      homeDir: args.globals.homeDir || undefined,
      // The owner check's control starts the service here, which ssh add must never do.
      disableAutoStart: !engineControl('remote-autostart'),
      requestTimeoutMs: limits.sshRequestDeadlineMs
    })
  } catch {
    return reply({ error: 'remote_not_running' })
  }
  try {
    const profiles = await client.request<{ defaultProfileId: string }>('profiles.status')
    await client.request('profiles.bind', { profile: profiles.defaultProfileId })
    return reply(await client.request(NET_ENGINE_CLI_METHODS.sshRemote, { request }))
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    const reason =
      error && typeof error === 'object'
        ? (error as { details?: { reason?: unknown } }).details?.reason
        : undefined
    return reply({ error: typeof reason === 'string' ? reason : typeof code === 'string' ? code : 'remote_failed' })
  } finally {
    await client?.close().catch(() => undefined)
  }
}

/** One line from `input`, at most `maxBytes`, within `waitMs`; the input may end instead of a newline. */
export function readRequestLine(input: NodeJS.ReadableStream, maxBytes: number, waitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    const done = (error?: Error): void => {
      clearTimeout(timer)
      input.removeListener('data', data)
      input.removeListener('end', end)
      input.removeListener('error', done)
      input.pause?.()
      if (error) reject(error)
      else resolve(Buffer.concat(parts).toString('utf8'))
    }
    const data = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const newline = bytes.indexOf(10)
      const take = newline >= 0 ? bytes.subarray(0, newline) : bytes
      size += take.byteLength
      if (size > maxBytes) return done(new Error('too_large'))
      parts.push(take)
      if (newline >= 0) done()
    }
    const end = (): void => done()
    const timer = setTimeout(() => done(new Error('timeout')), waitMs)
    timer.unref?.()
    input.on('data', data)
    input.once('end', end)
    input.once('error', done)
    input.resume?.()
  })
}

// ------------------------------------------------------------------------------------------------ entry

function terminalIO(args: ParsedArgs, client: DaemonClient, catchInterrupt: boolean): NetEngineCliIO {
  const interrupted = new AbortController()
  // Only invite ends something of its own on Ctrl+C (its invitation); elsewhere Ctrl+C stops the command as usual.
  if (catchInterrupt) {
    const stop = (): void => interrupted.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
  let wake: (() => void) | undefined
  let subscribed = false
  client.client.onEvent((event) => {
    const kind = (event.data as { kind?: unknown } | null)?.kind
    if (event.type === 'ui.notify' && kind === 'net-engine') wake?.()
  })
  return {
    emit: (value, text) => writeOutput(args.globals.mode, value, () => text),
    say: (text) => process.stderr.write(`${text}\n`),
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask: (question) =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
        let answered = false
        lines.question(question, (answer) => {
          answered = true
          lines.close()
          resolve(answer)
        })
        lines.once('close', () => {
          if (!answered) resolve(undefined)
        })
      }),
    changed: (signal) =>
      new Promise((resolve) => {
        // Only a command that waits listens to the profile's changes.
        if (!subscribed) {
          subscribed = true
          void client.client.subscribe(0).catch(() => undefined)
        }
        // Events say when to read again; a timer reads again anyway, in case one was missed.
        const timer = setTimeout(done, engineLimits().cliStatusReadMs)
        timer.unref?.()
        function done(): void {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          if (wake === done) wake = undefined
          resolve()
        }
        wake = done
        signal.addEventListener('abort', done, { once: true })
      }),
    interrupted: interrupted.signal
  }
}

export async function runNetEngine(args: ParsedArgs): Promise<void> {
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(NET_ENGINE_HELP)
    return
  }
  // What ssh add runs on the other computer: its stdout is read by a program, not a person.
  if (args.subcommand === 'ssh' && !args.positional.length) {
    process.exitCode = await runNetEngineSshRemote(args)
    return
  }
  let client: DaemonClient | undefined
  try {
    const request = prepareNetEngineCommand(args)
    client = await connectDaemonClient({ homeDir: args.globals.homeDir || undefined })
    const profile =
      (request.kind === 'ssh-add' ? request.localProfile : args.globals.profile) ??
      (await client.request<{ defaultProfileId: string }>('profiles.status')).defaultProfileId
    await client.request('profiles.bind', { profile })
    process.exitCode = await executeNetEngineCommand(request, client.client, terminalIO(args, client, request.kind === 'invite'))
  } catch (error) {
    const failure =
      error instanceof NetEngineCliArgumentError
        ? { code: 'bad_request', error: error.message, exitCode: 2 }
        : netEngineFailure(error)
    process.stderr.write(
      args.globals.mode === 'json'
        ? `${JSON.stringify({ code: failure.code, error: failure.error })}\n`
        : `Error [${failure.code}]: ${failure.error}\n`
    )
    process.exitCode = failure.exitCode
  } finally {
    await client?.close()
  }
}

/** The service's refusal in plain words: its own message when it gave one, else the error code's. */
export function netEngineFailure(error: unknown): { code: string; error: string; exitCode: number } {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'method_not_allowed')
    return { code: 'not_supported', error: 'This Mousse service does not have that command yet.', exitCode: 1 }
  const message = error instanceof Error ? error.message : ''
  const failure = netCliFailure(error)
  // A message the service wrote for a person (a NetError's own text) is kept; the code's default otherwise.
  return {
    ...failure,
    error: message && message !== failure.code && !/^[a-z_]+$/.test(message) ? message : failure.error
  }
}
