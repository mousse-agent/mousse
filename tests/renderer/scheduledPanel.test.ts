// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectionFromListing } from '../../src/shared/providerInstances'
import type { LlmProviderOption } from '../../src/shared/settings'
import type { Project, ScheduledJob, ScheduledJobPatch, ScheduledWebhookDelivery, SchedulerStatus, Thread } from '../../src/shared/types'
import { ScheduledPanel } from '../../src/renderer/components/ScheduledPanel'
import { MODE_NOTE, MODE_SHORT, WORKFLOW_PERMISSION_NOTE } from '../../src/renderer/components/scheduled/JobEditor'
import {
  createInputOf,
  cronFormOf,
  cronOfForm,
  draftFromJob,
  draftPreset,
  heldPermissionMode,
  modelGroups,
  newDraft,
  patchOf,
  permissionChoices,
  presetFields,
  quickDraft,
  validateDraft,
  type ScheduledCatalog
} from '../../src/renderer/components/scheduled/jobDraft'
import {
  clockText,
  describeSchedule,
  humanCron,
  nameFromPrompt,
  presetOf,
  relativeWhen,
  SCHEDULE_PRESETS,
  statusOf
} from '../../src/renderer/components/scheduled/scheduledLabels'
import { groupJobs, groupOf } from '../../src/renderer/components/scheduled/groupJobs'
import { SECRET_VISIBLE_MS } from '../../src/renderer/components/scheduled/WebhookDialog'

const openThread = vi.hoisted(() => vi.fn(async (_threadId: string) => undefined))
vi.mock('../../src/renderer/lib/openThread', () => ({ openThread }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const providers = [
  { id: 'anthropic', instanceId: 'claude:main', label: 'Claude', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'openai', instanceId: 'codex:main', label: 'Codex', models: [{ id: 'gpt-x', label: 'GPT X' }] }
] as unknown as LlmProviderOption[]
const projects = [
  { id: 'p1', name: 'Mousse', path: '/work/mousse', createdAt: '', order: 0 },
  { id: 'p2', name: 'Other', path: '/work/other', createdAt: '', order: 1 }
] as Project[]
/** p1 is a Git repository; p2 is a plain folder. */
const GIT_PROJECTS = new Set(['p1'])
const threads = [
  { id: 't1', name: 'Release thread', projectId: 'p1' },
  { id: 't2', name: 'Other project thread', projectId: 'p2', permissionMode: 'ask' },
  { id: 't3', name: 'Subagent', projectId: 'p1', lineage: { parentThreadId: 't1', rootThreadId: 't1', relationship: 'subagent' } }
] as unknown as Thread[]
const sonnet = selectionFromListing(providers[0], 'sonnet')

const NOW = '2026-10-27T10:00:00.000Z'
const webhookTrigger = { webhook: { scheme: 'mousse' as const, secretRef: 'ref', createdAt: NOW } }
const DAILY = SCHEDULE_PRESETS.find((preset) => preset.value === 'daily')!.label
const WEEKDAYS = SCHEDULE_PRESETS.find((preset) => preset.value === 'weekdays')!.label

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1',
    name: 'Nightly',
    prompt: 'Check CI',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    state: 'scheduled',
    nextRunAt: '2026-10-27T11:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

const URL_OF = (id: string) => `http://127.0.0.1:18790/hooks/${id}`
const SECRET = 'whsec_SECRETVALUE1234567890abcdefghijklmnopqrs'

interface Harness {
  state: { jobs: ScheduledJob[] }
  api: ReturnType<typeof makeApi>
  emit(jobs: ScheduledJob[]): Promise<void>
  /** For a mock that runs inside a click's act(): the update arrives as the daemon's event would. */
  emitNow(jobs: ScheduledJob[]): void
  emitStatus(status: Partial<SchedulerStatus>): Promise<void>
  clipboard: { writeText: ReturnType<typeof vi.fn> }
}

const RUNNING: SchedulerStatus = { running: true, lastHeartbeatAt: null, lastSuccessAt: null, lastTickError: null, activeJobId: null, activeJobIds: [], jobCount: 0, dueCount: 0 }

function makeApi(state: { jobs: ScheduledJob[] }) {
  let listener: ((jobs: ScheduledJob[]) => void) | null = null
  let statusListener: ((status: SchedulerStatus) => void) | null = null
  const settings = { agentJobs: false, agentJobMaxActive: 10, agentJobMinIntervalMinutes: 15, agentJobLifetimeDays: 7 }
  const scheduled = {
    list: vi.fn(async () => state.jobs),
    status: vi.fn(async (): Promise<SchedulerStatus> => ({ ...RUNNING, jobCount: state.jobs.length })),
    onUpdated: vi.fn((cb: (jobs: ScheduledJob[]) => void) => { listener = cb; return () => { listener = null } }),
    onStatus: vi.fn((cb: (status: SchedulerStatus) => void) => { statusListener = cb; return () => { statusListener = null } }),
    create: vi.fn(async (input: Record<string, unknown>) => job({ id: 'job-new', ...(input as object) } as Partial<ScheduledJob>)),
    update: vi.fn(async (id: string, _patch: ScheduledJobPatch) => state.jobs.find((item) => item.id === id) ?? null),
    delete: vi.fn(async () => true),
    pause: vi.fn(async () => null),
    resume: vi.fn(async () => null),
    run: vi.fn(async () => null),
    extend: vi.fn(async () => null),
    settings: {
      get: vi.fn(async () => ({ ...settings })),
      set: vi.fn(async (update: Partial<typeof settings>) => ({ ...Object.assign(settings, update) }))
    },
    webhook: {
      enable: vi.fn(),
      rotate: vi.fn(),
      disable: vi.fn(),
      deliveries: vi.fn(async (id: string) => ({ deliveries: [] as ScheduledWebhookDelivery[], url: URL_OF(id) }))
    }
  }
  const git = { status: vi.fn(async (scope: { projectId: string | null }) => ({ isRepo: GIT_PROJECTS.has(scope.projectId ?? '') })) }
  return { scheduled, git, push: (jobs: ScheduledJob[]) => listener?.(jobs), pushStatus: (status: SchedulerStatus) => statusListener?.(status) }
}

let root: Root
let host: HTMLElement
let harness: Harness

async function mount(jobs: ScheduledJob[]): Promise<Harness> {
  const state = { jobs }
  const api = makeApi(state)
  const clipboard = { writeText: vi.fn(async () => undefined) }
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  ;(window as unknown as { mousse: unknown }).mousse = {
    scheduled: api.scheduled,
    git: api.git,
    settings: { getOptions: async () => ({ llmProviders: providers }), get: async () => ({ permissions: { defaultMode: 'accept_edits' } }) },
    projects: { list: async () => projects },
    threads: { listAll: async () => threads }
  }
  harness = {
    state,
    api,
    clipboard,
    emit: async (next) => { state.jobs = next; await act(async () => api.push(next)) },
    emitNow: (next) => { state.jobs = next; api.push(next) },
    emitStatus: async (status) => { await act(async () => api.pushStatus({ ...RUNNING, ...status })) }
  }
  await act(async () => root.render(createElement(ScheduledPanel)))
  return harness
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string) => buttons().find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const must = <T>(value: T | null | undefined, what: string): T => {
  if (value == null) throw new Error(`Not found: ${what}`)
  return value
}
const click = async (element: HTMLElement | undefined | null) => { await act(async () => must(element, 'element to click').click()) }
const control = <T extends HTMLElement>(label: string) => {
  const found = [...document.querySelectorAll('label')].find((item) => item.textContent === label)
  return must(document.getElementById(must(found, `label ${label}`).htmlFor), `control for ${label}`) as T
}
const byAria = <T extends HTMLElement>(label: string) => must(document.querySelector<T>(`[aria-label="${label}"]`), label)
const hasLabel = (text: string) => [...document.querySelectorAll('label')].some((item) => item.textContent === text)
const setValue = async (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
  const setter = must(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set, 'value setter')
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
/** The options a shared Select offers: it lists them only while open, so this opens and closes it. */
const optionsOf = async (label: string) => {
  const trigger = control<HTMLButtonElement>(label)
  await click(trigger)
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => ({
    text: option.querySelector('.ui-select-option-label')?.textContent ?? '',
    disabled: option.getAttribute('aria-disabled') === 'true'
  }))
  await click(trigger)
  return options
}
const pick = async (trigger: HTMLElement, optionText: string) => {
  await click(trigger)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.querySelector('.ui-select-option-label')?.textContent === optionText)
  await click(must(option, `option ${optionText}`))
}
const choose = (label: string, optionText: string) => pick(control<HTMLButtonElement>(label), optionText)
/** Edit, Webhook, Delete and the rest live in the row's "…" menu. */
const menuItems = async (jobName: string) => {
  await click(button(`More actions for ${jobName}`))
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => item.textContent)
  await key(document, 'Escape')
  return items
}
const menuAction = async (jobName: string, action: string) => {
  await click(button(`More actions for ${jobName}`))
  await click(must([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === action), `${action} in the menu`))
}
const rowOf = (id: string) => must(document.querySelector<HTMLElement>(`[data-job-id="${id}"]`), id)
const statusText = (id: string) => rowOf(id).querySelector('[data-meta="status"]')?.textContent
const expandRow = async (id: string) => {
  const row = rowOf(id)
  if (row.getAttribute('data-open') !== 'true') await click(row.querySelector<HTMLElement>('[data-row-button]'))
  return row
}
const openDetails = async () => {
  const toggle = must(buttons().find((item) => item.textContent === 'Details'), 'Details')
  if (toggle.getAttribute('aria-expanded') !== 'true') await click(toggle)
}
/** The custom schedule builder, behind Details › Schedule › Change. */
const openBuilder = async () => {
  await openDetails()
  const change = must(button('Change'), 'Change')
  if (change.getAttribute('aria-expanded') !== 'true') await click(change)
}
const key = async (element: Element | Document, name: string, init: KeyboardEventInit = {}) => {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}
const frame = async () => { await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))) }) }
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent ?? '')

/** Opens the task from its "…" menu, with Details shown. */
async function openEdit(item = job()): Promise<void> {
  await menuAction(item.name, 'Edit')
  await openDetails()
}
async function save(): Promise<void> {
  await click(button('Save'))
}

const quickInput = () => byAria<HTMLInputElement>('New task')
/** Types into the quick-add line. */
const type = async (text: string) => {
  await act(async () => quickInput().focus())
  await setValue(quickInput(), text)
}
/** Opens the full editor for a new task from the quick-add line's Custom…. */
async function openNew(prompt = ''): Promise<void> {
  await type(prompt)
  await click(button('Custom…'))
}

const PROJECT_JOB = () => job({ projectId: 'p1' })

