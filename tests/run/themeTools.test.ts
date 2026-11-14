/**
 * The agents' theme tools (#1142) through the registry the Mousse MCP server serves, over a real settings store:
 * theme_read gives the themes and the guide; theme_set switches themes or saves a user theme and switches to it. It
 * changes settings, so a read-only turn, a read-only child and a Plan ceiling are refused, and under Ask the person
 * is asked first.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { AppearanceToolHost } from '../../src/mms/run/mcp/appTools'
import type { MousseSettingsUpdate } from '../../src/shared/settings'
import { canAnswerApproval } from '../../src/mms/run/approvalRights'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
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

  const setup = async (options: { mode?: 'ask' | 'accept_edits' | 'full'; answer?: 'allow' | 'reject'; readOnlyTurn?: boolean; readOnlyChild?: boolean; ceiling?: 'plan' | 'default'; subagent?: boolean; unattended?: boolean } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-theme-tools-'))
    const settings = new SettingsStore(MousseConfigStore.load(home))
    const saves: unknown[] = []
    const appearance: AppearanceToolHost = {
      get: () => settings.get().appearance,
      set: (patch) => {
        saves.push(patch)
        return settings.set({ appearance: patch } as MousseSettingsUpdate).appearance
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
    const ceiling = options.ceiling ?? 'default'
    turns.register(appTurn({
      threadId: 'parent', runId: run.runId, modeCeiling: ceiling, subagent: options.subagent ?? false,
      ...(options.unattended ? { approvals: 'never' as const } : {}),
      ...(options.readOnlyTurn ? { mode: 'plan', modeFacts: { readOnly: true, agent: false, build: false } } : {})
    }))
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registry.call(name, args, request({ threadId: 'parent', runId: run.runId, modeCeiling: ceiling }))
    const parsed = async (name: string, args: Record<string, unknown> = {}) => {
      const outcome = await call(name, args)
      if (outcome.isError) throw new Error(outcome.text)
      return JSON.parse(outcome.text) as Record<string, unknown>
    }
    return { call, parsed, settings, saves, asked, registry }
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
      expect.objectContaining({ rule: expect.stringContaining('b {') })
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

  it('theme_read gives the themes in use and the guide with the stable selectors, also in a read-only turn', async () => {
    const { parsed } = await setup({ readOnlyTurn: true })
    const read = await parsed('theme_read')
    expect(read).toMatchObject({ theme: 'blacksphere-plus', userTheme: null, userThemes: [] })
    expect((read.builtIn as Array<{ id: string }>).map((theme) => theme.id)).toContain('light')
    expect(read.guide).toContain('[data-mousse="sidebar"]')
  })

  it('a read-only turn (Plan) is refused and nothing changes', async () => {
    const { call, saves, asked } = await setup({ readOnlyTurn: true })
    await expect(call('theme_set', { theme: 'light' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('read-only') })
    expect(saves).toEqual([])
    expect(asked).toEqual([])
  })

  it('a read-only child and a Plan ceiling are refused before anything runs, and are not offered the tool', async () => {
    const child = await setup({ readOnlyChild: true })
    await expect(child.call('theme_set', { theme: 'light' })).rejects.toMatchObject({ code: 'mousse_read_only' })
    expect(child.registry.listForThread('parent').map((tool) => tool.name)).toContain('theme_read')
    expect(child.registry.listForThread('parent').map((tool) => tool.name)).not.toContain('theme_set')
    expect(child.saves).toEqual([])
    fx?.dispose()
    fx = undefined

    const plan = await setup({ ceiling: 'plan' })
    await expect(plan.call('theme_set', { theme: 'light' })).rejects.toMatchObject({ code: 'mousse_ceiling_exceeded' })
    expect(plan.registry.listFor({ readOnly: false, modeCeiling: 'plan' }).map((tool) => tool.name)).not.toContain('theme_set')
    expect(plan.saves).toEqual([])
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

  it.each(['accept_edits', 'full'] as const)('runs without asking under %s', async (mode) => {
    const { call, asked, settings } = await setup({ mode })
    await expect(call('theme_set', { theme: 'light' })).resolves.not.toMatchObject({ isError: true })
    expect(asked).toEqual([])
    expect(settings.get().appearance.theme).toBe('light')
  })
})
