// @vitest-environment jsdom
/**
 * The Automations inbox: grouping runs as data, the page's keys (j/k, Enter, e, u, 1–4, /, ?), Manage (on/off, Edit,
 * Delete, Tuning), the run strip, the project dot, and the draft card in its states (a draft, on, discarded).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationIndex, AutomationItem } from '../../src/shared/automations'
import type { AutomationInbox, InboxRun } from '../../src/shared/automationInbox'
import {
  groupOf, inboxGroups, moveCursor, projectDotCount, resolvable, rowKey, runLine, usageText, automationsById, dotLabel
} from '../../src/renderer/components/automations/inbox/inboxModel'
import { onLine, whenChoices } from '../../src/renderer/components/automations/DraftCard'
import { draftIdOf } from '../../src/renderer/components/automations/inbox/ChatDraftCard'
import { setInboxClient, useInboxStore, openRun } from '../../src/renderer/components/automations/inbox/inboxStore'
import { useAppStore } from '../../src/renderer/stores/appStore'

vi.mock('../../src/renderer/components/bots/face/BotFace', () => ({ BotFace: () => null, BotFaceStill: () => null }))
vi.mock('../../src/renderer/lib/openThread', () => ({ openThread: vi.fn(async () => undefined) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const computer = { name: 'Desk', timeZone: ZONE, local: true }
const NOW = new Date()
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

function automation(patch: Partial<AutomationItem> & { id: string }): AutomationItem {
  return {
    key: `job:${patch.id}`, kind: 'job', name: patch.id, trigger: 'time', whenText: '', schedule: { kind: 'cron', expr: '0 9 * * *' },
    who: { kind: 'agent', name: 'Default agent' }, paused: false, runs: [], link: { kind: 'job', jobId: patch.id }, computer,
    where: { projectId: 'p1', name: 'mousse' }, ...patch
  }
}

let n = 0
function run(patch: Partial<InboxRun> & { jobId: string }): InboxRun {
  n += 1
  return { id: `run_00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, jobName: patch.jobId, number: n, startedAt: ago(n), state: 'done', usage: [], items: [], projectId: 'p1', ...patch }
}
const item = (kind: 'needs_you' | 'failed' | 'approval', patch: Partial<InboxRun['items'][number]> = {}) => ({ id: `item-${kind}-${n}`, runId: '', kind, assignee: { kind: 'person' as const }, createdAt: ago(1), ...patch })

const AUTOMATIONS = [
  automation({ id: 'nightly', name: 'Nightly review' }),
  automation({ id: 'deps', name: 'Deps bump', where: { projectId: 'p2', name: 'mousse-plus' } }),
  automation({ id: 'pip', name: 'Morning summary', who: { kind: 'bot', name: 'Pip', look: { colour: 'teal', accessory: 'none' } } })
]
const live = run({ jobId: 'nightly', state: 'running', threadId: 't-live' })
const needs = run({ jobId: 'nightly', level: 'needs_you', summary: 'One risky migration in #412', threadId: 't-needs', items: [item('needs_you')], pr: { number: 412, url: 'u' } })
const failed = run({ jobId: 'deps', state: 'failed', error: 'No access', items: [item('failed')], projectId: 'p2' })
const bot = run({ jobId: 'pip', level: 'needs_you', summary: 'Calendar clash', botId: 'bot_1', items: [item('needs_you', { assignee: { kind: 'bot', botId: 'bot_1' } })] })
const noReport = run({ jobId: 'nightly', threadId: 't-none' })
const fyi = run({ jobId: 'deps', level: 'fyi', summary: '3 patch updates merged', projectId: 'p2', usage: [{ model: 'claude-x', input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 }] })
const resolved = run({ jobId: 'nightly', level: 'needs_you', summary: 'Reply to the reviewer', items: [item('needs_you', { resolvedAt: ago(1), resolvedBy: 'person' })] })
const quiet1 = run({ jobId: 'nightly', level: 'quiet', summary: 'Nothing new' })
const quiet2 = run({ jobId: 'deps', level: 'quiet', projectId: 'p2' })
const RUNS = [live, needs, failed, bot, noReport, fyi, resolved, quiet1, quiet2]
const byId = automationsById(AUTOMATIONS)

describe('the Runs list as data', () => {
  it('groups live runs on top, Needs you with bots folded, No report under Worth a look, resolved runs in FYI, quiet folded', () => {
    expect(groupOf(live)).toBe('live')
    expect(groupOf(needs)).toBe('needs_you')
    expect(groupOf(failed)).toBe('needs_you')
    expect(groupOf(bot)).toBe('needs_you')
    // No report is never quiet.
    expect(groupOf(noReport)).toBe('look')
    expect(groupOf(resolved)).toBe('fyi')
    expect(groupOf(quiet1)).toBe('quiet')
    const groups = inboxGroups(RUNS, {}, byId, { bots: false, quiet: false })
    expect(groups.map((group) => [group.key, group.count, group.rows.map((row) => (row.kind === 'run' ? row.run.id : `fold:${row.fold}`))])).toEqual([
      ['live', 1, [live.id]],
      ['needs_you', 2, [needs.id, failed.id, 'fold:bots']],
      ['look', 1, [noReport.id]],
      ['fyi', 2, [fyi.id, resolved.id]],
      ['quiet', 2, ['fold:quiet']]
    ])
    const open = inboxGroups(RUNS, {}, byId, { bots: true, quiet: true })
    expect(open.find((group) => group.key === 'needs_you')!.rows.map(rowKey)).toEqual([needs.id, failed.id, 'fold:bots', bot.id])
    expect(open.find((group) => group.key === 'quiet')!.rows).toHaveLength(3)
    expect(open.find((group) => group.key === 'fyi')!.rows.find((row) => row.kind === 'run' && row.run.id === resolved.id)).toMatchObject({ resolved: true })
  })

  it('filters by automation, project group and words', () => {
    const only = (filter: Parameters<typeof inboxGroups>[1]) => inboxGroups(RUNS, filter, byId, { bots: true, quiet: true }).flatMap((group) => group.rows).filter((row) => row.kind === 'run').map((row) => (row.kind === 'run' ? row.run.id : ''))
    expect(only({ automationId: 'deps' })).toEqual([failed.id, fyi.id, quiet2.id])
    expect(only({ project: { name: 'mousse-plus', projectIds: ['p2'] } })).toEqual([failed.id, fyi.id, quiet2.id])
    expect(only({ text: 'migration' })).toEqual([needs.id])
  })

  it('moves the cursor within the rows, and resolves only an open item of the person\'s', () => {
    const rows = inboxGroups(RUNS, {}, byId, { bots: false, quiet: false }).flatMap((group) => group.rows)
    expect(rowKey(moveCursor(rows, null, 1)!)).toBe(live.id)
    expect(rowKey(moveCursor(rows, null, -1)!)).toBe('fold:quiet')
    expect(rowKey(moveCursor(rows, live.id, 1)!)).toBe(needs.id)
    expect(rowKey(moveCursor(rows, live.id, -1)!)).toBe(live.id)
    expect(resolvable(rows, needs.id, undefined)?.id).toBe(needs.id)
    expect(resolvable(rows, noReport.id, needs)).toBeUndefined()
    expect(resolvable(rows, 'fold:bots', needs)?.id).toBe(needs.id)
    expect(resolvable(rows, null, bot)).toBeUndefined()
  })

  it('says what a run does, its usage (cost only when known), and the project dot', () => {
    expect(runLine(live, NOW)).toBe('Running')
    expect(runLine(failed, NOW)).toBe('Failed: No access')
    expect(runLine(noReport, NOW)).toBe('No report')
    expect(runLine(run({ jobId: 'x', state: 'paused_usage' }), NOW)).toBe('Paused for usage')
    expect(usageText(fyi.usage)).toBe('claude-x 1.2k')
    expect(usageText([{ model: 'gpt', input: 500, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.012 }])).toBe('gpt 500 · $0.012')
    expect(usageText([])).toBeUndefined()
    expect(projectDotCount({ byProject: { p1: 2, p2: 1 }, total: 3 }, ['p1', 'p2'])).toBe(3)
    expect(projectDotCount(null, ['p1'])).toBe(0)
    expect(dotLabel(1)).toBe('1 run needs you')
    expect(dotLabel(2)).toBe('2 runs need you')
  })
})

describe('the draft card as data', () => {
  it('offers the draft\'s own time first, then presets; a draft that is on says its current state', () => {
    const choices = whenChoices({ kind: 'cron', expr: '0 5 * * 4' }, NOW)
    expect(choices[0]!.value).toBe('cron:0 5 * * 4')
    expect(choices.map((choice) => choice.value)).toContain('cron:0 9 * * *')
    expect(whenChoices({ kind: 'cron', expr: '0 9 * * *' }, NOW).filter((choice) => choice.value === 'cron:0 9 * * *')).toHaveLength(1)
    const next = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(onLine(automation({ id: 'a', next: { at: next, timeZone: ZONE } }), NOW, ZONE)).toMatch(/^On · next /)
    expect(onLine(automation({ id: 'a', paused: true }), NOW, ZONE)).toBe('Paused')
    expect(onLine(automation({ id: 'a', trigger: 'on_demand' }), NOW, ZONE)).toBe('On · when you run it')
  })

  it('reads the draft id from the tool\'s result in any shape a runtime gives it', () => {
    expect(draftIdOf({}, { draftId: 'd1', problems: [] })).toBe('d1')
    expect(draftIdOf({}, '{"draftId":"d2","problems":[]}')).toBe('d2')
    expect(draftIdOf({}, [{ type: 'text', text: '{"draftId":"d3"}' }])).toBe('d3')
    expect(draftIdOf({ draftId: 'd4' }, 'Which project should it run in?')).toBe('d4')
    expect(draftIdOf({}, undefined)).toBeUndefined()
  })
})

// ── The page ──────────────────────────────────────────────────────────────────────────────────

let root: Root
let host: HTMLElement

function inboxOf(runs: InboxRun[], extra: Partial<AutomationInbox> = {}): AutomationInbox {
  return { runs, tuning: [], meta: [], month: { key: '2026-11', label: 'API keys · Nov', byJob: { deps: { tokens: 1200, costUsd: 0 }, nightly: { tokens: 9000, costUsd: 0.42 } } }, generatedAt: '', ...extra }
}

function api(index: AutomationIndex, inbox: AutomationInbox) {
  const request = vi.fn(async (method: string, _params?: unknown) => {
    switch (method) {
      case 'automations.list': return index
      case 'automations.inbox.list': return inbox
      case 'automations.inbox.counts': return { byProject: { p1: 1 }, total: 1 }
      case 'automations.inbox.resolve': return { resolved: 1 }
      case 'automations.inbox.undo': return { runId: needs.id }
      case 'automations.inbox.calibrate': return {}
      case 'automations.tuning.remove': return { removed: true }
      case 'automations.drafts.turnOn': return { job: {} }
      case 'bots.personal.list': return { bots: [] }
      default: throw new Error(method)
    }
  })
  return {
    platformRequest: { request },
    scheduled: {
      list: vi.fn(async () => []), onUpdated: vi.fn(() => () => undefined), update: vi.fn(async () => ({})),
      pause: vi.fn(async () => null), resume: vi.fn(async () => null), delete: vi.fn(async () => true), run: vi.fn(async () => null)
    },
    personalBots: { onChanged: vi.fn(() => () => undefined) },
    threads: { select: vi.fn(async () => undefined), listAll: vi.fn(async () => []) },
    pullRequests: { detail: vi.fn(async () => ({ state: 'open', checks: 'passing', headSha: 'abc' })) },
    settings: { getOptions: async () => ({ llmProviders: [] }), get: async () => ({ permissions: { defaultMode: 'accept_edits' }, provider: {} }) },
    projects: { list: async () => [] },
    orchestrator: { sendToThread: vi.fn(async () => ({})), abort: vi.fn(async () => true), answerQuestionsDetailed: vi.fn(async () => ({ ok: true })) }
  }
}

async function mount(runs: InboxRun[] = RUNS, items: AutomationItem[] = AUTOMATIONS, extra: Partial<AutomationInbox> = {}) {
  const mousse = api({ items, computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }, inboxOf(runs, extra))
  ;(window as unknown as { mousse: unknown }).mousse = mousse
  const { AutomationsInbox } = await import('../../src/renderer/components/automations/inbox/AutomationsInbox')
  await act(async () => root.render(createElement(AutomationsInbox, { active: true })))
  await act(async () => {})
  return mousse
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
const press = async (key: string) => {
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await act(async () => {})
}
const calls = (mousse: ReturnType<typeof api>, method: string) => mousse.platformRequest.request.mock.calls.filter(([name]) => name === method)

beforeEach(() => {
  setInboxClient(null)
  useInboxStore.setState({ index: null, inbox: null, counts: null, loadedAt: 0, filter: {}, openRunId: null, pane: 'run', editJobId: null, manageExpanded: null, actionError: null, folds: { bots: false, quiet: false }, composing: null })
  useAppStore.setState({ activeThreadId: null, scheduledOpen: true, projects: [], threads: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('the inbox page', () => {
  it('lists the runs in their groups, opens the first that needs you as the ordinary thread, and never resolves on open', async () => {
    const mousse = await mount()
    expect($$('[data-testid="inbox-group"]').map((group) => group.dataset.group)).toEqual(['live', 'needs_you', 'look', 'fyi', 'quiet'])
    expect($('[data-group="needs_you"] .inbox-group-count')?.textContent).toBe('2')
    expect($('[data-testid="inbox-fold-bots"]')?.textContent).toContain('Assigned to bots · 1')
    expect($(`[data-run-id="${noReport.id}"] .inbox-row-summary`)?.textContent).toBe('No report')
    expect($(`[data-run-id="${needs.id}"] [data-testid="inbox-pr-chip"]`)?.textContent).toContain('412')
    // The first row with a thread opens: its thread becomes the workspace's.
    expect(useInboxStore.getState().openRunId).toBe(live.id)
    expect(useAppStore.getState().activeThreadId).toBe('t-live')
    await click($(`[data-run-id="${needs.id}"]`))
    expect(useAppStore.getState().activeThreadId).toBe('t-needs')
    expect(mousse.threads.select).toHaveBeenLastCalledWith('t-needs')
    expect(calls(mousse, 'automations.inbox.resolve')).toHaveLength(0)
  })

  it('moves with j/k, resolves with e, undoes with u, jumps with 1–4, unfolds with Enter, filters with / and shows the keys with ?', async () => {
    const mousse = await mount()
    await press('j')
    expect(useInboxStore.getState().openRunId).toBe(needs.id)
    await press('e')
    expect(calls(mousse, 'automations.inbox.resolve')).toEqual([['automations.inbox.resolve', { runId: needs.id }]])
    await press('u')
    expect(calls(mousse, 'automations.inbox.undo')).toHaveLength(1)
    await press('2')
    expect(useInboxStore.getState().openRunId).toBe(noReport.id)
    // e on a run with nothing open does nothing.
    await press('e')
    expect(calls(mousse, 'automations.inbox.resolve')).toHaveLength(1)
    await press('4')
    await press('Enter')
    expect(useInboxStore.getState().folds.quiet).toBe(true)
    expect($$(`[data-run-id="${quiet1.id}"]`)).toHaveLength(1)
    await press('?')
    expect($('[data-testid="inbox-keys"]')?.textContent).toContain('Resolve')
    await press('/')
    expect($('[data-testid="inbox-search"]')).not.toBeNull()
  })

  it('filters to an automation by its name, with When, Who and this month\'s cost labelled API keys', async () => {
    await mount()
    await click($(`[data-run-id="${needs.id}"] .inbox-row-name`))
    expect($('[data-testid="inbox-filter-automation"]')?.textContent).toContain('Nightly review')
    expect($('[data-testid="inbox-filter-cost"]')?.textContent).toBe('$0.42API keys · Nov')
    expect($$('[data-testid="inbox-run"]').every((row) => [live.id, needs.id, noReport.id, resolved.id, quiet1.id].includes(row.dataset.runId!))).toBe(true)
    await click($('[aria-label="Show all runs"]'))
    // A subscription's automation shows tokens, not a cost.
    await click($(`[data-run-id="${fyi.id}"] .inbox-row-name`))
    expect($('[data-testid="inbox-filter-cost"]')?.textContent).toBe('1.2k tokensAPI keys · Nov')
  })

  it('shows Manage: the switch pauses and resumes, Edit opens Edit details, Delete asks first, and a Tuning note is removed', async () => {
    const mousse = await mount(RUNS, [...AUTOMATIONS.slice(0, 2), automation({ id: 'off', name: 'Deploy preview', paused: true })], {
      tuning: [{ id: 'tune_00000000-0000-0000-0000-000000000001', jobId: 'nightly', kind: 'noisy', runNumber: 14, text: 'Too noisy: “Main is green” was reported as FYI', createdAt: ago(60) }]
    })
    await click($('[data-testid="inbox-manage-btn"]'))
    const rows = $$('[data-testid="inbox-manage-row"]')
    expect(rows.map((row) => row.dataset.automation)).toEqual(['nightly', 'deps', 'off'])
    await click(rows[0]!.querySelector('[role="switch"]'))
    expect(mousse.scheduled.pause).toHaveBeenCalledWith('nightly')
    await click(rows[2]!.querySelector('[role="switch"]'))
    expect(mousse.scheduled.resume).toHaveBeenCalledWith('off')
    await click(rows[0]!.querySelector('[data-testid="inbox-tuning-toggle"]'))
    expect($('[data-testid="inbox-tuning-note"]')?.textContent).toContain('run 14')
    await click($('[data-testid="inbox-tuning-remove"]'))
    expect(calls(mousse, 'automations.tuning.remove')).toEqual([['automations.tuning.remove', { noteId: 'tune_00000000-0000-0000-0000-000000000001' }]])
    await click(rows[1]!.querySelector('[aria-label="More actions for Deps bump"]'))
    await click($('[data-testid="inbox-manage-delete"]'))
    expect($('[role="dialog"]')?.textContent).toContain('Delete “Deps bump”?')
    await click($('[data-testid="automation-delete-confirm"]'))
    expect(mousse.scheduled.delete).toHaveBeenCalledWith('deps')
    await click($('[aria-label="More actions for Nightly review"]'))
    await click($('[data-testid="inbox-manage-edit"]'))
    expect(useInboxStore.getState()).toMatchObject({ pane: 'edit', editJobId: 'nightly' })
  })

  it('shows one automation with no runs: its next run, Run now and Edit', async () => {
    const next = new Date(NOW.getTime() + 3_600_000).toISOString()
    const mousse = await mount([], [automation({ id: 'nightly', name: 'Nightly review', next: { at: next, timeZone: ZONE } })])
    expect($('[data-testid="inbox-empty-card"]')?.textContent).toContain('Nightly review')
    expect($('[data-testid="inbox-empty-card"]')?.textContent).toContain('Next run ·')
    await click($('[data-testid="inbox-run-now"]'))
    expect(mousse.scheduled.run).toHaveBeenCalledWith('nightly')
  })
})

describe('the run strip', () => {
  it('shows the level, the PR with Open PR and Merge, the usage, calibration and Resolve', async () => {
    const mousse = await mount()
    const { RunStrip } = await import('../../src/renderer/components/automations/inbox/RunStrip')
    const stripHost = document.createElement('div')
    document.body.append(stripHost)
    const stripRoot = createRoot(stripHost)
    act(() => openRun(needs))
    await act(async () => stripRoot.render(createElement(RunStrip)))
    await act(async () => {})
    expect($('[data-testid="inbox-strip-level"]')?.textContent).toBe('Needs you')
    expect($('[data-testid="inbox-pr-chip"][title*="checks pass"]')).not.toBeNull()
    expect($<HTMLButtonElement>('[data-testid="inbox-merge-pr"]')!.disabled).toBe(false)
    await click($('[data-testid="inbox-too-noisy"]'))
    expect(calls(mousse, 'automations.inbox.calibrate')).toEqual([['automations.inbox.calibrate', { runId: needs.id, kind: 'noisy' }]])
    await click($('[data-testid="inbox-should-tell"]'))
    expect(calls(mousse, 'automations.inbox.calibrate')[1]).toEqual(['automations.inbox.calibrate', { runId: needs.id, kind: 'missed' }])
    await click($('[data-testid="inbox-strip"] [data-testid="inbox-resolve"]'))
    expect(calls(mousse, 'automations.inbox.resolve')).toHaveLength(1)
    await click($('[data-testid="inbox-open-pr"]'))
    expect(useAppStore.getState()).toMatchObject({ mainView: 'pullRequest', mainAreaOpen: true })
    act(() => openRun(fyi))
    await act(async () => {})
    expect($('[data-testid="inbox-strip-usage"]')?.textContent).toBe('claude-x 1.2k')
    act(() => stripRoot.unmount())
    stripHost.remove()
  })
})

describe('the project dot', () => {
  it('counts the group\'s runs that need the person, and opens the inbox filtered to the group', async () => {
    await mount()
    useAppStore.setState({ scheduledOpen: false })
    const { ProjectRunsDot } = await import('../../src/renderer/components/automations/inbox/ProjectRunsDot')
    const dotHost = document.createElement('div')
    document.body.append(dotHost)
    const dotRoot = createRoot(dotHost)
    // The counts come from the daemon (automations.inbox.counts), per project of the group.
    await act(async () => dotRoot.render(createElement(ProjectRunsDot, { name: 'mousse', projectIds: ['p1', 'p-other'] })))
    await act(async () => {})
    const dot = $('[data-testid="inbox-project-dot"]')!
    expect(dot.getAttribute('aria-label')).toBe('mousse: 1 run needs you')
    await click(dot)
    expect(useAppStore.getState().scheduledOpen).toBe(true)
    expect(useInboxStore.getState().filter).toEqual({ project: { name: 'mousse', projectIds: ['p1', 'p-other'] } })
    await act(async () => dotRoot.render(createElement(ProjectRunsDot, { name: 'other', projectIds: ['p7'] })))
    expect($('[data-testid="inbox-project-dot"]')).toBeNull()
    act(() => dotRoot.unmount())
    dotHost.remove()
  })
})

describe('the draft card in a chat', () => {
  async function card(items: AutomationItem[], output: unknown, meta: AutomationInbox['meta'] = []) {
    const mousse = api({ items, computer: { name: 'Desk', timeZone: ZONE }, unavailable: [], generatedAt: '' }, inboxOf([], { meta }))
    ;(window as unknown as { mousse: unknown }).mousse = mousse
    setInboxClient(null)
    useInboxStore.setState({ index: null, inbox: null, loadedAt: 0 })
    useAppStore.setState({ activeThreadId: 'chat', projects: [{ id: 'p1', name: 'mousse', path: '/m', createdAt: '', order: 0 }] as never })
    const { ChatDraftCard } = await import('../../src/renderer/components/automations/inbox/ChatDraftCard')
    await act(async () => root.render(createElement(ChatDraftCard, { name: 'automation_draft_save', input: { name: 'Flaky checkout check', context: 'from the input' }, output, status: 'success' })))
    await act(async () => {})
    await act(async () => {})
    return mousse
  }
  const draft = automation({ id: 'd1', name: 'Flaky checkout check', draft: { draftId: 'd1', problems: [], originThreadId: 'chat' } as AutomationItem['draft'] })

  it('shows the draft with what "this" meant, When, Who and Project only, and turns it on', async () => {
    const mousse = await card([draft], { draftId: 'd1', problems: [] }, [{ jobId: 'd1', originThreadId: 'chat', context: 'Rerun checkout.spec 20× on main' }])
    expect($('[data-testid="chat-draft-card"]')).not.toBeNull()
    expect($('[data-testid="chat-draft-context"]')?.textContent).toBe('Rerun checkout.spec 20× on main')
    expect($$('[data-testid="chat-draft-card"] [aria-label]').map((entry) => entry.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['When', 'Who', 'Project']))
    expect($('[data-testid="chat-draft-card"]')?.textContent).not.toMatch(/Result|Tell me/)
    await click($('[data-testid="chat-draft-turn-on"]'))
    expect(calls(mousse, 'automations.drafts.turnOn')).toEqual([['automations.drafts.turnOn', { draftId: 'd1' }]])
  })

  it('folds to the automation\'s current state once it is on, and says when it was discarded', async () => {
    const next = new Date(NOW.getTime() + 3_600_000).toISOString()
    await card([automation({ id: 'd1', name: 'Flaky checkout check', next: { at: next, timeZone: ZONE } })], { draftId: 'd1' })
    expect($('[data-testid="chat-draft-on"]')?.textContent).toMatch(/On · next .*Open$/)
    await click([...document.querySelectorAll('[data-testid="chat-draft-on"] button')].find((button) => button.textContent === 'Open'))
    expect(useInboxStore.getState().filter).toEqual({ automationId: 'd1' })
    act(() => root.unmount())
    root = createRoot(host)
    await card([automation({ id: 'd1', name: 'Flaky checkout check', paused: true })], { draftId: 'd1' })
    expect($('[data-testid="chat-draft-on"]')?.textContent).toContain('Paused')
    act(() => root.unmount())
    root = createRoot(host)
    await card([], { draftId: 'd1' })
    expect($('[data-testid="chat-draft-gone"]')?.textContent).toBe('“Flaky checkout check” was discarded.')
  })
})
