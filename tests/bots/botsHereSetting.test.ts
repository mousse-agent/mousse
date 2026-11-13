/**
 * What bots may do here, as the service stores and reads it: one setting for the whole installation (its own
 * `mousse.conf`), the same for every profile's bots and Settings. A setting never written is all on (first start, an
 * update); one that is malformed, or lost with a settings file that could not be read, is all off and marked so until
 * the owner sets it again. A write names one or more switches, each on or off, and the service puts them over the
 * switches it holds; anything else changes nothing. An update is saved whole or not at all, and every profile's open
 * windows hear of a change. Another computer can't route to it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MousseMainService } from '../../src/mms/MousseMainService'
import type { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, BOT_OFF_HERE_MARK, type BotComputerLimit } from '../../src/shared/bots/personal/computerLimit'
import type { BotDefinition } from '../../src/shared/bots/personal/definition'
import { parseArgs } from '../../src/cli/parseArgs'
import { runConfig } from '../../src/cli/commands/config'
import { onSettingsSaved } from '../../src/mms/settings/SettingsStore'

/** `mousse config set …` reaches the service through this, in the test: the CLI's own parsing, the service's own handler. */
const cli = vi.hoisted(() => ({ request: undefined as undefined | ((method: string, params: unknown) => Promise<unknown>) }))
vi.mock('../../src/cli/mmsContext', () => ({
  openMms: async () => ({ client: { request: (method: string, params: unknown) => cli.request!(method, params) } }),
  closeMmsContext: async () => undefined
}))

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

function tempHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bots-here-')))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

const conf = (home: string) => join(home, 'mousse.conf')
const stored = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const open = { here: BOT_COMPUTER_OPEN }
const shut = { here: BOT_COMPUTER_SHUT, unreadable: true }

