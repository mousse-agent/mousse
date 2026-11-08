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

  it('keeps an offline computer’s rows on their own time, waiting with the reason offline', () => {
    const laptop = { name: 'Laptop', timeZone: ZONE, local: false, node: 'nod_laptop', offline: true as const }
    const away = item({ key: 'job:nod_laptop:deps', computer: laptop, next: { at: friday, timeZone: ZONE }, active: { at: friday, state: 'waiting', reason: 'offline' } })
    expect(groupAutomations([away], NOW).map((group) => group.key)).toEqual(['upcoming'])
    const parts = metaParts(away, { now: NOW, viewerZone: ZONE, manyComputers: true }).map((part) => part.text)
    expect(parts[0]).toBe(ownedWhenText(friday, NOW, laptop, ZONE))
    expect(parts).toContain('Laptop')
    expect(parts.at(-1)).toBe('offline')
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

/** What the Library holds for Who and Do: one published saved agent, one published workflow with two inputs, one bot. */
const LIBRARY: Record<string, unknown> = {
  'agentDefinitions.list': [
    { id: 'agent-1', name: 'PR reviewer', purpose: 'Reviews PRs', publishedRevision: 'r1', enabled: true, archived: false },
    { id: 'agent-draft', name: 'Draft only', enabled: true, archived: false }
  ],
  'workflows.list': [{ id: 'wf-1', slug: 'release-notes', name: 'Release notes', enabled: true, headRevisionId: 'h1', runnable: true, issues: [] }],
  'workflows.getRevision': {
    profileId: 'p', id: 'wf-1', slug: 'release-notes', name: 'Release notes', source: 'profile',
    bundle: { format: 'mousse-workflow', version: 1, manifest: {}, files: [] },
    compiled: { inputSchema: { type: 'object', properties: { tag: { type: 'string', title: 'Tag' }, draft: { type: 'boolean' } }, required: ['tag'] } }
  },
  'bots.personal.list': { bots: [{ id: 'bot_1', name: 'Pip', look: { colour: 'teal', accessory: 'headphones' } }] },
  'bots.schedules.add': { runs: [] },
  'automations.asks.answer': { ask: {} },
  'automations.keep': { job: {} },
  'bots.asks.answer': { message: {} }
}

function api(index: AutomationIndex, jobs: ScheduledJob[]) {
  return {
    platformRequest: { request: vi.fn(async (method: string, _params?: unknown) => { if (method === 'automations.list') return index; if (method in LIBRARY) return LIBRARY[method]; throw new Error(method) }) },
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
    orchestrator: { answerQuestionsDetailed: vi.fn(async () => ({ ok: true })) },
    git: { status: vi.fn(async () => ({ isRepo: true })) }
  }
}

async function mount(items: AutomationItem[], jobs: ScheduledJob[] = [], onOpenLibrary = vi.fn(), extra: Partial<AutomationIndex> = {}) {
  const mousse = api({ items, computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '', ...extra }, jobs)
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
      item({ key: 'job:b--s', name: 'Weather', who: { kind: 'bot', name: 'Pip', look: { colour: 'teal', accessory: 'none' } }, link: { kind: 'job', jobId: 'b--s', botId: 'b' }, next: { at: today, timeZone: ZONE } }),
      item({ key: 'watch:t1', kind: 'watch', name: 'Fix CI on #742', trigger: 'thread_event', whenText: 'PR #742', who: { kind: 'none', name: 'Notify' }, link: { kind: 'thread', threadId: 't1' } })
    ])
    expect($$('[data-testid="automation-group"]').map((group) => group.dataset.group)).toEqual(['needs', 'today', 'watching'])
    expect($('[data-group="needs"] .automation-group-head')?.textContent).toBe('Needs you · 1')
    const primaries = $$('[data-testid="automation-row"]').map((row) => [row.dataset.key, row.querySelector('[data-primary]')?.textContent])
    expect(primaries).toEqual([['job:failed', 'Retry'], ['job:today', 'Run now'], ['job:b--s', 'Open'], ['watch:t1', 'Open']])
    // A bot's row is a normal row: its next time, then the bot (its face, then its name).
    expect($$('[data-key="job:b--s"] [data-meta]').map((part) => part.dataset.meta).slice(0, 2)).toEqual(['when', 'bot'])
    expect($('[data-key="job:b--s"] [data-meta="bot"]')?.textContent).toBe('Pip')
    expect($('[data-key="job:b--s"] [data-testid="automation-bot-face"]')).not.toBeNull()
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

  it('opens a bot\'s automation as a normal editable row: Who stays the bot, May is its grant, When and Tell me save', async () => {
    const stored = job({ id: 'b--s', name: 'Weather', prompt: 'Tell me if it rains', schedule: { kind: 'interval', minutes: 30 }, threadId: 'bot-schedule:b', bot: { botId: 'b', scheduleId: 's', createdBy: 'bot' } })
    const pip = { kind: 'bot' as const, name: 'Pip', look: { colour: 'teal', accessory: 'none' } as const }
    const mousse = await mount([item({ key: 'job:b--s', name: 'Weather', who: pip, mayIsGrant: true, next: { at: stored.nextRunAt!, timeZone: ZONE }, tellMe: 'news', link: { kind: 'job', jobId: 'b--s', botId: 'b' } })], [stored])
    // Its row's menu has Pause… and Delete, and no Run now.
    await click($('[aria-label="More actions for Weather"]'))
    const labels = $$('[role="menuitem"]').map((entry) => entry.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Open bot chat', 'Pause…', 'Edit', 'Delete']))
    expect(labels).not.toContain('Run now')
    await click($$('[role="menuitem"]').find((entry) => entry.textContent === 'Edit'))
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
    expect($('[data-testid="automation-sentence"]')?.textContent).toMatch(/^Every 30 minutes, Pip does this\.$/)
    expect($('[aria-label="Where"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Run now')).toBe(false)
    expect($('[data-testid="automation-may-bot"]')?.textContent).toContain("Pip's grant")
    await click($('[data-testid="automation-when"]'))
    expect($$('[role="radiogroup"][aria-label="When"] [role="radio"]').map((entry) => entry.textContent)).toEqual(['Every…', 'Daily', 'Weekly', 'Cron'])
    await click($('[aria-labelledby$="tell-label"]'))
    await click(option('Only problems'))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('b--s', { tellMe: 'problems' })
  })

  it('shows search past twelve rows, and opens the Library from the header', async () => {
    const openLibrary = vi.fn()
    await mount(Array.from({ length: 13 }, (_, at) => item({ key: `job:${at}`, name: `Job ${at}`, trigger: 'on_demand' })), [], openLibrary)
    expect($('[aria-label="Search automations"]')).not.toBeNull()
    await click($('[data-testid="automations-library-link"]'))
    expect(openLibrary).toHaveBeenCalledOnce()
  })

  it('lets a saved agent do it: the Who picker lists published saved agents, and Add sends a real agent reference', async () => {
    const mousse = await mount([])
    await click($('[data-testid="automation-create"]'))
    await type($<HTMLInputElement>('[data-testid="automation-create-input"]')!, 'every weekday at 9 review open PRs')
    await click($('[data-testid="automation-create-who"]'))
    expect(option('Draft only')).toBeUndefined()
    await click(option('PR reviewer'))
    expect($('[data-testid="automation-create-who"]')?.textContent).toBe('PR reviewer')
    expect($('[data-testid="automation-create-may"]')?.textContent).toBe('May: what PR reviewer may use')
    await click($('[data-testid="automation-create-add"]'))
    const sent = mousse.scheduled.create.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ prompt: 'review open PRs', agent: { definitionId: 'agent-1' } })
    expect(sent.permissionMode).toBeUndefined()
  })

  it('swaps the prompt for a workflow inputs when / picks one, hides Who, and runs it as /slug --input', async () => {
    const mousse = await mount([])
    await click($('[data-testid="automation-create"]'))
    const input = $<HTMLInputElement>('[data-testid="automation-create-input"]')!
    await type(input, '/rel')
    const suggestions = $('[data-testid="automation-do-suggestions"]')
    expect(suggestions?.textContent).toContain('/release-notes')
    await click(suggestions!.querySelector('button'))
    await act(async () => {})
    expect($('[data-testid="automation-do"]')?.textContent).toBe('/release-notes')
    expect($('[data-testid="automation-create-who"]')).toBeNull()
    expect($('[data-testid="automation-workflow-inputs"]')?.textContent).toContain('Tag *')
    await type(input, 'every friday at 16')
    expect($<HTMLButtonElement>('[data-testid="automation-create-add"]')!.disabled).toBe(true)
    await type($<HTMLInputElement>('[data-input="tag"]')!, 'v1.2 beta')
    await click($('[data-testid="automation-create-add"]'))
    expect(mousse.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Release notes', prompt: '/release-notes --tag "v1.2 beta"', schedule: { kind: 'cron', expr: '0 16 * * 5' } }))
  })

  it('gives a bot the schedule when the bot is Who, and says a bot repeats', async () => {
    const mousse = await mount([])
    await click($('[data-testid="automation-create"]'))
    const input = $<HTMLInputElement>('[data-testid="automation-create-input"]')!
    await type(input, 'every day at 8 tell me the weather')
    await click($('[data-testid="automation-create-who"]'))
    await click(option('Pip'))
    expect($('[data-testid="automation-create-may"]')?.textContent).toContain("Pip's grant")
    expect($('[aria-label="Where"]')).toBeNull()
    await click($('[data-testid="automation-create-add"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('bots.schedules.add', { botId: 'bot_1', when: { kind: 'cron', expr: '0 8 * * *' }, prompt: 'tell me the weather' })
    expect(mousse.scheduled.create).not.toHaveBeenCalled()
    await click($('[data-testid="automation-create"]'))
    await click($('[data-testid="automation-create-who"]'))
    await click(option('Pip'))
    await click($('.automation-chip-select.when'))
    await click(option('On demand'))
    await type($<HTMLInputElement>('[data-testid="automation-create-input"]')!, 'check the news')
    expect($('[data-testid="automation-create-blocked"]')?.textContent).toMatch(/A bot repeats/)
    expect($<HTMLButtonElement>('[data-testid="automation-create-add"]')!.disabled).toBe(true)
  })

  it('shows who actually ran each run, and when its saved agent changed since the run before', async () => {
    const stored = job({ id: 'j1', name: 'Nightly', projectId: 'p1', agent: { definitionId: 'agent-1' } })
    const runs = [
      { at: new Date(Date.now() - 60_000).toISOString(), state: 'done' as const, ranBy: 'PR reviewer', agentChanged: true as const },
      { at: new Date(Date.now() - 86_400_000).toISOString(), state: 'done' as const, ranBy: 'PR reviewer' }
    ]
    await mount([item({ key: 'job:j1', name: 'Nightly', who: { kind: 'saved_agent', name: 'PR reviewer', definitionId: 'agent-1' }, mayIsGrant: true, runs })], [stored])
    await click($('[data-key="job:j1"] .automation-row-main'))
    expect($('[data-testid="automation-who"]')?.textContent).toBe('PR reviewer')
    expect($('[data-testid="automation-may-agent"]')?.textContent).toBe('What PR reviewer may use')
    expect($$('[data-testid="automation-run-who"]').map((entry) => entry.textContent)).toEqual(['PR reviewer', 'PR reviewer'])
    expect($$('[data-testid="automation-run-changed"]')).toHaveLength(1)
  })

  it('opens the create row prefilled from Automate… on a saved agent and on a workflow', async () => {
    const { openAutomationCreate, useAutomationCreate } = await import('../../src/renderer/stores/automationCreateStore')
    openAutomationCreate({ agentId: 'agent-1' })
    await mount([])
    await act(async () => {})
    expect($('[data-testid="automation-create"]')?.dataset.open).toBe('true')
    expect($('[data-testid="automation-create-who"]')?.textContent).toBe('PR reviewer')
    // The request is taken once: the page does not open it again later.
    expect(useAutomationCreate.getState().request).toBeNull()

    await act(async () => { openAutomationCreate({ workflowId: 'wf-1' }) })
    await act(async () => {})
    expect($('[data-testid="automation-do"]')?.textContent).toBe('/release-notes')
    expect($('[data-testid="automation-create-who"]')).toBeNull()
  })

  it('opens the create row from Repeat this… with the prompt, the project and the thread\'s model', async () => {
    const { openAutomationCreate } = await import('../../src/renderer/stores/automationCreateStore')
    const selection = { instanceId: providers[0]!.instanceId, llmProvider: providers[0]!.id, model: providers[0]!.models[0]!.id }
    openAutomationCreate({ prompt: 'summarize yesterday\'s commits', projectId: 'p1', selection })
    const mousse = await mount([])
    await act(async () => {})
    const input = $<HTMLInputElement>('[data-testid="automation-create-input"]')!
    expect(input.value).toBe('summarize yesterday\'s commits')
    expect($('[data-testid="automation-create-when"]')?.textContent).toBe('Choose when')
    expect($('[data-testid="automation-create-who"]')?.textContent).not.toBe('Claude')
    await type(input, 'every day at 7 summarize yesterday\'s commits')
    await click($('[data-testid="automation-create-add"]'))
    expect(mousse.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'summarize yesterday\'s commits', projectId: 'p1', selection: expect.objectContaining({ model: selection.model }) }))
  })

  it('answers asks in place from Needs you: Allow is the primary action, Not now is in "…"', async () => {
    const mousse = await mount([
      item({
        key: 'ask:a1', kind: 'ask', name: 'Check PR #42', trigger: 'time', who: { kind: 'agent', name: 'Reviewer' },
        attention: { kind: 'ask', text: 'Reviewer wants to check PR #42 every 30 min', threadId: 't9', answer: { kind: 'agent_ask', askId: 'a1' } },
        link: { kind: 'ask', askId: 'a1', threadId: 't9' }
      }),
      item({
        key: 'job:j2', name: 'Lint sweep', liveStatus: undefined,
        attention: { kind: 'ask', text: 'Wants your approval', threadId: 't2', answer: { kind: 'thread_approval', threadId: 't2', requestId: 'r2', questionId: 'q', allow: 'yes', deny: 'no' } }
      } as Parameters<typeof item>[0]),
      item({
        key: 'job:b--s', kind: 'job', name: 'every day · 08:00', who: { kind: 'bot', name: 'Pip', look: { colour: 'teal', accessory: 'none' } },
        attention: { kind: 'ask', text: 'Wants to read files in Notes', answer: { kind: 'bot_ask', botId: 'b', askId: 'esc_1' } },
        link: { kind: 'job', jobId: 'b--s', botId: 'b' }
      })
    ])
    expect($$('[data-group="needs"] [data-testid="automation-ask-allow"]')).toHaveLength(3)
    expect($('[data-key="ask:a1"] .automation-row-meta')?.textContent).toContain('Reviewer wants to check PR #42 every 30 min')
    await click($('[data-key="ask:a1"] [data-testid="automation-ask-allow"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.asks.answer', { askId: 'a1', answer: 'allow' })
    await click($('[data-key="job:j2"] [data-testid="automation-ask-allow"]'))
    expect(mousse.orchestrator.answerQuestionsDetailed).toHaveBeenCalledWith('r2', { q: 'yes' }, 't2')
    await click($('[aria-label="More actions for every day · 08:00"]'))
    await click($('[data-testid="automation-ask-not-now"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('bots.asks.answer', { botId: 'b', askId: 'esc_1', answer: 'not_now' })
  })

  it('offers Keep on an automation an agent added, and Keep removes only its end', async () => {
    const stored = job({ id: 'j1', name: 'Rerun checkout test', createdBy: { threadId: 't1' }, expiresAt: new Date(Date.now() + 86_400_000 * 5).toISOString() })
    const mousse = await mount([item({ key: 'job:j1', name: 'Rerun checkout test', keepable: true, expiresAt: stored.expiresAt, addedBy: { threadId: 't1', threadName: 'Fix flaky test' } })], [stored])
    await click($('[aria-label="More actions for Rerun checkout test"]'))
    expect($('[data-testid="automation-keep-menu"]')).not.toBeNull()
    await click($('[data-testid="automation-keep-menu"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.keep', { jobId: 'j1' })
    await click($('[data-key="job:j1"] .automation-row-main'))
    await click($('[data-testid="automation-more"]'))
    await click($('[data-testid="automation-keep"]'))
    expect(mousse.platformRequest.request.mock.calls.filter(([method]) => method === 'automations.keep')).toHaveLength(2)
  })
  it('lists another computer’s rows with their computer, and turns off the actions of an offline one', async () => {
    const laptop = { name: 'Laptop', timeZone: ZONE, local: false, node: 'nod_laptop', offline: true as const }
    const friday = new Date(2026, 10, 13, 16, 0).toISOString()
    await mount([
      item({ key: 'job:mine', name: 'Mine', trigger: 'on_demand' }),
      item({ key: 'job:nod_laptop:deps', name: 'Deps bump', computer: laptop, next: { at: friday, timeZone: ZONE }, active: { at: friday, state: 'waiting', reason: 'offline' }, link: { kind: 'job', jobId: 'nod_laptop:deps' } })
    ], [], vi.fn(), { computers: [laptop] })
    const row = $('[data-key="job:nod_laptop:deps"]')!
    expect(row.getAttribute('data-offline')).toBe('true')
    expect(row.querySelector('[data-meta="computer"]')?.textContent).toBe('Laptop')
    expect(row.querySelector('[data-meta="run"]')?.textContent).toBe('offline')
    const primary = row.querySelector<HTMLButtonElement>('.automation-primary')!
    expect(primary.disabled).toBe(true)
    expect(primary.title).toBe('Laptop is offline.')
    // It cannot be selected for Pause…, Resume or Delete.
    await click(row.querySelector('.automation-row-main'), { metaKey: true })
    expect($('[data-testid="automation-selection-bar"]')).toBeNull()
    // This computer's row says which computer it is on too, now that there are two.
    expect($('[data-key="job:mine"] [data-meta="computer"]')?.textContent).toBe('Desk')
  })
})
