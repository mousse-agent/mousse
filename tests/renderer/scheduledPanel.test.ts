// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectionFromListing } from '../../src/shared/providerInstances'
import type { LlmProviderOption } from '../../src/shared/settings'
import type { Project, ScheduledJob, ScheduledJobPatch, ScheduledWebhookDelivery, Thread } from '../../src/shared/types'
import { ScheduledPanel } from '../../src/renderer/components/ScheduledPanel'
import { MODE_NOTE, WORKFLOW_PERMISSION_NOTE } from '../../src/renderer/components/scheduled/JobEditor'
import {
  createInputOf,
  draftFromJob,
  heldPermissionMode,
  modelGroups,
  newDraft,
  patchOf,
  permissionChoices,
  validateDraft,
  type ScheduledCatalog
} from '../../src/renderer/components/scheduled/jobDraft'
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
const threads = [
  { id: 't1', name: 'Release thread', projectId: 'p1' },
  { id: 't2', name: 'Other project thread', projectId: 'p2', permissionMode: 'ask' },
  { id: 't3', name: 'Subagent', projectId: 'p1', lineage: { parentThreadId: 't1', rootThreadId: 't1', relationship: 'subagent' } }
] as unknown as Thread[]
const sonnet = selectionFromListing(providers[0], 'sonnet')

const NOW = '2026-10-27T10:00:00.000Z'
const webhookTrigger = { webhook: { scheme: 'mousse' as const, secretRef: 'ref', createdAt: NOW } }

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
  clipboard: { writeText: ReturnType<typeof vi.fn> }
}

function makeApi(state: { jobs: ScheduledJob[] }) {
  let listener: ((jobs: ScheduledJob[]) => void) | null = null
  const scheduled = {
    list: vi.fn(async () => state.jobs),
    status: vi.fn(async () => ({ running: true, lastHeartbeatAt: null, lastSuccessAt: null, lastTickError: null, activeJobId: null, activeJobIds: [], jobCount: state.jobs.length, dueCount: 0 })),
    onUpdated: vi.fn((cb: (jobs: ScheduledJob[]) => void) => { listener = cb; return () => { listener = null } }),
    onStatus: vi.fn(() => () => {}),
    create: vi.fn(async (input: Record<string, unknown>) => job({ id: 'job-new', ...(input as object) } as Partial<ScheduledJob>)),
    update: vi.fn(async (id: string, _patch: ScheduledJobPatch) => state.jobs.find((item) => item.id === id) ?? null),
    delete: vi.fn(async () => true),
    pause: vi.fn(async () => null),
    resume: vi.fn(async () => null),
    run: vi.fn(async () => null),
    webhook: {
      enable: vi.fn(),
      rotate: vi.fn(),
      disable: vi.fn(),
      deliveries: vi.fn(async (id: string) => ({ deliveries: [] as ScheduledWebhookDelivery[], url: URL_OF(id) }))
    }
  }
  return { scheduled, push: (jobs: ScheduledJob[]) => listener?.(jobs) }
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
    settings: { getOptions: async () => ({ llmProviders: providers }), get: async () => ({ permissions: { defaultMode: 'accept_edits' } }) },
    projects: { list: async () => projects },
    threads: { listAll: async () => threads }
  }
  harness = {
    state,
    api,
    clipboard,
    emit: async (next) => { state.jobs = next; await act(async () => api.push(next)) },
    emitNow: (next) => { state.jobs = next; api.push(next) }
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
const setValue = async (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
  const setter = must(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set, 'value setter')
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const choose = async (label: string, optionText: string) => {
  const select = control<HTMLSelectElement>(label)
  await setValue(select, must([...select.options].find((option) => option.textContent === optionText), `option ${optionText}`).value)
}
const key = async (element: Element, name: string, init: KeyboardEventInit = {}) => {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}
const frame = async () => { await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))) }) }
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent ?? '')

async function openEdit(item = job()): Promise<void> {
  await click(button(`Edit ${item.name}`))
}
async function save(): Promise<void> {
  await click(button('Save'))
}
const lastPatch = (): ScheduledJobPatch => {
  const calls = harness.api.scheduled.update.mock.calls
  return calls[calls.length - 1][1]
}

