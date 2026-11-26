import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { UserAction } from './gitPolicy'
import { mousseGitEnv } from './gitEnv'
import { execRunner, ghFallbackPaths, isMissingExecutable, processMessage, type ExecutableRunner } from './ghRunner'
import type {
  SourceControlInstall,
  SourceControlOperation,
  SourceControlProviderStatus,
  SourceRepository,
  SourceRepositoryList
} from '../../shared/sourceControl'

const HOST = 'github.com'
const DEVICE_URL = 'https://github.com/login/device'
const INSTALL_URL = 'https://github.com/cli/cli#installation'
/** A status read this recent is answered again without running gh. */
const STATUS_TTL_MS = 30_000
/** The repository list is read again after this long, or on Refresh. */
const REPOSITORIES_TTL_MS = 5 * 60_000
/** A device code lasts 15 minutes; a sign-in still running after that is stopped. */
const LOGIN_LIMIT_MS = 16 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** A running `gh auth login`: its output as it comes, and its end. */
export interface LoginProcess {
  onOutput(listener: (text: string) => void): void
  onExit(listener: (code: number | null, error?: Error) => void): void
  kill(): void
}

export type LoginSpawner = (executable: string, args: readonly string[]) => LoginProcess

const spawnLogin: LoginSpawner = (executable, args) => {
  // No terminal on stdin: gh signs in without asking anything and prints the code and the address instead of opening a browser.
  const child = spawn(executable, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: mousseGitEnv({ ...process.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' })
  })
  return {
    onOutput: (listener) => {
      child.stdout?.setEncoding('utf8').on('data', listener)
      child.stderr?.setEncoding('utf8').on('data', listener)
    },
    onExit: (listener) => {
      let ended = false
      child.once('error', (error) => { if (!ended) { ended = true; listener(null, error) } })
      child.once('close', (code) => { if (!ended) { ended = true; listener(code) } })
    },
    kill: () => { child.kill() }
  }
}

/** The code and address `gh auth login --web` prints when it cannot open a browser itself. */
export function parseDeviceCode(output: string): { code?: string; url?: string } {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1]?.toUpperCase()
  const url = /(https:\/\/[^\s]+\/login\/device)\b/.exec(text)?.[1]
  return { ...(code ? { code } : {}), ...(url ? { url } : {}) }
}

/** The account `gh auth status` names for github.com, in the words of old and new gh. */
export function parseAccount(output: string): string | undefined {
  return /Logged in to github\.com (?:account|as) ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/.exec(output)?.[1]
}

/** The last lines of gh's own error, for a failed sign-in or install. */
function failure(text: string, fallback: string): string {
  const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const kept = lines.filter((line) => !/one-time code|login\/device|Press Enter|Open this URL/i.test(line))
  return kept.slice(-3).join(' ') || fallback
}

interface Dependencies {
  run?: ExecutableRunner
  spawnLogin?: LoginSpawner
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  now?: () => number
}

interface Operation extends SourceControlOperation {
  cancelled: boolean
  process?: LoginProcess
}

/**
 * This computer's GitHub account, as GitHub CLI (gh) holds it: whether gh is installed and signed in, Connect (install
 * gh with the platform's package manager when it is missing, then `gh auth login --web`, whose one-time code the window
 * shows), Sign out, and the account's repositories. The sign-in is gh's own, so a gh the person already signed in to
 * is used as it is, and terminals and Git (through `gh auth setup-git`) use the same account.
 */
export class GitHubAccount {
  private readonly run: ExecutableRunner
  private readonly spawnLogin: LoginSpawner
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly exists: (path: string) => boolean
  private readonly now: () => number
  private cached: { status: SourceControlProviderStatus; at: number } | null = null
  private reading: Promise<SourceControlProviderStatus> | null = null
  private operation: Operation | null = null
  private lastError: string | undefined
  private repositories: { list: SourceRepositoryList; account: string } | null = null
  private listing: Promise<SourceRepositoryList> | null = null

  constructor(dependencies: Dependencies = {}) {
    this.run = dependencies.run ?? execRunner
    this.spawnLogin = dependencies.spawnLogin ?? spawnLogin
    this.platform = dependencies.platform ?? process.platform
    this.env = dependencies.env ?? process.env
    this.exists = dependencies.exists ?? existsSync
    this.now = dependencies.now ?? Date.now
  }

  /** The account now; read again when `refresh`, after a change, or once the last read is half a minute old. */
  async status(refresh = false): Promise<SourceControlProviderStatus> {
    if (this.operation) return this.withOperation(this.cached?.status ?? { id: 'github', name: 'GitHub', state: 'signed-out' })
    if (!refresh && this.cached && this.now() - this.cached.at < STATUS_TTL_MS) return this.withOperation(this.cached.status)
    if (!this.reading) {
      this.reading = this.read().finally(() => { this.reading = null })
    }
    return this.withOperation(await this.reading)
  }

