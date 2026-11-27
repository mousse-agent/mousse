/**
 * Mousse's look through the app tools, as a bot's turn reaches them: every bot's main turn has the theme tools without a
 * grant; the grant compiled for the turn, the bot's authority, the registry's listing and per-call check, and the theme
 * tools over a real settings store and a real wallpaper store. A bot has Full access for the theme tools: CSS and a new
 * wallpaper run without asking anyone, with the checks a thread's agent has.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WallpaperStore } from '../../src/mms/appearance/WallpaperStore'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import type { AppearanceToolHost } from '../../src/mms/run/mcp/appTools'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { BOT_THEMES_PERMISSION, BOT_THEME_TOOLS, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import type { MousseSettingsUpdate } from '../../src/shared/settings'
import { WALLPAPER_REFUSED } from '../../src/shared/themes/wallpaperImage'
import { pngHeader } from '../fixtures/wallpaperBytes'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const themeNames = (names: readonly string[]) => names.filter((name) => name.startsWith('theme_')).sort()

describe('a bot\'s theme tools', () => {
  let fx: DelegationFixture | undefined
  let base: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (base) rmSync(base, { recursive: true, force: true })
    base = undefined
  })

  /**
   * A bot whose chat thread is `home`, holding a live run that, like every bot turn, nobody answers (`approvals: never`).
   * `grant` adds permissions to the starter grant; `botTools` is what its turn is compiled with; `role` is the thread's.
   */
  const world = async (options: { grant?: string[]; botTools?: Partial<NonNullable<CompileInput['botTools']>>; role?: 'activation' | 'context' | 'subagent' } = {}) => {
    fx = delegationFixture()
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-themes-')))
    const profile = join(base, 'profile')
    const scratch = join(profile, 'bots', 'scratch', 'act-1')
    const files = join(profile, 'bots', 'files', 'alpha')
    mkdirSync(scratch, { recursive: true })
    mkdirSync(files, { recursive: true })
    const starter = botStarterManifest()
    const grant = { ...starter, appTools: [...starter.appTools, ...(options.grant ?? [])] }
    const compiled = compileBotThread({
      grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files,
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 600_000 },
      botTools: { escalate: true, consult: false, memory: true, themes: true, ...options.botTools }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    const role = options.role ?? 'activation'
    const authority = createBotAuthority({
      activationId: 'act-1', role, permissions: compiled.permissions, waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    const settings = new SettingsStore(MousseConfigStore.load(base))
    const saves: unknown[] = []
    // The profile's real wallpaper store, wired as the daemon wires it for every agent: never a network share.
    const wallpapers = new WallpaperStore(profile)
    const appearance: AppearanceToolHost = {
      get: () => settings.get().appearance,
      set: (patch) => {
        saves.push(patch)
        return settings.set({ appearance: patch } as MousseSettingsUpdate).appearance
      },
      importWallpaper: (path) => wallpapers.importFile(path, { network: false })
    }
    const asked: string[] = []
    const homeRun = await fx.runningRun('home')
    const fake = fakeAppToolHost({
      appearance: () => appearance,
      botRole: (id) => (id === 'home' ? role : undefined),
      // A bot's binding is always Ask; were it consulted, every change would be refused or asked.
      permissionModeFor: () => 'ask',
      askApproval: async (_threadId, questions) => {
        asked.push(questions[0]!.prompt)
        return { permission: 'reject' }
      }
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'home', runId: homeRun.runId, bot: authority, approvals: 'never', ...(role === 'subagent' ? { subagent: true } : {}) }))
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const outcome = await registry.call(name, args, request({ threadId: 'home', runId: homeRun.runId }))
      // A refusal reads as its words; its shape is checked in toolRefusalShape.test.ts.
      return { error: outcome.isError === true, text: refusalOf(outcome)?.message ?? outcome.text }
    }
    const listed = () => themeNames(registry.listForThread('home', homeRun.runId).map((tool) => tool.name))
    /** A PNG at `folder` (the bot's files folder by default). */
    const picture = (folder = files, name = 'wall.png'): string => {
      mkdirSync(folder, { recursive: true })
      const path = join(folder, name)
      writeFileSync(path, pngHeader(3840, 2160, 16))
      return path
    }
    return { compiled, call, listed, settings, saves, asked, picture, base: base! }
  }

  // What each kind of turn is offered and listed: a main turn of any bot, chat or work, has both.
  const lanes: Array<[string, Parameters<typeof world>[0], readonly string[]]> = [
    ['work (a run\'s main turn)', {}, BOT_THEME_TOOLS],
    ['a chat turn', { botTools: { frontDesk: true } }, BOT_THEME_TOOLS],
    // A grant an older build approved with "change how Mousse looks" gives nothing more.
    ['a grant that still names the old permission', { grant: [BOT_THEMES_PERMISSION] }, BOT_THEME_TOOLS],
    ['a consult', { botTools: { themes: undefined }, role: 'context' }, []],
    ['a subagent of its work', { botTools: { subagent: true }, role: 'subagent' }, []]
  ]
  it.each(lanes)('%s', async (_name, options, shown) => {
    const { compiled, listed } = await world(options)
    expect(themeNames(compiled.permissions.appTools)).toEqual([...shown].sort())
    expect(themeNames(compiled.policy.tools!.allow)).toEqual([...shown].sort())
    expect(listed()).toEqual([...shown].sort())
  })

  it('a consult is refused theme_read and theme_set, and nothing is saved', async () => {
    const { call, saves } = await world({ botTools: { themes: undefined }, role: 'context' })
    expect(await call('theme_read')).toMatchObject({ error: true, text: expect.stringMatching(/not allowed to use theme_read/) })
    expect(await call('theme_set', { theme: 'dark' })).toMatchObject({ error: true })
    expect(saves).toEqual([])
  })

  it('with no grant for it, it reads the themes and switches to a built-in one, asking nobody, in a run nobody answers', async () => {
    const { call, settings, asked } = await world()
    const read = await call('theme_read')
    expect(read.error).toBe(false)
    expect(JSON.parse(read.text)).toMatchObject({ builtIn: expect.arrayContaining([expect.objectContaining({ id: 'dark' })]) })
    expect(await call('theme_set', { theme: 'light' })).toMatchObject({ error: false })
    expect(settings.get().appearance.theme).toBe('light')
    expect(asked).toEqual([])
  })

  it('saves a theme with CSS and a wallpaper from its files folder, as a thread agent in Full access does, asking nobody', async () => {
    const { call, settings, asked, picture } = await world()
    const css = '[data-mousse="composer"] { border-radius: 4px }'
    const outcome = await call('theme_set', { userTheme: { name: 'Dusk', base: 'dark', accent: '#ff8800', css, wallpaper: { path: picture(), dim: 40 } } })
    expect(outcome.error, outcome.text).toBe(false)
    const theme = settings.get().appearance.userThemes.find((entry) => entry.id === 'user-dusk')!
    expect(theme).toMatchObject({ css, accent: '#ff8800', wallpaper: { type: 'image/png', width: 3840, height: 2160, dim: 40 } })
    expect(settings.get().appearance.userTheme).toBe('user-dusk')
    expect(asked).toEqual([])
  })

  it('a picture anywhere else on this computer works too, as for a thread agent', async () => {
    const { call, settings, picture, base } = await world()
    const outcome = await call('theme_set', { userTheme: { name: 'Away', base: 'light', wallpaper: { path: picture(join(base, 'Pictures')) } } })
    expect(outcome.error, outcome.text).toBe(false)
    expect(settings.get().appearance.userThemes[0]!.wallpaper).toMatchObject({ width: 3840 })
  })

  // The same checks a thread agent's path has: one sentence that does not say which, and nothing saved.
  it.each([
    ['a network share', () => '\\\\attacker\\share\\x.png'],
    ['a file that is not an image', (base: string) => { writeFileSync(join(base, 'notes.txt'), 'secret'); return join(base, 'notes.txt') }],
    ['a relative path', () => 'wall.png']
  ])('refuses %s and saves nothing', async (_name, path) => {
    const { call, saves, base } = await world()
    expect(await call('theme_set', { userTheme: { name: 'Bad', base: 'dark', wallpaper: { path: path(base) } } })).toEqual({ error: true, text: WALLPAPER_REFUSED })
    expect(saves).toEqual([])
  })

  it('a subagent of its work is refused, even were the tools to reach it', async () => {
    const { call, saves } = await world({ botTools: { subagent: true }, role: 'subagent' })
    expect(await call('theme_set', { theme: 'dark' })).toMatchObject({ error: true })
    expect(saves).toEqual([])
  })
})
