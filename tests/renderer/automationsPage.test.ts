// @vitest-environment jsdom
/**
 * The Automations page: the create row (English When, Choose when, Next with the owning computer's zone, May), the
 * groups and Needs you, rows and their one action, multi-select with Pause…, the detail's Tell me, and the Library link.
 * The rules behind them are tested as data first.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationIndex, AutomationItem } from '../../src/shared/automations'
import type { LlmProviderOption } from '../../src/shared/settings'
import type { Project, ScheduledJob } from '../../src/shared/types'
import { parseWhen } from '../../src/renderer/components/automations/parseWhen'
import { defaultMay, groupAutomations, matchesSearch, metaParts, pauseUntil, primaryOf } from '../../src/renderer/components/automations/automationList'
import { nextBeforeAdd, ownedWhenText, skippedDates, whenText, zonedDayOffset } from '../../src/renderer/components/automations/automationTime'
import { whenSentence } from '../../src/renderer/components/automations/AutomationDetail'
import { cronFormOf, cronOfForm, draftFromJob, heldPermissionMode, modelGroups, newDraft, patchOf, validateDraft, type ScheduledCatalog } from '../../src/renderer/components/scheduled/jobDraft'
import { clockText, describeSchedule, humanCron, nameFromPrompt } from '../../src/renderer/components/scheduled/scheduledLabels'

const openThread = vi.hoisted(() => vi.fn(async (_threadId: string) => undefined))
vi.mock('../../src/renderer/lib/openThread', () => ({ openThread }))
vi.mock('../../src/renderer/components/bots/face/BotFace', () => ({ BotFace: () => null, BotFaceStill: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = new Date(2026, 10, 9, 8, 0) // Monday 9 Nov 2026, 08:00 local
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const computer = { name: 'Desk', timeZone: ZONE, local: true }

function item(patch: Partial<AutomationItem> & { key: string }): AutomationItem {
  return {
    kind: 'job',
    id: patch.key.replace(/^job:/, ''),
    name: patch.key,
    trigger: 'time',
    whenText: '',
    who: { kind: 'agent', name: 'Default agent' },
    paused: false,
    runs: [],
    link: { kind: 'job', jobId: patch.key.replace(/^job:/, '') },
    computer,
    ...patch
  }
}

describe('When, read from English', () => {
  const ok = (text: string) => {
    const parsed = parseWhen(text, NOW)
    if (parsed.kind !== 'ok') throw new Error(`${text}: ${parsed.kind}`)
    return parsed
  }

  it('reads repeating times and leaves the rest as what to do', () => {
    expect(ok('every weekday at 9 review open PRs and comment on risky ones')).toMatchObject({ schedule: { kind: 'cron', expr: '0 9 * * 1-5' }, prompt: 'review open PRs and comment on risky ones' })
    expect(ok('review open PRs every weekday at 9:30').schedule).toEqual({ kind: 'cron', expr: '30 9 * * 1-5' })
    expect(ok('daily at 6pm summarize the day').schedule).toEqual({ kind: 'cron', expr: '0 18 * * *' })
    expect(ok('every morning at 8 check the weather').schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' })
    expect(ok('every evening at 7 tidy notes').schedule).toEqual({ kind: 'cron', expr: '0 19 * * *' })
    expect(ok('every monday and thursday at 10:15 send the digest').schedule).toEqual({ kind: 'cron', expr: '15 10 * * 1,4' })
    expect(ok('on weekends at 11 water the plants').schedule).toEqual({ kind: 'cron', expr: '0 11 * * 0,6' })
    expect(ok('at 17:00 every day back up').schedule).toEqual({ kind: 'cron', expr: '0 17 * * *' })
    expect(ok('every 30 minutes check CI').schedule).toEqual({ kind: 'interval', minutes: 30 })
    expect(ok('every 2 hours check CI').schedule).toEqual({ kind: 'interval', minutes: 120 })
    expect(ok('hourly check CI')).toMatchObject({ schedule: { kind: 'interval', minutes: 60 }, prompt: 'check CI' })
  })

  it('reads one-time phrases on this computer\'s clock', () => {
    expect(ok('tomorrow at 9am draft the notes').schedule).toEqual({ kind: 'once', runAt: new Date(2026, 10, 10, 9, 0).toISOString() })
    expect(ok('in 20 minutes remind me').schedule).toEqual({ kind: 'once', runAt: new Date(NOW.getTime() + 20 * 60_000).toISOString() })
  })

  it('never guesses: an unclear hour, a missing time, a lone time or two times are ambiguous', () => {
    expect(parseWhen('every day at 5 send it', NOW).kind).toBe('ambiguous')
    expect(parseWhen('every weekday review PRs', NOW).kind).toBe('ambiguous')
    expect(parseWhen('at 9 check CI', NOW).kind).toBe('ambiguous')
    expect(parseWhen('every hour and tomorrow at 9am do it', NOW).kind).toBe('ambiguous')
    expect(parseWhen('every day at 25:00 do it', NOW).kind).toBe('ambiguous')
    expect(parseWhen('today at 7am do it', NOW).kind).toBe('ambiguous')
  })

  it('never makes On demand from text', () => {
    expect(parseWhen('check CI', NOW).kind).toBe('none')
    expect(parseWhen('on demand check CI', NOW).kind).toBe('none')
  })
})

describe('time on the owning computer\'s clock', () => {
  it('names the zone only when it differs from this computer\'s, and always before Add', () => {
    const at = new Date(2026, 10, 10, 9, 0).toISOString()
    expect(ownedWhenText(at, NOW, computer, ZONE)).toBe(`Tomorrow ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)
    const laptop = { name: 'Laptop', timeZone: ZONE === 'Asia/Kolkata' ? 'America/New_York' : 'Asia/Kolkata' }
    expect(ownedWhenText(at, NOW, laptop, ZONE)).toMatch(/ Laptop time$/)
    expect(nextBeforeAdd(at, NOW, { name: 'Desk', timeZone: 'Asia/Kolkata' })).toMatch(/ Desk time \(.+\)$/)
  })

  it('counts days and words times in the given zone', () => {
    const at = new Date('2026-11-09T20:00:00.000Z')
    const now = new Date('2026-11-09T10:00:00.000Z')
    expect(zonedDayOffset(at, now, 'UTC')).toBe(0)
    expect(zonedDayOffset(at, now, 'Asia/Kolkata')).toBe(1)
    expect(whenText(at.toISOString(), now, 'Asia/Kolkata', 'en-GB')).toMatch(/^Tomorrow 0?1:30$/)
  })

  it('lists days a cron schedule says it runs but cannot', () => {
    const skipped = skippedDates({ kind: 'cron', expr: '0 9 31 * *' }, new Date(2026, 0, 1))
    expect(skipped.length).toBeGreaterThan(0)
    expect(skipped.map((entry) => entry.date)).toContain('2026-02-31')
    expect(skippedDates({ kind: 'interval', minutes: 60 }, NOW)).toEqual([])
  })
})

describe('the list as data', () => {
  const today = new Date(2026, 10, 9, 9, 0).toISOString()
  const friday = new Date(2026, 10, 13, 16, 0).toISOString()
  const items = [
    item({ key: 'job:failed', last: { at: today, state: 'failed', detail: 'npm install exited 1' }, attention: { kind: 'failed', text: 'npm install exited 1' }, next: { at: friday, timeZone: ZONE } }),
    item({ key: 'job:today', next: { at: today, timeZone: ZONE } }),
    item({ key: 'job:waiting', next: { at: friday, timeZone: ZONE }, active: { at: today, state: 'waiting', reason: 'usage_limit', until: new Date(2026, 10, 9, 14, 0).toISOString() } }),
    item({ key: 'job:upcoming', next: { at: friday, timeZone: ZONE } }),
    item({ key: 'watch:t1', kind: 'watch', trigger: 'thread_event', whenText: 'PR #742', who: { kind: 'none', name: 'Notify' }, notifyOnly: true, link: { kind: 'thread', threadId: 't1' } }),
    item({ key: 'job:manual', trigger: 'on_demand' }),
    item({ key: 'job:paused', paused: true, last: { at: today, state: 'failed' }, attention: { kind: 'failed', text: 'x' } })
  ]

  it('groups rows; a waiting run stays on its row and never reaches Needs you', () => {
    const groups = groupAutomations(items, NOW)
    expect(groups.map((group) => [group.key, group.items.map((entry) => entry.key)])).toEqual([
      ['needs', ['job:failed']],
      ['today', ['job:today', 'job:waiting']],
      ['upcoming', ['job:upcoming']],
      ['watching', ['watch:t1']],
      ['on_demand', ['job:manual']],
      ['paused', ['job:paused']]
    ])
    expect(groupAutomations([], NOW)).toEqual([])
  })

  it('gives each row one primary action: Retry only on a Failed run', () => {
    expect(primaryOf(items[0]!).label).toBe('Retry')
    expect(primaryOf(items[1]!).label).toBe('Run now')
    expect(primaryOf(items[4]!).label).toBe('Open')
    expect(primaryOf(items[6]!).label).toBe('Resume')
    expect(primaryOf(item({ key: 'job:ask', attention: { kind: 'incomplete', text: 'stopped' } })).label).toBe('Open')
  })

  it('says one meta line: when, who, where, and what the run is doing', () => {
    const ctx = { now: NOW, viewerZone: ZONE, manyComputers: false }
    expect(metaParts(items[2]!, ctx).map((part) => part.text).at(-1)).toMatch(/^waiting · usage limit until /)
    expect(metaParts(items[4]!, ctx).map((part) => part.text)).toEqual(['PR #742', 'Notify'])
    expect(metaParts(items[0]!, ctx).map((part) => part.text)).toEqual(['failed · npm install exited 1'])
    expect(metaParts(items[1]!, { ...ctx, manyComputers: true }).map((part) => part.key)).toContain('computer')
  })

  it('searches names and understands agent: and computer:', () => {
    const claude = item({ key: 'job:c', name: 'PR reviewer', who: { kind: 'agent', name: 'Claude' }, computer: { ...computer, name: 'Laptop' } })
    expect(matchesSearch(claude, 'review')).toBe(true)
    expect(matchesSearch(claude, 'agent:claude')).toBe(true)
    expect(matchesSearch(claude, 'agent:codex')).toBe(false)
    expect(matchesSearch(claude, 'computer:lap review')).toBe(true)
    expect(matchesSearch(claude, 'computer:desk')).toBe(false)
  })

  it('starts May at the profile default held to its ceiling, else Ask before acting', () => {
    expect(defaultMay('auto', 'accept_edits')).toBe('accept_edits')
    expect(defaultMay('accept_edits', 'full')).toBe('accept_edits')
    expect(defaultMay(undefined)).toBe('ask')
  })

  it('ends a pause tomorrow, on Monday, on a chosen day, or never', () => {
    const sunday = new Date(2026, 10, 8, 15, 0)
    expect(pauseUntil('resume', sunday)).toBeUndefined()
    expect(pauseUntil('tomorrow', sunday)).toBe(new Date(2026, 10, 9).toISOString())
    expect(pauseUntil('monday', sunday)).toBe(new Date(2026, 10, 9).toISOString())
    expect(pauseUntil('monday', NOW)).toBe(new Date(2026, 10, 16).toISOString())
    expect(pauseUntil('date', sunday, '2026-12-24')).toBe(new Date(2026, 11, 24).toISOString())
    expect(pauseUntil('date', sunday, '')).toBeUndefined()
  })
})

describe('labels', () => {
  it('humanises the simple cron forms and leaves the rest as a custom schedule', () => {
    expect(humanCron('0 9 * * 1-5')).toBe(`Weekdays at ${clockText(9, 0)}`)
    expect(humanCron('0 9 1 * *')).toBeNull()
    expect(describeSchedule({ kind: 'manual' })).toBe('Only when run')
    expect(nameFromPrompt('Summarize open PRs. Post them to #eng.')).toBe('Summarize open PRs')
  })

  it('words the detail\'s sentence', () => {
    const draft = (patch: Partial<ReturnType<typeof draftFromJob>>) => ({ ...draftFromJob(job(), catalog, providers), ...patch })
    expect(whenSentence(draft({ scheduleKind: 'cron', expr: '0 9 * * 1-5' }))).toBe(`Every weekday at ${clockText(9, 0)}`)
    expect(whenSentence(draft({ scheduleKind: 'interval', minutes: '30' }))).toBe('Every 30 minutes')
    expect(whenSentence(draft({ scheduleKind: 'manual' }))).toBe('When you run it')
  })
})

// ── The page ──────────────────────────────────────────────────────────────────────────────────

const providers = [{ id: 'anthropic', instanceId: 'claude:main', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }] }] as unknown as LlmProviderOption[]
const projects = [{ id: 'p1', name: 'mousse', path: '/work/mousse', createdAt: '', order: 0 }] as Project[]
const catalog: ScheduledCatalog = { models: modelGroups(providers), projects, threads: [], defaultPermissionMode: 'accept_edits' }

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return { id: 'j1', name: 'Nightly', prompt: 'Check CI', schedule: { kind: 'interval', minutes: 30 }, enabled: true, state: 'scheduled', nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: '', updatedAt: '', ...patch }
}

describe('job draft', () => {
  it('round-trips a job to an empty patch, and sends a Tell me change alone', () => {
    const initial = draftFromJob(job({ projectId: 'p1', tellMe: 'every' }), catalog, providers)
    expect(initial.tellMe).toBe('every')
    expect(patchOf(initial, initial, catalog)).toEqual({})
    expect(patchOf(initial, { ...initial, tellMe: 'problems' }, catalog)).toEqual({ tellMe: 'problems' })
    expect(draftFromJob(job(), catalog, providers).tellMe).toBe('news')
  })

  it('reads the plain forms of the When builder from cron and writes them back', () => {
    expect(cronFormOf('0 9 * * *')).toBe('daily')
    expect(cronFormOf('15 8 * * 3')).toBe('weekly')
    expect(cronFormOf('0 9 * * 1-5')).toBe('cron')
    expect(cronOfForm('daily', '07:30', '1')).toBe('30 7 * * *')
    expect(cronOfForm('weekly', '08:15', '3')).toBe('15 8 * * 3')
  })

  it('holds May to the mode the person holds, and checks only a mode being chosen now', () => {
    const asking = { ...catalog, threads: [{ id: 't2', name: 'Strict', projectId: 'p1', permissionMode: 'ask' }] as unknown as ScheduledCatalog['threads'] }
    expect(heldPermissionMode(newDraft(), catalog)).toEqual({ mode: 'accept_edits', exact: true })
    expect(heldPermissionMode({ ...newDraft(), projectId: 'p1', threadId: 't2' }, asking)).toEqual({ mode: 'ask', exact: true })
    expect(heldPermissionMode({ ...newDraft(), projectId: 'p1', workspaceKind: 'worktree', worktreePath: '/wt' }, catalog)).toEqual({ mode: 'ask', exact: false })
    const draft = { ...newDraft(), prompt: 'x', permissionMode: 'full' as const }
    expect(validateDraft(draft, { hasWebhook: false, requireName: false }).permission).toBeUndefined()
    expect(validateDraft(draft, { hasWebhook: false, requireName: false, held: 'ask' }).permission).toMatch(/Full access is wider than Ask before acting/)
  })

  it('sends a mode in a patch, and null to clear it', () => {
    const initial = draftFromJob(job({ permissionMode: 'ask', permissionCeiling: 'full' }), catalog, providers)
    expect(patchOf(initial, { ...initial, permissionMode: 'accept_edits' }, catalog)).toEqual({ permissionMode: 'accept_edits' })
    expect(patchOf(initial, { ...initial, permissionMode: '' }, catalog)).toEqual({ permissionMode: null })
    expect(patchOf(initial, { ...initial, name: 'Renamed' }, catalog)).toEqual({ name: 'Renamed' })
  })
})

let root: Root
let host: HTMLElement

function api(index: AutomationIndex, jobs: ScheduledJob[]) {
  return {
    platformRequest: { request: vi.fn(async (method: string) => { if (method === 'automations.list') return index; throw new Error(method) }) },
    scheduled: {
      list: vi.fn(async () => jobs),
      status: vi.fn(async () => ({ running: true })),
      onUpdated: vi.fn(() => () => undefined),
      onStatus: vi.fn(() => () => undefined),
      create: vi.fn(async () => jobs[0]),
      update: vi.fn(async () => jobs[0]),
      delete: vi.fn(async () => true),
      pause: vi.fn(async () => null),
      resume: vi.fn(async () => null),
      run: vi.fn(async () => null),
      extend: vi.fn(async () => null),
      settings: { get: vi.fn(async () => ({ agentJobs: false, agentJobMaxActive: 10, agentJobMinIntervalMinutes: 15, agentJobLifetimeDays: 7 })) },
      webhook: { enable: vi.fn(), rotate: vi.fn(), disable: vi.fn(), deliveries: vi.fn(async () => ({ deliveries: [], url: '' })) }
    },
    personalBots: { onChanged: vi.fn(() => () => undefined) },
    settings: { getOptions: async () => ({ llmProviders: providers }), get: async () => ({ permissions: { defaultMode: 'accept_edits' }, provider: { llmProvider: 'anthropic', instanceId: 'claude:main', model: 'sonnet' } }) },
    projects: { list: async () => projects },
    threads: { listAll: async () => [] },
    git: { status: vi.fn(async () => ({ isRepo: true })) }
  }
}

async function mount(items: AutomationItem[], jobs: ScheduledJob[] = [], onOpenLibrary = vi.fn()) {
  const mousse = api({ items, computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }, jobs)
  ;(window as unknown as { mousse: unknown }).mousse = mousse
  const { AutomationsList } = await import('../../src/renderer/components/automations/AutomationsList')
  await act(async () => root.render(createElement(AutomationsList, { active: true, onOpenLibrary })))
  await act(async () => {})
  return mousse
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const click = async (element: Element | null | undefined, init: MouseEventInit = {}) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}
const type = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const option = (text: string) => $$('.ui-select-option-label').find((entry) => entry.textContent === text)?.closest('[role="option"]')

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('the Automations page', () => {
  it('opens the quiet create row in place and adds a real scheduled job from one English line', async () => {
    const mousse = await mount([])
    expect($('[data-testid="automation-create"]')?.textContent).toContain('New automation…')
    expect($('[data-testid="automation-create"]')?.getAttribute('title')).toMatch(/^New automation/)
    await click($('[data-testid="automation-create"]'))
    const input = $<HTMLInputElement>('[data-testid="automation-create-input"]')!
    await type(input, 'every weekday at 9 review open PRs')
    expect($('[data-testid="automation-create-when"]')?.textContent).toBe(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }))
    expect($('[data-testid="automation-create-who"]')?.textContent).toBe('Claude')
    expect($('[data-testid="automation-create-next"]')?.textContent).toMatch(/^Next .+ Desk time \(.+\)$/)
    expect($('.automation-create-may')?.textContent).toContain('Auto-accept edits')
    const add = $<HTMLButtonElement>('[data-testid="automation-create-add"]')!
    expect(add.disabled).toBe(false)
    await click(add)
    expect(mousse.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'review open PRs',
      prompt: 'review open PRs',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
      createThread: true,
      permissionMode: 'accept_edits',
      tellMe: 'news'
    }))
  })

  it('says Choose when and keeps Add off while When is unread; On demand only when picked', async () => {
    const mousse = await mount([])
    await click($('[data-testid="automation-create"]'))
    const input = $<HTMLInputElement>('[data-testid="automation-create-input"]')!
    await type(input, 'at 5 check CI')
    expect($('[data-testid="automation-create-when"]')?.textContent).toBe('Choose when')
    expect($<HTMLButtonElement>('[data-testid="automation-create-add"]')!.disabled).toBe(true)
    await click($('.automation-chip-select.when'))
    await click(option('On demand'))
    expect($('[data-testid="automation-create-when"]')?.textContent).toBe('On demand')
    await click($('[data-testid="automation-create-add"]'))
    expect(mousse.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'at 5 check CI', schedule: { kind: 'manual' } }))
  })

  it('shows the groups that have rows, Needs you with its count, and Retry only on the failed row', async () => {
    const today = new Date(Date.now() + 60_000).toISOString()
    await mount([
      item({ key: 'job:failed', name: 'Nightly deps', last: { at: today, state: 'failed', detail: 'npm install exited 1' }, attention: { kind: 'failed', text: 'npm install exited 1' } }),
      item({ key: 'job:today', name: 'PR reviewer', next: { at: today, timeZone: ZONE } }),
      item({ key: 'bot:b:s', kind: 'bot', name: 'Weather', who: { kind: 'bot', name: 'Pip', look: { colour: 'teal', accessory: 'none' } }, link: { kind: 'bot', botId: 'b', scheduleId: 's' }, next: { at: today, timeZone: ZONE } }),
      item({ key: 'watch:t1', kind: 'watch', name: 'Fix CI on #742', trigger: 'thread_event', whenText: 'PR #742', who: { kind: 'none', name: 'Notify' }, link: { kind: 'thread', threadId: 't1' } })
    ])
    expect($$('[data-testid="automation-group"]').map((group) => group.dataset.group)).toEqual(['needs', 'today', 'watching'])
    expect($('[data-group="needs"] .automation-group-head')?.textContent).toBe('Needs you · 1')
    const primaries = $$('[data-testid="automation-row"]').map((row) => [row.dataset.key, row.querySelector('[data-primary]')?.textContent])
    expect(primaries).toEqual([['job:failed', 'Retry'], ['job:today', 'Run now'], ['bot:b:s', 'Open'], ['watch:t1', 'Open']])
    // A bot row's meta line starts with the bot (its face, then its name): no time, no blank before it.
    expect($$('[data-key="bot:b:s"] [data-meta]').map((part) => part.dataset.meta)[0]).toBe('bot')
    expect($('[data-key="bot:b:s"] [data-meta="bot"]')?.textContent).toBe('Pip')
    expect($('[data-key="bot:b:s"] [data-testid="automation-bot-face"]')).not.toBeNull()
    expect($('[data-key="watch:t1"] .automation-row-meta')?.textContent).toContain('Notify')
    await click($('[data-key="watch:t1"] .automation-row-main'))
    expect(openThread).toHaveBeenCalledWith('t1')
    expect($('[data-testid="automations-search"]')).toBeNull()
  })

  it('selects rows with ⌘/Ctrl-click and pauses them until tomorrow through one picker', async () => {
    const later = new Date(Date.now() + 86_400_000 * 3).toISOString()
    const mousse = await mount([
      item({ key: 'job:a', name: 'A', next: { at: later, timeZone: ZONE } }),
      item({ key: 'job:b', name: 'B', next: { at: later, timeZone: ZONE } })
    ])
    await click($('[data-key="job:a"] .automation-row-main'), { ctrlKey: true })
    await click($('[data-key="job:b"] .automation-row-main'), { ctrlKey: true })
    expect($('[data-key="job:a"]')?.dataset.selected).toBe('true')
    const bar = $('[data-testid="automation-selection-bar"]')!
    expect(bar.textContent).toContain('2 selected')
    await click([...bar.querySelectorAll('button')].find((button) => button.textContent === 'Pause…'))
    expect($('[data-testid="automation-pause-picker"]')).not.toBeNull()
    await click([...document.querySelectorAll<HTMLInputElement>('input[name="pause-until"]')].find((radio) => radio.value === 'tomorrow'))
    await click($('[data-testid="automation-pause-confirm"]'))
    expect(mousse.scheduled.pause).toHaveBeenCalledTimes(2)
    expect(mousse.scheduled.pause).toHaveBeenCalledWith('a', undefined, pauseUntil('tomorrow'))
  })

  it('opens a job\'s detail, where the sentence is the editor and Tell me saves alone', async () => {
    const stored = job({ id: 'j1', name: 'Nightly', projectId: 'p1' })
    const mousse = await mount([item({ key: 'job:j1', name: 'Nightly', next: { at: stored.nextRunAt!, timeZone: ZONE }, tellMe: 'news' })], [stored])
    await click($('[data-key="job:j1"] .automation-row-main'))
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
    expect($('[data-testid="automation-sentence"]')?.textContent).toMatch(/^Every 30 minutes, Claude does this in mousse\.$/)
    await click($('[aria-labelledby$="tell-label"]'))
    await click(option('Only problems'))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('j1', { tellMe: 'problems' })
    await click($('[data-testid="automation-why"]'))
    expect($('[data-testid="automation-why-panel"]')?.textContent).toContain(ZONE)
  })

  it('shows search past twelve rows, and opens the Library from the header', async () => {
    const openLibrary = vi.fn()
    await mount(Array.from({ length: 13 }, (_, at) => item({ key: `job:${at}`, name: `Job ${at}`, trigger: 'on_demand' })), [], openLibrary)
    expect($('[aria-label="Search automations"]')).not.toBeNull()
    await click($('[data-testid="automations-library-link"]'))
    expect(openLibrary).toHaveBeenCalledOnce()
  })
})