describe('Scheduled page: editing a task saves only what changed', () => {
  const cases: Array<[string, () => ScheduledJob, () => Promise<void>, ScheduledJobPatch]> = [
    ['name', job, () => setValue(control('Name'), 'Renamed'), { name: 'Renamed' }],
    ['prompt', job, () => setValue(control('Prompt'), 'Look at the failing tests'), { prompt: 'Look at the failing tests' }],
    ['interval minutes', job, async () => { await openBuilder(); await setValue(control('Minutes between runs'), '45') }, { schedule: { kind: 'interval', minutes: 45 } }],
    ['cron schedule', job, async () => { await openBuilder(); await click(button('Cron')); await setValue(control('Cron expression'), '0 8 1 * *') }, { schedule: { kind: 'cron', expr: '0 8 1 * *' } }],
    ['one-time schedule', job, async () => { await openBuilder(); await click(button('Once')); await setValue(control('Run at'), '2030-01-02T03:04') }, { schedule: { kind: 'once', runAt: new Date('2030-01-02T03:04').toISOString() } }],
    ['manual schedule', job, async () => { await openBuilder(); await click(button('Manual')) }, { schedule: { kind: 'manual' } }],
    ['a preset chip', job, () => click(button(WEEKDAYS)), { schedule: { kind: 'cron', expr: '0 9 * * 1-5' } }],
    ['model', job, () => choose('Model', 'Claude Sonnet'), { selection: sonnet }],
    ['clearing the model', () => job({ selection: sonnet }), () => choose('Model', 'Default model'), { selection: null }],
    ['mode', job, () => choose('Mode', 'Plan (no changes)'), { mode: 'plan' }],
    ['clearing the mode', () => job({ mode: 'agent' }), () => choose('Mode', 'Default'), { mode: null }],
    ['project', job, () => choose('Where', 'Mousse'), { projectId: 'p1' }],
    ['clearing the project', PROJECT_JOB, () => choose('Where', 'No project'), { projectId: null }],
    ['thread', PROJECT_JOB, () => choose('Thread', 'Release thread'), { threadId: 't1', createThread: false }],
    [
      'thread on a task with a new-worktree workspace (a bound task takes no workspace)',
      () => job({ projectId: 'p1', workspace: { kind: 'newWorktree' } }),
      () => choose('Thread', 'Release thread'),
      { threadId: 't1', createThread: false, workspace: null }
    ],
    ['new thread per run again', () => job({ projectId: 'p1', threadId: 't1' }), () => choose('Thread', 'A new thread for each run'), { threadId: null, createThread: true }],
    ['new-worktree workspace', PROJECT_JOB, () => choose('Runs in', 'New worktree per run (recommended)'), { workspace: { kind: 'newWorktree' } }],
    [
      'existing worktree workspace',
      PROJECT_JOB,
      async () => { await choose('Runs in', 'Existing worktree'); await setValue(control('Worktree path'), '/work/mousse-wt') },
      { workspace: { kind: 'worktree', path: '/work/mousse-wt' }, threadId: null }
    ],
    [
      'leaving an existing worktree drops its owner thread',
      () => job({ projectId: 'p1', threadId: 't1', workspace: { kind: 'worktree', path: '/work/mousse-wt' } }),
      () => choose('Runs in', 'Project checkout'),
      { workspace: null, threadId: null, createThread: true }
    ]
  ]

  it.each(cases)('%s', async (_name, makeJob, change, expected) => {
    const item = makeJob()
    const h = await mount([item])
    await openEdit(item)
    await change()
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledTimes(1)
    expect(h.api.scheduled.update).toHaveBeenCalledWith(item.id, expected)
    // Saved: the row closes.
    expect(document.querySelector('form')).toBeNull()
  })

  it('Save stays off until something changed, and Cancel sends nothing', async () => {
    const h = await mount([PROJECT_JOB()])
    await openEdit()
    expect(button('Save')?.disabled).toBe(true)
    await setValue(control('Name'), 'Renamed')
    expect(button('Save')?.disabled).toBe(false)
    await setValue(control('Name'), 'Nightly')
    expect(button('Save')?.disabled).toBe(true)
    await click(button('Cancel'))
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
    expect(document.querySelector('form')).toBeNull()
  })

  it('an edit never rewrites fields it did not touch (a stale model stays as it was)', async () => {
    const stale = { instanceId: 'gone:one', llmProvider: 'gone', model: 'retired' }
    const h = await mount([job({ selection: stale })])
    await openEdit()
    expect(control('Model').textContent).toBe('Retired (not available now)')
    await setValue(control('Name'), 'Still nightly')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { name: 'Still nightly' })
  })
})

describe('Scheduled page: validation', () => {
  it('names what is wrong, saves nothing, and puts focus on the first problem', async () => {
    const h = await mount([job()])
    await openEdit()
    await setValue(control('Prompt'), '   ')
    await setValue(control('Name'), '')
    await openBuilder()
    await setValue(control('Minutes between runs'), '0')
    await save()
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
    expect(alerts()).toEqual(expect.arrayContaining(['Give the task a name.', 'Write what the agent should do.', 'Use a whole number of minutes, at least 1.']))
    // The prompt is the first field the form shows.
    expect(document.activeElement).toBe(control('Prompt'))
    expect(control('Prompt').getAttribute('aria-invalid')).toBe('true')
    expect(control('Prompt').getAttribute('aria-describedby')).toBe(document.querySelector('[role="alert"]')?.id)
  })

  it('opens Details to show a problem that lives there, and focuses it', async () => {
    const h = await mount([job()])
    await menuAction('Nightly', 'Edit')
    await openDetails()
    await setValue(control('Name'), '')
    // Folded away again: saving opens it for the problem.
    await click(must(buttons().find((item) => item.textContent === 'Details'), 'Details'))
    expect(hasLabel('Name')).toBe(false)
    await save()
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['Give the task a name.'])
    expect(document.activeElement).toBe(control('Name'))
  })

  it('shows nothing until the first save attempt, then clears a problem once it is fixed', async () => {
    await mount([job()])
    await openEdit()
    await setValue(control('Prompt'), '')
    expect(alerts()).toEqual([])
    await save()
    expect(alerts()).toEqual(['Write what the agent should do.'])
    await setValue(control('Prompt'), 'Back again')
    expect(alerts()).toEqual([])
  })

  it('checks cron fields and a missing worktree path', async () => {
    const h = await mount([PROJECT_JOB()])
    await openEdit()
    await openBuilder()
    await click(button('Cron'))
    await setValue(control('Cron expression'), '* *')
    await choose('Runs in', 'Existing worktree')
    await save()
    expect(alerts()).toEqual(expect.arrayContaining(['A cron expression has five fields, for example 0 9 * * *.', 'Enter the path of the worktree.']))
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
  })

  it('refuses a one-time schedule for a task with a webhook, and says how to fix it', async () => {
    const h = await mount([job({ trigger: webhookTrigger })])
    await openEdit()
    await openBuilder()
    await click(button('Once'))
    await save()
    expect(alerts().join(' ')).toContain('cannot be one-time')
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
  })

  it('offers only modes the task may use: no plan with a new worktree, no new worktree with plan', async () => {
    await mount([PROJECT_JOB()])
    await openEdit()
    const modes = async () => (await optionsOf('Mode')).map((option) => option.text)
    const workspaces = async () => (await optionsOf('Runs in')).map((option) => option.text)
    expect(await modes()).toEqual(['Default', 'Agent', 'Plan (no changes)'])
    await choose('Runs in', 'New worktree per run (recommended)')
    expect(await modes()).toEqual(['Default', 'Agent'])
    await choose('Runs in', 'Project checkout')
    await choose('Mode', 'Plan (no changes)')
    expect(await workspaces()).toEqual(['Project checkout', 'Existing worktree'])
  })

  it('shows what the profile refuses, in words, and keeps the form open for another try', async () => {
    const h = await mount([PROJECT_JOB()])
    h.api.scheduled.update.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:update': Error: A new worktree needs a project backed by a Git repository"))
    await openEdit()
    await choose('Runs in', 'New worktree per run (recommended)')
    await save()
    expect(document.querySelector('[data-testid="save-error"]')?.textContent).toBe('A new worktree needs a project backed by a Git repository')
    expect(document.querySelector('form')).not.toBeNull()
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledTimes(2)
    expect(document.querySelector('form')).toBeNull()
  })

  it('warns about the project checkout and recommends a new worktree; the default mode explains itself', async () => {
    await mount([PROJECT_JOB()])
    await openEdit()
    expect(document.querySelector('[data-testid="workspace-warning"]')?.textContent).toContain('no checkpoints or undo')
    const modeNote = must(document.querySelector<HTMLElement>('[data-testid="mode-note"]'), 'mode note')
    expect(modeNote.textContent).toBe(MODE_SHORT)
    expect(modeNote.title).toBe(MODE_NOTE)
    await choose('Mode', 'Plan (no changes)')
    expect(document.querySelector('[data-testid="workspace-warning"]')).toBeNull()
    expect(document.querySelector('[data-testid="mode-note"]')).toBeNull()
    await choose('Runs in', 'Existing worktree')
    expect(document.querySelector('[data-testid="workspace-warning"]')).toBeNull()
  })

  it('shows the thread\'s own workspace for a task bound to a thread', async () => {
    await mount([job({ projectId: 'p1', threadId: 't1' })])
    await openEdit()
    expect(hasLabel('Runs in')).toBe(false)
    expect(document.body.textContent).toContain("The thread's own workspace")
    // The subagent thread is not offered; a thread of another project is not offered for this project.
    expect((await optionsOf('Thread')).map((option) => option.text)).toEqual(['A new thread for each run', 'Release thread'])
  })
})

