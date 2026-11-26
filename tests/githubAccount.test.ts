import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccount, parseAccount, parseDeviceCode, type LoginProcess } from '../src/mms/git/GitHubAccount'
import type { ExecutableRunner } from '../src/mms/git/ghRunner'

// gh's output below is hand-authored from gh's own source (pkg/cmd/auth/status and internal/authflow): it proves
// Mousse's side only. No test signs in to a real account.
const STATUS_NEW = 'github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Active account: true\n'
const STATUS_OLD = 'github.com\n  ✓ Logged in to github.com as octo-cat (oauth_token)\n'
const NOT_LOGGED_IN = 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
const DEVICE = '! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n'

const missing = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
const failed = (stderr: string) => Object.assign(new Error('exit 1'), { stderr })
const action = { via: 'button', label: 'Connect GitHub' } as const

/** A computer's programs: which exist, and what gh answers. */
function computer(options: { gh?: 'path' | 'program-files' | 'none'; signedIn?: boolean; winget?: boolean; brew?: boolean; platform?: NodeJS.Platform; install?: Promise<void> } = {}) {
  const state = { gh: options.gh ?? 'path', signedIn: options.signedIn ?? false }
  const calls: string[] = []
  const programFiles = 'C:\\Program Files\\GitHub CLI\\gh.exe'
  const run = vi.fn<ExecutableRunner>(async (executable, args) => {
    calls.push([executable, ...args].join(' '))
    const isGh = (executable === 'gh' && state.gh === 'path') || (executable === programFiles && state.gh === 'program-files')
    if (executable === 'winget') {
      if (!options.winget) throw missing()
      if (args[0] === 'install') {
        await options.install
        state.gh = 'program-files'
      }
      return { stdout: 'v1.9', stderr: '' }
    }
    if (executable === 'brew' || executable.endsWith('/brew')) {
      if (!options.brew) throw missing()
      if (args[0] === 'install') state.gh = 'path'
      return { stdout: 'Homebrew 4', stderr: '' }
    }
    if (!isGh) throw missing()
    const command = args.slice(0, 2).join(' ')
    if (args[0] === '--version') return { stdout: 'gh version 2.63.0', stderr: '' }
    if (command === 'auth status') {
      if (!state.signedIn) throw failed(NOT_LOGGED_IN)
      return { stdout: STATUS_NEW, stderr: '' }
    }
    if (command === 'auth logout') {
      state.signedIn = false
      return { stdout: '', stderr: '✓ Logged out of github.com account octo-cat' }
    }
    if (command === 'auth setup-git') return { stdout: '', stderr: '' }
    if (args[0] === 'api') {
      return {
        stdout: JSON.stringify([
          { n: 'octo-cat/notes', p: true, d: 'Notes', u: '2026-11-20T10:00:00Z', f: false },
          { n: 'acme/web-app', p: false, d: null, u: '2026-11-19T10:00:00Z', f: true },
          { n: 'not a repository', p: false }
        ]),
        stderr: ''
      }
    }
    throw new Error(`unexpected ${executable} ${args.join(' ')}`)
  })
  const logins: { executable: string; args: readonly string[]; output: (text: string) => void; exit: (code: number) => void; killed: boolean }[] = []
  const spawnLogin = vi.fn((executable: string, args: readonly string[]): LoginProcess => {
    const login = { executable, args, output: (_text: string) => {}, exit: (_code: number) => {}, killed: false }
    logins.push(login)
    return {
      onOutput: (listener) => { login.output = listener },
      onExit: (listener) => {
        login.exit = (code) => {
          if (code === 0) state.signedIn = true
          listener(code)
        }
      },
      kill: () => { login.killed = true }
    }
  })
  const account = new GitHubAccount({
    run,
    spawnLogin,
    platform: options.platform ?? 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: (path) => path === programFiles && state.gh === 'program-files'
  })
  return { account, run, calls, logins, state }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('what gh prints', () => {
  it.each([
    [STATUS_NEW, 'octo-cat'],
    [STATUS_OLD, 'octo-cat'],
    ['github.com\n  X Failed to log in to github.com account octo-cat (keyring)', undefined]
  ])('account in %j', (text, expected) => {
    expect(parseAccount(text)).toBe(expected)
  })

  it('reads the code and address of a web sign-in, with or without colour', () => {
    expect(parseDeviceCode(DEVICE)).toEqual({ code: 'AB12-CD34', url: 'https://github.com/login/device' })
    expect(parseDeviceCode('\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[1mWXYZ-0001\u001b[0m')).toEqual({ code: 'WXYZ-0001' })
    expect(parseDeviceCode('- Waiting for authentication...')).toEqual({})
  })
})

describe('GitHub account', () => {
  it('uses a gh that is already signed in as it is: connected, with no sign-in started', async () => {
    const { account, logins } = computer({ signedIn: true })
    expect(await account.status()).toMatchObject({ state: 'connected', account: 'octo-cat' })
    expect(await account.connect(action)).toMatchObject({ state: 'connected', account: 'octo-cat' })
    expect(logins).toHaveLength(0)
  })

  it.each([
    ['win32', { winget: true }, { via: 'winget', automatic: true, command: 'winget install --id GitHub.cli --exact --source winget' }],
    ['win32', {}, { via: 'manual', automatic: false }],
    ['darwin', { brew: true }, { via: 'brew', automatic: true, command: 'brew install gh' }],
    ['linux', {}, { via: 'manual', automatic: false }]
  ] as const)('without gh on %s, says how Connect would install it', async (platform, tools, install) => {
    const { account } = computer({ gh: 'none', platform, ...tools })
    const status = await account.status()
    expect(status.state).toBe('missing')
    expect(status.install).toMatchObject(install)
  })

  it('signs in with a one-time code, then sets Git up to use the account', async () => {
    const { account, logins, calls } = computer()
    expect((await account.connect(action)).operation).toMatchObject({ phase: 'starting' })
    await settle()
    expect(logins).toHaveLength(1)
    expect(logins[0]!.args).toEqual(['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'])
    logins[0]!.output(DEVICE)
    expect((await account.status()).operation).toMatchObject({ phase: 'code', code: 'AB12-CD34', url: 'https://github.com/login/device' })
    logins[0]!.exit(0)
    await settle()
    await settle()
    const after = await account.status()
    expect(after).toMatchObject({ state: 'connected', account: 'octo-cat' })
    expect(after.operation).toBeUndefined()
    expect(calls).toContain('gh auth setup-git --hostname github.com')
  })

  it('installs gh with winget first when it is missing, and finds it where winget put it', async () => {
    const { account, logins, run } = computer({ gh: 'none', winget: true })
    expect((await account.connect(action)).operation).toMatchObject({ phase: 'installing' })
    await settle()
    await settle()
    expect(run).toHaveBeenCalledWith('winget', expect.arrayContaining(['install', '--id', 'GitHub.cli']), expect.objectContaining({ userRequested: action }))
    expect(logins[0]!.executable).toBe('C:\\Program Files\\GitHub CLI\\gh.exe')
  })

  it('refuses to connect when gh is missing and nothing here can install it', async () => {
    const { account, logins } = computer({ gh: 'none', platform: 'linux' })
    await expect(account.connect(action)).rejects.toThrow(/Install GitHub CLI first/)
    expect(logins).toHaveLength(0)
  })

  it("keeps gh's reason when the sign-in fails, and Cancel stops a sign-in without one", async () => {
    const { account, logins } = computer()
    await account.connect(action)
    await settle()
    logins[0]!.output('error: authorization was denied\n')
    logins[0]!.exit(1)
    await settle()
    await settle()
    const failedStatus = await account.status()
    expect(failedStatus).toMatchObject({ state: 'signed-out', error: expect.stringContaining('authorization was denied') })
    expect(failedStatus.operation).toBeUndefined()

    await account.connect(action)
    await settle()
    const cancelled = await account.cancel()
    expect(logins[1]!.killed).toBe(true)
    expect(cancelled.operation).toBeUndefined()
    expect(cancelled.error).toBeUndefined()
  })

  it('starts one Connect when two arrive at once, and Cancel stops it', async () => {
    const { account, logins } = computer()
    const [first, second] = await Promise.all([account.connect(action), account.connect(action)])
    expect(second.operation?.id).toBe(first.operation?.id)
    await settle()
    expect(logins).toHaveLength(1)
    await account.cancel()
    expect(logins[0]!.killed).toBe(true)
    expect((await account.status()).operation).toBeUndefined()
  })

  it('lets an install finish after Cancel, then stops; Connect again during it joins the same install', async () => {
    let release = () => {}
    const { account, logins, calls } = computer({ gh: 'none', winget: true, install: new Promise<void>((resolve) => { release = resolve }) })
    await account.connect(action)
    await settle()
    const installs = () => calls.filter((call) => call.startsWith('winget install')).length
    expect((await account.connect(action)).operation).toMatchObject({ phase: 'installing' })
    expect(installs()).toBe(1)
    // Cancelled mid-install: the installer is left to finish, and the row says so.
    expect((await account.cancel()).operation).toMatchObject({ phase: 'installing', stopping: true })
    release()
    await settle()
    await settle()
    expect(logins).toHaveLength(0)
    expect((await account.status()).operation).toBeUndefined()
    expect(installs()).toBe(1)
  })

  it('goes on to the sign-in when Connect is pressed again before a cancelled install ends', async () => {
    let release = () => {}
    const { account, logins, calls } = computer({ gh: 'none', winget: true, install: new Promise<void>((resolve) => { release = resolve }) })
    await account.connect(action)
    await settle()
    await account.cancel()
    expect((await account.connect(action)).operation?.stopping).toBeUndefined()
    release()
    await settle()
    await settle()
    expect(logins).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith('winget install'))).toHaveLength(1)
  })

  it('signs out the account it shows', async () => {
    const { account, calls } = computer({ signedIn: true })
    expect(await account.signOut(action)).toMatchObject({ state: 'signed-out' })
    expect(calls).toContain('gh auth logout --hostname github.com --user octo-cat')
  })

  it('lists the repositories once and answers again from memory until Refresh', async () => {
    const { account, calls } = computer({ signedIn: true })
    const first = await account.listRepositories()
    expect(first.repositories).toEqual([
      { nameWithOwner: 'octo-cat/notes', private: true, description: 'Notes', pushedAt: '2026-11-20T10:00:00Z' },
      { nameWithOwner: 'acme/web-app', private: false, pushedAt: '2026-11-19T10:00:00Z', fork: true }
    ])
    await account.listRepositories()
    expect(calls.filter((call) => call.startsWith('gh api'))).toHaveLength(1)
    await account.listRepositories(true)
    expect(calls.filter((call) => call.startsWith('gh api'))).toHaveLength(2)
  })

  it('lists nothing while signed out, without calling GitHub', async () => {
    const { account, calls } = computer()
    expect((await account.listRepositories()).repositories).toEqual([])
    expect(calls.some((call) => call.startsWith('gh api'))).toBe(false)
  })
})