const PROJECT_JOB = () => job({ projectId: 'p1' })

describe('Scheduled page: editing a job saves only what changed', () => {
  const cases: Array<[string, () => ScheduledJob, () => Promise<void>, ScheduledJobPatch]> = [
    ['name', job, () => setValue(control('Name'), 'Renamed'), { name: 'Renamed' }],
    ['prompt', job, () => setValue(control('Prompt'), 'Look at the failing tests'), { prompt: 'Look at the failing tests' }],
    ['interval minutes', job, () => setValue(control('Minutes between runs'), '45'), { schedule: { kind: 'interval', minutes: 45 } }],
    ['cron schedule', job, async () => { await click(button('Cron')); await setValue(control('Cron expression'), '0 8 * * 1') }, { schedule: { kind: 'cron', expr: '0 8 * * 1' } }],
    ['one-time schedule', job, async () => { await click(button('Once')); await setValue(control('Run at'), '2030-01-02T03:04') }, { schedule: { kind: 'once', runAt: new Date('2030-01-02T03:04').toISOString() } }],
    ['manual schedule', job, () => click(button('Manual')), { schedule: { kind: 'manual' } }],
    ['model', job, () => choose('Model', 'Sonnet'), { selection: sonnet }],
    ['clearing the model', () => job({ selection: sonnet }), () => choose('Model', 'Default model'), { selection: null }],
    ['mode', job, () => choose('Mode', 'Plan (no changes)'), { mode: 'plan' }],
    ['clearing the mode', () => job({ mode: 'agent' }), () => choose('Mode', 'Default'), { mode: null }],
    ['project', job, () => choose('Project', 'Mousse'), { projectId: 'p1' }],
    ['clearing the project', PROJECT_JOB, () => choose('Project', 'No project'), { projectId: null }],
    ['target thread', PROJECT_JOB, () => choose('Target thread', 'Release thread'), { threadId: 't1', createThread: false }],
    [
      'target thread on a job with a new-worktree workspace (a bound job takes no workspace)',
      () => job({ projectId: 'p1', workspace: { kind: 'newWorktree' } }),
      () => choose('Target thread', 'Release thread'),
      { threadId: 't1', createThread: false, workspace: null }
    ],
    ['new thread per run again', () => job({ projectId: 'p1', threadId: 't1' }), () => choose('Target thread', 'A new thread for each run'), { threadId: null, createThread: true }],
    ['new-worktree workspace', PROJECT_JOB, () => choose('Workspace', 'New worktree per run (recommended)'), { workspace: { kind: 'newWorktree' } }],
    [
      'existing worktree workspace',
      PROJECT_JOB,
      async () => { await choose('Workspace', 'Existing worktree'); await setValue(control('Worktree path'), '/work/mousse-wt') },
      { workspace: { kind: 'worktree', path: '/work/mousse-wt' }, threadId: null }
    ],
    [
      'leaving an existing worktree drops its owner thread',
      () => job({ projectId: 'p1', threadId: 't1', workspace: { kind: 'worktree', path: '/work/mousse-wt' } }),
      () => choose('Workspace', 'Project checkout'),
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
    // Saved: the form closes.
    expect(document.querySelector('form')).toBeNull()
  })

  it('saving without a change sends nothing and closes the form', async () => {
    const h = await mount([PROJECT_JOB()])
    await openEdit()
    await save()
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
    expect(document.querySelector('form')).toBeNull()
  })

  it('an edit never rewrites fields it did not touch (a stale model stays as it was)', async () => {
    const stale = { instanceId: 'gone:one', llmProvider: 'gone', model: 'retired' }
    const h = await mount([job({ selection: stale })])
    await openEdit()
    expect(control<HTMLSelectElement>('Model').selectedOptions[0].textContent).toBe('retired (not available now)')
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
    await setValue(control('Minutes between runs'), '0')
    await save()
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
    expect(alerts()).toEqual(expect.arrayContaining(['Give the job a name.', 'Write the prompt the job runs.', 'Use a whole number of minutes, at least 1.']))
    expect(document.activeElement).toBe(control('Name'))
    expect(control('Name').getAttribute('aria-invalid')).toBe('true')
    expect(control('Name').getAttribute('aria-describedby')).toBe(document.querySelector('[role="alert"]')?.id)
  })

  it('shows nothing until the first save attempt, then clears a problem once it is fixed', async () => {
    await mount([job()])
    await openEdit()
    await setValue(control('Prompt'), '')
    expect(alerts()).toEqual([])
    await save()
    expect(alerts()).toEqual(['Write the prompt the job runs.'])
    await setValue(control('Prompt'), 'Back again')
    expect(alerts()).toEqual([])
  })

  it('checks cron fields and a missing worktree path', async () => {
    const h = await mount([PROJECT_JOB()])
    await openEdit()
    await click(button('Cron'))
    await setValue(control('Cron expression'), '* *')
    await choose('Workspace', 'Existing worktree')
    await save()
    expect(alerts()).toEqual(expect.arrayContaining(['A cron expression has five fields, for example 0 9 * * *.', 'Enter the path of the worktree.']))
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
  })

  it('refuses a one-time schedule for a job with a webhook, and says how to fix it', async () => {
    const h = await mount([job({ trigger: webhookTrigger })])
    await openEdit()
    await click(button('Once'))
    await save()
    expect(alerts().join(' ')).toContain('cannot be one-time')
    expect(h.api.scheduled.update).not.toHaveBeenCalled()
  })

  it('offers only modes the job may use: no plan with a new worktree, no new worktree with plan', async () => {
    await mount([PROJECT_JOB()])
    await openEdit()
    const modes = () => [...control<HTMLSelectElement>('Mode').options].map((option) => option.textContent)
    const workspaces = () => [...control<HTMLSelectElement>('Workspace').options].map((option) => option.textContent)
    expect(modes()).toEqual(['Default', 'Agent', 'Plan (no changes)'])
    await choose('Workspace', 'New worktree per run (recommended)')
    expect(modes()).toEqual(['Default', 'Agent'])
    await choose('Workspace', 'Project checkout')
    await choose('Mode', 'Plan (no changes)')
    expect(workspaces()).toEqual(['Project checkout', 'Existing worktree'])
  })

  it('shows what the profile refuses, in words, and keeps the form open for another try', async () => {
    const h = await mount([PROJECT_JOB()])
    h.api.scheduled.update.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:update': Error: A new worktree needs a project backed by a Git repository"))
    await openEdit()
    await choose('Workspace', 'New worktree per run (recommended)')
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
    expect(document.querySelector('[data-testid="mode-note"]')?.textContent).toBe(MODE_NOTE)
    await choose('Mode', 'Plan (no changes)')
    expect(document.querySelector('[data-testid="workspace-warning"]')).toBeNull()
    expect(document.querySelector('[data-testid="mode-note"]')).toBeNull()
    await choose('Workspace', 'Existing worktree')
    expect(document.querySelector('[data-testid="workspace-warning"]')).toBeNull()
  })

  it('hides the workspace for a job bound to a thread', async () => {
    await mount([job({ projectId: 'p1', threadId: 't1' })])
    await openEdit()
    expect([...document.querySelectorAll('label')].some((item) => item.textContent === 'Workspace')).toBe(false)
    expect(document.body.textContent).toContain("The run uses the thread's own workspace.")
    // The subagent thread is not offered; a thread of another project is not offered for this project.
    expect([...control<HTMLSelectElement>('Target thread').options].map((option) => option.textContent)).toEqual(['A new thread for each run', 'Release thread'])
  })
})