describe('Scheduled page: quick add', () => {
  const created = (h: Harness) => h.api.scheduled.create.mock.calls[0][0] as Record<string, unknown>
  const addButton = () => must(buttons().find((item) => item.textContent?.startsWith('Add') && item.classList.contains('scheduled-add')), 'Add')

  it('shows one line until focused, then the schedule chips, a project and Add', async () => {
    await mount([])
    expect(quickInput().placeholder).toBe('What should the agent do?')
    expect(button('Hourly')).toBeUndefined()
    await act(async () => quickInput().focus())
    expect(button('Hourly')).toBeDefined()
    expect(button(DAILY)).toBeDefined()
    expect(button(WEEKDAYS)).toBeDefined()
    expect(button('Custom…')).toBeDefined()
    expect(byAria('Project').textContent).toBe('No project')
    expect(addButton().disabled).toBe(true)
    expect(document.body.textContent).toContain('Nothing scheduled yet.')
  })

  it('Enter adds the task with a preset, named after its first sentence, in a new worktree for a Git project', async () => {
    const h = await mount([])
    await type('Summarize open PRs. Post the list to #eng.')
    await click(button(WEEKDAYS))
    expect(button(WEEKDAYS)?.getAttribute('aria-pressed')).toBe('true')
    await pick(byAria('Project'), 'Mousse')
    const preview = document.querySelector('[data-testid="quick-preview"]')?.textContent
    expect(preview).toMatch(new RegExp(`^Monday to Friday at ${clockText(9, 0)} · First run .+ · Runs in a new worktree, on your default model$`))
    await key(quickInput(), 'Enter')
    expect(h.api.scheduled.create).toHaveBeenCalledWith({
      name: 'Summarize open PRs',
      prompt: 'Summarize open PRs. Post the list to #eng.',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
      projectId: 'p1',
      createThread: true,
      workspace: { kind: 'newWorktree' }
    })
    // The line is ready for the next task.
    expect(quickInput().value).toBe('')
  })

  it('a project that is not a Git repository runs in its checkout', async () => {
    const h = await mount([])
    await type('Tidy the notes folder')
    await click(button(DAILY))
    await pick(byAria('Project'), 'Other')
    expect(document.querySelector('[data-testid="quick-preview"]')?.textContent).toContain('Runs in the project checkout')
    await click(addButton())
    expect(created(h)).toMatchObject({ projectId: 'p2', schedule: { kind: 'cron', expr: '0 9 * * *' }, createThread: true })
    expect(created(h)).not.toHaveProperty('workspace')
    expect(h.api.git.status).toHaveBeenCalledWith({ projectId: 'p2', workspaceThreadId: null })
  })

  it('with no chip chosen it keeps the editor\'s default of every 30 minutes, and says so', async () => {
    const h = await mount([])
    await type('Check CI')
    expect(document.querySelector('[data-testid="quick-preview"]')?.textContent).toMatch(/^Every 30 minutes · First run .+ · Runs in a new thread, on your default model$/)
    await key(quickInput(), 'Enter')
    expect(created(h)).toEqual({ name: 'Check CI', prompt: 'Check CI', schedule: { kind: 'interval', minutes: 30 }, createThread: true })
  })

  it('a chip pressed again is unchosen', async () => {
    await mount([])
    await type('Check CI')
    await click(button('Hourly'))
    expect(document.querySelector('[data-testid="quick-preview"]')?.textContent).toMatch(/^Every hour · /)
    await click(button('Hourly'))
    expect(button('Hourly')?.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-testid="quick-preview"]')?.textContent).toMatch(/^Every 30 minutes · /)
  })

  it('does nothing with an empty line, and shows a refusal in words', async () => {
    const h = await mount([])
    await type('   ')
    await key(quickInput(), 'Enter')
    expect(h.api.scheduled.create).not.toHaveBeenCalled()
    await type('Check CI')
    h.api.scheduled.create.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:create': Error: Too many tasks"))
    await key(quickInput(), 'Enter')
    expect(alerts()).toEqual(['Too many tasks'])
    expect(quickInput().value).toBe('Check CI')
  })

  it('Custom… opens the full editor with the prompt, the 30-minute default and the worktree default carried over', async () => {
    const h = await mount([])
    await type('Check CI in the repo')
    await pick(byAria('Project'), 'Mousse')
    await click(button('Custom…'))
    const form = must(document.querySelector('form[aria-label="New scheduled task"]'), 'new task form')
    expect(control<HTMLTextAreaElement>('Prompt').value).toBe('Check CI in the repo')
    expect(document.activeElement).toBe(control('Prompt'))
    expect(form.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Custom…')
    expect(control<HTMLInputElement>('Minutes between runs').value).toBe('30')
    expect(control('Runs in').textContent).toBe('New worktree per run (recommended)')
    expect(control<HTMLInputElement>('Name').placeholder).toBe('Check CI in the repo')
    await click(button('Add'))
    expect(created(h)).toEqual({
      name: 'Check CI in the repo',
      prompt: 'Check CI in the repo',
      schedule: { kind: 'interval', minutes: 30 },
      projectId: 'p1',
      createThread: true,
      workspace: { kind: 'newWorktree' }
    })
    expect(document.querySelector('form')).toBeNull()
    expect(quickInput().value).toBe('')
  })

  it('Escape closes the full editor, keeps what was typed in the line and focuses it', async () => {
    await mount([])
    await openNew('Check CI')
    await key(control('Prompt'), 'Escape')
    expect(document.querySelector('form')).toBeNull()
    await frame()
    expect(document.activeElement).toBe(quickInput())
    expect(quickInput().value).toBe('Check CI')
  })

  it('the full editor sends model, mode, project, a new worktree and a manual schedule', async () => {
    const h = await mount([])
    await openNew('Check CI in the repo')
    await setValue(control('Name'), 'Check CI')
    await choose('Model', 'Claude Sonnet')
    await choose('Mode', 'Agent')
    await choose('Where', 'Mousse')
    await choose('Runs in', 'New worktree per run (recommended)')
    await click(button('Manual'))
    await click(button('Add'))
    expect(h.api.scheduled.create).toHaveBeenCalledWith({
      name: 'Check CI',
      prompt: 'Check CI in the repo',
      schedule: { kind: 'manual' },
      projectId: 'p1',
      createThread: true,
      selection: sonnet,
      mode: 'agent',
      workspace: { kind: 'newWorktree' }
    })
  })

  it('a task bound to a thread sends that thread and no workspace', async () => {
    const h = await mount([])
    await openNew('Summarize')
    await choose('Where', 'Mousse')
    await choose('Runs in', 'New worktree per run (recommended)')
    await choose('Thread', 'Release thread')
    await click(button('Add'))
    const input = created(h)
    expect(input).toMatchObject({ name: 'Summarize', threadId: 't1', projectId: 'p1' })
    expect(input).not.toHaveProperty('workspace')
    expect(input).not.toHaveProperty('createThread')
  })

  it('the full editor needs a prompt', async () => {
    const h = await mount([])
    await openNew('')
    await click(button('Add'))
    expect(h.api.scheduled.create).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['Write what the agent should do.'])
  })
})

describe('Scheduled page: schedule chips and the custom builder', () => {
  const summary = () => document.querySelector('[data-testid="schedule-summary"]')?.textContent
  const pressed = () => document.querySelector('form button[aria-pressed="true"]')?.textContent
  const createWith = async (chip: string) => {
    const h = await mount([])
    await openNew('Check CI')
    await click(button(chip))
    await click(button('Add'))
    return (h.api.scheduled.create.mock.calls[0][0] as { schedule: unknown }).schedule
  }

  it('choosing Hourly is explicit and closes the builder; Custom… afterwards opens on what Hourly set', async () => {
    await mount([])
    await openNew('Check CI')
    await click(button('Hourly'))
    expect(pressed()).toBe('Hourly')
    expect(summary()).toBe('Every hour')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    await click(button('Custom…'))
    expect(control<HTMLInputElement>('Minutes between runs').value).toBe('60')
  })

  it.each([
    ['Hourly', { kind: 'interval', minutes: 60 }],
    [DAILY, { kind: 'cron', expr: '0 9 * * *' }],
    [WEEKDAYS, { kind: 'cron', expr: '0 9 * * 1-5' }]
  ])('%s saves as the scheduler\'s own schedule', async (chip, schedule) => {
    expect(await createWith(chip)).toEqual(schedule)
  })

  it('states the clock a daily preset reads, and predicts no time before saving', async () => {
    await mount([])
    await openNew('Check CI')
    await click(button(WEEKDAYS))
    expect(summary()).toBe(`Monday to Friday at ${clockText(9, 0)}, this computer's time`)
    expect(document.querySelector('form')?.textContent).not.toMatch(/Next /)
  })

  it('a saved preset task opens on its chip with the cron in Details and its next run', async () => {
    const item = job({ schedule: { kind: 'cron', expr: '0 9 * * 1-5' } })
    const h = await mount([item])
    await openEdit(item)
    expect(pressed()).toBe(WEEKDAYS)
    expect(summary()).toBe(`Monday to Friday at ${clockText(9, 0)}, this computer's time · Next ${relativeWhen(item.nextRunAt)}`)
    expect(document.querySelector('.scheduled-mono')?.textContent).toBe('0 9 * * 1-5')
    expect(button('Save')?.disabled).toBe(true)
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
  })

  it('Daily and Weekly are plain forms that save as cron', async () => {
    const item = job({ schedule: { kind: 'cron', expr: '0 9 * * *' } })
    const h = await mount([item])
    await openEdit(item)
    await click(button('Custom…'))
    // A daily expression opens on the Daily form.
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Daily')
    expect(control<HTMLInputElement>('Time').value).toBe('09:00')
    await setValue(control('Time'), '07:30')
    expect(pressed()).toBe('Custom…')
    await click(button('Weekly'))
    await choose('Day', 'Wednesday')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { schedule: { kind: 'cron', expr: '30 7 * * 3' } })
  })

  it('a task on any other schedule opens on Custom… with the builder folded; Change opens it', async () => {
    await mount([job()])
    await openEdit()
    expect(pressed()).toBe('Custom…')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(summary()).toMatch(/^Every 30 minutes/)
    await click(button('Change'))
    expect(control<HTMLInputElement>('Minutes between runs').value).toBe('30')
  })
})

