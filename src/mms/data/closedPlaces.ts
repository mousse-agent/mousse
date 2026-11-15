import { readdirSync, realpathSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32 } from 'node:path'

/**
 * Places a bot's turn closes or reads by their real path: Mousse's own entries in the system's temporary folders, which a
 * bot's command sandbox closes (`mousseTempEntries`), and network paths that name this computer (`localPathOf`), which
 * the bot's file check turns into the local path they mean.
 */
/** A place Mousse must close can't be listed, so what to close isn't known. */
export class ClosedPlacesUnknown extends Error {}

/**
 * The folders and files Mousse keeps in the system's temporary folders `temps`, as they are now: every entry named
 * `mousse-…` (the ChatGPT token broker's socket folder, pasted bot attachments; for the seconds a task runs, a pull
 * request's text, the paths the owner stages, Git's trace of their hooks, an ACP agent's check), the owner's own
 * folders of that name included. A bot's sandbox closes them by name, read when its turn starts: a pattern can't stand
 * for them, since Codex's Linux sandbox lists a whole folder to expand one and refuses every command when any folder in
 * it can't be read, as some in `/tmp` never can.
 */
export function mousseTempEntries(temps: readonly string[]): string[] {
  const entries: string[] = []
  for (const temp of new Set(temps)) {
    let names: string[]
    try {
      names = readdirSync(temp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new ClosedPlacesUnknown('Mousse could not list a temporary folder.')
    }
    for (const name of names) if (name.startsWith('mousse-')) entries.push(join(temp, name))
  }
  return entries
}

/** Whether `place` is one of Mousse's entries in a temporary folder (`mousseTempEntries`): short-lived, most of them. */
export function isMousseTempEntry(place: string, temps: readonly string[] = defaultTemps(process.platform)): boolean {
  return basename(place).startsWith('mousse-') && temps.some((temp) => resolve(dirname(place)) === resolve(temp) || realOrSpelled(dirname(place)) === realOrSpelled(temp))
}

function defaultTemps(platform: NodeJS.Platform): string[] {
  return [tmpdir(), ...(platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])]
}

/**
 * A path that names this computer over the network (Windows): its UNC form (`\\host\share\…`, `\\?\UNC\host\share\…`,
 * with `/` or `\`), or a device path to a drive (`\\?\C:\…`, `\\.\C:\…`), as the local path it means. `host` is this
 * computer when it is `localhost`, a loopback or unspecified address in any IPv4 or IPv6 form (`[::1]`,
 * `0--1.ipv6-literal.net`, `::ffff:127.0.0.1`), one of this computer's own addresses in any of those forms, or one of
 * its names (alone, with a domain after it, or with a final dot). Its administrative drive share (`C$`) and `ADMIN$` are
 * turned into the drive and the Windows folder; any other share on this computer, a numeric host Windows would read in
 * a way not listed here, and any other device path, is refused, since it can't be turned into a local path with
 * certainty. So is a path on any other host whose volume is one of this computer's own (`ThisComputer.ownVolume`): a name
 * this computer doesn't know it goes by (a DNS name that points back to it). A UNC path to another computer, or one that
 * can't be reached, is an ordinary network file.
 */
export type LocalPathOf = { kind: 'plain' } | { kind: 'local'; path: string } | { kind: 'remote' } | { kind: 'refused' }

export interface ThisComputer {
  /** Names, lower case. */
  names: string[]
  /** Addresses, lower case, without a zone (`canonicalAddress` is applied when they are compared). */
  addresses: string[]
  /** The Windows folder (`%SystemRoot%`), for `ADMIN$`. */
  windows: string
  /**
   * Whether a network path is on one of this computer's own volumes: the volume serial number Windows reports through
   * the share for the deepest part of the path that exists is one of this computer's local drives'. A path that can't be
   * reached is not. Absent: not checked.
   */
  ownVolume?: (path: string) => boolean
}

export function thisComputer(env: Readonly<Record<string, string | undefined>> = process.env): ThisComputer {
  const names = new Set<string>(['localhost'])
  for (const name of [safe(() => hostname()), env.COMPUTERNAME]) if (name) names.add(name.toLowerCase())
  const addresses = new Set<string>()
  for (const list of Object.values(safe(() => networkInterfaces()) ?? {}))
    for (const address of list ?? []) addresses.add(normalAddress(address.address))
  return { names: [...names], addresses: [...addresses], windows: env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows', ownVolume: onLocalVolume }
}

/** `ThisComputer.ownVolume` on the real file system. */
export function onLocalVolume(path: string): boolean {
  const volume = volumeOf(path)
  return volume !== undefined && localVolumes().has(volume)
}

/** The volume serial number of the deepest part of `path` that exists, or undefined when none can be read. */
function volumeOf(path: string): bigint | undefined {
  for (let at = path; ; ) {
    try {
      return statSync(at, { bigint: true }).dev
    } catch {
      const parent = win32.dirname(at)
      if (parent === at) return undefined
      at = parent
    }
  }
}

/** The volume serial numbers of this computer's drives, without the drives mapped to a network share. */
function localVolumes(): Set<bigint> {
  const volumes = new Set<bigint>()
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (realpathSync.native(root).startsWith('\\\\')) continue
      volumes.add(statSync(root, { bigint: true }).dev)
    } catch {
      // No such drive, or no disk in it.
    }
  }
  return volumes
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function normalAddress(address: string): string {
  return address.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '')
}

