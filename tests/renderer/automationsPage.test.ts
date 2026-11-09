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
import type { Thread } from '../../src/shared/types'
import { groupAutomations, matchesSearch, metaParts, pauseUntil, primaryOf, resultWord } from '../../src/renderer/components/automations/automationList'
import { ownedWhenText, skippedDates, whenText, zonedDayOffset } from '../../src/renderer/components/automations/automationTime'
import { computerOptions } from '../../src/renderer/components/automations/computerChoice'
import { agentBlock, resultBlock, whenBlock } from '../../src/renderer/components/automations/DraftCard'
import { builtByOptions, defaultBuiltBy } from '../../src/renderer/components/automations/AutomationComposer'
import { botComputerOptions } from '../../src/renderer/components/bots/BotAboutPanel'
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

describe('time on the owning computer\'s clock', () => {
  it('names the zone only when it differs from this computer\'s', () => {
    const at = new Date(2026, 10, 10, 9, 0).toISOString()
    expect(ownedWhenText(at, NOW, computer, ZONE)).toBe(`Tomorrow ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)
    const laptop = { name: 'Laptop', timeZone: ZONE === 'Asia/Kolkata' ? 'America/New_York' : 'Asia/Kolkata' }
    expect(ownedWhenText(at, NOW, laptop, ZONE)).toMatch(/ Laptop time$/)
  })

  it('greys an offline computer in the Computer chip', () => {
    const all = [{ node: '', name: 'Desk', timeZone: ZONE }, { node: 'nod_laptop', name: 'Laptop', timeZone: ZONE }, { node: 'nod_studio', name: 'Studio', timeZone: ZONE, offline: true }]
    expect(computerOptions(all)[2]).toMatchObject({ disabled: true, description: 'Studio is offline.' })
    // A bot runs on the computer that holds it: the others are listed, greyed, with why.
    expect(botComputerOptions([{ id: 'this_computer', name: 'Desk' }, { id: 'nod_laptop', name: 'Laptop', offline: true, unavailable: 'Laptop is offline.' }])).toEqual([
      { value: 'this_computer', label: 'Desk' },
      { value: 'nod_laptop', label: 'Laptop · offline', disabled: true, description: 'Laptop is offline.' }
    ])
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
    // A computer name with a space is quoted; a row of this computer matches its own name.
    const studio = item({ key: 'job:s', name: 'Nightly', computer: { name: 'Desk PC', timeZone: ZONE, local: false, node: 'nod_s' } })
    expect(matchesSearch(studio, 'computer:"desk pc"')).toBe(true)
    expect(matchesSearch(studio, 'computer:"desk pc" nightly')).toBe(true)
    expect(matchesSearch(studio, 'computer:"desk laptop"')).toBe(false)
    expect(matchesSearch(item({ key: 'job:mine' }), 'computer:desk')).toBe(true)

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
/** The threads the pickers list (a test that needs a thread with a pull request puts one here). */
let catalogThreads: Thread[] = []
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
  'bots.asks.answer': { message: {} },
  'automations.manager.thread': { threadId: 'mgr' },
  'automations.drafts.turnOn': { job: {} },
  'automations.drafts.discard': { ok: true },
  'automations.drafts.answered': { ok: true },
  'automations.drafts.create': { job: { id: 'd-new' } },
  'bots.chat.send': { message: {} },
  'bots.chat.stop': {}
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
    threads: { listAll: async () => catalogThreads },
    orchestrator: { answerQuestionsDetailed: vi.fn(async () => ({ ok: true })), sendToThread: vi.fn(async () => ({})), abort: vi.fn(async () => true) },
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
/** A row opens its card; Edit details opens the full form. */
const openForm = async (key: string) => {
  await click($(`[data-key="${key}"] .automation-row-main`))
  await click($('[data-testid="automation-edit-details"]'))
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

describe('the card and the composer as data', () => {
  const ctx = { now: NOW, viewerZone: ZONE }
  it('words When → Agent → Result for a time, the CLI, a request and a pull request', () => {
    const weekly = item({ key: 'job:d1', schedule: { kind: 'cron', expr: '0 5 * * 4' }, where: { projectId: 'p1', name: 'mousse' }, tellMe: 'news', result: { thread: 'new' } })
    expect(whenBlock(weekly, ctx)).toEqual({ title: describeSchedule({ kind: 'cron', expr: '0 5 * * 4' }, NOW), sub: 'repeats' })
    expect(whenBlock(item({ key: 'job:c', trigger: 'on_demand', cliName: 'deploy-preview' }), ctx)).toEqual({ title: 'From the CLI', sub: 'mousse-cli automation run deploy-preview' })
    expect(whenBlock(item({ key: 'job:r', trigger: 'request' }), ctx).title).toBe('On request')
    expect(whenBlock(item({ key: 'job:e', trigger: 'thread_event', whenText: '#712 gets a review' }), ctx).title).toBe('#712 gets a review')
    expect(agentBlock(weekly, 'Review open PRs.\nComment on risky ones.', 'Claude')).toEqual({ title: 'Claude · mousse', sub: '“Review open PRs.”' })
    expect(resultBlock(weekly)).toEqual({ title: 'New thread + notify', sub: 'only news' })
    expect(resultBlock(item({ key: 'job:x', result: { thread: 'reuse' }, tellMe: 'problems' }))).toEqual({ title: 'Same thread + notify', sub: 'only problems' })
    expect(resultWord({ tellMe: 'news' })).toBe('notify')
    expect(resultWord({ tellMe: 'every' })).toBe('notify every run')
  })

  it('builds with your first bot, and always offers the Automation manager', () => {
    const pip = { id: 'bot_1', name: 'Pip', look: { colour: 'teal', accessory: 'none' } } as never
    expect(defaultBuiltBy([pip])).toBe('bot:bot_1')
    expect(defaultBuiltBy([])).toBe('manager')
    expect(builtByOptions([pip]).map((entry) => entry.label)).toEqual(['Pip', 'Automation manager'])
  })

  it('puts drafts in their own section, first, and never in Needs you', () => {
    const draft = item({ key: 'job:d', draft: { draftId: 'd', problems: [] }, attention: undefined })
    const failed = item({ key: 'job:f', attention: { kind: 'failed', text: 'boom' } })
    expect(groupAutomations([failed, draft], NOW).map((group) => group.key)).toEqual(['draft', 'needs'])
  })
})

describe('the Automations page', () => {
  it('starts with the composer: Project and Built by, Computer only with two computers, and Set up by hand', async () => {
    await mount([])
    const composer = $('[data-testid="automation-composer"]')!
    expect(document.querySelector('[data-testid="automations-list"] .automations-column')!.firstElementChild!.contains(composer)).toBe(true)
    expect(composer.querySelector('textarea')!.getAttribute('placeholder')).toBe('Describe an automation…')
    expect($('[data-testid="automation-built-by"]')?.textContent).toBe('Pip')
    expect($('[aria-label="Computer"]')).toBeNull()
    expect($('[data-testid="automation-set-up-by-hand"]')?.textContent).toBe('Set up by hand')
    act(() => root.unmount())
    root = createRoot(host)
    await mount([], [], vi.fn(), { computers: [{ name: 'Studio', timeZone: ZONE, local: false, node: 'nod_studio', offline: true }] })
    await click($('[aria-label="Computer"]'))
    expect(option('Studio')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('sends the words to the Automation manager\'s hidden thread with the project, says it is setting it up, and stops it', async () => {
    const mousse = await mount([])
    await click($('[aria-label="Built by"]'))
    await click(option('Automation manager'))
    await click($('[aria-label="Project"]'))
    await click(option('mousse'))
    const input = $<HTMLTextAreaElement>('[data-testid="automation-composer"] textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Check PRs every Thursday at 5 am')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click($('[data-testid="automation-composer-send"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.manager.thread', {})
    expect(mousse.orchestrator.sendToThread).toHaveBeenCalledWith('mgr', 'Check PRs every Thursday at 5 am\n\n[Project: mousse (p1)]')
    expect($('[data-testid="automation-composer-status"]')?.textContent).toContain('Setting it up…')
    await click($('[data-testid="automation-composer-stop"]'))
    expect(mousse.orchestrator.abort).toHaveBeenCalledWith('mgr')
    expect($('[data-testid="automation-composer-status"]')).toBeNull()
  })

  it('sends to a bot when a bot builds it', async () => {
    const mousse = await mount([])
    const input = $<HTMLTextAreaElement>('[data-testid="automation-composer"] textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'every morning tell me the weather')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click($('[data-testid="automation-composer-send"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('bots.chat.send', expect.objectContaining({ botId: 'bot_1', text: 'every morning tell me the weather\n\n[Project: none picked]' }))
  })

  it('shows a draft as When → Agent → Result with its May, answers its question inline, and turns it on', async () => {
    const stored = job({ id: 'd1', name: 'PR check', prompt: 'Review open PRs, comment on risky ones', schedule: { kind: 'cron', expr: '0 5 * * 4' }, enabled: false, nextRunAt: null, projectId: 'p1' })
    const draft = item({
      key: 'job:d1', name: 'PR check', schedule: stored.schedule, where: { projectId: 'p1', name: 'mousse' }, may: 'accept_edits', tellMe: 'news', result: { thread: 'new' },
      draft: { draftId: 'd1', managerThreadId: 'mgr', problems: [], ask: { question: 'Want me to skip draft PRs?', options: ['Yes', 'No'] } }
    })
    const mousse = await mount([draft], [stored])
    const card = $('[data-testid="automation-draft-card"]')!
    expect([...card.querySelectorAll('.automation-card-label')].map((label) => label.textContent)).toEqual(['When', 'Agent', 'Result'])
    expect(card.querySelector('[data-block="agent"]')!.textContent).toContain('Claude · mousse')
    expect(card.querySelector('[data-testid="automation-card-may"]')!.textContent).toBe('May: Auto-accept edits')
    expect($('[data-group="needs"]')).toBeNull()
    await click([...$('[data-testid="automation-draft-ask"]')!.querySelectorAll('button')].find((button) => button.textContent === 'Yes'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.drafts.answered', { draftId: 'd1' })
    expect(mousse.orchestrator.sendToThread).toHaveBeenCalledWith('mgr', 'Yes\n\n[Project: mousse (p1) · Draft: d1]')
    await click($('[data-testid="automation-draft-turn-on"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.drafts.turnOn', { draftId: 'd1' })
    await click($('[data-testid="automation-draft-discard"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.drafts.discard', { draftId: 'd1' })
  })

  it('keeps Turn on off while a draft has a problem, and says the first one', async () => {
    const draft = item({ key: 'job:d2', name: 'Nightly', draft: { draftId: 'd2', problems: ['Which project should it run in?'] } })
    await mount([draft], [job({ id: 'd2', enabled: false })])
    expect($<HTMLButtonElement>('[data-testid="automation-draft-turn-on"]')!.disabled).toBe(true)
    expect($('[data-testid="automation-draft-problem"]')?.textContent).toBe('Which project should it run in?')
  })

  it('reads a row as trigger → agent → result', async () => {
    const later = new Date(Date.now() + 86_400_000 * 3).toISOString()
    await mount([item({ key: 'job:a', name: 'PR check', next: { at: later, timeZone: ZONE }, where: { projectId: 'p1', name: 'mousse' }, tellMe: 'news' })])
    const parts = $$('[data-key="job:a"] [data-meta]').map((part) => [part.dataset.meta, part.dataset.arrow ?? ''])
    expect(parts).toEqual([['when', ''], ['who', 'true'], ['where', ''], ['result', 'true']])
    expect($('[data-key="job:a"] [data-meta="result"]')?.textContent).toBe('notify')
  })

  it('opens an automation on its card: Change it… goes to the manager with its id, and Edit details opens the full form', async () => {
    const stored = job({ id: 'j1', name: 'Nightly', projectId: 'p1' })
    const mousse = await mount([item({ key: 'job:j1', name: 'Nightly', where: { projectId: 'p1', name: 'mousse' }, next: { at: stored.nextRunAt!, timeZone: ZONE }, tellMe: 'news' })], [stored])
    await click($('[data-key="job:j1"] .automation-row-main'))
    expect($('[data-testid="automation-card"]')).not.toBeNull()
    expect($('[data-testid="automation-detail"]')).toBeNull()
    const change = $<HTMLInputElement>('[data-testid="automation-change-it"]')!
    expect(change.placeholder).toBe('Change it… (describe the change)')
    await type(change, 'move it to 8')
    await act(async () => { change.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(mousse.orchestrator.sendToThread).toHaveBeenCalledWith('mgr', 'move it to 8\n\n[Project: mousse (p1) · Change automation: j1]')
    await click($('[data-testid="automation-edit-details"]'))
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
  })

  it('sets one up by hand: a blank draft opens in the full form', async () => {
    const blank = job({ id: 'd-new', name: 'New automation', prompt: '', enabled: false, nextRunAt: null, schedule: { kind: 'manual' } })
    const mousse = await mount([], [blank])
    mousse.platformRequest.request.mockImplementation(async (method: string) => {
      if (method === 'automations.list') return { items: [item({ key: 'job:d-new', name: 'New automation', trigger: 'on_demand', draft: { draftId: 'd-new', problems: ['Say what it should do.'] } })], computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }
      if (method in LIBRARY) return LIBRARY[method]
      throw new Error(method)
    })
    await click($('[data-testid="automation-set-up-by-hand"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.drafts.create', {})
    expect($('[data-testid="automation-detail"]')?.getAttribute('data-job-id')).toBe('d-new')
  })

  it('fills the composer from Repeat this… and Automate…', async () => {
    const { openAutomationCreate, useAutomationCreate } = await import('../../src/renderer/stores/automationCreateStore')
    openAutomationCreate({ prompt: 'summarize yesterday\'s commits', projectId: 'p1' })
    await mount([])
    await act(async () => {})
    expect($<HTMLTextAreaElement>('[data-testid="automation-composer"] textarea')!.value).toBe('summarize yesterday\'s commits')
    expect(useAutomationCreate.getState().request).toBeNull()
    await act(async () => { openAutomationCreate({ agentId: 'agent-1' }) })
    await act(async () => {})
    expect($<HTMLTextAreaElement>('[data-testid="automation-composer"] textarea')!.value).toMatch(/^Have the saved agent “PR reviewer” \(agent-1\)/)
  })

  it('shows a thread-event row in Watching next to a notify-only watch, and its (why?) says what it ignores', async () => {
    const watchRow = item({ key: 'watch:t-w', kind: 'watch', name: 'Fix CI on #742', trigger: 'thread_event', whenText: 'PR #742', who: { kind: 'none', name: 'Notify' }, notifyOnly: true, link: { kind: 'thread', threadId: 't-w' } })
    const eventRow = item({
      key: 'job:j1', name: 'Address reviews', trigger: 'thread_event', whenText: '#712 gets a review',
      threadEvent: { threadId: 't-pr', threadName: 'Fix flaky checkout test', number: 712, events: ['review'], watching: true, log: [
        { at: new Date(Date.now() - 60_000).toISOString(), kinds: ['checks_failed'], outcome: 'own', reason: 'its own push' },
        { at: new Date(Date.now() - 120_000).toISOString(), kinds: ['review'], outcome: 'held', until: new Date(Date.now() + 300_000).toISOString() }
      ] }
    })
    const stored = job({ id: 'j1', name: 'Address reviews', schedule: { kind: 'manual' }, nextRunAt: null, threadId: 't-pr', trigger: { threadEvent: { threadId: 't-pr', number: 712, events: ['review'] } } })
    const mousse = await mount([eventRow, watchRow], [stored])
    const watching = $('[data-group="watching"]')!
    expect([...watching.querySelectorAll('[data-testid="automation-row"]')].map((row) => row.getAttribute('data-key'))).toEqual(['job:j1', 'watch:t-w'])
    expect(watching.querySelector('[data-key="watch:t-w"]')!.textContent).toContain('Notify')
    expect(watching.querySelector('[data-key="job:j1"]')!.textContent).toContain('#712 gets a review')
    await openForm('job:j1')
    expect($('[data-testid="automation-when"]')?.textContent).toBe('When #712 gets a review')
    await click($('[data-testid="automation-why"]'))
    const why = $('[data-testid="automation-why-panel"]')!.textContent!
    expect(why).toContain('Ignores what its own run caused')
    expect(why).toContain('At most one run every 10 minutes')
    expect($$('[data-testid="automation-event-log"] li').map((entry) => entry.textContent)).toEqual([
      expect.stringContaining('checks failed · ignored: its own push'),
      expect.stringMatching(/review · held until .+ \(one run per 10 minutes\)/)
    ])
    await click($('[aria-label="When"]'))
    await click(option('Any of these'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('j1', { threadEvent: { events: ['checks_failed', 'checks_passed', 'review', 'comment'] } })
  })

  it('moves selected rows to another computer, and says which did not move and why', async () => {
    const laptop = { name: 'Laptop', timeZone: ZONE, local: false, node: 'nod_laptop' }
    const remoteRow = item({ key: 'job:nod_laptop:r1', name: 'Theirs', trigger: 'on_demand', computer: laptop, link: { kind: 'job', jobId: 'nod_laptop:r1' } })
    const mousse = await mount([item({ key: 'job:a', name: 'Alpha', trigger: 'on_demand' }), item({ key: 'job:b', name: 'Beta', trigger: 'on_demand' }), remoteRow], [], vi.fn(), { computers: [laptop] })
    mousse.platformRequest.request.mockImplementation(async (method: string) => {
      if (method === 'automations.move') return { moved: [{ id: 'a', to: 'nod_laptop:n1' }], failed: [{ id: 'b', name: 'Beta', error: 'It runs in a thread of this computer.' }] }
      if (method === 'automations.list') return { items: [], computer: { name: 'Desk', timeZone: ZONE }, computers: [laptop], unavailable: [], generatedAt: '' }
      throw new Error(method)
    })
    await click($('[data-key="job:a"] .automation-row-main'), { metaKey: true })
    await click($('[data-key="job:nod_laptop:r1"] .automation-row-main'), { metaKey: true })
    // Another computer's automation moves from there.
    expect($<HTMLButtonElement>('[data-testid="automation-move"]')!.disabled).toBe(true)
    expect($('[data-testid="automation-move"]')!.title).toBe('Move it from Laptop.')
    await click($('[data-key="job:nod_laptop:r1"] .automation-row-main'), { metaKey: true })
    await click($('[data-key="job:b"] .automation-row-main'), { metaKey: true })
    await click($('[data-testid="automation-move"]'))
    await click($('[data-testid="automation-move-confirm"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.move', { jobIds: ['a', 'b'], node: 'nod_laptop' })
    expect($('.scheduled-action-error')?.textContent).toBe('Moved 1 to Laptop. Not moved: Beta (It runs in a thread of this computer).')
  })

  it('searches across computers with computer:', async () => {
    const laptop = { name: 'Laptop', timeZone: ZONE, local: false, node: 'nod_laptop' }
    const rows = Array.from({ length: 13 }, (_, n) => item({ key: `job:${n}`, name: `Job ${n}`, trigger: 'on_demand', ...(n < 2 ? { computer: laptop, link: { kind: 'job' as const, jobId: `nod_laptop:${n}` } } : {}) }))
    await mount(rows, [], vi.fn(), { computers: [laptop] })
    await click($('[aria-label="Search automations"]'))
    await type($<HTMLInputElement>('[data-testid="automations-search"]')!, 'computer:laptop')
    expect($$('[data-testid="automation-row"]').map((row) => row.getAttribute('data-key'))).toEqual(['job:0', 'job:1'])
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
    await openForm('job:j1')
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
    expect($('[data-testid="automation-sentence"]')?.textContent).toMatch(/^Every 30 minutes, Claude does this in mousse\.$/)
    await click($('[aria-labelledby$="tell-label"]'))
    await click(option('Only problems'))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('j1', { tellMe: 'problems' })
    await click($('[data-testid="automation-why"]'))
    expect($('[data-testid="automation-why-panel"]')?.textContent).toContain(ZONE)
  })

  it('marks the one run that stands for the repeats missed while the computer was off, in Runs and Recent', async () => {
    const stored = job({ id: 'j1', name: 'Deps bump' })
    const ran = new Date(Date.now() - 3_600_000).toISOString()
    const run = { at: ran, state: 'done' as const, missed: { count: 4, since: new Date(Date.now() - 4 * 86_400_000).toISOString() } }
    await mount([item({ key: 'job:j1', name: 'Deps bump', runs: [run], last: run })], [stored])
    await click($('[data-testid="automation-recent"]'))
    expect($('[data-testid="automation-recent-runs"] [data-testid="automation-run-missed"]')?.textContent).toBe('Missed while offline')
    await openForm('job:j1')
    const mark = $('[data-testid="automation-detail"] [data-testid="automation-run-missed"]')!
    expect(mark.textContent).toBe('Missed while offline')
    expect(mark.title).toMatch(/^4 runs fell while the computer was off/)
  })

  it('shows a request automation in its detail: + Field inserts a token, More has the URL and a signed curl line, and the delivery log resends', async () => {
    const webhook = { scheme: 'mousse' as const, secretRef: 'scheduled-webhook-j1', createdAt: '2026-11-01T00:00:00.000Z' }
    const stored = job({ id: 'j1', name: 'Deploy preview', prompt: 'Deploy {{body.ref}}', schedule: { kind: 'manual' }, nextRunAt: null, trigger: { webhook } })
    const at = new Date(Date.now() - 600_000).toISOString()
    const run = { at, state: 'done' as const, request: { occurrenceId: 'occ-1', resendable: true as const } }
    const request = {
      url: 'http://127.0.0.1:18790/hooks/j1',
      deliveries: [
        { at, outcome: 'completed' as const, bytes: 14, occurrenceId: 'occ-1', resendable: true as const },
        { at: new Date(Date.now() - 300_000).toISOString(), outcome: 'rejected_signature' as const, bytes: 3 },
        { at: new Date(Date.now() - 200_000).toISOString(), outcome: 'completed' as const, bytes: 2, occurrenceId: 'occ-2', missing: ['body.ref'] }
      ]
    }
    const row = item({ key: 'job:j1', name: 'Deploy preview', trigger: 'request', runs: [run], last: run, request })
    const mousse = await mount([row], [stored])
    mousse.platformRequest.request.mockImplementation(async (method: string) => {
      if (method === 'automations.list') return { items: [row], computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }
      if (method === 'automations.request.resend') return { occurrenceId: 'occ-3' }
      if (method in LIBRARY) return LIBRARY[method]
      throw new Error(method)
    })
    // Recent shows the refused request as a line of its own, and Resend on the delivered one.
    await click($('[data-testid="automation-recent"]'))
    expect($('[data-testid="automation-recent-delivery"]')?.textContent).toContain('Rejected signature')
    await click($('[data-testid="automation-recent-resend"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.request.resend', { jobId: 'j1', occurrenceId: 'occ-1' })

    await openForm('job:j1')
    expect($$('[data-testid="request-field"]').map((entry) => entry.textContent)).toEqual(['ref'])
    const prompt = $<HTMLTextAreaElement>('textarea.scheduled-prompt')!
    prompt.setSelectionRange(prompt.value.length, prompt.value.length)
    await click($('[data-testid="request-field-add"]'))
    await type($<HTMLInputElement>('[data-testid="request-field-input"]')!, 'pr.number')
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Insert'))
    expect(prompt.value).toBe('Deploy {{body.ref}}{{body.pr.number}}')
    expect($$('[data-testid="request-field"]').map((entry) => entry.textContent)).toEqual(['ref', 'pr.number'])

    // The delivery log: the outcome in the log's words, the missing fields, and Resend where a stored request ran.
    const rows = $$('[data-testid="automation-delivery"]')
    expect(rows.map((row) => row.querySelector('.scheduled-outcome')?.textContent)).toEqual(['Accepted', 'Rejected signature', 'Accepted'])
    expect(rows[2]!.textContent).toContain('Missing fields: body.ref')
    expect(rows.map((row) => Boolean(row.querySelector('[data-testid="automation-resend"]')))).toEqual([true, false, false])

    await click($('[data-testid="automation-more"]'))
    expect($('[data-testid="request-url"]')?.textContent).toBe('http://127.0.0.1:18790/hooks/j1')
    const curl = $('[data-testid="request-curl"]')!.textContent!
    expect(curl).toContain(`BODY='{"ref":"<ref>","pr":{"number":"<pr.number>"}}'`)
    expect(curl).toContain('-hmac "$MOUSSE_SECRET"')
    expect(curl).toContain("curl -sS -X POST 'http://127.0.0.1:18790/hooks/j1'")
    // The old dialog is gone: the menu has no Request URL… entry.
    await click($('[aria-label="More actions for Deploy preview"]'))
    expect($$('[role="menuitem"]').map((entry) => entry.textContent)).toEqual(['Delete'])
  })

  it('asks for a missing saved key from Needs you in a masked field, and the automation names the keys it needs in More', async () => {
    const stored = job({ id: 'j1', name: 'Bump deps', schedule: { kind: 'manual' }, nextRunAt: null, keys: ['GITHUB_TOKEN'] })
    const run = { at: new Date(Date.now() - 60_000).toISOString(), state: 'incomplete' as const, detail: 'Add key GITHUB_TOKEN', missingKey: 'GITHUB_TOKEN' }
    const row = item({ key: 'job:j1', name: 'Bump deps', trigger: 'on_demand', runs: [run], last: run, keys: [{ name: 'GITHUB_TOKEN', stored: false }], attention: { kind: 'incomplete', text: 'Add key GITHUB_TOKEN', addKey: 'GITHUB_TOKEN' } })
    const mousse = await mount([row], [stored])
    mousse.platformRequest.request.mockImplementation(async (method: string) => {
      if (method === 'automations.list') return { items: [row], computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }
      if (method === 'automations.keys.list') return { keys: [{ name: 'NPM_TOKEN' }] }
      if (method === 'automations.keys.set') return { name: 'GITHUB_TOKEN' }
      if (method in LIBRARY) return LIBRARY[method]
      throw new Error(method)
    })
    const needs = $('[data-group="needs"] [data-key="job:j1"]')!
    // The key's name keeps its case on the row.
    expect(needs.textContent).toContain('incomplete · add key GITHUB_TOKEN')
    const primary = [...needs.querySelectorAll('button')].find((button) => button.textContent === 'Add key')!
    await click(primary)
    expect($('[role="dialog"]')?.textContent).toContain('Add key GITHUB_TOKEN')
    const value = $<HTMLInputElement>('[data-testid="key-value"]')!
    expect(value.type).toBe('password')
    expect($('[data-testid="key-name"]')).toBeNull()
    await type(value, 'ghp_typed_secret')
    await click($('[data-testid="key-save"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.keys.set', { name: 'GITHUB_TOKEN', value: 'ghp_typed_secret' })
    // It already names the key, so the automation is not changed; the secret is nowhere on the page.
    expect(mousse.scheduled.update).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('ghp_typed_secret')

    await openForm('job:j1')
    await click($('[data-testid="automation-more"]'))
    expect($$('[data-testid="automation-key"]').map((entry) => [entry.dataset.stored, entry.textContent])).toEqual([['false', expect.stringContaining('GITHUB_TOKEN · missing')]])
    await click($('[data-testid="automation-key-add"]'))
    await type($<HTMLInputElement>('[data-testid="key-name"]')!, 'npm token')
    expect($('[role="dialog"]')?.textContent).toContain('Replaces the stored NPM_TOKEN.')
    await type($<HTMLInputElement>('[data-testid="key-value"]')!, 'npm_x')
    await click($('[data-testid="key-save"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.keys.set', { name: 'NPM_TOKEN', value: 'npm_x' })
    expect(mousse.scheduled.update).toHaveBeenCalledWith('j1', { keys: ['GITHUB_TOKEN', 'NPM_TOKEN'] })
  })

  it('says why an agent-added automation cannot take requests before Keep, and sets one up after it', async () => {
    const stored = job({ id: 'j1', name: 'Rerun test', schedule: { kind: 'manual' }, nextRunAt: null, createdBy: { threadId: 't1' }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    const mousse = await mount([item({ key: 'job:j1', name: 'Rerun test', trigger: 'on_demand', addedBy: { threadId: 't1' }, keepable: true })], [stored])
    mousse.scheduled.webhook.enable.mockResolvedValue({ job: stored, secret: 'whsec_shown_once', url: 'http://127.0.0.1:18790/hooks/j1', listening: true })
    await openForm('job:j1')
    await click($('[data-testid="automation-more"]'))
    expect($<HTMLButtonElement>('[data-testid="request-enable"]')!.disabled).toBe(true)
    expect($('[data-testid="request-refusal"]')?.textContent).toMatch(/^Keep it first/)
  })

  it('shows the secret once after Set up, and the curl line signed with it', async () => {
    const stored = job({ id: 'j1', name: 'Deploy preview', prompt: 'Deploy {{body.ref}}', schedule: { kind: 'manual' }, nextRunAt: null })
    const mousse = await mount([item({ key: 'job:j1', name: 'Deploy preview', trigger: 'on_demand' })], [stored])
    mousse.scheduled.webhook.enable.mockResolvedValue({ job: stored, secret: 'whsec_shown_once', url: 'http://127.0.0.1:18790/hooks/j1', listening: true })
    await openForm('job:j1')
    await click($('[data-testid="automation-more"]'))
    await click($('[data-testid="request-enable"]'))
    expect(mousse.scheduled.webhook.enable).toHaveBeenCalledWith('j1')
    expect($('[data-testid="request-secret"]')?.textContent).toBe('whsec_shown_once')
    expect($('[data-testid="request-curl"]')?.textContent).toContain("-hmac 'whsec_shown_once'")
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

  it('shows who actually ran each run, and when its saved agent changed since the run before', async () => {
    const stored = job({ id: 'j1', name: 'Nightly', projectId: 'p1', agent: { definitionId: 'agent-1' } })
    const runs = [
      { at: new Date(Date.now() - 60_000).toISOString(), state: 'done' as const, ranBy: 'PR reviewer', agentChanged: true as const },
      { at: new Date(Date.now() - 86_400_000).toISOString(), state: 'done' as const, ranBy: 'PR reviewer' }
    ]
    await mount([item({ key: 'job:j1', name: 'Nightly', who: { kind: 'saved_agent', name: 'PR reviewer', definitionId: 'agent-1' }, mayIsGrant: true, runs })], [stored])
    await openForm('job:j1')
    expect($('[data-testid="automation-who"]')?.textContent).toBe('PR reviewer')
    expect($('[data-testid="automation-may-agent"]')?.textContent).toBe('What PR reviewer may use')
    expect($$('[data-testid="automation-run-who"]').map((entry) => entry.textContent)).toEqual(['PR reviewer', 'PR reviewer'])
    expect($$('[data-testid="automation-run-changed"]')).toHaveLength(1)
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
    await openForm('job:j1')
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