describe('Scheduled page: groups', () => {
  // Thursday 5 November 2026, 12:00 on this computer's clock.
  const now = new Date(2026, 10, 5, 12, 0)
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()
  const tasks = () => [
    job({ id: 'ran', name: 'Ran today', lastRunAt: at(5, 9, 2), lastStatus: 'ok', nextRunAt: at(6, 9), schedule: { kind: 'cron', expr: '0 9 * * 1-5' } }),
    job({ id: 'due', name: 'Due later today', nextRunAt: at(5, 17) }),
    job({ id: 'needs', name: 'Needs an answer', liveStatus: 'needs_answer', liveThreadId: 't-ask', nextRunAt: at(8, 9) }),
    job({ id: 'failed', name: 'Failed today', lastRunAt: at(5, 11), lastStatus: 'error', lastError: 'Timed out', nextRunAt: at(5, 13) }),
    job({ id: 'next-week', name: 'Next week', nextRunAt: at(9, 8, 30) }),
    job({ id: 'tomorrow', name: 'Tomorrow', nextRunAt: at(6, 10) }),
    job({ id: 'manual', name: 'Release checklist', schedule: { kind: 'manual' }, nextRunAt: null, trigger: webhookTrigger }),
    job({ id: 'paused', name: 'Translate docs', state: 'paused', enabled: false, pausedAt: at(4, 18), nextRunAt: null }),
    job({ id: 'done', name: 'One-off', state: 'completed', schedule: { kind: 'once', runAt: at(3, 10) }, lastRunAt: at(3, 10), lastStatus: 'ok', nextRunAt: null })
  ]

  it('sorts tasks into Today, Upcoming, On demand and Paused, with Done only when asked for', () => {
    const groups = groupJobs(tasks(), { now })
    expect(groups.map((group) => [group.label, group.jobs.map((item) => item.id)])).toEqual([
      // What needs a person first: an answer, then a failure; then by next run (due at 17:00 before tomorrow 9:00).
      ['Today', ['needs', 'failed', 'due', 'ran']],
      ['Upcoming', ['tomorrow', 'next-week']],
      ['On demand', ['manual']],
      ['Paused', ['paused']]
    ])
    expect(groupJobs(tasks(), { now, showDone: true }).map((group) => group.label)).toEqual(['Today', 'Upcoming', 'On demand', 'Paused', 'Done'])
    expect(groupJobs([], { now })).toEqual([])
  })

  it('a running task is in Today whatever its schedule, and a paused one that is running too', () => {
    expect(groupOf(job({ schedule: { kind: 'manual' }, nextRunAt: null, liveStatus: 'running' }), now)).toBe('today')
    expect(groupOf(job({ state: 'paused', pendingOccurrence: { occurrenceKey: 'k', threadId: 't', runId: 'r', state: 'running' } }), now)).toBe('today')
    expect(groupOf(job({ nextRunAt: null, lastStatus: 'error', lastRunAt: at(1, 9) }), now)).toBe('today')
    expect(groupOf(job({ state: 'error', nextRunAt: at(9, 9) }), now)).toBe('today')
  })

  it('shows the groups on the page; finished tasks wait under "…" › Show done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    await mount(tasks())
    const heads = () => [...document.querySelectorAll('.scheduled-group-head')].map((item) => item.textContent)
    expect(heads()).toEqual(['Today', 'Upcoming', 'On demand', 'Paused'])
    expect(document.querySelector('[data-job-id="done"]')).toBeNull()
    await click(button('Scheduled page actions'))
    await click(must([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Show done (1)'), 'Show done'))
    expect(heads()).toEqual(['Today', 'Upcoming', 'On demand', 'Paused', 'Done'])
    expect(statusText('done')).toBe(`Done ${relativeWhen(at(3, 10), now)}`)
    await click(button('Scheduled page actions'))
    await click(must([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Hide done'), 'Hide done'))
    expect(heads()).not.toContain('Done')
  })

  it('a page of finished tasks says nothing is left to run', async () => {
    await mount([job({ state: 'completed', nextRunAt: null, lastStatus: 'ok', lastRunAt: NOW })])
    expect(document.body.textContent).toContain('Nothing left to run.')
    expect(document.body.textContent).not.toContain('Nothing scheduled yet.')
  })

  it('Show done is off when nothing is done', async () => {
    await mount([job()])
    await click(button('Scheduled page actions'))
    const item = must([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'Show done'), 'Show done')
    expect(item.disabled).toBe(true)
  })
})

describe('Scheduled page: the row', () => {
  const record = (patch: Partial<NonNullable<ScheduledJob['runHistory']>[number]>) => ({ runAt: '2026-10-27T09:00:00.000Z', status: 'ok' as const, ...patch })

  it('reads as one sentence: project, schedule, status, Open thread and next run; the prompt waits in the open row', async () => {
    const lastRunAt = new Date().toISOString()
    const nextRunAt = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString()
    await mount([job({ projectId: 'p1', lastStatus: 'error', lastError: 'Timed out', lastRunAt, nextRunAt, schedule: { kind: 'cron', expr: '0 9 * * 1-5' }, runHistory: [record({ runAt: lastRunAt, status: 'error', error: 'Timed out', threadId: 't-run' })] })])
    const row = rowOf('job-1')
    expect(row.querySelector('[data-row-button]')?.textContent).toBe('Nightly')
    const segments = [...row.querySelectorAll('.scheduled-row-seg')].map((item) => item.textContent)
    expect(segments).toEqual(['Mousse', `Weekdays at ${clockText(9, 0)}`, `Failed ${relativeWhen(lastRunAt)} · Timed out`, 'Open thread', `Next ${relativeWhen(nextRunAt)}`])
    // Only the status word takes a status colour; the glyph says it too.
    expect(row.querySelector('[data-meta="status"]')?.className).toBe('scheduled-tone-bad')
    expect(row.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('bad')
    expect(row.querySelector('[data-meta="schedule"]')?.getAttribute('title')).toBe('0 9 * * 1-5')
    expect(row.textContent).not.toContain('Check CI')
    await click(must([...row.querySelectorAll('button')].find((item) => item.textContent === 'Open thread'), 'line link'))
    expect(openThread).toHaveBeenLastCalledWith('t-run')
    await expandRow('job-1')
    expect(control<HTMLTextAreaElement>('Prompt').value).toBe('Check CI')
    expect(row.getAttribute('data-open')).toBe('true')
  })

  it('shows a working run as Running or Needs your answer, with the thread as its one control', async () => {
    await mount([
      job({ liveStatus: 'needs_answer', pendingOccurrence: { occurrenceKey: 'k', threadId: 't-run', runId: 'r1', state: 'running' } }),
      job({ id: 'job-2', name: 'Working', liveStatus: 'running', runClaim: { claimedAt: new Date().toISOString() } as never, pendingOccurrence: { occurrenceKey: 'k', threadId: 't-two', runId: 'r2', state: 'running' } }),
      job({ id: 'job-3', name: 'Idle' }),
      // Claimed and still inside its turn: no pending occurrence yet, an older run in the history.
      job({ id: 'job-4', name: 'Claimed', state: 'running', liveStatus: 'needs_answer', liveThreadId: 't-live', runHistory: [{ runAt: '2026-01-01T00:00:00.000Z', status: 'ok', threadId: 't-old' }] })
    ])
    expect(statusText('job-1')).toBe('Needs your answer')
    expect(rowOf('job-1').querySelector('[data-meta="status"]')?.className).toBe('scheduled-tone-warn')
    expect(statusText('job-2')).toMatch(/^Running since /)
    await click(button("Open the thread of Nightly's run"))
    expect(openThread).toHaveBeenCalledWith('t-run')
    expect(statusText('job-4')).toBe('Needs your answer')
    await click(button("Open the thread of Claimed's run"))
    expect(openThread).toHaveBeenLastCalledWith('t-live')
    // A task that never ran has no thread to open: its control is Run now and "…" has no thread either.
    expect(button('Run Idle now')).toBeDefined()
    expect(await menuItems('Idle')).toEqual(['Pause', 'Edit', 'Webhook', 'Delete'])
    // While it runs, Run now waits in "…", off.
    await click(button('More actions for Working'))
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Run now')?.disabled).toBe(true)
  })

  it('has one control and "…": Run now, or Resume when paused; Pause, Edit, the last thread, Webhook and Delete are in the menu', async () => {
    const h = await mount([
      job({ runHistory: [record({ threadId: 't-old' })] }),
      job({ id: 'job-2', name: 'Asleep', state: 'paused', enabled: false, pausedAt: new Date().toISOString(), nextRunAt: null })
    ])
    const labels = [...rowOf('job-1').querySelectorAll('.scheduled-row-actions button')].map((item) => item.getAttribute('aria-label'))
    expect(labels).toEqual(['Run Nightly now', 'More actions for Nightly'])
    expect(await menuItems('Nightly')).toEqual(['Pause', 'Edit', 'Open last thread', 'Webhook', 'Delete'])
    await menuAction('Nightly', 'Pause')
    expect(h.api.scheduled.pause).toHaveBeenCalledWith('job-1')
    await menuAction('Nightly', 'Open last thread')
    expect(openThread).toHaveBeenLastCalledWith('t-old')
    expect(statusText('job-2')).toBe('Paused today')
    await click(button('Resume Asleep'))
    expect(h.api.scheduled.resume).toHaveBeenCalledWith('job-2')
    expect(await menuItems('Asleep')).toEqual(['Run now', 'Edit', 'Webhook', 'Delete'])
  })

  it('keeps everything technical behind a folded Details in the open row', async () => {
    await mount([
      job({ projectId: 'p1', selection: sonnet, mode: 'agent', workspace: { kind: 'newWorktree' }, trigger: webhookTrigger }),
      job({ id: 'job-2', name: 'Queued', pendingOccurrence: { occurrenceKey: 'k', threadId: 't9', runId: 'r1', state: 'queued' } })
    ])
    expect(statusText('job-2')).toBe('Queued')
    expect(rowOf('job-1').querySelector('[data-meta="webhook"]')?.textContent).toBe('Webhook on')
    await expandRow('job-1')
    const details = must(buttons().find((item) => item.textContent === 'Details'), 'Details')
    expect(details.getAttribute('aria-expanded')).toBe('false')
    for (const label of ['Model', 'Mode', 'Runs in', 'Thread', 'Permissions', 'Name']) expect(hasLabel(label)).toBe(false)
    expect(control('Where').textContent).toBe('Mousse')
    await click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(control('Model').textContent).toBe('Claude Sonnet')
    expect(control('Mode').textContent).toBe('Agent')
    expect(control('Runs in').textContent).toBe('New worktree per run (recommended)')
    expect(document.body.textContent).toContain('A new worktree and a new thread for each run')
    expect(control('Thread').textContent).toBe('A new thread for each run')
    const webhookRow = must([...document.querySelectorAll('.scheduled-detail-row')].find((row) => row.textContent?.startsWith('Webhook')), 'webhook row')
    expect(webhookRow.textContent).toBe('WebhookOnManage')
  })

  it('Webhook in Details opens the webhook dialog', async () => {
    await mount([job()])
    await openEdit()
    await click(button('Set up'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).not.toBeNull()
  })

  it('lists the last three runs, newest first, with what each used in its tooltip; All runs shows ten', async () => {
    const history = Array.from({ length: 12 }, (_, index) => record({ runAt: new Date(Date.UTC(2026, 9, 1 + index, 9)).toISOString(), runId: `r${index}`, status: index === 11 ? 'error' : 'ok', error: index === 11 ? 'Provider refused' : undefined, selection: sonnet, mode: 'agent', workspace: { kind: 'newWorktree' }, threadId: `t-${index}` }))
    await mount([job({ runHistory: history })])
    await openEdit()
    const rows = () => [...document.querySelectorAll<HTMLElement>('.scheduled-history-row')]
    expect(rows()).toHaveLength(3)
    expect(document.querySelector('.scheduled-history-sub')?.textContent).toBe('last 3 of 12')
    expect(rows()[0].getAttribute('data-status')).toBe('error')
    expect(rows()[0].textContent).toContain('Provider refused')
    expect(rows()[0].title).toBe('sonnet · Agent · New worktree per run')
    await click(must(rows()[1].querySelector('button'), 'run thread'))
    expect(openThread).toHaveBeenLastCalledWith('t-10')
    await click(button('All runs'))
    expect(rows()).toHaveLength(10)
  })

  it('shows missing placeholders a run recorded', async () => {
    await mount([job({ runHistory: [record({ missingPlaceholders: ['body.pull_request.title'] })] })])
    await openEdit()
    expect(document.body.textContent).toContain('Missing fields: body.pull_request.title')
  })

  it('the open row is marked by its background only, never a bar at an edge', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/scheduled-panel.css'), 'utf8')
    const rule = must(css.match(/\.scheduled-row\[data-open='true'\] \.scheduled-row-head\s*\{([^}]*)\}/), 'open rule')[1]
    expect(rule).toMatch(/background:/)
    expect(rule).not.toMatch(/border|box-shadow|outline/)
    expect(css).not.toMatch(/\[data-open='true'\][^{]*(::before|::after)/)
  })

  it('the quick-add field carries the fill: its input stays clear even where a theme paints inputs white', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/scheduled-panel.css'), 'utf8')
    const rule = must(css.match(/\.scheduled-quick-field \.scheduled-quick-input,\s*\.scheduled-quick-field \.scheduled-quick-input:focus\s*\{([^}]*)\}/), 'reset rule')[1]
    expect(rule).toMatch(/background:\s*transparent/)
  })

  it('a one-time task says when in its schedule, not again as Next', async () => {
    const runAt = new Date(Date.now() + 24 * 3_600_000).toISOString()
    await mount([job({ schedule: { kind: 'once', runAt }, nextRunAt: runAt })])
    expect(rowOf('job-1').querySelector('[data-meta="schedule"]')?.textContent).toBe(`Once, ${relativeWhen(runAt)}`)
    expect(rowOf('job-1').querySelector('[data-meta="next"]')).toBeNull()
  })

  it('reports a refused action instead of failing silently', async () => {
    const h = await mount([job()])
    h.api.scheduled.run.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:run': Error: Job is already running: Nightly"))
    await click(button('Run Nightly now'))
    expect(alerts()).toEqual(['Job is already running: Nightly'])
    expect(document.querySelector('[data-testid="run-progress"]')?.textContent).toBe('')
  })
})

describe('Scheduled page: Run now shows on the row', () => {
  const progress = () => document.querySelector('[data-testid="run-progress"]')?.textContent
  const earlier = { runAt: '2026-10-27T08:00:00.000Z', status: 'ok' as const, threadId: 't-old' }

  it('the row says Starting…, then Running with its thread, then the result; a status region reads it out', async () => {
    const h = await mount([job({ runHistory: [earlier] })])
    await click(button('Run Nightly now'))
    expect(h.api.scheduled.run).toHaveBeenCalledWith('job-1')
    // The earlier record is not this run's result.
    expect(statusText('job-1')).toBe('Starting…')
    expect(progress()).toBe('Starting Nightly.')
    expect(document.querySelector('[data-testid="run-progress"]')?.getAttribute('role')).toBe('status')
    await h.emit([job({ runHistory: [earlier], liveStatus: 'running', liveThreadId: 't-run' })])
    expect(statusText('job-1')).toBe('Running')
    expect(progress()).toBe('Nightly is running.')
    await click(must([...rowOf('job-1').querySelectorAll('button')].find((item) => item.textContent === 'Open thread'), 'Open thread'))
    expect(openThread).toHaveBeenLastCalledWith('t-run')
    const failedAt = new Date().toISOString()
    await h.emit([job({ runHistory: [earlier, { runAt: failedAt, status: 'error', error: 'Provider refused', threadId: 't-run' }] })])
    expect(statusText('job-1')).toBe(`Failed ${relativeWhen(failedAt)} · Provider refused`)
    expect(progress()).toBe('Nightly failed: Provider refused')
  })

  it('says when the run finished', async () => {
    const h = await mount([job()])
    await click(button('Run Nightly now'))
    const doneAt = new Date().toISOString()
    await h.emit([job({ runHistory: [{ runAt: doneAt, status: 'ok', threadId: 't-run' }] })])
    expect(statusText('job-1')).toBe(`Done ${relativeWhen(doneAt)}`)
    expect(progress()).toBe('Nightly finished.')
  })
})

describe('Scheduled page: deleting a task asks first', () => {
  const two = () => [job({ id: 'a', name: 'Alpha', nextRunAt: '2030-10-27T11:00:00.000Z' }), job({ id: 'b', name: 'Bravo', nextRunAt: '2030-10-27T12:00:00.000Z' })]
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

  it('names the task; Escape keeps it and returns focus to its "…" button', async () => {
    const h = await mount(two())
    await menuAction('Alpha', 'Delete')
    expect(dialog()?.textContent).toContain('Delete “Alpha”?')
    // Focus starts on the dialog, never on the destructive button.
    expect(document.activeElement).not.toBe(document.querySelector('[data-testid="delete-job-confirm"]'))
    await key(document, 'Escape')
    expect(dialog()).toBeNull()
    expect(h.api.scheduled.delete).not.toHaveBeenCalled()
    expect(document.querySelector('[data-job-id="a"]')).not.toBeNull()
    await frame()
    expect(document.activeElement).toBe(button('More actions for Alpha'))
  })

  it('Cancel keeps the task too', async () => {
    const h = await mount(two())
    await menuAction('Bravo', 'Delete')
    await click(button('Cancel'))
    expect(dialog()).toBeNull()
    expect(h.api.scheduled.delete).not.toHaveBeenCalled()
  })

  it('deletes after the confirming button and moves focus to the next row', async () => {
    const h = await mount(two())
    h.api.scheduled.delete.mockImplementation(async () => { h.state.jobs = h.state.jobs.filter((item) => item.id !== 'a'); return true })
    await menuAction('Alpha', 'Delete')
    await click(document.querySelector<HTMLElement>('[data-testid="delete-job-confirm"]'))
    expect(h.api.scheduled.delete).toHaveBeenCalledWith('a')
    expect(dialog()).toBeNull()
    expect(document.querySelector('[data-job-id="a"]')).toBeNull()
    await frame()
    expect(document.activeElement).toBe(document.querySelector('[data-job-id="b"] [data-row-button]'))
  })

  it('moves focus to the quick-add line when the last task is deleted', async () => {
    const h = await mount([job()])
    h.api.scheduled.delete.mockImplementation(async () => { h.state.jobs = []; return true })
    await menuAction('Nightly', 'Delete')
    await click(document.querySelector<HTMLElement>('[data-testid="delete-job-confirm"]'))
    await frame()
    expect(document.activeElement).toBe(quickInput())
  })

  it('keeps the dialog open with the reason when deleting is refused', async () => {
    const h = await mount([job()])
    h.api.scheduled.delete.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:delete': Error: The scheduler is shutting down"))
    await menuAction('Nightly', 'Delete')
    await click(document.querySelector<HTMLElement>('[data-testid="delete-job-confirm"]'))
    expect(dialog()).not.toBeNull()
    expect(alerts()).toEqual(['The scheduler is shutting down'])
    expect(document.querySelector('[data-job-id="job-1"]')).not.toBeNull()
  })
})

describe('Scheduled page: scheduler state', () => {
  const warning = () => document.querySelector<HTMLElement>('[data-testid="scheduler-state"]')

  it('says nothing while the scheduler runs, and one warning line with Refresh when it does not', async () => {
    const h = await mount([job()])
    expect(warning()).toBeNull()
    expect(button('Refresh')).toBeUndefined()
    await h.emitStatus({ running: false })
    expect(warning()?.textContent).toBe('Scheduler stopped. Nothing will run.Refresh')
    expect(warning()?.querySelector('.settings-status-warn')).not.toBeNull()
    h.api.scheduled.status.mockRejectedValueOnce(new Error('no answer'))
    await click(button('Refresh'))
    expect(warning()?.textContent).toBe('Scheduler did not answer.Refresh')
    h.api.scheduled.status.mockResolvedValueOnce({ ...RUNNING, running: false })
    await click(button('Refresh'))
    expect(warning()?.textContent).toBe('Scheduler stopped. Nothing will run.Refresh')
    await click(button('Refresh'))
    expect(warning()).toBeNull()
  })
})

describe('Scheduled page: the webhook secret is shown once', () => {
  const hooked = () => job({ trigger: webhookTrigger })
  const grant = (secret?: string) => ({ job: hooked(), url: URL_OF('job-1'), ...(secret ? { secret } : {}) })

  it('shows the secret after enabling with a copy button, then never again', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await menuAction('Nightly', 'Webhook')
    expect(document.body.textContent).toContain('Enable webhook')
    expect(h.api.scheduled.webhook.deliveries).not.toHaveBeenCalled()
    await click(button('Enable webhook'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
    expect(document.querySelector('[data-testid="webhook-url"]')?.textContent).toBe(URL_OF('job-1'))
    expect(document.body.textContent).toContain('shown only this once')

    await click(button('Copy secret'))
    expect(h.clipboard.writeText).toHaveBeenCalledWith(SECRET)
    expect(button('Copied')).toBeDefined()

    await click(button('Done'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)

    // Opening it again shows the address and the log but not the secret; nothing can ask for it.
    await menuAction('Nightly', 'Webhook')
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.querySelector('[data-testid="webhook-secret"]')).toBeNull()
    expect(document.querySelector('[data-testid="webhook-secret-hidden"]')?.textContent).toContain('not shown again')
    expect(document.querySelector('[data-testid="webhook-url"]')?.textContent).toBe(URL_OF('job-1'))
  })

  it('shows the secret even when the answer arrives before the job update', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockResolvedValue(grant(SECRET))
    await menuAction('Nightly', 'Webhook')
    await click(button('Enable webhook'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
    await h.emit([hooked()])
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
  })

  it('drops the secret when the dialog is closed with Escape or the close button', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await menuAction('Nightly', 'Webhook')
    await click(button('Enable webhook'))
    await key(document, 'Escape')
    expect(document.body.textContent).not.toContain(SECRET)
    await menuAction('Nightly', 'Webhook')
    expect(document.body.textContent).not.toContain(SECRET)
    await click(button('Close'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('rotating shows the new secret once, says the old one stopped, and the old one is gone from the page', async () => {
    const h = await mount([hooked()])
    const NEW_SECRET = 'whsec_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW1'
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(NEW_SECRET))
    await menuAction('Nightly', 'Webhook')
    expect(document.querySelector('[data-testid="webhook-secret"]')).toBeNull()
    await click(button('Rotate secret'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(NEW_SECRET)
    expect(document.body.textContent).toContain('The old secret no longer works.')
    expect(h.api.scheduled.webhook.rotate).toHaveBeenCalledWith('job-1')
    await click(button('Close'))
    expect(document.body.textContent).not.toContain(NEW_SECRET)
  })

  it('hides the secret by itself after a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await mount([hooked()])
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(SECRET))
    await menuAction('Nightly', 'Webhook')
    await click(button('Rotate secret'))
    expect(document.body.textContent).toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(SECRET_VISIBLE_MS - 1) })
    expect(document.body.textContent).toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(2) })
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.querySelector('[data-testid="webhook-secret-hidden"]')?.textContent).toContain('The secret was hidden.')
  })

  it('keeps the secret out of the page when copying fails, and says so', async () => {
    const h = await mount([hooked()])
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(SECRET))
    h.clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
    await menuAction('Nightly', 'Webhook')
    await click(button('Rotate secret'))
    await click(button('Copy secret'))
    expect(alerts()).toEqual(['Copying failed. Select the text and copy it by hand.'])
    expect(button('Copied')).toBeUndefined()
  })

  it('cannot enable a webhook on a one-time task or one an agent added, and says why', async () => {
    await mount([
      job({ schedule: { kind: 'once', runAt: '2030-01-01T00:00:00.000Z' } }),
      job({ id: 'job-2', name: 'Agent job', createdBy: { threadId: 't1' } })
    ])
    await menuAction('Nightly', 'Webhook')
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Change its schedule to Manual first.')
    await key(document, 'Escape')
    await menuAction('Agent job', 'Webhook')
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Tasks an agent added cannot have a webhook.')
  })

  it('shows a refusal from enabling, and a listener that did not start', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:enable': Error: Webhooks are not available in this profile."))
    await menuAction('Nightly', 'Webhook')
    await click(button('Enable webhook'))
    expect(alerts()).toEqual(['Webhooks are not available in this profile.'])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return { ...grant(SECRET), listening: false, error: 'The webhook listener could not start on port 18790.' } })
    await click(button('Enable webhook'))
    expect(document.body.textContent).toContain('could not start on port 18790')
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
  })
})