/**
 * One spelling per address: an IPv4 address as it is; an IPv6 address that carries an IPv4 one (`::ffff:a.b.c.d`, and the
 * older `::a.b.c.d`) as that IPv4 address; any other IPv6 address with every group written out. Anything else unchanged.
 */
function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) return address
  const groups = expandIPv6(address)
  if (!groups) return address
  const zeros = groups.slice(0, 5).every((group) => group === 0)
  const carried = zeros && (groups[5] === 0xffff || (groups[5] === 0 && (groups[6] !== 0 || groups[7]! > 1)))
  if (carried) return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.')
  return groups.map((group) => group.toString(16)).join(':')
}

/** Whether an address (`canonicalAddress`) is a loopback or unspecified one: `127.0.0.0/8`, `0.0.0.0`, `::1`, `::`. */
function loopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.') || address === '0.0.0.0'
  return address === '0:0:0:0:0:0:0:1' || address === '0:0:0:0:0:0:0:0'
}

function expandIPv6(address: string): number[] | undefined {
  let text = address
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const parts = v4[1]!.split('.').map(Number)
    if (parts.some((part) => part > 255)) return undefined
    text = text.slice(0, -v4[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const read = (part: string | undefined) => (part ? part.split(':').filter(Boolean).map((group) => parseInt(group, 16)) : [])
  const front = read(head)
  const back = read(tail)
  const fill = text.includes('::') ? 8 - front.length - back.length : 0
  const groups = [...front, ...Array(Math.max(fill, 0)).fill(0), ...back]
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined
}

export function localPathOf(raw: string, computer: ThisComputer = thisComputer()): LocalPathOf {
  const path = raw.replace(/\//g, '\\')
  if (!path.startsWith('\\\\')) return { kind: 'plain' }
  let unc: string
  const device = /^\\\\[?.]\\(.*)$/s.exec(path)
  if (device) {
    const rest = device[1]!
    const uncDevice = /^UNC\\(.*)$/is.exec(rest)
    if (!uncDevice) return /^[A-Za-z]:(\\|$)/.test(rest) ? { kind: 'local', path: win32.normalize(rest.length === 2 ? `${rest}\\` : rest) } : { kind: 'refused' }
    unc = uncDevice[1]!
  } else unc = path.slice(2)
  const [rawHost = '', share = '', ...rest] = unc.split('\\')
  if (!rawHost || !share) return { kind: 'refused' }
  let host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  // The IPv6 literal form Windows takes in UNC paths: `fe80--1s4.ipv6-literal.net` is `fe80::1%4`.
  const literal = /^(.*)\.ipv6-literal\.net$/.exec(host)
  if (literal) host = literal[1]!.replace(/-/g, ':').replace(/s(\d+)$/, '%$1')
  host = canonicalAddress(normalAddress(host))
  const named = computer.names.some((name) => host === name || host.startsWith(`${name}.`))
  const local = named || loopbackAddress(host) || computer.addresses.some((address) => canonicalAddress(address) === host)
  if (!local) {
    // A host Windows would read as a number though it is no plain address (`127.1`, `2130706433`, `0x7f.1`, `0177.0.0.1`):
    // it may be this computer, so it is not certain.
    if (/^((0x[0-9a-f]+|\d+)\.){0,3}(0x[0-9a-f]+|\d+)$/.test(host) && (isIP(host) !== 4 || /(^|\.)0\d/.test(host))) return { kind: 'refused' }
    if (computer.ownVolume?.(`\\\\${unc}`)) return { kind: 'refused' }
    return { kind: 'remote' }
  }
  const after = rest.join('\\')
  const drive = /^([A-Za-z])\$$/.exec(share)
  if (drive) return { kind: 'local', path: win32.normalize(`${drive[1]!.toUpperCase()}:\\${after}`) }
  if (share.toLowerCase() === 'admin$') return { kind: 'local', path: win32.normalize(win32.join(computer.windows, after)) }
  return { kind: 'refused' }
}

/** The real path of a folder that may not exist: the real path of the deepest folder that does, and the rest as it is. */
function realOrSpelled(place: string): string {
  const rest: string[] = []
  let current = resolve(place)
  for (;;) {
    try {
      return rest.length ? join(realpathSync.native(current), ...rest) : realpathSync.native(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(place)
      rest.unshift(basename(current))
      current = parent
    }
  }
}
