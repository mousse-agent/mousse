// @vitest-environment jsdom
/**
 * Automations: time on the owning computer's clock, the labels, the job draft behind Edit details, and the Edit
 * details form itself (opened from the inbox): its sentence, Tell me (the level filter), requests, keys, Keep and bots.
 * The inbox's list, keys and cards are in automationsInbox.test.ts.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationIndex, AutomationItem } from '../../src/shared/automations'
import type { AutomationInbox } from '../../src/shared/automationInbox'
import type { LlmProviderOption } from '../../src/shared/settings'
import type { Project, ScheduledJob } from '../../src/shared/types'
import type { Thread } from '../../src/shared/types'
import { pauseUntil } from '../../src/renderer/components/automations/automationList'
import { ownedWhenText, skippedDates, whenText, zonedDayOffset } from '../../src/renderer/components/automations/automationTime'
import { botComputerOptions } from '../../src/renderer/components/bots/BotAboutPanel'
import { whenSentence } from '../../src/renderer/components/automations/AutomationDetail'
import { openEdit, setInboxClient, useInboxStore } from '../../src/renderer/components/automations/inbox/inboxStore'
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

  it('greys an offline computer in the bot computer choice', () => {
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

describe('pausing', () => {
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
    expect(patchOf(initial, { ...initial, tellMe: 'needs_you' }, catalog)).toEqual({ tellMe: 'needs_you' })
    expect(draftFromJob(job(), catalog, providers).tellMe).toBe('look')
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
  'automations.drafts.nextWho': { ok: true },
  'automations.drafts.setWho': { job: {} },
  'bots.chat.send': { message: {} },
  'bots.chat.stop': {},
  'automations.inbox.counts': { byProject: {}, total: 0 }
}

const EMPTY_INBOX: AutomationInbox = { runs: [], tuning: [], meta: [], month: { key: '2026-11', label: 'API keys · Nov', byJob: {} }, generatedAt: '' }

function api(index: AutomationIndex, jobs: ScheduledJob[]) {
  return {
    platformRequest: { request: vi.fn(async (method: string, _params?: unknown) => { if (method === 'automations.list') return index; if (method === 'automations.inbox.list') return EMPTY_INBOX; if (method in LIBRARY) return LIBRARY[method]; throw new Error(method) }) },
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
    pullRequests: { detail: vi.fn(async () => { throw new Error('no host') }) },
    settings: { getOptions: async () => ({ llmProviders: providers }), get: async () => ({ permissions: { defaultMode: 'accept_edits' }, provider: { llmProvider: 'anthropic', instanceId: 'claude:main', model: 'sonnet' } }) },
    projects: { list: async () => projects },
    threads: { listAll: async () => catalogThreads },
    orchestrator: { answerQuestionsDetailed: vi.fn(async () => ({ ok: true })), sendToThread: vi.fn(async () => ({})), abort: vi.fn(async () => true) },
    git: { status: vi.fn(async () => ({ isRepo: true })) }
  }
}

/** The inbox, with these automations and no runs yet. */
async function mount(items: AutomationItem[], jobs: ScheduledJob[] = [], extra: Partial<AutomationIndex> = {}) {
  const mousse = api({ items, computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '', ...extra }, jobs)
  ;(window as unknown as { mousse: unknown }).mousse = mousse
  const { AutomationsInbox } = await import('../../src/renderer/components/automations/inbox/AutomationsInbox')
  await act(async () => root.render(createElement(AutomationsInbox, { active: true })))
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
/** Edit details: the full form, in the inbox's pane (Manage's Edit). */
const openForm = async (key: string) => {
  await act(async () => { openEdit(key.replace(/^job:/, '')) })
  await act(async () => {})
}
const option = (text: string) => $$('.ui-select-option-label').find((entry) => entry.textContent === text)?.closest('[role="option"]')

beforeEach(() => {
  setInboxClient(null)
  useInboxStore.setState({ index: null, inbox: null, counts: null, loadedAt: 0, filter: {}, openRunId: null, pane: 'run', editJobId: null, manageExpanded: null, actionError: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('Edit details, from the inbox', () => {
  it('opens a job\'s detail, where the sentence is the editor and Tell me saves alone', async () => {
    const stored = job({ id: 'j1', name: 'Nightly', projectId: 'p1' })
    const mousse = await mount([item({ key: 'job:j1', name: 'Nightly', next: { at: stored.nextRunAt!, timeZone: ZONE }, tellMe: 'look' })], [stored])
    await openForm('job:j1')
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
    expect($('[data-testid="automation-sentence"]')?.textContent).toMatch(/^Every 30 minutes, Claude does this in mousse\.$/)
    await click($('[aria-labelledby$="tell-label"]'))
    await click(option('Needs you'))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('j1', { tellMe: 'needs_you' })
    await click($('[data-testid="automation-why"]'))
    expect($('[data-testid="automation-why-panel"]')?.textContent).toContain(ZONE)
  })

  it('marks the one run that stands for the repeats missed while the computer was off, in the Runs of Edit details', async () => {
    const stored = job({ id: 'j1', name: 'Deps bump' })
    const ran = new Date(Date.now() - 3_600_000).toISOString()
    const run = { at: ran, state: 'done' as const, missed: { count: 4, since: new Date(Date.now() - 4 * 86_400_000).toISOString() } }
    await mount([item({ key: 'job:j1', name: 'Deps bump', runs: [run], last: run })], [stored])
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
      if (method === 'automations.inbox.list') return EMPTY_INBOX
      if (method === 'automations.request.resend') return { occurrenceId: 'occ-3' }
      if (method in LIBRARY) return LIBRARY[method]
      throw new Error(method)
    })
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
    await click(rows[0]!.querySelector('[data-testid="automation-resend"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.request.resend', { jobId: 'j1', occurrenceId: 'occ-1' })

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

  it('names the keys an automation needs in More, and adds one in a masked field', async () => {
    const stored = job({ id: 'j1', name: 'Bump deps', schedule: { kind: 'manual' }, nextRunAt: null, keys: ['GITHUB_TOKEN'] })
    const run = { at: new Date(Date.now() - 60_000).toISOString(), state: 'incomplete' as const, detail: 'Add key GITHUB_TOKEN', missingKey: 'GITHUB_TOKEN' }
    const row = item({ key: 'job:j1', name: 'Bump deps', trigger: 'on_demand', runs: [run], last: run, keys: [{ name: 'GITHUB_TOKEN', stored: false }], attention: { kind: 'incomplete', text: 'Add key GITHUB_TOKEN', addKey: 'GITHUB_TOKEN' } })
    const mousse = await mount([row], [stored])
    mousse.platformRequest.request.mockImplementation(async (method: string) => {
      if (method === 'automations.list') return { items: [row], computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }
      if (method === 'automations.inbox.list') return EMPTY_INBOX
      if (method === 'automations.keys.list') return { keys: [{ name: 'NPM_TOKEN' }] }
      if (method === 'automations.keys.set') return { name: 'GITHUB_TOKEN' }
      if (method in LIBRARY) return LIBRARY[method]
      throw new Error(method)
    })
    await openForm('job:j1')
    await click($('[data-testid="automation-more"]'))
    expect($$('[data-testid="automation-key"]').map((entry) => [entry.dataset.stored, entry.textContent])).toEqual([['false', expect.stringContaining('GITHUB_TOKEN · missing')]])
    await click($('[data-testid="automation-key-add"]'))
    await type($<HTMLInputElement>('[data-testid="key-name"]')!, 'npm token')
    expect($('[role="dialog"]')?.textContent).toContain('Replaces the stored NPM_TOKEN.')
    await type($<HTMLInputElement>('[data-testid="key-value"]')!, 'npm_x')
    await click($('[data-testid="key-save"]'))
    expect(mousse.platformRequest.request).toHaveBeenCalledWith('automations.keys.set', { name: 'NPM_TOKEN', value: 'npm_x' })
    expect(document.body.textContent).not.toContain('npm_x')
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

  it('edits a bot\'s automation: Who stays the bot, May is its grant, When and Tell me save', async () => {
    const stored = job({ id: 'b--s', name: 'Weather', prompt: 'Tell me if it rains', schedule: { kind: 'interval', minutes: 30 }, threadId: 'bot-schedule:b', bot: { botId: 'b', scheduleId: 's', createdBy: 'bot' } })
    const pip = { kind: 'bot' as const, name: 'Pip', look: { colour: 'teal', accessory: 'none' } as const }
    const mousse = await mount([item({ key: 'job:b--s', name: 'Weather', who: pip, mayIsGrant: true, next: { at: stored.nextRunAt!, timeZone: ZONE }, tellMe: 'look', link: { kind: 'job', jobId: 'b--s', botId: 'b' } })], [stored])
    await openForm('job:b--s')
    expect($('[data-testid="automation-detail"]')).not.toBeNull()
    expect($('[data-testid="automation-sentence"]')?.textContent).toMatch(/^Every 30 minutes, Pip does this\.$/)
    expect($('[aria-label="Where"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Run now')).toBe(false)
    expect($('[data-testid="automation-may-bot"]')?.textContent).toContain("Pip's grant")
    await click($('[data-testid="automation-when"]'))
    expect($$('[role="radiogroup"][aria-label="When"] [role="radio"]').map((entry) => entry.textContent)).toEqual(['Every…', 'Daily', 'Weekly', 'Cron'])
    await click($('[aria-labelledby$="tell-label"]'))
    await click(option('Needs you'))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mousse.scheduled.update).toHaveBeenCalledWith('b--s', { tellMe: 'needs_you' })
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

  it('offers Keep in More on an automation an agent added, and Keep removes only its end', async () => {
    const stored = job({ id: 'j1', name: 'Rerun checkout test', createdBy: { threadId: 't1' }, expiresAt: new Date(Date.now() + 86_400_000 * 5).toISOString() })
    const mousse = await mount([item({ key: 'job:j1', name: 'Rerun checkout test', keepable: true, expiresAt: stored.expiresAt, addedBy: { threadId: 't1', threadName: 'Fix flaky test' } })], [stored])
    await openForm('job:j1')
    await click($('[data-testid="automation-more"]'))
    await click($('[data-testid="automation-keep"]'))
    expect(mousse.platformRequest.request.mock.calls.filter(([method]) => method === 'automations.keep')).toHaveLength(1)
  })
})