describe('Scheduled page: disabling a webhook needs a confirmation', () => {
  const hooked = () => job({ trigger: webhookTrigger })

  async function openWebhook(): Promise<Harness> {
    const h = await mount([hooked()])
    h.api.scheduled.webhook.disable.mockImplementation(async () => { h.emitNow([job()]); return job() })
    await menuAction('Nightly', 'Webhook')
    return h
  }
  const dialogs = () => document.querySelectorAll('[role="dialog"]')

  it('asks first; Keep webhook changes nothing', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    expect(dialogs()).toHaveLength(2)
    expect(document.body.textContent).toContain('stop working right away')
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
    await click(button('Keep webhook'))
    expect(dialogs()).toHaveLength(1)
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
  })

  it('disables only after the confirming button, then offers to enable again', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    const confirm = [...buttons()].filter((item) => item.textContent === 'Disable webhook').pop()
    await click(confirm)
    expect(h.api.scheduled.webhook.disable).toHaveBeenCalledTimes(1)
    expect(h.api.scheduled.webhook.disable).toHaveBeenCalledWith('job-1')
    expect(dialogs()).toHaveLength(1)
    expect(button('Enable webhook')).toBeDefined()
  })

  it('Escape cancels the question and leaves the webhook dialog open; focus starts on the dialog, not the destructive button', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    const destructive = [...buttons()].filter((item) => item.textContent === 'Disable webhook').pop()
    expect(document.activeElement).not.toBe(destructive)
    expect(document.activeElement?.getAttribute('role') === 'dialog' || document.activeElement?.classList.contains('modal')).toBe(true)
    await key(document, 'Escape')
    expect(dialogs()).toHaveLength(1)
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
    await key(document, 'Escape')
    expect(dialogs()).toHaveLength(0)
  })

  it('a refusal from disabling is shown and the webhook stays', async () => {
    const h = await openWebhook()
    h.api.scheduled.webhook.disable.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:disable': Error: This job has no webhook."))
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook').pop())
    expect(alerts()).toEqual(['This job has no webhook.'])
    expect(button('Rotate secret')).toBeDefined()
  })
})

