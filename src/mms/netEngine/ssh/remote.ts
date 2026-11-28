import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { NetError } from '../../../shared/net/errors'
import type { NetEngineService } from '../NetEngineService'
import { findNetHelper } from '../helper/process'
import { engineControl, engineLimits } from '../limits'
import { prepare, type PrepareRequest, type PrepareStep } from './prepare'
import { SshRequestStore } from './requests'

/** The line `mousse-cli net-engine ssh` and `mousse-helper pipe` write before anything else (1b §3.3). */
export const SSH_MARKER = 'mousse-ssh/1'

/** What the daemon gives B's side of Add over SSH: its profiles and their engines. */
export interface SshRemoteHost {
  /** `MOUSSE_HOME`. */
  home: string
  profiles(): Array<{ id: string; label: string; root: string; active: boolean }>
  engine(profileId: string): Promise<NetEngineService>
  /** A new profile with `label`; answers its id. */
  createProfile(label: string): Promise<string>
  /** Whether Mousse starts at login for this OS account (`loginStart.startsAtLogin`). */
  startsAtLogin(): Promise<boolean> | boolean
}

const SELECTOR = /^[a-z2-7]{26}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new selector: 26 characters of `[a-z2-7]`, random. */
function newSelector(): string {
  return [...randomBytes(26)].map((byte) => BASE32[byte & 31]).join('')
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows: the folder's rights hold.
  }
}

/**
 * B's side of Add over SSH for one installation (1b §3.3, §3.4): `mousse-cli net-engine ssh` hands its request
 * here. It keeps each profile's selector, `endpoints.json` and the launchers under `MOUSSE_HOME`, the request
 * journal and its retention.
 */