describe('Scheduled page: creating a job', () => {
  it('sends model, mode, project and a new worktree; a job without a target thread gets a thread per run', async () => {
    const h = await mount([])
    await click(button('New job'))
    await setValue(control('Name'), 'Check CI')
    await setValue(control('Prompt'), 'Check CI in the repo')
    await choose('Model', 'Sonnet')
    await choose('Mode', 'Agent')
    await choose('Project', 'Mousse')
    await choose('Workspace', 'New worktree per run (recommended)')
    await click(button('Manual'))
    await click(button('Create'))
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
    expect(document.querySelector('form')).toBeNull()
  })

  it('a job bound to a thread sends that thread and no workspace', async () => {
    const h = await mount([])
    await click(button('New job'))
    await setValue(control('Prompt'), 'Summarize')
    await choose('Project', 'Mousse')
    await choose('Workspace', 'New worktree per run (recommended)')
    await choose('Target thread', 'Release thread')
    await click(button('Create'))
    const input = h.api.scheduled.create.mock.calls[0][0] as Record<string, unknown>
    expect(input).toMatchObject({ name: 'Scheduled job', threadId: 't1', projectId: 'p1' })
    expect(input).not.toHaveProperty('workspace')
    expect(input).not.toHaveProperty('createThread')
  })

  it('needs a prompt', async () => {
    const h = await mount([])
    await click(button('New job'))
    await click(button('Create'))
    expect(h.api.scheduled.create).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['Write the prompt the job runs.'])
  })
})

