/**
 * "Start Mousse at login so your other computers can reach this one?" (Phase 1b design §10): asked once per
 * installation when networking is turned on and the startup entry is not installed; "Start at login" installs the
 * existing entry (the path `mousse-cli service install` takes), "Not now" installs nothing; the answer is kept. The
 * startup module is faked: nothing is installed on this computer.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({
  installed: false,
  failInstall: false,
  installStartup: vi.fn(),
  startupStatus: vi.fn()
}))
vi.mock('../../src/mms/startup', () => ({
  detectPlatform: () => 'linux-systemd',
  uninstallStartup: vi.fn(),
  installStartup: startup.installStartup,
  startupStatus: startup.startupStatus
}))

const { LoginStartQuestion, loginStartFile, startsAtLogin, startupEntry } = await import(
  '../../src/mms/netEngine/loginStart'
)
const { NetEngineService } = await import('../../src/mms/netEngine/NetEngineService')
const { registerNetEngineMethods } = await import('../../src/mms/netEngine/registerMethods')
const { DomainHandlerRegistry } = await import('../../src/mms/protocol/domainRegistry')
const { NET_LOCAL_CAPABILITY } = await import('../../src/shared/net/local')

const root = mkdtempSync(join(tmpdir(), 'login-start-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const home = () => join(root, `home-${++n}`)

beforeEach(() => {
  startup.installed = false
  startup.failInstall = false
  startup.installStartup.mockReset().mockImplementation(async () => {
    if (startup.failInstall) throw new Error('launchctl bootstrap and load both failed')
    startup.installed = true
  })
  startup.startupStatus
    .mockReset()
    .mockImplementation(async () => ({ installed: startup.installed, detail: '' }))
})

describe('the start-at-login question', () => {
  const question = (at: string) => new LoginStartQuestion(loginStartFile(at), startupEntry(at))

  // Inputs: the entry installed or not, or unreadable; an answer kept from before or not; a restart between asking
  // and answering; an install that fails.
  it.each([
    ['the entry is not installed', false, true],
    ['the entry is installed', true, false]
  ])('when %s, asks: %s', async (_name, installed, asks) => {
    startup.installed = installed
    const q = question(home())
    expect(await q.turnedOn()).toBe(asks)
    expect(q.asking()).toBe(asks)
  })

  it('asks nothing when the entry cannot be read, and asks the next time it can', async () => {
    const q = question(home())
    startup.startupStatus.mockRejectedValueOnce(new Error('launchctl not found'))
    expect(await q.turnedOn()).toBe(false)
    expect(await q.turnedOn()).toBe(true)
  })

  it('"Start at login" installs the existing entry for this installation, once, and is not asked again', async () => {
    const at = home()
    const q = question(at)
    await q.turnedOn()
    await q.answer(true)
    expect(startup.installStartup).toHaveBeenCalledTimes(1)
    // The entry `mousse-cli service install` writes: the CLI to run and this installation's home, nothing else.
    const [opts] = startup.installStartup.mock.calls[0]!
    expect(opts.homeDir).toBe(at)
    expect(typeof opts.cliPath).toBe('string')
    expect(opts.environment).toBeUndefined()
    expect(q.asking()).toBe(false)
    // Turned off and on again, or another profile turned on: not asked, nothing installed again.
    startup.installed = false
    expect(await q.turnedOn()).toBe(false)
    expect(await question(at).turnedOn()).toBe(false)
    expect(startup.installStartup).toHaveBeenCalledTimes(1)
  })

  it('"Not now" installs nothing and is remembered across restarts', async () => {
    const at = home()
    const q = question(at)
    await q.turnedOn()
    await q.answer(false)
    expect(startup.installStartup).not.toHaveBeenCalled()
    expect(await question(at).turnedOn()).toBe(false)
    expect(JSON.parse(readFileSync(loginStartFile(at), 'utf8'))).toMatchObject({ answer: 'not_now' })
  })

  it('keeps waiting across a restart until it is answered', async () => {
    const at = home()
    await question(at).turnedOn()
    const afterRestart = question(at)
    expect(afterRestart.asking()).toBe(true)
    await afterRestart.answer(true)
    expect(startup.installStartup).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting when the install fails, and installs on the next try', async () => {
    const q = question(home())
    await q.turnedOn()
    startup.failInstall = true
    await expect(q.answer(true)).rejects.toThrow(/launchctl/)
    expect(q.asking()).toBe(true)
    startup.failInstall = false
    await q.answer(true)
    expect(q.asking()).toBe(false)
    expect(startup.installStartup).toHaveBeenCalledTimes(2)
  })

  it('reports whether Mousse starts at login, unreadable as no (the SSH replies\' starts_at_login)', async () => {
    startup.installed = true
    expect(await startsAtLogin()).toBe(true)
    startup.installed = false
    expect(await startsAtLogin()).toBe(false)
    startup.startupStatus.mockRejectedValueOnce(new Error('schtasks failed'))
    expect(await startsAtLogin()).toBe(false)
  })
})

describe('the question through the window\'s daemon calls', () => {
  /** One profile's engine behind the registered local methods; its engine and helper starts are no-ops. */
  function profile(installation: string, profileDir = join(installation, 'profiles', 'p1')) {
    const engine = new NetEngineService({
      profileDir,
      profileId: 'p1',
      net: { onSetAside: () => undefined, v1On: () => true } as never,
      bridge: () => undefined,
      loginStart: new LoginStartQuestion(loginStartFile(installation), startupEntry(installation))
    })
    engine.start = async () => undefined
    engine.startHelper = async () => undefined
    const domains = new DomainHandlerRegistry()
    registerNetEngineMethods(domains, () => engine)
    const context = {
      connection: {
        id: 'settings',
        clientType: 'gui',
        capabilities: new Set([NET_LOCAL_CAPABILITY]),
        binding: { profileId: 'p1', epoch: 1 }
      }
    } as never
    return (method: string, params: unknown = {}) => domains.dispatch(context, method, params) as Promise<any>
  }

  it('asks in the reply to the switch turning on, and "Start at login" installs the entry', async () => {
    const call = profile(home())
    expect((await call('netEngine.status')).loginStart).toBeUndefined()
    expect((await call('netEngine.enable')).loginStart).toBe('ask')
    expect((await call('netEngine.status')).loginStart).toBe('ask')
    const after = await call('netEngine.loginStart', { start: true })
    expect(after.loginStart).toBeUndefined()
    expect(startup.installStartup).toHaveBeenCalledTimes(1)
  })

  it('does not ask on a profile whose switch is off, and refuses an answer without `start`', async () => {
    const installation = home()
    await profile(installation)('netEngine.enable')
    const other = profile(installation, join(installation, 'profiles', 'p2'))
    expect((await other('netEngine.status')).loginStart).toBeUndefined()
    await expect(other('netEngine.loginStart', {})).rejects.toThrow(/needs start/)
  })
})