describe('Scheduled page: recent requests', () => {
  const row = (patch: Partial<ScheduledWebhookDelivery>): ScheduledWebhookDelivery => ({ receivedAt: '2026-10-27T09:00:00.000Z', outcome: 'accepted', bodyBytes: 120, ...patch })

  async function openLog(deliveries: ScheduledWebhookDelivery[]): Promise<Harness> {
    const h = await mount([job({ trigger: webhookTrigger })])
    h.api.scheduled.webhook.deliveries.mockResolvedValue({ deliveries, url: URL_OF('job-1') })
    await menuAction('Nightly', 'Webhook')
    return h
  }
  const items = () => [...document.querySelectorAll<HTMLElement>('.scheduled-request')]

  it('lists accepted and refused requests with a reason each', async () => {
    await openLog([
      row({ outcome: 'completed', occurrenceId: 'o1' }),
      row({ outcome: 'rejected_signature', bodyBytes: 1, receivedAt: '2026-10-27T09:01:00.000Z' }),
      row({ outcome: 'running', receivedAt: '2026-10-27T09:02:00.000Z' }),
      row({ outcome: 'too_large', bodyBytes: 2_000_000, receivedAt: '2026-10-27T09:03:00.000Z' }),
      row({ outcome: 'dispatch_failed', error: 'Thread was deleted.', receivedAt: '2026-10-27T09:04:00.000Z' })
    ])
    expect(document.querySelector('[aria-label="Recent requests"]')).not.toBeNull()
    expect(items()).toHaveLength(5)
    const [completed, signature, running, large, failed] = items()
    expect(completed.getAttribute('data-refused')).toBe('false')
    expect(completed.textContent).toContain('Accepted')
    expect(completed.textContent).toContain('The run finished.')
    expect(completed.textContent).toContain('120 bytes')
    expect(signature.getAttribute('data-refused')).toBe('true')
    expect(signature.textContent).toContain('Refused')
    expect(signature.textContent).toContain('The signature did not match.')
    expect(signature.textContent).toContain('1 byte')
    expect(running.textContent).toContain('The job was already running.')
    expect(large.textContent).toContain('The request body was too large.')
    expect(failed.textContent).toContain('Accepted')
    expect(failed.textContent).toContain('Thread was deleted.')
  })

  it('shows sizes and reasons only: a body or header that reached the page is never printed', async () => {
    const leaky = { ...row({ outcome: 'accepted' }), body: 'BODY-TEXT-FROM-SENDER', headers: { 'x-api-key': 'HEADER-VALUE' }, payload: { a: 'PAYLOAD-VALUE' } } as ScheduledWebhookDelivery
    await openLog([leaky])
    const text = document.body.textContent ?? ''
    expect(items()).toHaveLength(1)
    expect(text).toContain('120 bytes')
    for (const hidden of ['BODY-TEXT-FROM-SENDER', 'HEADER-VALUE', 'PAYLOAD-VALUE']) expect(text).not.toContain(hidden)
  })

  it('says so when there are no requests, and when the log cannot be read', async () => {
    const h = await openLog([])
    expect(document.body.textContent).toContain('No requests yet.')
    h.api.scheduled.webhook.deliveries.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:deliveries': Error: Job not found: job-1"))
    await click(button('Refresh requests'))
    expect(alerts()).toEqual(['Job not found: job-1'])
  })

  it('shows the fields a template could not fill, when the log records them', async () => {
    await openLog([row({ missingPlaceholders: ['body.pull_request.title', 'headers.x-event'] })])
    expect(items()[0].textContent).toContain('Missing fields: body.pull_request.title, headers.x-event')
  })

  it('reloads the log when the job changes (a request started a run)', async () => {
    const h = await openLog([])
    expect(h.api.scheduled.webhook.deliveries).toHaveBeenCalledTimes(1)
    h.api.scheduled.webhook.deliveries.mockResolvedValue({ deliveries: [row({ outcome: 'queued' })], url: URL_OF('job-1') })
    await h.emit([job({ trigger: webhookTrigger, updatedAt: '2026-10-27T10:05:00.000Z', state: 'running' })])
    expect(h.api.scheduled.webhook.deliveries).toHaveBeenCalledTimes(2)
    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('Waiting in the queue behind another run.')
  })

  it('closes when the job is deleted, taking any secret with it', async () => {
    const h = await openLog([])
    await h.emit([job({ id: 'job-2', name: 'Other' })])
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
  })
})

describe('Scheduled page: keyboard', () => {
  const three = () => [job({ id: 'a', name: 'Alpha', nextRunAt: '2030-10-27T11:00:00.000Z' }), job({ id: 'b', name: 'Bravo', nextRunAt: '2030-10-27T12:00:00.000Z' }), job({ id: 'c', name: 'Charlie', nextRunAt: '2030-10-27T13:00:00.000Z' })]
  const rowButtons = () => [...document.querySelectorAll<HTMLElement>('[data-row-button]')]

  it('arrow keys, Home and End move between rows; they stop at the ends', async () => {
    await mount(three())
    const [alpha, bravo, charlie] = rowButtons()
    alpha.focus()
    await key(alpha, 'ArrowDown')
    expect(document.activeElement).toBe(bravo)
    await key(bravo, 'ArrowDown')
    expect(document.activeElement).toBe(charlie)
    await key(charlie, 'ArrowDown')
    expect(document.activeElement).toBe(charlie)
    await key(charlie, 'ArrowUp')
    expect(document.activeElement).toBe(bravo)
    await key(bravo, 'Home')
    expect(document.activeElement).toBe(alpha)
    await key(alpha, 'End')
    expect(document.activeElement).toBe(charlie)
  })

  it('every control is a labelled button a person can tab to', async () => {
    await mount(three())
    const unlabeled = buttons().filter((item) => !(item.textContent?.trim() || item.getAttribute('aria-label') || item.title || item.labels.length > 0))
    expect(unlabeled).toEqual([])
    const row = rowOf('a')
    for (const name of ['Alpha', 'Run Alpha now', 'More actions for Alpha']) {
      const item = must(button(name), name)
      expect(row.contains(item)).toBe(true)
      expect(item.tabIndex).toBe(0)
    }
    expect(rowOf('a').querySelector('[data-row-button]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape cancels an edit and focus returns to that row\'s "…" button', async () => {
    await mount(three())
    await menuAction('Bravo', 'Edit')
    expect(document.activeElement).toBe(control('Prompt'))
    await key(control('Prompt'), 'Escape')
    expect(document.querySelector('form')).toBeNull()
    await frame()
    expect(document.activeElement).toBe(button('More actions for Bravo'))
  })

  it('opening another row closes the first', async () => {
    await mount(three())
    await expandRow('a')
    await expandRow('b')
    expect(rowOf('a').getAttribute('data-open')).toBeNull()
    expect(rowOf('b').getAttribute('data-open')).toBe('true')
    expect(document.querySelectorAll('form')).toHaveLength(1)
  })

  it('the builder\'s schedule choice is a radio group: arrow keys move the choice and its focus; one stop in the tab order', async () => {
    await mount([job()])
    await openEdit()
    await openBuilder()
    const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios().map((item) => item.textContent)).toEqual(['Every…', 'Daily', 'Weekly', 'Cron', 'Once', 'Manual'])
    expect(radios().filter((item) => item.tabIndex === 0)).toHaveLength(1)
    const checked = () => radios().find((item) => item.getAttribute('aria-checked') === 'true')?.textContent
    expect(checked()).toBe('Every…')
    await key(must(radios().find((item) => item.getAttribute('aria-checked') === 'true')), 'ArrowRight')
    expect(checked()).toBe('Daily')
    await frame()
    expect(document.activeElement?.textContent).toBe('Daily')
    await key(document.activeElement!, 'ArrowLeft')
    expect(checked()).toBe('Every…')
  })

  it('the webhook dialog takes focus on open, keeps Tab inside, closes with Escape and returns focus to the row\'s "…" button', async () => {
    // jsdom lays nothing out, so every control would count as hidden to the dialog's focus handling.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    await mount([job({ trigger: webhookTrigger })])
    await menuAction('Nightly', 'Webhook')
    const dialog = must(document.querySelector<HTMLElement>('[role="dialog"]'), 'dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    const last = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')].pop()!
    last.focus()
    await key(last, 'Tab')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(last)
    await key(document, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await frame()
    expect(document.activeElement).toBe(button('More actions for Nightly'))
  })
})

describe('Scheduled page: tasks agents add', () => {
  const agentsToggle = () => control<HTMLButtonElement>('Agents may add tasks')
  const isOn = () => agentsToggle().getAttribute('aria-checked') === 'true'
  const LIMITS = ['Most active tasks', 'Fewest minutes between runs', 'Days before a task ends'] as const

  it('keeps the setting and its limits in one disclosure below the list that says whether it is on', async () => {
    await mount([job()])
    const disclosure = must(agentsToggle().closest('details'), 'disclosure')
    expect(disclosure.open).toBe(false)
    expect(disclosure.querySelector('summary')?.textContent).toBe('Agents may add tasks · Off')
    for (const label of LIMITS) expect(disclosure.contains(byAria(label))).toBe(true)
    // The limits read as sentences.
    expect([...disclosure.querySelectorAll('.scheduled-limit-control')].map((item) => item.closest('.settings-item')?.textContent)).toEqual(['At mostactive', 'At leastminutes apart', 'End afterdays'])
    const rows = must(document.querySelector('.scheduled-rows'), 'task rows')
    expect(rows.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows "Agents may add tasks" off by default as a switch, and saves the choice', async () => {
    const h = await mount([])
    expect(agentsToggle().getAttribute('role')).toBe('switch')
    expect(isOn()).toBe(false)
    await click(agentsToggle())
    expect(h.api.scheduled.settings.set).toHaveBeenCalledWith({ agentJobs: true })
    expect(isOn()).toBe(true)
    expect(agentsToggle().closest('details')?.querySelector('summary')?.textContent).toBe('Agents may add tasks · On')
    await click(agentsToggle())
    expect(h.api.scheduled.settings.set).toHaveBeenLastCalledWith({ agentJobs: false })
    expect(isOn()).toBe(false)
  })

  it('shows the setting as the profile has it, and says why when the choice is refused', async () => {
    const h = await mount([])
    expect(h.api.scheduled.settings.get).toHaveBeenCalledTimes(1)
    h.api.scheduled.settings.set.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:settings:set': Error: Not saved"))
    await click(agentsToggle())
    expect(alerts().join(' ')).toContain('Not saved')
    expect(isOn()).toBe(false)
  })

  describe('the limits on tasks agents add', () => {
    const limit = (label: (typeof LIMITS)[number]) => byAria<HTMLInputElement>(label)
    const blur = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }) }

    it('shows the three limits under the switch, whether it is on or off, with their values', async () => {
      await mount([])
      expect(isOn()).toBe(false)
      expect(limit('Most active tasks').value).toBe('10')
      expect(limit('Fewest minutes between runs').value).toBe('15')
      expect(limit('Days before a task ends').value).toBe('7')
      await click(agentsToggle())
      expect(limit('Most active tasks').value).toBe('10')
      expect(limit('Most active tasks').closest<HTMLElement>('.settings-item')?.title).toMatch(/never pauses or deletes a task that exists/)
      expect(limit('Days before a task ends').closest<HTMLElement>('.settings-item')?.title).toMatch(/does not change/)
    })

    it('saves a value when the field is left, and only that one', async () => {
      const h = await mount([])
      await setValue(limit('Most active tasks'), '25')
      await blur(limit('Most active tasks'))
      expect(h.api.scheduled.settings.set).toHaveBeenCalledWith({ agentJobMaxActive: 25 })
      expect(limit('Most active tasks').value).toBe('25')
      await setValue(limit('Days before a task ends'), '14')
      await key(limit('Days before a task ends'), 'Enter')
      expect(h.api.scheduled.settings.set).toHaveBeenLastCalledWith({ agentJobLifetimeDays: 14 })
      expect(limit('Days before a task ends').value).toBe('14')
    })

    it.each([
      ['Most active tasks', '0', /from 1 to 100/],
      ['Most active tasks', '101', /from 1 to 100/],
      ['Fewest minutes between runs', '1441', /from 1 to 1440/],
      ['Fewest minutes between runs', '1.5', /from 1 to 1440/],
      ['Days before a task ends', '', /from 1 to 365/],
      ['Days before a task ends', '-3', /from 1 to 365/]
    ] as const)('refuses %s of "%s" and shows the range', async (label, value, range) => {
      const h = await mount([])
      await setValue(limit(label), value)
      await blur(limit(label))
      expect(h.api.scheduled.settings.set).not.toHaveBeenCalled()
      expect(alerts().join(' ')).toMatch(range)
      expect(limit(label).getAttribute('aria-invalid')).toBe('true')
    })

    it('says "Extend N days" with the time that is set', async () => {
      const future = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString()
      const h = await mount([job({ id: 'job-agent', name: 'Agent made', createdBy: { threadId: 't1' }, expiresAt: future })])
      await openEdit(h.state.jobs[0])
      const extendLabel = () => [...document.querySelectorAll('button')].map((item) => item.textContent).find((text) => text?.startsWith('Extend'))
      expect(extendLabel()).toBe('Extend 7 days')
      await setValue(limit('Days before a task ends'), '30')
      await blur(limit('Days before a task ends'))
      expect(h.api.scheduled.settings.set).toHaveBeenCalledWith({ agentJobLifetimeDays: 30 })
      expect(extendLabel()).toBe('Extend 30 days')
    })
  })

  it('an agent\'s task is an ordinary row that says when it ends; a person extends it in Details', async () => {
    const future = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString()
    const h = await mount([
      job({ id: 'job-agent', name: 'Agent made', createdBy: { threadId: 't1' }, expiresAt: future }),
      job({ id: 'job-person', name: 'Person made' })
    ])
    expect(rowOf('job-agent').querySelector('[data-meta="agent"]')?.textContent).toMatch(/^Added by an agent, ends /)
    expect(rowOf('job-person').querySelector('[data-meta="agent"]')).toBeNull()
    await openEdit(h.state.jobs[1])
    expect(document.querySelector('[data-testid="agent-row"]')).toBeNull()
    await openEdit(h.state.jobs[0])
    const agentRow = must(document.querySelector('[data-testid="agent-row"]'), 'agent row')
    expect(agentRow.textContent).toContain('From Release thread')
    expect(agentRow.querySelector('[data-meta="expires"]')?.textContent).toContain('Ends')
    await click(must([...agentRow.querySelectorAll('button')].find((item) => item.textContent === 'Extend 7 days'), 'extend button'))
    expect(h.api.scheduled.extend).toHaveBeenCalledWith('job-agent')
    await click(button('Open the thread that added it'))
    expect(openThread).toHaveBeenLastCalledWith('t1')
  })

  it('a task paused because agents were turned off says so, with the reason in its tooltip and Resume as its control', async () => {
    const reason = 'Agents may create jobs is off, so jobs agents created do not run. Resume the job to run it again once it is on.'
    await mount([job({ id: 'job-off', name: 'Paused by the setting', createdBy: { threadId: 't1' }, state: 'paused', enabled: false, pausedReason: reason })])
    expect(statusText('job-off')).toBe('Paused · agents were turned off')
    expect(rowOf('job-off').querySelector('[data-meta="status"]')?.getAttribute('title')).toBe(reason)
    expect(rowOf('job-off').querySelector('[data-glyph]')?.getAttribute('title')).toBe(reason)
    expect(button('Resume Paused by the setting')).toBeDefined()
    expect(rowOf('job-off').closest('[data-group]')?.getAttribute('data-group')).toBe('paused')
  })

  it('marks run records of an agent\'s task in their tooltip', async () => {
    await mount([job({ id: 'job-agent', name: 'Agent made', createdBy: { threadId: 't1', runId: 'r1' }, runHistory: [{ runAt: NOW, status: 'ok', agentCreated: true }] })])
    await openEdit(job({ name: 'Agent made' }))
    expect(document.querySelector<HTMLElement>('.scheduled-history-row')?.title).toBe('Task added by an agent')
  })
})