describe('Scheduled page: rows and history', () => {
  const record = (patch: Partial<NonNullable<ScheduledJob['runHistory']>[number]>) => ({ runAt: '2026-10-27T09:00:00.000Z', status: 'ok' as const, ...patch })

  it('shows a working run as Running or Needs your answer, and opens the thread it runs on', async () => {
    await mount([
      job({ liveStatus: 'needs_answer', pendingOccurrence: { occurrenceKey: 'k', threadId: 't-run', runId: 'r1', state: 'running' } }),
      job({ id: 'job-2', name: 'Working', liveStatus: 'running', pendingOccurrence: { occurrenceKey: 'k', threadId: 't-two', runId: 'r2', state: 'running' } }),
      job({ id: 'job-3', name: 'Idle' })
    ])
    const row = must(document.querySelector('[data-job-id="job-1"]'), 'row')
    expect(row.querySelector('.scheduled-status')?.textContent).toBe('Needs your answer')
    expect(must(document.querySelector('[data-job-id="job-2"]'), 'working').querySelector('.scheduled-status')?.textContent).toBe('Running')
    const open = must(row.querySelector<HTMLButtonElement>('button[title="Open the run\'s thread"]'), 'open button')
    await act(async () => open.click())
    expect(openThread).toHaveBeenCalledWith('t-run')
    // A job that never ran has no thread to open.
    expect(must(document.querySelector('[data-job-id="job-3"]'), 'idle').querySelector('button[title="Open the run\'s thread"]')).toBeNull()
  })

  it('shows the model, mode, workspace, target, webhook and a queued run on the row', async () => {
    await mount([
      job({
        projectId: 'p1',
        selection: sonnet,
        mode: 'plan',
        workspace: { kind: 'newWorktree' },
        trigger: webhookTrigger,
        pendingOccurrence: { occurrenceKey: 'k', threadId: 't9', runId: 'r1', state: 'queued' }
      }),
      job({ id: 'job-2', name: 'Bound', threadId: 't1', projectId: 'p1', nextRunAt: null, schedule: { kind: 'manual' } })
    ])
    const row = must(document.querySelector('[data-job-id="job-1"]'), 'row')
    expect(row.querySelector('[data-meta="model"]')?.textContent).toBe('sonnet')
    expect(row.querySelector('[data-meta="mode"]')?.textContent).toBe('Plan')
    expect(row.querySelector('[data-meta="workspace"]')?.textContent).toBe('New worktree per run')
    expect(row.querySelector('[data-meta="project"]')?.textContent).toBe('Mousse')
    expect(row.querySelector('[data-meta="webhook"]')).not.toBeNull()
    expect(row.querySelector('.scheduled-status')?.textContent).toBe('Queued')
    const bound = must(document.querySelector('[data-job-id="job-2"]'), 'bound row')
    expect(bound.textContent).toContain('Thread: Release thread')
    expect(bound.textContent).toContain("The thread's own workspace")
    expect(bound.textContent).toContain('Manual')
    expect(bound.textContent).toContain('Default model')
  })

  it('selecting a row lights its background and lists the runs with what each used', async () => {
    await mount([
      job({
        runHistory: [
          record({ status: 'error', error: 'Provider refused', selection: sonnet, mode: 'agent', workspace: { kind: 'newWorktree' } }),
          record({ runAt: '2026-10-27T09:30:00.000Z', status: 'queued', selection: sonnet, mode: 'plan' })
        ]
      })
    ])
    const row = must(document.querySelector<HTMLElement>('[data-job-id="job-1"]'), 'row')
    expect(row.hasAttribute('data-selected')).toBe(false)
    expect(row.querySelector('.scheduled-history')).toBeNull()
    await click(row.querySelector<HTMLElement>('[data-row-button]'))
    expect(row.getAttribute('data-selected')).toBe('true')
    expect(row.querySelector('[data-row-button]')?.getAttribute('aria-expanded')).toBe('true')
    const rows = [...row.querySelectorAll('.scheduled-history-row')]
    // Newest first.
    expect(rows.map((item) => item.getAttribute('data-status'))).toEqual(['queued', 'error'])
    expect(rows[0].textContent).toContain('Queued behind another run')
    expect(rows[0].textContent).toContain('sonnet')
    expect(rows[0].textContent).toContain('Plan')
    expect(rows[1].textContent).toContain('Failed')
    expect(rows[1].textContent).toContain('Provider refused')
    expect(rows[1].textContent).toContain('New worktree per run')
    await click(row.querySelector<HTMLElement>('[data-row-button]'))
    expect(row.hasAttribute('data-selected')).toBe(false)
  })

  it('shows missing placeholders a run recorded', async () => {
    await mount([job({ runHistory: [record({ missingPlaceholders: ['body.pull_request.title'] })] })])
    await click(document.querySelector<HTMLElement>('[data-row-button]'))
    expect(document.body.textContent).toContain('Missing fields: body.pull_request.title')
  })

  it('a selected row is marked by its background only, never a bar at an edge', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/scheduled-panel.css'), 'utf8')
    const rule = must(css.match(/\.scheduled-item\[data-selected='true'\]\s*\{([^}]*)\}/), 'selected rule')[1]
    expect(rule).toMatch(/background:/)
    expect(rule).not.toMatch(/border|box-shadow|outline|::before|::after/)
    expect(css).not.toMatch(/\.scheduled-item[^{]*(::before|::after)/)
  })

  it('reports a refused action instead of failing silently', async () => {
    const h = await mount([job()])
    h.api.scheduled.run.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:run': Error: Job is already running: Nightly"))
    await click(button('Run Nightly now'))
    expect(alerts()).toEqual(['Job is already running: Nightly'])
  })
})