  /**
   * Starts Connect, or answers the one already running: installs gh when it is missing and the platform's package
   * manager can, then signs in. The answer comes at once; `status` follows the operation.
   */
  async connect(userRequested: UserAction): Promise<SourceControlProviderStatus> {
    if (this.operation) return this.status()
    const before = await this.status(true)
    if (before.state === 'connected') return before
    if (before.state === 'missing' && !before.install?.automatic) {
      throw new Error('Install GitHub CLI first, then connect again.')
    }
    const operation: Operation = { id: randomUUID(), phase: before.state === 'missing' ? 'installing' : 'starting', cancelled: false }
    this.operation = operation
    this.lastError = undefined
    void this.runConnect(operation, before, userRequested)
    return this.status()
  }

  /** Stops a Connect that is running; whatever it installed stays. */
  cancel(): Promise<SourceControlProviderStatus> {
    const operation = this.operation
    if (operation) {
      operation.cancelled = true
      operation.process?.kill()
      this.end(operation)
    }
    return this.status(true)
  }

  async signOut(userRequested: UserAction): Promise<SourceControlProviderStatus> {
    if (this.operation) throw new Error('Wait for Connect to finish, or cancel it.')
    const current = await this.status(true)
    if (current.state !== 'connected') return current
    const gh = await this.locate()
    if (!gh) return this.status(true)
    const base = ['auth', 'logout', '--hostname', HOST]
    try {
      await this.run(gh, current.account ? [...base, '--user', current.account] : base, { userRequested })
    } catch (error) {
      // gh from before accounts (2.40) knows no --user, and with one account it needs none.
      if (!current.account || !/unknown flag/i.test(processMessage(error))) throw new Error(`GitHub sign-out failed: ${processMessage(error)}`)
      await this.run(gh, base, { userRequested })
    }
    this.repositories = null
    return this.status(true)
  }

  /**
   * The repositories the account owns, collaborates on or reaches through its organizations, most recently pushed
   * first (one page of 100). Answered from memory for five minutes; `refresh` reads again.
   */
  async listRepositories(refresh = false): Promise<SourceRepositoryList> {
    const current = await this.status()
    if (current.state !== 'connected' || !current.account) return { repositories: [], fetchedAt: this.now() }
    const kept = this.repositories
    if (!refresh && kept && kept.account === current.account && this.now() - kept.list.fetchedAt < REPOSITORIES_TTL_MS) return kept.list
    if (!this.listing) {
      const account = current.account
      this.listing = this.readRepositories()
        .then((list) => {
          this.repositories = { list, account }
          return list
        })
        .finally(() => { this.listing = null })
    }
    return this.listing
  }

