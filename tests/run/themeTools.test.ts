/**
 * The agents' theme tools (#1142) through the registry the Mousse MCP server serves, over a real settings store:
 * theme_read gives the themes and the guide; theme_set switches themes or saves a user theme and switches to it. It
 * changes settings, so a read-only turn and a read-only child are refused, and under Ask the person
 * is asked first.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { WallpaperStore } from '../../src/mms/appearance/WallpaperStore'
import { ThemeRestoreStore } from '../../src/mms/appearance/ThemeRestoreStore'
import { WALLPAPER_REFUSED } from '../../src/shared/themes/wallpaperImage'
import { shownPath } from '../../src/mms/run/mcp/appTools/appearance'
import { pngHeader } from '../fixtures/wallpaperBytes'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { AppearanceToolHost } from '../../src/mms/run/mcp/appTools'
import type { MousseSettingsUpdate } from '../../src/shared/settings'
import { canAnswerApproval } from '../../src/mms/run/approvalRights'
import { appToolRegistry, appTurn, denied, fakeAppToolHost, refusalOf } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('theme_read and theme_set', () => {
  let fx: DelegationFixture | undefined
  let home: string | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const setup = async (options: { mode?: 'ask' | 'accept_edits' | 'full'; answer?: 'allow' | 'reject'; readOnlyTurn?: boolean; readOnlyChild?: boolean; subagent?: boolean; unattended?: boolean; importWallpaper?: AppearanceToolHost['importWallpaper'] } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-theme-tools-'))
    const settings = new SettingsStore(MousseConfigStore.load(home))
    const saves: unknown[] = []
    // The profile's real wallpaper store, wired as the daemon wires it: an agent's path is never a network share.
    const wallpapers = new WallpaperStore(join(home, 'profile'))
    const appearance: AppearanceToolHost = {
      get: () => settings.get().appearance,
      set: (patch) => {
        saves.push(patch)
        return settings.set({ appearance: patch } as MousseSettingsUpdate).appearance
      },
      importWallpaper: options.importWallpaper ?? ((path) => wallpapers.importFile(path, { network: false })),
      // A new store at every call, so the restore point is read back from disk as after a restart.
      restorePoint: {
        get: () => new ThemeRestoreStore(join(home!, 'profile')).get(),
        set: (point) => new ThemeRestoreStore(join(home!, 'profile')).set(point)
      }
    }
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const asked: Array<{ prompt: string; approval: unknown }> = []
    const fake = fakeAppToolHost({
      appearance: () => appearance,
      permissionModeFor: () => options.mode ?? 'accept_edits',
      ...(options.readOnlyChild ? { readOnlyThread: () => true } : {}),
      askApproval: async (_threadId, questions, ask) => {
        asked.push({ prompt: questions[0]!.prompt, approval: ask.approval })
        return { permission: options.answer ?? 'allow' }
      }
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({
      threadId: 'parent', runId: run.runId, subagent: options.subagent ?? false,
      ...(options.unattended ? { approvals: 'never' as const } : {}),
      ...(options.readOnlyTurn ? { mode: 'reviewer', modeFacts: { readOnly: true, agent: false, build: false } } : {})
    }))
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registry.call(name, args, request({ threadId: 'parent', runId: run.runId }))
    const parsed = async (name: string, args: Record<string, unknown> = {}) => {
      const outcome = await call(name, args)
      if (outcome.isError) throw new Error(outcome.text)
      return JSON.parse(outcome.text) as Record<string, unknown>
    }
    return { call, parsed, settings, saves, asked, registry, home: home! }
  }

  /** A PNG on disk an agent can name. */
  const picture = (folder: string, width = 5120, height = 2880): string => {
    const path = join(folder, `wall-${width}x${height}.png`)
    writeFileSync(path, pngHeader(width, height, 16))
    return path
  }

  it('"switch me to dark mode": theme_set switches to a built-in theme and turns a user theme off', async () => {
    const { parsed, settings } = await setup()
    await parsed('theme_set', { userTheme: { name: 'Paper', base: 'light' } })
    expect(settings.get().appearance.userTheme).toBe('user-paper')
    expect(await parsed('theme_set', { theme: 'dark' })).toMatchObject({ theme: 'dark', userTheme: null })
    expect(settings.get().appearance).toMatchObject({ theme: 'dark', userTheme: '' })
    await parsed('theme_set', { theme: 'system' })
    expect(settings.get().appearance.theme).toBe('system')
  })

  it('saves a user theme and switches to it, updates it by id, and switches back to it by id', async () => {
    const { parsed, settings } = await setup()
    const created = await parsed('theme_set', {
      userTheme: { name: 'Night Owl', base: 'dark', accent: '#7fdbca', colors: { '--surface-base': '#011627' }, css: '[data-mousse="composer"] { border-radius: 4px }' }
    })
    expect(created).toMatchObject({ saved: 'user-night-owl', theme: 'dark', userTheme: { id: 'user-night-owl', name: 'Night Owl' } })
    expect(created.dropped).toBeUndefined()
    const saved = settings.get().appearance
    expect(saved.userThemes).toEqual([{ id: 'user-night-owl', name: 'Night Owl', base: 'dark', accent: '#7fdbca', colors: { '--surface-base': '#011627' }, css: '[data-mousse="composer"] { border-radius: 4px }' }])

    await parsed('theme_set', { userTheme: { id: 'user-night-owl', name: 'Night Owl', base: 'light', css: '' } })
    expect(settings.get().appearance).toMatchObject({ theme: 'light', userTheme: 'user-night-owl' })
    expect(settings.get().appearance.userThemes).toHaveLength(1)

    await parsed('theme_set', { theme: 'github-dark' })
    await parsed('theme_set', { theme: 'user-night-owl' })
    expect(settings.get().appearance).toMatchObject({ theme: 'light', userTheme: 'user-night-owl' })
  })

  it('says which rules the window will drop, and saves the theme with them as written', async () => {
    const { parsed, settings } = await setup()
    const css = 'a { color: red }\n@import url(https://evil.example/x.css);\nb { background: \\75 rl(https://evil.example/y) }'
    const result = await parsed('theme_set', { userTheme: { name: 'Leaky', base: 'dark', css } })
    expect(result.dropped).toEqual([
      expect.objectContaining({ rule: expect.stringContaining('@import') }),
      // Declaration by declaration, as the window drops it: the rule b stays, without its background.
      expect.objectContaining({ rule: expect.stringContaining('background: \\75 rl(https://evil.example/y)') })
    ])
    expect(settings.get().appearance.userThemes[0]!.css).toBe(css)
  })

  it.each([
    ['neither theme nor userTheme', {}, /either theme or userTheme/],
    ['an unknown theme', { theme: 'neon' }, /No theme neon/],
    ['an unknown user theme id', { userTheme: { id: 'user-nope', name: 'x', base: 'dark' } }, /No user theme user-nope/],
    ['a base that is not a theme', { userTheme: { name: 'x', base: 'system' } }, /base must be/],
    ['a color that is not a plain color', { userTheme: { name: 'x', base: 'dark', colors: { '--surface-base': 'url(https://evil.example/x)' } } }, /not a plain color/],
    ['an accent that is not #rrggbb', { userTheme: { name: 'x', base: 'dark', accent: 'red' } }, /accent must be/]
  ])('refuses %s and saves nothing', async (_name, args, message) => {
    const { call, saves } = await setup()
    await expect(call('theme_set', args)).resolves.toMatchObject({ isError: true, text: expect.stringMatching(message) })
    expect(saves).toEqual([])
  })

  it('refuses CSS over 50,000 characters with the limit in the error, and saves nothing; 50,000 is allowed', async () => {
    const { call, saves, settings } = await setup({ mode: 'full' })
    const css = (length: number) => `a{}${' '.repeat(length - 3)}`
    const long = await call('theme_set', { userTheme: { name: 'Long', base: 'dark', css: css(50_001) } })
    expect(long).toMatchObject({ isError: true, text: expect.stringContaining('50,001 characters; the limit is 50,000') })
    expect(long.text).toContain('Nothing was saved')
    expect(saves).toEqual([])
    await expect(call('theme_set', { userTheme: { name: 'Edge', base: 'dark', css: css(50_000) } })).resolves.not.toMatchObject({ isError: true })
    expect(settings.get().appearance.userThemes.map((theme) => theme.css.length)).toEqual([50_000])
  })

  it('theme_read gives the themes in use and the guide with the stable selectors, also in a read-only turn', async () => {
    const { parsed } = await setup({ readOnlyTurn: true })
    const read = await parsed('theme_read')
    expect(read).toMatchObject({ theme: 'blacksphere-plus', userTheme: null, userThemes: [] })
    expect((read.builtIn as Array<{ id: string }>).map((theme) => theme.id)).toContain('light')
    expect(read.guide).toContain('[data-mousse="sidebar"]')
  })

  it('a read-only turn (a mode that denies edits) is refused and nothing changes', async () => {
    const { call, saves, asked } = await setup({ readOnlyTurn: true })
    await expect(call('theme_set', { theme: 'light' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('read-only') })
    expect(saves).toEqual([])
    expect(asked).toEqual([])
  })

  it('a read-only child is refused before anything runs, and are not offered the tool', async () => {
    const child = await setup({ readOnlyChild: true })
    expect(await denied(child.call('theme_set', { theme: 'light' }))).toMatchObject({ code: 'mousse_read_only' })
    expect(child.registry.listForThread('parent').map((tool) => tool.name)).toContain('theme_read')
    expect(child.registry.listForThread('parent').map((tool) => tool.name)).not.toContain('theme_set')
    expect(child.saves).toEqual([])
  })

  it('a subagent is refused: only the thread\'s own agent changes the theme', async () => {
    const { call, saves } = await setup({ subagent: true })
    await expect(call('theme_set', { theme: 'light' })).resolves.toMatchObject({ isError: true })
    expect(saves).toEqual([])
  })

  it('under Ask the person is asked first; a rejection changes nothing', async () => {
    const rejected = await setup({ mode: 'ask', answer: 'reject' })
    await expect(rejected.call('theme_set', { theme: 'light' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(rejected.asked).toEqual([{ prompt: 'Allow this agent to change how Mousse looks?', approval: expect.objectContaining({ action: 'edit', permissionKey: 'mousse:appearance' }) }])
    // Switching themes is an edit like any other: an agent allowed to answer edits may answer it.
    expect((rejected.asked[0]!.approval as { reason?: string }).reason).toBeUndefined()
    expect(rejected.saves).toEqual([])
    fx?.dispose()
    fx = undefined

    const allowed = await setup({ mode: 'ask', answer: 'allow' })
    await expect(allowed.call('theme_set', { theme: 'light' })).resolves.not.toMatchObject({ isError: true })
    expect(allowed.settings.get().appearance.theme).toBe('light')
  })

  it('a run nobody answers is refused under Ask without asking, and runs where its mode allows edits', async () => {
    const ask = await setup({ mode: 'ask', unattended: true })
    await expect(ask.call('theme_set', { theme: 'light' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('refused') })
    expect(ask.asked).toEqual([])
    expect(ask.saves).toEqual([])
    fx?.dispose()
    fx = undefined

    const edits = await setup({ mode: 'accept_edits', unattended: true })
    await expect(edits.call('theme_set', { theme: 'light' })).resolves.not.toMatchObject({ isError: true })
    expect(edits.settings.get().appearance.theme).toBe('light')
  })

  it('a theme with CSS asks unless the run is in Full access; colors alone do not', async () => {
    const edits = await setup({ mode: 'accept_edits', answer: 'reject' })
    await expect(edits.call('theme_set', { userTheme: { name: 'Plain', base: 'dark', colors: { '--surface-base': '#101010' } } })).resolves.not.toMatchObject({ isError: true })
    expect(edits.asked).toEqual([])
    await expect(edits.call('theme_set', { userTheme: { name: 'Cover', base: 'dark', css: 'a { position: fixed; inset: 0; opacity: 0 }' } })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(edits.asked).toHaveLength(1)
    expect(edits.settings.get().appearance.userThemes.map((theme) => theme.name)).toEqual(['Plain'])
    // The person's alone: another agent, even one in Full access with the right to answer approvals, cannot allow it.
    const asked = edits.asked[0]!.approval as { action: 'edit'; permissionKey: string; reason?: string }
    expect(asked.reason).toBeTruthy()
    const agent = { kind: 'agent' as const, threadId: 'other', runId: 'run-other', permissionMode: 'full' as const, access: { level: 'manage' as const, answerApprovals: true, projectAllowed: () => true } }
    expect(canAnswerApproval({ threadId: 'parent', ...asked }, agent as never, { decision: 'allow', scope: 'once' }, () => undefined)).toMatchObject({ ok: false, code: 'person_only' })
    fx?.dispose()
    fx = undefined

    const full = await setup({ mode: 'full' })
    await expect(full.call('theme_set', { userTheme: { name: 'Cover', base: 'dark', css: 'a { color: red }' } })).resolves.not.toMatchObject({ isError: true })
    expect(full.asked).toEqual([])
  })

  it('an update by id keeps the CSS, colors and accent it leaves out', async () => {
    const { parsed, settings } = await setup({ mode: 'full' })
    await parsed('theme_set', { userTheme: { name: 'Night', base: 'dark', accent: '#7fdbca', colors: { '--surface-base': '#011627' }, css: 'a { color: red }' } })
    await parsed('theme_set', { userTheme: { id: 'user-night', name: 'Night Owl' } })
    expect(settings.get().appearance.userThemes).toEqual([{ id: 'user-night', name: 'Night Owl', base: 'dark', accent: '#7fdbca', colors: { '--surface-base': '#011627' }, css: 'a { color: red }' }])
  })

  it('an update changes only the colors it names; null removes one', async () => {
    const { parsed, settings } = await setup()
    await parsed('theme_set', { userTheme: { name: 'Night', base: 'dark', colors: { '--surface-base': '#011627', '--text-primary': '#d6deeb' } } })
    await parsed('theme_set', { userTheme: { id: 'user-night', colors: { '--surface-base': '#000000', '--text-primary': null, '--accent': '#7fdbca' } } })
    expect(settings.get().appearance.userThemes[0]!.colors).toEqual({ '--surface-base': '#000000', '--accent': '#7fdbca' })
  })

  describe('restore', () => {
    // The person's own theme, with CSS and a stored wallpaper, in use before any agent change.
    const mine = {
      id: 'user-mine', name: 'Mine', base: 'light', accent: '#112233', colors: { '--surface-base': '#fafafa' }, css: 'a { color: blue }',
      wallpaper: { id: 'a'.repeat(64), type: 'image/webp', width: 1920, height: 1080, fit: 'contain', position: 'top', dim: 40 }
    }

    it("puts back the theme from before the agents' changes, however many: the person's theme as it was, wallpaper included, and removes the themes agents made", async () => {
      const { call, parsed, settings, asked } = await setup()
      settings.set({ appearance: { userThemes: [mine], userTheme: 'user-mine' } } as MousseSettingsUpdate)
      const original = settings.get().appearance

      const switched = await parsed('theme_set', { theme: 'dark' })
      expect(switched.before).toEqual({ theme: 'light', userTheme: 'user-mine' })
      await parsed('theme_set', { userTheme: { id: 'user-mine', colors: { '--surface-base': '#000000' }, wallpaper: null } })
      await parsed('theme_set', { userTheme: { name: 'Agent Try', base: 'dark', colors: { '--surface-base': '#101418' } } })
      await parsed('theme_set', { userTheme: { id: 'user-agent-try', accent: '#ff0000' } })
      expect(await parsed('theme_read')).toMatchObject({
        restorePoint: { theme: 'light', userTheme: 'user-mine', changedThemes: ['user-mine', 'user-agent-try'] }
      })

      const restored = await parsed('theme_set', { restore: true })
      expect(restored).toMatchObject({ restored: true, removed: ['user-agent-try'], userTheme: { id: 'user-mine' } })
      expect(settings.get().appearance).toEqual(original)
      // Putting back the person's own CSS asks nobody, under Accept edits.
      expect(asked).toEqual([])
      expect(await parsed('theme_read')).toMatchObject({ restorePoint: null })
      await expect(call('theme_set', { restore: true })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('Nothing to restore') })
    })

    it('a theme the person picks in Settings after an agent change stays; the next agent change starts from it', async () => {
      const { call, parsed, settings } = await setup()
      await parsed('theme_set', { theme: 'dark' })
      settings.set({ appearance: { theme: 'light' } } as MousseSettingsUpdate)
      expect(await parsed('theme_read')).toMatchObject({ restorePoint: null })
      await expect(call('theme_set', { restore: true })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('changed in Settings') })
      expect(settings.get().appearance.theme).toBe('light')

      await parsed('theme_set', { theme: 'dark' })
      await parsed('theme_set', { restore: true })
      expect(settings.get().appearance).toMatchObject({ theme: 'light', userTheme: '' })
    })

    it('is refused with theme or userTheme beside it, and where settings may not change', async () => {
      const both = await setup()
      await both.parsed('theme_set', { theme: 'dark' })
      await expect(both.call('theme_set', { restore: true, theme: 'light' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('restore alone') })
      expect(both.settings.get().appearance.theme).toBe('dark')
      const plan = await setup({ readOnlyTurn: true })
      await expect(plan.call('theme_set', { restore: true })).resolves.toMatchObject({ isError: true })
    })
  })

  it('"use this image as my wallpaper": theme_set stores the image, saves the theme with it and theme_read shows it', async () => {
    const { parsed, settings, home } = await setup({ mode: 'full' })
    const path = picture(home)
    const saved = await parsed('theme_set', { userTheme: { name: 'Goku', base: 'dark', wallpaper: { path, dim: 55 } } })
    const wallpaper = settings.get().appearance.userThemes[0]!.wallpaper!
    expect(wallpaper).toMatchObject({ type: 'image/png', width: 5120, height: 2880, fit: 'cover', position: 'center', dim: 55 })
    expect(wallpaper.id).toMatch(/^[0-9a-f]{64}$/)
    expect(saved).toMatchObject({ saved: 'user-goku' })
    // Mousse keeps its own copy: the source can go.
    rmSync(path)
    expect(existsSync(join(home, 'profile', 'wallpapers', `${wallpaper.id}.png`))).toBe(true)
    const read = await parsed('theme_read')
    expect((read.userThemes as Array<{ wallpaper?: unknown }>)[0]!.wallpaper).toMatchObject({ id: wallpaper.id, dim: 55 })
    expect(read.guide).toContain('userTheme.wallpaper')

    // Fit, position and dim change without a path; null removes the wallpaper.
    await parsed('theme_set', { userTheme: { id: 'user-goku', wallpaper: { fit: 'contain', position: 'top' } } })
    expect(settings.get().appearance.userThemes[0]!.wallpaper).toMatchObject({ id: wallpaper.id, fit: 'contain', position: 'top', dim: 55 })
    await parsed('theme_set', { userTheme: { id: 'user-goku', wallpaper: null } })
    expect(settings.get().appearance.userThemes[0]!.wallpaper).toBeUndefined()
  })

  it.each([
    ['a file that is not an image', (folder: string) => { writeFileSync(join(folder, 'notes.txt'), 'secret'); return join(folder, 'notes.txt') }],
    ['a missing file', (folder: string) => join(folder, 'missing.png')],
    ['a network share', () => '\\\\attacker\\share\\x.png'],
    ['a relative path', () => 'x.png']
  ])('refuses %s with one sentence that does not say which, and saves nothing', async (_name, path) => {
    const { call, saves, home } = await setup({ mode: 'full' })
    const outcome = await call('theme_set', { userTheme: { name: 'Bad', base: 'dark', wallpaper: { path: path(home) } } })
    expect(refusalOf(outcome)).toMatchObject({ message: WALLPAPER_REFUSED })
    expect(saves).toEqual([])
  })

  it('refuses display fields for a theme with no image yet, and bad fields, before reading anything', async () => {
    let imports = 0
    const { call, saves } = await setup({ mode: 'full', importWallpaper: async () => { imports++; throw new Error('never') } })
    await expect(call('theme_set', { userTheme: { name: 'A', base: 'dark', wallpaper: { dim: 30 } } })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('no wallpaper yet') })
    await expect(call('theme_set', { userTheme: { name: 'A', base: 'dark', wallpaper: { path: 'C:\\x.png', fit: 'stretch' } } })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('wallpaper.fit') })
    await expect(call('theme_set', { userTheme: { name: 'A', base: 'dark', wallpaper: { path: 'C:\\x.png', dim: 95 } } })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('wallpaper.dim') })
    expect(imports).toBe(0)
    expect(saves).toEqual([])
  })

  it('a new image asks unless the run is in Full access, naming the file, and nothing is read before the answer', async () => {
    const full = await setup({ mode: 'full' })
    await expect(full.call('theme_set', { userTheme: { name: 'Wall', base: 'dark', wallpaper: { path: picture(full.home) } } })).resolves.not.toMatchObject({ isError: true })
    expect(full.asked).toEqual([])
    fx?.dispose()
    fx = undefined

    const edits = await setup({ mode: 'accept_edits', answer: 'reject' })
    const other = picture(edits.home, 800, 600)
    await expect(edits.call('theme_set', { userTheme: { name: 'Wall', base: 'dark', wallpaper: { path: other } } })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('did not approve') })
    expect(edits.asked).toEqual([{ prompt: `Allow this agent to use ${other} as the wallpaper and change how Mousse looks?`, approval: expect.objectContaining({ permissionKey: 'mousse:appearance' }) }])
    expect(existsSync(join(edits.home, 'profile', 'wallpapers'))).toBe(false)
    expect(edits.saves).toEqual([])
  })

  it('the approval shows the path on one line, without characters that could make it read as another path', () => {
    expect(shownPath('C:\\pics\\a\u202egnp.exe\nC:\\safe.png')).toBe('C:\\pics\\agnp.exeC:\\safe.png')
    expect(shownPath(`C:\\${'d\\'.repeat(150)}goku.png`)).toMatch(/^….*goku\.png$/)
    expect(shownPath(`C:\\${'d\\'.repeat(150)}goku.png`)).toHaveLength(200)
  })

  it('fit, position and dim of a stored image run under Accept edits without asking', async () => {
    const { call, parsed, asked, settings, home } = await setup({ mode: 'accept_edits', answer: 'allow' })
    await parsed('theme_set', { userTheme: { name: 'Wall', base: 'dark', wallpaper: { path: picture(home) } } })
    asked.length = 0
    await expect(call('theme_set', { userTheme: { id: 'user-wall', wallpaper: { dim: 70 } } })).resolves.not.toMatchObject({ isError: true })
    expect(asked).toEqual([])
    expect(settings.get().appearance.userThemes[0]!.wallpaper?.dim).toBe(70)
  })

  it('a change made while the image is being stored is kept: the themes are read after the import', async () => {
    let finish!: (value: { id: string; type: 'image/png'; width: number; height: number }) => void
    const pending = new Promise<{ id: string; type: 'image/png'; width: number; height: number }>((resolve) => { finish = resolve })
    const { call, settings } = await setup({ mode: 'full', importWallpaper: () => pending })
    const setting = call('theme_set', { userTheme: { name: 'Wall', base: 'dark', wallpaper: { path: 'C:\\x.png' } } })
    // Meanwhile another window adds a theme.
    await new Promise((resolve) => setTimeout(resolve, 10))
    settings.set({ appearance: { userThemes: [{ id: 'user-other', name: 'Other', base: 'light', accent: '', colors: {}, css: '' }] } } as MousseSettingsUpdate)
    finish({ id: 'a'.repeat(64), type: 'image/png', width: 100, height: 100 })
    await expect(setting).resolves.not.toMatchObject({ isError: true })
    expect(settings.get().appearance.userThemes.map((theme) => theme.id)).toEqual(['user-other', 'user-wall'])
    expect(settings.get().appearance.userThemes[1]!.wallpaper?.id).toBe('a'.repeat(64))
  })
})