describe('reading the stored setting', () => {
  it('first start: every switch on, no notice, and nothing written for it', () => {
    const home = tempHome()
    const installation = MousseConfigStore.loadInstallation(home)
    expect(installation.botSettings()).toEqual(open)
    expect(stored(conf(home))).not.toHaveProperty('bots')
    // A restart reads the same.
    expect(MousseConfigStore.loadInstallation(home).botSettings()).toEqual(open)
  })

  it('an update from a build without it: every switch on, the rest of the file kept', () => {
    const home = tempHome()
    writeFileSync(conf(home), JSON.stringify({ version: 1, mms: { autostart: true, logLevel: 'debug' }, features: {} }))
    const installation = MousseConfigStore.loadInstallation(home)
    expect(installation.botSettings()).toEqual(open)
    expect(installation.getMmsSection()).toMatchObject({ autostart: true, logLevel: 'debug' })
    expect(readdirSync(home).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })

  // The stored `bots` value, and what every switch reads.
  const rows: Array<[string, unknown, typeof open | typeof shut | { here: BotComputerLimit }]> = [
    ['all three on', { here: { shell: true, files: true, browser: true } }, open],
    ['one off', { here: { shell: false, files: true, browser: true } }, { here: { ...BOT_COMPUTER_OPEN, shell: false } }],
    ['a switch the build does not know is ignored', { here: { shell: true, files: true, browser: true, camera: false } }, open],
    ['null', null, shut],
    ['false', false, shut],
    ['a string', 'on', shut],
    ['an array', [true, true, true], shut],
    ['an empty object', {}, shut],
    ['here null', { here: null }, shut],
    ['here an array', { here: [] }, shut],
    ['a switch missing', { here: { shell: true, files: true } }, shut],
    ['a switch not a boolean', { here: { shell: 'true', files: true, browser: true } }, shut],
    ['a switch as a number', { here: { shell: 1, files: true, browser: true } }, shut],
    ['marked unreadable, whatever the switches say', { here: { shell: true, files: true, browser: true }, unreadable: '2026-11-13T00:00:00.000Z' }, shut]
  ]
  it.each(rows)('stored as %s', (_name, bots, expected) => {
    const home = tempHome()
    writeFileSync(conf(home), JSON.stringify({ version: 1, mms: { autostart: false, logLevel: 'info' }, features: {}, bots }))
    expect(MousseConfigStore.loadInstallation(home).botSettings()).toEqual(expected)
  })

  it('a settings file that can\'t be read: kept aside, every switch off and marked, across restarts, until the owner sets them', () => {
    const home = tempHome()
    writeFileSync(conf(home), JSON.stringify({ version: 1, mms: { autostart: false, logLevel: 'info' }, features: {}, bots: open }))
    // Cut off mid-write.
    writeFileSync(conf(home), '{"version":1,"bots":{"here":{"shell":tr')
    const installation = MousseConfigStore.loadInstallation(home)
    expect(readdirSync(home).filter((name) => name.startsWith('mousse.conf.corrupt-'))).toHaveLength(1)
    expect(installation.botSettings()).toEqual(shut)
    expect(MousseConfigStore.loadInstallation(home).botSettings()).toEqual(shut)
    // Settings shows the same: what every profile reads.
    const profile = MousseConfigStore.loadProfile(join(home, 'profiles', 'p1'), installation)
    const settings = new SettingsStore(profile)
    expect(settings.get().bots).toEqual(shut)
    // The owner switches one on: the notice goes, and what was set is what is read, after a restart too.
    settings.set({ bots: { here: { shell: false, files: true, browser: false } } })
    expect(settings.get().bots).toEqual({ here: { shell: false, files: true, browser: false } })
    expect(MousseConfigStore.loadInstallation(home).botSettings()).toEqual({ here: { shell: false, files: true, browser: false } })
  })

  it('a profile\'s own file that can\'t be read leaves the installation\'s setting as it is', () => {
    const home = tempHome()
    const installation = MousseConfigStore.loadInstallation(home)
    installation.setBotsHere({ ...BOT_COMPUTER_OPEN, browser: false })
    const root = join(home, 'profiles', 'p1')
    mkdirSync(root, { recursive: true })
    writeFileSync(conf(root), '{ not json')
    const profile = MousseConfigStore.loadProfile(root, installation)
    expect(readdirSync(root).filter((name) => name.startsWith('mousse.conf.corrupt-'))).toHaveLength(1)
    expect(profile.botSettings()).toEqual({ here: { ...BOT_COMPUTER_OPEN, browser: false } })
    // And a profile's file never holds it.
    expect(stored(conf(root))).not.toHaveProperty('bots')
  })
})

describe('one setting for every profile of this computer, through the real service', () => {
  const runner: BotDefinition = {
    format: 2, id: 'runner', name: 'Runner', description: 'test', look: { colour: 'coral', accessory: 'none' },
    owner: { kind: 'person', id: 'self' }, placement: { kind: 'this_computer' }, role: 'test',
    main: { key: 'main', title: 'Main', agent: { instructions: '' }, model: { mode: 'auto', depth: 'normal' } },
    context: [], triggers: { manual: true },
    permissions: { tools: ['shell'], appTools: [], mcp: [], skills: [], workspace: null, budget: { maxActiveMs: 60_000 }, audience: 'owner' }
  }
  /** A bot in `services` that holds "run commands". */
  function botIn(services: MmsProfileServices) {
    const bots = services.personalBots!
    const draft = bots.save(runner)
    bots.publish(runner.id, draft.draftHash)
    bots.approve(runner.id, botManifestDigest(runner.permissions))
    const marks = () => bots.service.get('runner').permissions.filter((item) => item.mark).map((item) => [item.title, item.mark])
    return { bots, marks }
  }
  const set = (services: MmsProfileServices, partial: unknown) =>
    dispatchMethod({ mms: services, connection: { id: 'test', binding: { profileId: services.profileId, epoch: 1 }, capabilities: new Set() } } as never, 'settings.set', { partial })

  it('set in one profile: every profile\'s Settings shows it and every profile\'s bots are held to it, a new profile too; a write that is not three switches changes nothing', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = tempHome()
    const home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    cleanup.push(() => main.stop())
    const manager = main.getInstallationHost()!.manager
    const other = await main.getProfileServices(manager.create({ displayName: 'Other', slug: 'other' }).id)
    const theirs = botIn(other)
    expect(other.settings.get().bots).toEqual(open)
    expect(theirs.marks()).toEqual([])
    const changed: unknown[] = []
    theirs.bots.events.on('changed', (event) => changed.push(event))

    // The owner switches commands off in the first profile's Settings.
    await set(main, { bots: { here: { ...BOT_COMPUTER_OPEN, shell: false } } })
    // The other profile's bot reads About again.
    expect(changed).toContainEqual({ botId: 'runner' })
    expect(other.settings.get().bots).toEqual({ here: { ...BOT_COMPUTER_OPEN, shell: false } })
    expect(theirs.marks()).toEqual([['run commands', BOT_OFF_HERE_MARK]])
    // Kept once, in the installation's file; no profile's file holds it.
    expect(stored(conf(home)).bots).toEqual({ here: { ...BOT_COMPUTER_OPEN, shell: false } })
    for (const services of [main, other]) expect(stored(services.config.getPath())).not.toHaveProperty('bots')
    // A profile made afterwards starts held to it, not all on.
    const later = await main.getProfileServices(manager.create({ displayName: 'Later', slug: 'later' }).id)
    expect(later.settings.get().bots).toEqual({ here: { ...BOT_COMPUTER_OPEN, shell: false } })

    // Anything but one or more known switches, each a boolean, is refused, nothing in the same update is saved, and
    // nothing is reset.
    const theme = other.settings.get().appearance.theme
    for (const bots of [null, false, 'on', [], {}, { here: null }, { here: {} }, { here: [] }, { here: { shell: 'true' } }, { here: { shell: null } }, { here: { camera: true } }, { here: { ...BOT_COMPUTER_OPEN, camera: true } }, { here: BOT_COMPUTER_OPEN, unreadable: true }, { here: BOT_COMPUTER_OPEN, more: 1 }])
      await expect(set(other, { bots, appearance: { theme: theme === 'dark' ? 'light' : 'dark' } }), JSON.stringify(bots)).rejects.toThrow(/What bots may do here/)
    expect(main.settings.get().bots).toEqual({ here: { ...BOT_COMPUTER_OPEN, shell: false } })
    expect(other.settings.get().appearance.theme).toBe(theme)
    expect(existsSync(conf(home))).toBe(true)
  }, 120_000)

  it('two windows, each with its own copy: one switch changed in each, the CLI too, and none turns back another\'s; every profile\'s windows hear each change', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = tempHome()
    const home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    cleanup.push(() => main.stop())
    const other = await main.getProfileServices(main.getInstallationHost()!.manager.create({ displayName: 'Other', slug: 'other' }).id)
    // What each profile's open windows are told (the protocol server pushes these to that profile's windows).
    const told = new Map<string, Array<BotComputerLimit>>()
    for (const services of [main, other]) {
      told.set(services.profileId, [])
      services.events.on('protocol:event', (event) => {
        const { type, data } = event as { type: string; data: { settings: { bots: { here: BotComputerLimit } } } }
        if (type === 'settings.changed') told.get(services.profileId)!.push(data.settings.bots.here)
      })
    }
    // Two Settings windows opened while every switch was on: each keeps that copy.
    const windowA = main.settings.get().bots.here
    const windowB = other.settings.get().bots.here
    expect([windowA, windowB]).toEqual([BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN])

    // Window B (the other profile) switches commands off: it sends that switch alone.
    await set(other, { bots: { here: { shell: false } } })
    // Window A, whose copy still says commands are on, switches the browser off: commands stay off.
    await set(main, { bots: { here: { browser: false } } })
    expect(main.settings.get().bots).toEqual({ here: { shell: false, files: true, browser: false } })
    // The CLI, as the owner types it.
    cli.request = (method, params) => dispatchMethod({ mms: main, connection: { id: 'cli', binding: { profileId: main.profileId, epoch: 1 }, capabilities: new Set() } } as never, method, params)
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await runConfig(parseArgs(['config', 'set', 'bots.here.files', 'false']))
    expect(stored(conf(home)).bots).toEqual({ here: { shell: false, files: false, browser: false } })
    await runConfig(parseArgs(['config', 'set', 'bots.here.shell', 'true']))
    expect(other.settings.get().bots).toEqual({ here: { shell: true, files: false, browser: false } })

    // Every profile's windows were told of each change with that profile's own settings, whichever profile made it.
    const steps = [{ shell: false, files: true, browser: true }, { shell: false, files: true, browser: false }, { shell: false, files: false, browser: false }, { shell: true, files: false, browser: false }]
    for (const services of [main, other]) expect(told.get(services.profileId)!.filter((here, index, all) => index === 0 || JSON.stringify(here) !== JSON.stringify(all[index - 1])), services.profileId).toEqual(steps)

    // The control: a window that sends its whole old copy, as the first version did, turns back what others changed.
    await set(main, { bots: { here: { ...windowA, browser: false } } })
    expect(main.settings.get().bots.here).toEqual({ shell: true, files: true, browser: false })
  }, 120_000)
})