export class SshRemote {
  private store?: SshRequestStore
  private timer?: ReturnType<typeof setInterval>
  /** A check stops B after a step of `prepare`, as a crash would. */
  crashAt?: (step: PrepareStep) => boolean
  /** Requests and removals of one remote computer run one at a time, on every profile. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly host: SshRemoteHost) {}

  get requests(): SshRequestStore {
    this.store ??= new SshRequestStore(join(this.host.home, 'net-engine', 'ssh-requests.db'))
    return this.store
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.store?.close()
    this.store = undefined
  }

  /** A profile's selector, made once (`<profile>/net-engine/selector`). */
  selectorOf(root: string): string {
    const file = join(root, 'net-engine', 'selector')
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (SELECTOR.test(value)) return value
    } catch {
      // None yet.
    }
    mkdirSync(join(root, 'net-engine'), { recursive: true })
    const made = newSelector()
    writePrivate(file, made)
    return made
  }

  private profileOf(selector: string) {
    return this.host.profiles().find((profile) => profile.active && this.selectorOf(profile.root) === selector)
  }

  /** Gives a profile's engine the journal and its selector (its removals mark requests, §3.6). */
  attach(engine: NetEngineService, root: string): void {
    engine.sshHost = {
      requests: this.requests,
      selector: () => this.selectorOf(root),
      locked: (joiner, work) => this.locked(joiner, work)
    }
  }

  /**
   * After ready, in the background: each profile's engine gets the journal, `endpoints.json` and the launchers are
   * written, and old request records go every `sshRequestPruneMs`.
   */
  async afterReady(): Promise<void> {
    for (const profile of this.host.profiles())
      if (profile.active) this.attach(await this.host.engine(profile.id), profile.root)
    this.writeEndpoints()
    this.writeLaunchers()
    this.prune()
    this.timer = setInterval(() => this.prune(), engineLimits().sshRequestPruneMs)
    this.timer.unref?.()
  }

  /** Request records past `sshRequestKeepSecs` go (§3.4 retry safety). */
  prune(): void {
    this.requests.prune(Date.now() / 1000 - engineLimits().sshRequestKeepSecs)
  }

  /**
   * `$MOUSSE_HOME/net-engine/endpoints.json` (owner-only): each profile's selector and its helper's state folder,
   * as `mousse-helper pipe --profile <selector>` reads it.
   */
  writeEndpoints(): void {
    const profiles: Record<string, { state: string; networking: boolean }> = {}
    for (const profile of this.host.profiles()) {
      if (!profile.active) continue
      profiles[this.selectorOf(profile.root)] = {
        state: join(profile.root, 'net-engine', 'endpoint'),
        networking: networkingOn(profile.root)
      }
    }
    mkdirSync(join(this.host.home, 'net-engine'), { recursive: true })
    writePrivate(join(this.host.home, 'net-engine', 'endpoints.json'), `${JSON.stringify({ profiles }, null, 2)}\n`)
  }

  /**
   * Stable launchers in `$MOUSSE_HOME/bin/` (§3.3): `mousse-helper` and `mousse-cli`, small scripts that set
   * `MOUSSE_HOME` and run this build's binaries, so an update never changes the SSH command. `sh` scripts on macOS
   * and Linux; `.cmd` files on Windows, which another computer's SSH session runs as `.\.mousse\bin\<name>.cmd`
   * from the profile folder (`windowsLauncherText`). A `.cmd` launcher that cannot be written safely is not written,
   * and the console says why.
   */
  writeLaunchers(): void {
    const bin = join(this.host.home, 'bin')
    mkdirSync(bin, { recursive: true })
    if (process.platform === 'win32') {
      const helper = findNetHelper()
      const targets: Array<[string, string[] | undefined]> = [
        ['mousse-helper', helper ? [helper] : undefined],
        ['mousse-cli', cliCommand()]
      ]
      for (const [name, target] of targets) {
        if (!target) continue
        const path = join(bin, `${name}.cmd`)
        const text = windowsLauncherText(this.host.home, target, process.env)
        if (text) writeLauncher(path, text)
        else {
          // A launcher left from an earlier install would run that install.
          rmSync(path, { force: true })
          console.warn(
            `ssh launcher ${name}.cmd not written: ${[this.host.home, ...target].join(' ')} has characters a .cmd file can't hold outside %USERPROFILE% and %LOCALAPPDATA%`
          )
        }
      }
      return
    }
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
    const home = `MOUSSE_HOME=${quote(this.host.home)}; export MOUSSE_HOME`
    const helper = findNetHelper()
    const cli = cliCommand()
    const script = (command: string) => `#!/bin/sh\n${home}\nexec ${command} "$@"\n`
    if (helper) writeLauncher(join(bin, 'mousse-helper'), script(quote(helper)))
    if (cli) writeLauncher(join(bin, 'mousse-cli'), script(cli.map(quote).join(' ')))
  }

  /** One request from `mousse-cli net-engine ssh`; answers its reply, or `{error}` with a §3.5 reason. */
  async serve(request: unknown): Promise<Record<string, unknown>> {
    try {
      if (!request || typeof request !== 'object') throw bad()
      const fields = request as Record<string, unknown>
      if (fields.op === 'profiles') return this.profilesReply()
      if (fields.op === 'prepare') return { ...(await this.prepare(fields)) }
      throw bad()
    } catch (error) {
      const reason =
        error instanceof NetError
          ? String((error.details as { reason?: unknown } | undefined)?.reason ?? error.code)
          : 'remote_failed'
      return { error: reason }
    }
  }

  private async profilesReply(): Promise<Record<string, unknown>> {
    const profiles = []
    for (const profile of this.host.profiles()) {
      if (!profile.active) continue
      const engine = await this.host.engine(profile.id)
      const identity = engine.status().identity
      // The control hides a profile already paired elsewhere, which the list must never do (PLAN).
      if (engineControl('refuse-if-paired') && engine.peerRows().some((row) => row.state !== 'removed'))
        continue
      profiles.push({
        selector: this.selectorOf(profile.root),
        label: profile.label,
        networking: networkingOn(profile.root),
        ...(identity ? { identity } : {})
      })
    }
    return {
      computer: hostname(),
      os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
      starts_at_login: await this.host.startsAtLogin(),
      profiles
    }
  }

  private async prepare(fields: Record<string, unknown>) {
    const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : undefined)
    const request: PrepareRequest = {
      requestId: text('request_id') ?? '',
      issuedAt: Number(fields.issued_at),
      joiner: (text('joiner') ?? '').toLowerCase(),
      joinerName: (text('joiner_name') ?? '').slice(0, 80),
      ...(text('selector') ? { selector: text('selector') } : {}),
      ...(text('new_label') ? { newLabel: text('new_label')!.slice(0, 80) } : {})
    }
    if (!Number.isSafeInteger(request.issuedAt) || !/^(?:[0-9a-f]{2}){1,256}$/.test(request.joiner)) throw bad()
    const limits = engineLimits()
    const reply = await prepare(
      {
        requests: this.requests,
        now: () => Date.now() / 1000,
        maxAgeSecs: limits.sshRequestMaxAgeSecs,
        hasProfile: (selector) => !!this.profileOf(selector),
        profileTagged: (tag) => {
          const tagged = this.host
            .profiles()
            .find((profile) => profile.active && readTag(profile.root) === tag)
          return tagged ? this.selectorOf(tagged.root) : undefined
        },
        createProfile: async (label, tag) => {
          const id = await this.host.createProfile(label)
          const root = this.host.profiles().find((profile) => profile.id === id)!.root
          mkdirSync(join(root, 'net-engine'), { recursive: true })
          if (tag) writePrivate(join(root, 'net-engine', 'ssh-request'), tag)
          return this.selectorOf(root)
        },
        engine: async (selector) => {
          const profile = this.profileOf(selector)
          if (!profile) throw new NetError('bad_request', 'That profile is gone.', { details: { reason: 'remote_no_endpoint' } })
          const engine = await this.host.engine(profile.id)
          this.attach(engine, profile.root)
          await engine.quietNetworking(limits.sshRequestDeadlineMs)
          this.writeEndpoints()
          return engine.prepareEngine()
        },
        locked: (joiner, work) => this.locked(joiner, work),
        startsAtLogin: () => this.host.startsAtLogin(),
        crashAt: (step) => !!this.crashAt?.(step)
      },
      request
    )
    return reply
  }

  /** Runs `work` under the lock of the remote computer `joiner`: its prepares, on any profile, and its removals (§3.6). */
  locked<T>(joiner: string, work: () => Promise<T>): Promise<T> {
    const key = joiner.toLowerCase()
    const before = this.locks.get(key) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(work)
    const held = run.catch(() => undefined)
    this.locks.set(key, held)
    void held.then(() => {
      if (this.locks.get(key) === held) this.locks.delete(key)
    })
    return run
  }
}