  private async readRepositories(): Promise<SourceRepositoryList> {
    const gh = await this.locate()
    if (!gh) return { repositories: [], fetchedAt: this.now() }
    const result = await this.run(gh, [
      'api',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '[.[] | {n: .full_name, p: .private, d: .description, u: .pushed_at, f: .fork}]'
    ])
    const rows: unknown = JSON.parse(result.stdout || '[]')
    const repositories: SourceRepository[] = []
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue
      const value = row as { n?: unknown; p?: unknown; d?: unknown; u?: unknown; f?: unknown }
      if (typeof value.n !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value.n)) continue
      repositories.push({
        nameWithOwner: value.n,
        private: value.p === true,
        ...(typeof value.d === 'string' && value.d ? { description: value.d.slice(0, 300) } : {}),
        ...(typeof value.u === 'string' ? { pushedAt: value.u } : {}),
        ...(value.f === true ? { fork: true } : {})
      })
    }
    return { repositories, fetchedAt: this.now() }
  }

  private withOperation(status: SourceControlProviderStatus): SourceControlProviderStatus {
    const operation = this.operation
    const error = status.state === 'connected' ? undefined : this.lastError ?? status.error
    return {
      ...status,
      ...(operation ? { operation: { id: operation.id, phase: operation.phase, ...(operation.code ? { code: operation.code } : {}), ...(operation.url ? { url: operation.url } : {}) } } : {}),
      ...(error && !operation ? { error } : {})
    }
  }

  /** gh by name, or where it usually is when the PATH Mousse started with does not have it. */
  private async locate(): Promise<string | null> {
    const candidates = ['gh', ...ghFallbackPaths(this.platform, this.env).filter((path) => this.exists(path))]
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        await this.run(candidate, ['--version'])
        return candidate
      } catch (error) {
        if (!isMissingExecutable(error)) {
          lastError = error
          break
        }
      }
    }
    if (lastError) throw lastError
    return null
  }

  private async read(): Promise<SourceControlProviderStatus> {
    const base = { id: 'github', name: 'GitHub' } as const
    let status: SourceControlProviderStatus
    try {
      const gh = await this.locate()
      if (!gh) {
        status = { ...base, state: 'missing', install: await this.installer() }
      } else {
        try {
          const result = await this.run(gh, ['auth', 'status', '--hostname', HOST])
          const account = parseAccount(`${result.stdout}\n${result.stderr}`)
          status = { ...base, state: 'connected', ...(account ? { account } : {}) }
        } catch {
          status = { ...base, state: 'signed-out' }
        }
      }
    } catch (error) {
      status = { ...base, state: 'error', error: `Could not run GitHub CLI: ${processMessage(error)}` }
    }
    this.cached = { status, at: this.now() }
    return status
  }

  /** How Connect would install gh here: winget on Windows, Homebrew on macOS and Linux, or by hand. */
  private async installer(): Promise<SourceControlInstall> {
    if (this.platform === 'win32') {
      try {
        await this.run('winget', ['--version'])
        return { via: 'winget', automatic: true, command: 'winget install --id GitHub.cli --exact --source winget', url: INSTALL_URL }
      } catch {
        return { via: 'manual', automatic: false, url: INSTALL_URL }
      }
    }
    const brew = await this.brew()
    if (brew) return { via: 'brew', automatic: true, command: 'brew install gh', url: INSTALL_URL }
    return { via: 'manual', automatic: false, url: INSTALL_URL }
  }

  private async brew(): Promise<string | null> {
    const candidates = ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']
    for (const candidate of candidates) {
      if (candidate !== 'brew' && !this.exists(candidate)) continue
      try {
        await this.run(candidate, ['--version'])
        return candidate
      } catch {
        // Next place.
      }
    }
    return null
  }

  private async install(userRequested: UserAction): Promise<void> {
    if (this.platform === 'win32') {
      await this.run('winget', [
        'install', '--id', 'GitHub.cli', '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
      ], { userRequested, timeoutMs: INSTALL_TIMEOUT_MS })
      return
    }
    const brew = await this.brew()
    if (!brew) throw new Error('Homebrew was not found. Install GitHub CLI yourself, then connect again.')
    await this.run(brew, ['install', 'gh'], { userRequested, timeoutMs: INSTALL_TIMEOUT_MS, env: { HOMEBREW_NO_AUTO_UPDATE: '1' } })
  }

  private async runConnect(operation: Operation, before: SourceControlProviderStatus, userRequested: UserAction): Promise<void> {
    try {
      if (before.state === 'missing') {
        try {
          await this.install(userRequested)
        } catch (error) {
          throw new Error(`Installing GitHub CLI failed: ${failure(processMessage(error), 'the installer stopped')}`)
        }
        if (operation.cancelled) return
        operation.phase = 'starting'
      }
      const gh = await this.locate()
      if (!gh) throw new Error('GitHub CLI was installed, but Mousse cannot find it yet. Restart Mousse, then connect again.')
      if (operation.cancelled) return
      await this.signIn(operation, gh)
      if (operation.cancelled) return
      operation.phase = 'finishing'
      // Git then uses the same account for fetch and push, as gh's own interactive sign-in offers by default.
      await this.run(gh, ['auth', 'setup-git', '--hostname', HOST], { userRequested }).catch(() => undefined)
      this.repositories = null
      this.end(operation)
      await this.status(true)
    } catch (error) {
      if (operation.cancelled) return
      this.end(operation)
      this.lastError = error instanceof Error ? error.message : String(error)
      await this.status(true).catch(() => undefined)
    }
  }

  private signIn(operation: Operation, gh: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let output = ''
      const child = this.spawnLogin(gh, ['auth', 'login', '--web', '--hostname', HOST, '--git-protocol', 'https'])
      operation.process = child
      const limit = setTimeout(() => {
        child.kill()
        reject(new Error('The sign-in code expired. Connect again for a new one.'))
      }, LOGIN_LIMIT_MS)
      limit.unref?.()
      child.onOutput((text) => {
        output = `${output}${text}`.slice(-8_000)
        const found = parseDeviceCode(output)
        if (found.code && !operation.code) {
          operation.code = found.code
          operation.url = found.url ?? DEVICE_URL
          operation.phase = 'code'
        }
      })
      child.onExit((code, error) => {
        clearTimeout(limit)
        operation.process = undefined
        if (operation.cancelled) return resolve()
        if (error) return reject(new Error(`Could not start GitHub CLI: ${error.message}`))
        if (code === 0) return resolve()
        reject(new Error(`GitHub sign-in failed: ${failure(output, `gh exited with ${code}`)}`))
      })
    })
  }

  private end(operation: Operation): void {
    if (this.operation === operation) this.operation = null
    this.cached = null
  }
}