describe('an update is saved whole or not at all', () => {
  /** An installation and a profile, with a settings store over the profile, as each profile's service has. */
  function stores() {
    const home = tempHome()
    const installation = MousseConfigStore.loadInstallation(home)
    const profileRoot = join(home, 'profiles', 'p1')
    const settings = new SettingsStore(MousseConfigStore.loadProfile(profileRoot, installation))
    const saved = vi.fn()
    cleanup.push(onSettingsSaved(saved))
    return { home, profileRoot, settings, saved }
  }
  /** A settings file that can no longer be written: a folder (with a file in it) where the file was. */
  const unwritable = (path: string) => {
    rmSync(path, { force: true })
    mkdirSync(path)
    writeFileSync(join(path, 'keep'), '')
  }

  it('the rest of the update fails: the switches are not saved and nobody is told', () => {
    const { home, profileRoot, settings, saved } = stores()
    const theme = settings.get().appearance.theme
    unwritable(conf(profileRoot))
    expect(() => settings.set({ bots: { here: { shell: false } }, appearance: { theme: theme === 'dark' ? 'light' : 'dark' } } as never)).toThrow()
    expect(settings.get().bots).toEqual(open)
    expect(settings.get().appearance.theme).toBe(theme)
    expect(stored(conf(home))).not.toHaveProperty('bots')
    expect(saved).not.toHaveBeenCalled()
  })

  it('the switches fail: the rest of the update is put back, in the profile and in its file', () => {
    const { home, profileRoot, settings, saved } = stores()
    const theme = settings.get().appearance.theme
    const next = theme === 'dark' ? 'light' : 'dark'
    unwritable(conf(home))
    expect(() => settings.set({ bots: { here: { shell: false } }, appearance: { theme: next } } as never)).toThrow()
    expect(settings.get().appearance.theme).toBe(theme)
    expect((stored(conf(profileRoot)).settings as { appearance: { theme: string } }).appearance.theme).toBe(theme)
    expect(settings.get().bots).toEqual(open)
    expect(saved).not.toHaveBeenCalled()
    // The control: with both files writable, the same update saves both.
    rmSync(conf(home), { recursive: true, force: true })
    settings.set({ bots: { here: { shell: false } }, appearance: { theme: next } } as never)
    expect(settings.get().appearance.theme).toBe(next)
    expect(stored(conf(home)).bots).toEqual({ here: { ...BOT_COMPUTER_OPEN, shell: false } })
  })
})