const bad = () => new NetError('bad_request', 'Bad request.', { details: { reason: 'bad_request' } })

function readTag(root: string): string | undefined {
  try {
    return readFileSync(join(root, 'net-engine', 'ssh-request'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function networkingOn(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, 'net-engine', 'settings.json'), 'utf8'))?.enabled === true
  } catch {
    return false
  }
}

function writeLauncher(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return
  writePrivate(path, text)
  chmodSync(path, 0o700)
}

/**
 * How this build's `mousse-cli` runs: `MOUSSE_NET_ENGINE_CLI` (a check's own command line, words split on spaces),
 * else the launcher an installed app ships beside its binary (`mousse-cli.cmd` on Windows).
 */
export function cliCommand(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string[] | undefined {
  const given = env.MOUSSE_NET_ENGINE_CLI?.trim()
  if (given) return given.split(/\s+/)
  const name = platform === 'darwin' ? '../Resources/mousse-cli' : platform === 'win32' ? 'mousse-cli.cmd' : 'mousse-cli'
  const beside = (platform === 'win32' ? win32 : posix).join(execPath, '..', name)
  return exists(beside) ? [beside] : undefined
}

/**
 * A path as `.cmd` text inside double quotes. `cmd` reads a `.cmd` file in the console's OEM code page, so only
 * printable ASCII is written as it is: a path under `%LOCALAPPDATA%` or `%USERPROFILE%` (exactly as this process
 * sees them; an SSH session of the same account gets the same values) is written relative to it, so a non-ASCII
 * user name is no problem. `%` is written `%%`, and `%%%%` on a `call` line, which expands it once more; `call` also
 * doubles `^`, so a `^` there cannot be written. Undefined when the path cannot be written.
 */
export function cmdPath(
  path: string,
  env: { USERPROFILE?: string; LOCALAPPDATA?: string },
  call = false
): string | undefined {
  const percent = call ? '%%%%' : '%%'
  const plain = (text: string) =>
    /^[\x20-\x7e]*$/.test(text) && !text.includes('"') && !(call && text.includes('^'))
      ? text.replace(/%/g, percent)
      : undefined
  for (const name of ['LOCALAPPDATA', 'USERPROFILE'] as const) {
    const base = env[name]
    // A `%` in the value itself would be expanded again by `call`.
    if (!base || (call && base.includes('%')) || !path.startsWith(`${base}\\`)) continue
    const rest = plain(path.slice(base.length))
    if (rest !== undefined) return `%${name}%${rest}`
  }
  return plain(path)
}

/**
 * A Windows launcher in `%MOUSSE_HOME%\bin` (1b §3.3): sets `MOUSSE_HOME` to exactly `home` (the daemon's pipe name
 * is a digest of it) and runs `target` with the session's arguments, passing its exit code on. A `.cmd` target (the
 * app's own `mousse-cli.cmd`) is run with `call`, so control comes back. No label or parenthesized block, so `%*` is
 * expanded whatever the arguments are. Undefined when a path cannot be written (`cmdPath`).
 */
export function windowsLauncherText(
  home: string,
  target: readonly string[],
  env: { USERPROFILE?: string; LOCALAPPDATA?: string }
): string | undefined {
  if (!target.length) return undefined
  const call = /\.(?:cmd|bat)$/i.test(target[0]!)
  const homeText = cmdPath(home, env)
  const words = target.map((word) => cmdPath(word, env, call))
  if (homeText === undefined || words.some((word) => word === undefined)) return undefined
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "MOUSSE_HOME=${homeText}"`,
    `${call ? 'call ' : ''}${words.map((word) => `"${word}"`).join(' ')} %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
}