describe('Scheduled page: the webhook secret is shown once', () => {
  const hooked = () => job({ trigger: webhookTrigger })
  const grant = (secret?: string) => ({ job: hooked(), url: URL_OF('job-1'), ...(secret ? { secret } : {}) })

  it('shows the secret after enabling with a copy button, then never again', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await click(button('Webhook for Nightly'))
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
    await click(button('Webhook for Nightly'))
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.querySelector('[data-testid="webhook-secret"]')).toBeNull()
    expect(document.querySelector('[data-testid="webhook-secret-hidden"]')?.textContent).toContain('not shown again')
    expect(document.querySelector('[data-testid="webhook-url"]')?.textContent).toBe(URL_OF('job-1'))
  })

  it('shows the secret even when the answer arrives before the job update', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockResolvedValue(grant(SECRET))
    await click(button('Webhook for Nightly'))
    await click(button('Enable webhook'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
    await h.emit([hooked()])
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
  })

  it('drops the secret when the dialog is closed with Escape or the close button', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await click(button('Webhook for Nightly'))
    await click(button('Enable webhook'))
    await key(document, 'Escape')
    expect(document.body.textContent).not.toContain(SECRET)
    await click(button('Webhook for Nightly'))
    expect(document.body.textContent).not.toContain(SECRET)
    await click(button('Close'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('rotating shows the new secret once, says the old one stopped, and the old one is gone from the page', async () => {
    const h = await mount([hooked()])
    const NEW_SECRET = 'whsec_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW1'
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(NEW_SECRET))
    await click(button('Webhook for Nightly'))
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
    await click(button('Webhook for Nightly'))
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
    await click(button('Webhook for Nightly'))
    await click(button('Rotate secret'))
    await click(button('Copy secret'))
    expect(alerts()).toEqual(['Copying failed. Select the text and copy it by hand.'])
    expect(button('Copied')).toBeUndefined()
  })

  it('cannot enable a webhook on a one-time or agent-created job, and says why', async () => {
    await mount([
      job({ schedule: { kind: 'once', runAt: '2030-01-01T00:00:00.000Z' } }),
      job({ id: 'job-2', name: 'Agent job', createdBy: { threadId: 't1' } })
    ])
    await click(button('Webhook for Nightly'))
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Change its schedule to Manual first.')
    await key(document, 'Escape')
    await click(button('Webhook for Agent job'))
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Agent-created jobs cannot have a webhook.')
  })

  it('shows a refusal from enabling, and a listener that did not start', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:enable': Error: Webhooks are not available in this profile."))
    await click(button('Webhook for Nightly'))
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
    await click(button('Webhook for Nightly'))
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
    await click(button('Webhook for Nightly'))
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
  const three = () => [job({ id: 'a', name: 'Alpha', nextRunAt: '2026-10-27T11:00:00.000Z' }), job({ id: 'b', name: 'Bravo', nextRunAt: '2026-10-27T12:00:00.000Z' }), job({ id: 'c', name: 'Charlie', nextRunAt: '2026-10-27T13:00:00.000Z' })]
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
    const unlabeled = buttons().filter((item) => !(item.textContent?.trim() || item.getAttribute('aria-label') || item.title))
    expect(unlabeled).toEqual([])
    const row = must(document.querySelector('[data-job-id="a"]'), 'row')
    for (const name of ['Edit Alpha', 'Webhook for Alpha', 'Run Alpha now', 'Pause Alpha', 'Delete Alpha']) {
      const item = must(button(name), name)
      expect(row.contains(item)).toBe(true)
      expect(item.tabIndex).toBe(0)
    }
  })

  it('Escape cancels an edit and focus returns to that row\'s Edit button', async () => {
    await mount(three())
    const edit = must(button('Edit Bravo'), 'edit')
    edit.focus()
    await click(edit)
    expect(document.activeElement).toBe(control('Name'))
    await key(control('Name'), 'Escape')
    expect(document.querySelector('form')).toBeNull()
    await frame()
    expect(document.activeElement).toBe(button('Edit Bravo'))
  })

  it('Escape cancels a new job and focus returns to New job', async () => {
    await mount([])
    await click(button('New job'))
    expect(document.activeElement).toBe(control('Name'))
    await key(control('Prompt'), 'Escape')
    expect(document.querySelector('form')).toBeNull()
    expect(document.activeElement).toBe(button('New job'))
  })

  it('the schedule choice is a radio group: arrow keys move the choice and its focus; one stop in the tab order', async () => {
    await mount([job()])
    await openEdit()
    const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios().filter((item) => item.tabIndex === 0)).toHaveLength(1)
    const checked = () => radios().find((item) => item.getAttribute('aria-checked') === 'true')?.textContent
    expect(checked()).toBe('Every…')
    await key(must(radios().find((item) => item.getAttribute('aria-checked') === 'true')), 'ArrowRight')
    expect(checked()).toBe('Cron')
    await frame()
    expect(document.activeElement?.textContent).toBe('Cron')
    await key(document.activeElement!, 'ArrowLeft')
    expect(checked()).toBe('Every…')
  })

  it('the webhook dialog takes focus on open, keeps Tab inside, closes with Escape and returns focus to its button', async () => {
    // jsdom lays nothing out, so every control would count as hidden to the dialog's focus handling.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    await mount([job({ trigger: webhookTrigger })])
    const opener = must(button('Webhook for Nightly'), 'webhook button')
    opener.focus()
    await click(opener)
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
    expect(document.activeElement).toBe(button('Webhook for Nightly'))
  })
})