describe('labels: the schedule and the status as sentences', () => {
  const now = new Date(2026, 10, 5, 12, 0)
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()

  it('humanises the simple cron forms and leaves the rest as a custom schedule', () => {
    expect(humanCron('0 9 * * *')).toBe(`Daily at ${clockText(9, 0)}`)
    expect(humanCron('0 9 * * 1-5')).toBe(`Weekdays at ${clockText(9, 0)}`)
    expect(humanCron('0 9 * * 1-5', true)).toBe(`Monday to Friday at ${clockText(9, 0)}`)
    expect(humanCron('30 8 * * 1')).toBe(`Mondays at ${clockText(8, 30)}`)
    expect(humanCron('0 10 * * 0,6')).toBe(`Weekends at ${clockText(10, 0)}`)
    expect(humanCron('0 10 * * 1,3,5')).toBe(`Mon, Wed, Fri at ${clockText(10, 0)}`)
    expect(humanCron('0 */2 * * *')).toBe('Every 2 hours')
    expect(humanCron('0 * * * *')).toBe('Hourly')
    expect(humanCron('*/15 * * * *')).toBe('Every 15 min')
    expect(humanCron('0 9 1 * *')).toBeNull()
    expect(humanCron('0 9-17 * * *')).toBeNull()
    expect(describeSchedule({ kind: 'cron', expr: '0 9 1 * *' })).toBe('Custom schedule')
    expect(describeSchedule({ kind: 'manual' })).toBe('Only when run')
    expect(describeSchedule({ kind: 'interval', minutes: 60 })).toBe('Hourly')
    expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('Every 30 min')
    expect(describeSchedule({ kind: 'once', runAt: at(6, 10) }, now)).toBe(`Once, tomorrow ${clockText(10, 0)}`)
  })

  it('says times relative to today when near, dated when not', () => {
    expect(relativeWhen(at(5, 15), now)).toBe(clockText(15, 0))
    expect(relativeWhen(at(6, 9), now)).toBe(`tomorrow ${clockText(9, 0)}`)
    expect(relativeWhen(at(4, 9, 1), now)).toBe(`yesterday ${clockText(9, 1)}`)
    expect(relativeWhen(at(9, 8, 30), now)).toBe(`${new Date(at(9, 8, 30)).toLocaleDateString(undefined, { weekday: 'short' })} ${clockText(8, 30)}`)
    expect(relativeWhen(at(20, 10), now)).toBe(`${new Date(at(20, 10)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clockText(10, 0)}`)
  })

  it('puts the state into the sentence, with one tone and one glyph', () => {
    expect(statusOf(job({ lastStatus: 'ok', lastRunAt: at(5, 9, 2) }), now)).toMatchObject({ text: `Done ${clockText(9, 2)}`, tone: 'ok', glyph: 'ok' })
    expect(statusOf(job({ runHistory: [{ runAt: at(5, 14), status: 'error', error: 'Timed out' }] }), now)).toMatchObject({ text: `Failed ${clockText(14, 0)} · Timed out`, tone: 'bad', glyph: 'bad' })
    expect(statusOf(job({ liveStatus: 'running', runClaim: { claimedAt: at(5, 14, 30) } as never }), now)).toMatchObject({ text: `Running since ${clockText(14, 30)}`, tone: 'strong', glyph: 'running' })
    expect(statusOf(job({ liveStatus: 'needs_answer' }), now)).toMatchObject({ text: 'Needs your answer', tone: 'warn', glyph: 'needs' })
    expect(statusOf(job({ state: 'paused', pausedAt: at(4, 18), pausedReason: 'Paused by a person' }), now)).toMatchObject({ text: 'Paused yesterday', glyph: 'paused', title: 'Paused by a person' })
    expect(statusOf(job({ runHistory: [{ runAt: at(5, 9), status: 'uncertain' }] }), now)).toMatchObject({ tone: 'warn', glyph: 'needs' })
    expect(statusOf(job(), now)).toMatchObject({ text: '', glyph: 'scheduled' })
    expect(statusOf(job(), now, true)).toMatchObject({ text: 'Starting…' })
  })

  it('names a task after the first sentence of its prompt, cut to about 70 characters', () => {
    expect(nameFromPrompt('Summarize open PRs. Post them to #eng.')).toBe('Summarize open PRs')
    expect(nameFromPrompt('  Check the deploy\nthen report')).toBe('Check the deploy')
    expect(nameFromPrompt('/deploy staging')).toBe('/deploy staging')
    const long = nameFromPrompt('a'.repeat(100))
    expect(long).toHaveLength(70)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('job draft', () => {
  const catalog: ScheduledCatalog = { models: modelGroups(providers), projects, threads, defaultPermissionMode: 'accept_edits' }

  it('a task that already has everything it needs round-trips to an empty patch', () => {
    const item = job({ projectId: 'p1', selection: sonnet, mode: 'agent', workspace: { kind: 'newWorktree' }, schedule: { kind: 'cron', expr: '0 9 * * *' } })
    const draft = draftFromJob(item, catalog, providers)
    expect(patchOf(draft, draft, catalog)).toEqual({})
    expect(draft).toMatchObject({ modelKey: expect.stringContaining('sonnet'), workspaceKind: 'newWorktree', scheduleKind: 'cron' })
  })

  it('a new draft is a 30-minute interval task on the default model, mode and project checkout', () => {
    expect(newDraft()).toMatchObject({ scheduleKind: 'interval', minutes: '30', modelKey: '', mode: '', permissionMode: '', projectId: '', threadId: '', workspaceKind: 'project' })
    expect(draftPreset(newDraft())).toBe('custom')
  })

  it('a quick-add draft uses a new worktree in a Git project and the checkout elsewhere', () => {
    expect(quickDraft('x', 'hourly', 'p1', true)).toMatchObject({ prompt: 'x', scheduleKind: 'interval', minutes: '60', projectId: 'p1', workspaceKind: 'newWorktree' })
    expect(quickDraft('x', null, 'p2', false)).toMatchObject({ scheduleKind: 'interval', minutes: '30', workspaceKind: 'project' })
    expect(quickDraft('x', 'daily', '', true)).toMatchObject({ scheduleKind: 'cron', expr: '0 9 * * *', workspaceKind: 'project' })
    expect(createInputOf(quickDraft('Do it. Then more.', null, '', false), catalog).name).toBe('Do it')
  })

  it('reads the builder\'s plain forms from cron and writes them back', () => {
    expect(cronFormOf('0 9 * * *')).toBe('daily')
    expect(cronFormOf('15 8 * * 3')).toBe('weekly')
    expect(cronFormOf('0 9 * * 1-5')).toBe('cron')
    expect(cronFormOf('0 9 1 * *')).toBe('cron')
    expect(cronOfForm('daily', '07:30', '1')).toBe('30 7 * * *')
    expect(cronOfForm('weekly', '08:15', '3')).toBe('15 8 * * 3')
  })

  it('reads a preset only from the exact saved form, so anything else stays custom', () => {
    expect(presetOf({ kind: 'interval', minutes: 60 })).toBe('hourly')
    expect(presetOf({ kind: 'cron', expr: ' 0  9 * * 1-5 ' })).toBe('weekdays')
    expect(presetOf({ kind: 'cron', expr: '0 9 * * 1-6' })).toBe('custom')
    expect(presetOf({ kind: 'interval', minutes: 30 })).toBe('custom')
    expect(draftPreset({ ...newDraft(), scheduleKind: 'once' })).toBe('custom')
    expect(presetFields('daily')).toEqual({ scheduleKind: 'cron', expr: '0 9 * * *' })
  })

  it('offers no permission mode above the one the person holds for the task', () => {
    const offered = (draft: ReturnType<typeof newDraft>) => permissionChoices(draft, catalog).filter((choice) => !choice.disabled).map((choice) => choice.value)
    // No thread: the mode threads start in (Auto-accept edits here).
    expect(offered(newDraft())).toEqual(['', 'ask', 'accept_edits'])
    // A thread set to Ask limits the task to Ask; a thread without a mode of its own follows the default.
    expect(offered({ ...newDraft(), projectId: 'p2', threadId: 't2' })).toEqual(['', 'ask'])
    expect(offered({ ...newDraft(), projectId: 'p1', threadId: 't1' })).toEqual(['', 'ask', 'accept_edits'])
    expect(heldPermissionMode({ ...newDraft(), projectId: 'p2', threadId: 't2' }, catalog)).toEqual({ mode: 'ask', exact: true })
  })

  it('computes the mode held for an existing worktree from the thread that owns it, and offers only Ask when the owner is not known', () => {
    const offered = (draft: ReturnType<typeof newDraft>, saved?: ScheduledJob) => permissionChoices(draft, catalog, saved).filter((choice) => !choice.disabled).map((choice) => choice.value)
    const saved = job({ projectId: 'p2', threadId: 't2', workspace: { kind: 'worktree', path: '/work/other-wt' } })
    const draft = draftFromJob(saved, catalog, providers)
    // The saved task records its owner (t2, set to Ask): nothing above Ask is offered, even though the default is wider.
    expect(heldPermissionMode(draft, catalog, saved)).toEqual({ mode: 'ask', exact: true })
    expect(offered(draft, saved)).toEqual(['', 'ask'])
    // A path just typed has no known owner: the form offers Ask only, and the profile checks the rest.
    const typed = { ...draft, worktreePath: '/work/somewhere-else' }
    expect(heldPermissionMode(typed, catalog, saved)).toEqual({ mode: 'ask', exact: false })
    expect(offered(typed, saved)).toEqual(['', 'ask'])
    expect(offered({ ...newDraft(), projectId: 'p1', workspaceKind: 'worktree', worktreePath: '/work/wt' })).toEqual(['', 'ask'])
    // An owner in the list whose mode is the default is offered up to it.
    const owned = job({ projectId: 'p1', threadId: 't1', workspace: { kind: 'worktree', path: '/work/mousse-wt' } })
    expect(offered(draftFromJob(owned, catalog, providers), owned)).toEqual(['', 'ask', 'accept_edits'])
  })

  it('disables a mode above what is held even when the task already has it, and checks only a mode being chosen now', () => {
    const draft = { ...newDraft(), projectId: 'p2', threadId: 't2', permissionMode: 'full' as const }
    expect(permissionChoices(draft, catalog).find((choice) => choice.value === 'full')?.disabled).toBe(true)
    expect(validateDraft(draft, { hasWebhook: false, requireName: false }).permission).toBeUndefined()
    expect(validateDraft(draft, { hasWebhook: false, requireName: false, held: 'ask' }).permission).toMatch(/Full access is wider than Ask before acting/)
    expect(validateDraft({ ...draft, permissionMode: 'ask' }, { hasWebhook: false, requireName: false, held: 'ask' }).permission).toBeUndefined()
  })

  it('sends a permission mode on create and in a patch, and null to clear it', () => {
    const draft = { ...newDraft(), prompt: 'x', permissionMode: 'ask' as const }
    expect(createInputOf(draft, catalog)).toMatchObject({ permissionMode: 'ask' })
    expect(createInputOf(newDraft(), catalog)).not.toHaveProperty('permissionMode')
    const initial = draftFromJob(job({ permissionMode: 'ask', permissionCeiling: 'full' }), catalog, providers)
    expect(initial.permissionMode).toBe('ask')
    expect(patchOf(initial, { ...initial, permissionMode: 'accept_edits' }, catalog)).toEqual({ permissionMode: 'accept_edits' })
    expect(patchOf(initial, { ...initial, permissionMode: '' }, catalog)).toEqual({ permissionMode: null })
    expect(patchOf(initial, { ...initial, name: 'Renamed' }, catalog)).toEqual({ name: 'Renamed' })
  })
})

describe('Scheduled page: permissions respect the task\'s ceiling', () => {
  it('offers modes up to the one held for the task, and moving the task to a stricter thread narrows the choices', async () => {
    await mount([])
    await openNew('Check CI')
    expect(await optionsOf('Permissions')).toEqual([
      { text: "Default (the mode new threads start in, up to the task's limit)", disabled: false },
      { text: 'Ask before acting', disabled: false },
      { text: 'Auto-accept edits', disabled: false },
      { text: 'Auto', disabled: true },
      { text: 'Full access', disabled: true }
    ])
    expect(document.querySelector('[data-testid="permission-note"]')?.textContent).toBe('Never more than Auto-accept edits')
    await choose('Where', 'Other')
    await choose('Thread', 'Other project thread')
    expect((await optionsOf('Permissions')).map((option) => option.disabled)).toEqual([false, false, true, true, true])
    expect(document.querySelector('[data-testid="permission-note"]')?.textContent).toContain('Ask before acting')
  })

  it('creates a task with the chosen permission mode', async () => {
    const h = await mount([])
    await openNew('Check CI')
    await choose('Permissions', 'Ask before acting')
    await click(button('Add'))
    expect(h.api.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'ask', createThread: true }))
  })

  it('refuses a mode that became too wide when the thread changed, saving nothing', async () => {
    const h = await mount([])
    await openNew('Check CI')
    await choose('Permissions', 'Auto-accept edits')
    await choose('Where', 'Other')
    await choose('Thread', 'Other project thread')
    await click(button('Add'))
    expect(h.api.scheduled.create).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['A task cannot run above the mode you hold here. Auto-accept edits is wider than Ask before acting; choose Ask before acting or stricter.'])
  })

  it('shows what the daemon refuses, and the task\'s own limit when editing', async () => {
    const item = job({ projectId: 'p1', permissionMode: 'ask', permissionCeiling: 'accept_edits' })
    const h = await mount([item])
    h.api.scheduled.update.mockRejectedValueOnce(new Error('A job cannot run above the mode its creator holds'))
    await openEdit(item)
    const note = must(document.querySelector<HTMLElement>('[data-testid="permission-note"]'), 'note')
    expect(note.textContent).toContain("this task's limit is Auto-accept edits")
    expect(note.title).toContain('A run follows its thread, never above that limit')
    expect(control('Permissions').textContent).toBe('Ask before acting')
    await choose('Permissions', 'Auto-accept edits')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { permissionMode: 'accept_edits' })
    expect(document.querySelector('[data-testid="save-error"]')?.textContent).toContain('A job cannot run above the mode its creator holds')
  })

  it('does not block saving an unrelated change on a task whose mode is wider than what is held now', async () => {
    const item = job({ projectId: 'p2', threadId: 't2', permissionMode: 'full', permissionCeiling: 'full' })
    const h = await mount([item])
    await openEdit(item)
    expect(control('Permissions').textContent).toBe('Full access')
    await setValue(control('Name'), 'Renamed')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { name: 'Renamed' })
  })

  it('says that saving lowers a task\'s mode when it is moved to a stricter thread, and sends no mode of its own', async () => {
    const item = job({ projectId: 'p2', permissionMode: 'accept_edits', permissionCeiling: 'accept_edits' })
    const h = await mount([item])
    await openEdit(item)
    expect(document.querySelector('[data-testid="permission-lowered"]')).toBeNull()
    await choose('Thread', 'Other project thread')
    expect(document.querySelector('[data-testid="permission-lowered"]')?.textContent).toContain('from Auto-accept edits to Ask before acting')
    await save()
    // The profile does the lowering; the page sends only the thread change.
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { threadId: 't2', createThread: false })
  })

  it('does not say it for a rename, which leaves the mode as it is', async () => {
    const item = job({ projectId: 'p2', threadId: 't2', permissionMode: 'full', permissionCeiling: 'full' })
    await mount([item])
    await openEdit(item)
    await setValue(control('Name'), 'Renamed')
    expect(document.querySelector('[data-testid="permission-lowered"]')).toBeNull()
  })

  it('labels the default as the thread\'s mode up to the task\'s limit', async () => {
    const item = job({ projectId: 'p1', threadId: 't1', permissionCeiling: 'ask' })
    await mount([item])
    await openEdit(item)
    expect((await optionsOf('Permissions'))[0].text).toBe("Default (the thread's mode, up to the task's limit)")
  })

  it('hides the permission select for a workflow prompt, explains why, and clears a mode the task had', async () => {
    const item = job({ projectId: 'p1', permissionMode: 'ask', permissionCeiling: 'ask' })
    const h = await mount([item])
    await openEdit(item)
    expect(hasLabel('Permissions')).toBe(true)
    await setValue(control('Prompt'), '/deploy staging')
    expect(hasLabel('Permissions')).toBe(false)
    expect(document.querySelector('[data-testid="workflow-permission-note"]')?.textContent).toBe(WORKFLOW_PERMISSION_NOTE)
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { prompt: '/deploy staging', permissionMode: null })
  })

  it('sends no permission mode on create for a workflow prompt', () => {
    const catalog: ScheduledCatalog = { models: [], projects, threads, defaultPermissionMode: 'accept_edits' }
    expect(createInputOf({ ...newDraft(), prompt: '  /deploy', permissionMode: 'ask' }, catalog)).not.toHaveProperty('permissionMode')
  })

  it('shows the mode in Details and on each run that recorded one', async () => {
    const item = job({ permissionMode: 'ask', permissionCeiling: 'full', runHistory: [{ runAt: '2026-10-27T09:00:00.000Z', status: 'ok', permissionMode: 'ask' }] })
    await mount([item])
    await openEdit(item)
    expect(control('Permissions').textContent).toBe('Ask before acting')
    expect(document.querySelector<HTMLElement>('.scheduled-history-row')?.title).toBe('Ask before acting')
  })
})