describe('job draft', () => {
  const catalog: ScheduledCatalog = { models: modelGroups(providers), projects, threads, defaultPermissionMode: 'accept_edits' }

  it('a job that already has everything it needs round-trips to an empty patch', () => {
    const item = job({ projectId: 'p1', selection: sonnet, mode: 'agent', workspace: { kind: 'newWorktree' }, schedule: { kind: 'cron', expr: '0 9 * * *' } })
    const draft = draftFromJob(item, catalog, providers)
    expect(patchOf(draft, draft, catalog)).toEqual({})
    expect(draft).toMatchObject({ modelKey: expect.stringContaining('sonnet'), workspaceKind: 'newWorktree', scheduleKind: 'cron' })
  })

  it('a new draft is an hourly-ish interval job on the default model, mode and project checkout', () => {
    expect(newDraft()).toMatchObject({ scheduleKind: 'interval', minutes: '30', modelKey: '', mode: '', permissionMode: '', projectId: '', threadId: '', workspaceKind: 'project' })
  })

  it('offers no permission mode above the one the person holds for the job', () => {
    const offered = (draft: ReturnType<typeof newDraft>) => permissionChoices(draft, catalog).filter((choice) => !choice.disabled).map((choice) => choice.value)
    // No thread: the mode threads start in (Auto-accept edits here).
    expect(offered(newDraft())).toEqual(['', 'ask', 'accept_edits'])
    // A thread set to Ask limits the job to Ask; a thread without a mode of its own follows the default.
    expect(offered({ ...newDraft(), projectId: 'p2', threadId: 't2' })).toEqual(['', 'ask'])
    expect(offered({ ...newDraft(), projectId: 'p1', threadId: 't1' })).toEqual(['', 'ask', 'accept_edits'])
    expect(heldPermissionMode({ ...newDraft(), projectId: 'p2', threadId: 't2' }, catalog)).toEqual({ mode: 'ask', exact: true })
  })

  it('computes the mode held for an existing worktree from the thread that owns it, and offers only Ask when the owner is not known', () => {
    const offered = (draft: ReturnType<typeof newDraft>, saved?: ScheduledJob) => permissionChoices(draft, catalog, saved).filter((choice) => !choice.disabled).map((choice) => choice.value)
    const saved = job({ projectId: 'p2', threadId: 't2', workspace: { kind: 'worktree', path: '/work/other-wt' } })
    const draft = draftFromJob(saved, catalog, providers)
    // The saved job records its owner (t2, set to Ask): nothing above Ask is offered, even though the default is wider.
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

  it('disables a mode above what is held even when the job already has it, and checks only a mode being chosen now', () => {
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

describe('Scheduled page: permissions respect the job\'s ceiling', () => {
  const optionsOf = (label: string) => [...control<HTMLSelectElement>(label).options].map((option) => ({ text: option.textContent, disabled: option.disabled }))

  it('offers modes up to the one held for the job, and moving the job to a stricter thread narrows the choices', async () => {
    await mount([])
    await click(button('New job'))
    expect(optionsOf('Permissions')).toEqual([
      { text: "Default (the mode new threads start in, up to the job's limit)", disabled: false },
      { text: 'Ask before acting', disabled: false },
      { text: 'Auto-accept edits', disabled: false },
      { text: 'Full access', disabled: true }
    ])
    await choose('Project', 'Other')
    await choose('Target thread', 'Other project thread')
    expect(optionsOf('Permissions').map((option) => option.disabled)).toEqual([false, false, true, true])
    expect(document.querySelector('[data-testid="permission-note"]')?.textContent).toContain('Ask before acting')
  })

  it('creates a job with the chosen permission mode', async () => {
    const h = await mount([])
    await click(button('New job'))
    await setValue(control('Prompt'), 'Check CI')
    await choose('Permissions', 'Ask before acting')
    await click(button('Create'))
    expect(h.api.scheduled.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'ask', createThread: true }))
  })

  it('refuses a mode that became too wide when the thread changed, saving nothing', async () => {
    const h = await mount([])
    await click(button('New job'))
    await setValue(control('Prompt'), 'Check CI')
    await choose('Permissions', 'Auto-accept edits')
    await choose('Project', 'Other')
    await choose('Target thread', 'Other project thread')
    await click(button('Create'))
    expect(h.api.scheduled.create).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['A job cannot run above the mode you hold here. Auto-accept edits is wider than Ask before acting; choose Ask before acting or stricter.'])
  })

  it('shows what the daemon refuses, and the job\'s own limit when editing', async () => {
    const item = job({ projectId: 'p1', permissionMode: 'ask', permissionCeiling: 'accept_edits' })
    const h = await mount([item])
    h.api.scheduled.update.mockRejectedValueOnce(new Error('A job cannot run above the mode its creator holds'))
    await openEdit(item)
    expect(document.querySelector('[data-testid="permission-note"]')?.textContent).toContain("This job's limit is Auto-accept edits")
    expect(control<HTMLSelectElement>('Permissions').value).toBe('ask')
    await choose('Permissions', 'Auto-accept edits')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { permissionMode: 'accept_edits' })
    expect(document.querySelector('[data-testid="save-error"]')?.textContent).toContain('A job cannot run above the mode its creator holds')
  })

  it('does not block saving an unrelated change on a job whose mode is wider than what is held now', async () => {
    const item = job({ projectId: 'p2', threadId: 't2', permissionMode: 'full', permissionCeiling: 'full' })
    const h = await mount([item])
    await openEdit(item)
    expect(control<HTMLSelectElement>('Permissions').value).toBe('full')
    await setValue(control('Name'), 'Renamed')
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { name: 'Renamed' })
  })

  it('says that saving lowers a job\'s mode when it is moved to a stricter thread, and sends no mode of its own', async () => {
    const item = job({ projectId: 'p2', permissionMode: 'accept_edits', permissionCeiling: 'accept_edits' })
    const h = await mount([item])
    await openEdit(item)
    expect(document.querySelector('[data-testid="permission-lowered"]')).toBeNull()
    await choose('Target thread', 'Other project thread')
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

  it('labels the default as the thread\'s mode up to the job\'s limit', async () => {
    const item = job({ projectId: 'p1', threadId: 't1', permissionCeiling: 'ask' })
    await mount([item])
    await openEdit(item)
    expect(optionsOf('Permissions')[0].text).toBe("Default (the thread's mode, up to the job's limit)")
    expect(document.querySelector('[data-testid="permission-note"]')?.textContent).toContain('A run follows its thread, never above that limit')
  })

  it('hides the permission select for a workflow prompt, explains why, and clears a mode the job had', async () => {
    const item = job({ projectId: 'p1', permissionMode: 'ask', permissionCeiling: 'ask' })
    const h = await mount([item])
    await openEdit(item)
    expect([...document.querySelectorAll('label')].some((label) => label.textContent === 'Permissions')).toBe(true)
    await setValue(control('Prompt'), '/deploy staging')
    expect([...document.querySelectorAll('label')].some((label) => label.textContent === 'Permissions')).toBe(false)
    expect(document.querySelector('[data-testid="workflow-permission-note"]')?.textContent).toBe(WORKFLOW_PERMISSION_NOTE)
    await save()
    expect(h.api.scheduled.update).toHaveBeenCalledWith('job-1', { prompt: '/deploy staging', permissionMode: null })
  })

  it('sends no permission mode on create for a workflow prompt', () => {
    const catalog: ScheduledCatalog = { models: [], projects, threads, defaultPermissionMode: 'accept_edits' }
    expect(createInputOf({ ...newDraft(), prompt: '  /deploy', permissionMode: 'ask' }, catalog)).not.toHaveProperty('permissionMode')
  })

  it('shows the mode on the row and on each run that recorded one', async () => {
    await mount([job({ permissionMode: 'ask', permissionCeiling: 'full', runHistory: [{ runAt: '2026-10-27T09:00:00.000Z', status: 'ok', permissionMode: 'ask' }] })])
    const row = must(document.querySelector('[data-job-id="job-1"]'), 'row')
    expect(row.querySelector('[data-meta="permission"]')?.textContent).toBe('Ask before acting')
    await click(row.querySelector<HTMLElement>('[data-row-button]'))
    expect(row.querySelector('.scheduled-history-row [data-meta="permission"]')?.textContent).toBe('Ask before acting')
  })
})
