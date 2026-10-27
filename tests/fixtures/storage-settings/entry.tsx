import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { StorageSettings } from '../../../src/renderer/components/StorageSettings'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import { STORAGE_POLICY_DEFAULTS, type StoragePolicy } from '../../../src/shared/storage'
// The page's own styles and theme tokens; global.css adds Tailwind, which this page does not use.
import '../../../src/renderer/styles/themes/index.css'
import '../../../src/renderer/styles/layout-tokens.css'
import '../../../src/renderer/styles/compact-shell.css'
import '../../../src/renderer/styles/polish.css'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/settings.css'

/*
 * Mounts the production Storage page against a scripted `window.mousse`. The scripted daemon keeps what
 * the page saves and answers from it, so a change only shows on screen if it was sent and read back.
 */

interface Call { method: string; args: unknown[] }
const calls: Call[] = []
const failures: string[] = []
window.addEventListener('error', (event) => failures.push(event.error?.stack ?? event.message))
window.addEventListener('unhandledrejection', (event) => failures.push(String(event.reason?.stack ?? event.reason)))

const MB = 1024 * 1024
const daemon = {
  trash: { schemaVersion: 1 as const, graceDays: 30, automaticPurge: false },
  policy: structuredClone(STORAGE_POLICY_DEFAULTS) as StoragePolicy,
  usageMode: 'ok' as 'ok' | 'malformed',
  report: null as unknown,
  runShouldFail: false
}

const names = { projects: { p1: 'Mousse', p2: 'Website' }, threads: { t1: 'Fix storage', t2: 'Add search', t3: 'Landing page' } }
const localUsage = (fresh: boolean) => daemon.usageMode === 'malformed'
  ? { measuredAt: 'soon', durationMs: 'fast', partial: false, entries: [{ kind: 'logs', bytes: -1, files: 'many' }], names }
  : {
      measuredAt: new Date(Date.now() - (fresh ? 0 : 5 * 60_000)).toISOString(), durationMs: 10, partial: false, names,
      entries: [
        { kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 400 * MB, files: 40 },
        { kind: 'worktrees', projectId: 'p1', threadId: 't2', bytes: 200 * MB, files: 20 },
        { kind: 'threads', projectId: 'p1', threadId: 't1', bytes: 100 * MB, files: 10 },
        { kind: 'browser', projectId: 'p2', bytes: 200 * MB, files: 20 },
        { kind: 'worktrees', projectId: 'p2', threadId: 't3', bytes: 50 * MB, files: 5 },
        { kind: 'logs', bytes: 100 * MB, files: 3 }
      ]
    }
const laptopUsage = () => ({
  measuredAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 10, partial: false,
  names: { projects: { p9: 'Laptop project' }, threads: { r1: 'Remote thread' } },
  entries: [{ kind: 'worktrees', projectId: 'p9', threadId: 'r1', bytes: 300 * MB, files: 30 }, { kind: 'logs', bytes: 20 * MB, files: 2 }]
})

const device = (node: string, name: string, state: 'open' | 'closed', self = false) => ({ node, name, caps: ['read'], keyEpoch: 1, expiresAt: 0, self, revoked: false, state })
const lifecycle = (taskId: string, state: string) => ({
  schemaVersion: 1, minimumWriterVersion: 1, profileId: 'fixture', taskId, generation: 1, state, originalLocation: `/x/${taskId}`, location: `/x/${taskId}`, locations: [`/x/${taskId}`],
  operations: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...(state === 'trashed' ? { trashedAt: '2026-10-01T00:00:00.000Z' } : {})
})

const record = <A extends unknown[], R>(method: string, work: (...args: A) => R | Promise<R>) => async (...args: A): Promise<R> => {
  calls.push({ method, args: structuredClone(args) })
  return work(...args)
}

const plan = [
  { rule: 'worktree-inactive', threadId: 't2', label: 'Add search', action: 'remove', reason: 'Inactive for 41 days', bytes: 200 * MB },
  { rule: 'worktree-merged', label: 'Old branch', action: 'remove', reason: 'Work is merged into the default branch', bytes: 50 * MB, bytesApproximate: true },
  { rule: 'worktree-inactive', threadId: 't1', label: 'Fix storage', action: 'keep', reason: 'Has uncommitted changes (3 files)', bytes: 0 }
]
const report = () => ({
  startedAt: new Date(Date.now() - 4000).toISOString(), completedAt: new Date().toISOString(), trigger: 'manual', bytesRecovered: 250 * MB, bytesApproximate: true,
  counts: { removed: 2, kept: 1, failed: 1 }, omittedCount: 3,
  items: [
    { rule: 'worktree-inactive', label: 'Fix storage', bytes: 0, outcome: 'kept', reason: 'Has ignored files (node_modules/)' },
    { rule: 'worktree-inactive', threadId: 't2', label: 'Add search', bytes: 200 * MB, outcome: 'removed', reason: 'Inactive for 41 days' },
    { rule: 'worktree-merged', label: 'Old branch', bytes: 50 * MB, bytesApproximate: true, outcome: 'removed', reason: 'Work is merged into the default branch' },
    { rule: 'browser-capture', label: 'Browser session s1', bytes: 0, outcome: 'failed', reason: 'Repository is busy' }
  ]
})

const trashedReclaim = { bytes: Math.round(1.2 * 1024 ** 3), estimated: false, partial: false }
const trashedPreview = {
  taskId: 't9', generation: 1, digest: 'digest', exclusiveBytes: 1, blockers: [], retained: [],
  items: [{ id: 'w1', kind: 'worktree', identity: '/work/t9', discardRequired: true, reason: 'unpublished commits' }]
}

const unsubscribe = () => () => {}
Object.assign(window, {
  mousse: {
    threads: {
      inventory: async () => ({ lifecycles: [lifecycle('t1', 'active'), lifecycle('t9', 'trashed')], taskNames: { t1: 'Fix storage', t9: 'Old experiment' }, trashPolicy: daemon.trash, trashSweepStatus: { suspended: false } }),
      configureTrash: record('threads.configureTrash', (next: typeof daemon.trash) => { daemon.trash = { ...daemon.trash, ...next, schemaVersion: 1 } }),
      select: record('threads.select', async (_id: string) => undefined),
      purge: record('threads.purge', async (_id: string, _options?: unknown) => ({ preview: trashedPreview, reclaim: trashedReclaim })),
      restore: record('threads.restore', async (_id: string) => undefined)
    },
    storage: {
      policy: async () => ({ trash: daemon.trash, trashSweepStatus: { suspended: false }, policy: daemon.policy, clockSuspended: false }),
      configure: record('storage.configure', (next: StoragePolicy) => { daemon.policy = structuredClone(next); return { policy: daemon.policy } }),
      usage: record('storage.usage', (options?: { refresh?: boolean }) => localUsage(options?.refresh === true)),
      cleanupLastReport: async () => ({ report: daemon.report }),
      cleanupPlan: record('storage.cleanupPlan', () => ({ plan })),
      cleanupRun: record('storage.cleanupRun', () => {
        if (daemon.runShouldFail) throw Object.assign(new Error('The cleanup service stopped'), { code: 'internal' })
        daemon.report = report()
        return { report: daemon.report }
      })
    },
    bridge: { onThreadPart: unsubscribe },
    platformRequest: {
      request: async (method: string, params: Record<string, unknown> = {}) => {
        if (method.startsWith('bridge.hub.')) calls.push({ method, args: [structuredClone(params)] })
        switch (method) {
          case 'net.status': return { enabled: true, self: { node: 'nod_self', name: 'This computer' }, keystore: 'unlocked' }
          case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
          case 'net.ssh.list': return { records: [] }
          case 'bridge.nodes': return { nodes: [device('nod_self', 'This computer', 'open', true), device('nod_laptop', 'Laptop', 'open'), device('nod_server', 'Server', 'open'), device('nod_phone', 'Phone', 'closed')] }
          case 'bridge.hub.storage':
            if (params.target === 'nod_laptop') return laptopUsage()
            throw Object.assign(new Error('Not permitted.'), { code: 'forbidden' })
          case 'bridge.hub.attach': return { attached: true }
          case 'bridge.hub.detach': return { detached: true }
          default: throw new Error(`Unscripted platform request ${method}`)
        }
      }
    }
  }
})

const scrolled: string[] = []
Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.id) }
useAppStore.setState({
  profileId: 'fixture', settingsOpen: true, activeThreadId: null,
  threads: [
    { id: 't1', name: 'Fix storage', projectId: 'p1', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' },
    { id: 't2', name: 'Add search', projectId: 'p1', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' },
    { id: 't3', name: 'Landing page', projectId: 'p2', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }
  ] as never
})

// ---- Driving the page ----

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const $$ = <T extends HTMLElement = HTMLElement>(selector: string): T[] => [...document.querySelectorAll<T>(selector)]
const tid = (id: string) => `[data-testid="${id}"]`
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function until<T>(read: () => T | null | undefined | false, label: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await sleep(15)
  }
}
const settled = () => until(() => { const button = $<HTMLButtonElement>(tid('storage-usage-refresh')); return button && !button.disabled && !$(tid('storage-usage-loading')) }, 'usage settled')
const text = (selector: string) => ($(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim()
async function pick(testId: string, value: string): Promise<void> {
  const trigger = await until(() => $(tid(testId)), `select ${testId}`)
  trigger.click()
  const option = await until(() => $(`[role="option"][data-value="${value}"]`), `option ${value} of ${testId}`)
  option.click()
  await until(() => !$('[role="listbox"]'), 'list closed')
}
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (element: HTMLElement, key: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
const callsOf = (method: string) => calls.filter((call) => call.method === method)
const rowsOf = () => $$(tid('storage-usage-row')).map((row) => ({ key: row.dataset.key!, label: (row.querySelector('th')?.textContent ?? '').trim(), bytes: Number(row.dataset.bytes) }))
// Read from the drawn circles, not from the data the chart was given.
const arcsOf = () => $$(tid('storage-donut-arc')).map((arc) => ({ key: arc.dataset.key!, length: Number((arc.getAttribute('stroke-dasharray') ?? '').split(' ')[0]), stroke: arc.getAttribute('stroke') }))
const valueOf = (testId: string) => $(tid(testId))?.dataset.value
const unavailable = () => text(tid('storage-usage-unavailable'))

async function customDays(testId: string, typed: string): Promise<{ typed: string; configureCalls: number; bound: string; ariaInvalid: string | null }> {
  const before = callsOf('storage.configure').length
  const input = $<HTMLInputElement>(tid(`${testId}-custom`)) ?? await (async () => { await pick(testId, 'custom'); return until(() => $<HTMLInputElement>(tid(`${testId}-custom`)), 'custom input') })()
  type(input, typed)
  press(input, 'Enter')
  await sleep(120)
  return { typed, configureCalls: callsOf('storage.configure').length - before, bound: text(tid(`${testId}-bound`)), ariaInvalid: $<HTMLInputElement>(tid(`${testId}-custom`))?.getAttribute('aria-invalid') ?? null }
}

async function run() {
  await until(() => $(tid('storage-usage')) && valueOf('storage-inactive-select'), 'page loaded')
  await settled()
  const evidence: Record<string, unknown> = {}

  // The saved values reach the controls, and the rules say what they delete and never delete.
  evidence.initial = {
    trash: valueOf('storage-auto-empty-select'), inactive: valueOf('storage-inactive-select'), captures: valueOf('storage-captures-select'),
    deleted: $('#storage-remove-deleted-switch')?.getAttribute('aria-checked'), merged: $('#storage-merged-switch')?.getAttribute('aria-checked'),
    ruleRows: ['storage-auto-empty', 'storage-remove-deleted', 'storage-inactive', 'storage-merged', 'storage-captures'].map((id) => ({ id, text: text(tid(id)) })),
    keepWhen: text(tid('storage-keep-when')),
    groups: ['storage-trash', 'storage-worktrees', 'storage-browser', 'storage-usage', 'storage-cleanup'].map((id) => Boolean(document.getElementById(id))),
    machineSelect: Boolean($(tid('storage-machine-select'))),
    measuredAt: text(tid('storage-measured-at')),
    projectRows: rowsOf(), projectArcs: arcsOf().length
  }

  // Policy editing: each setting is sent, saved by the daemon and read back.
  const policy: Record<string, unknown> = {}
  const typed45 = await customDays('storage-inactive-select', '45')
  await until(() => valueOf('storage-inactive-select') === '45', 'inactive shows 45')
  policy.custom45 = { ...typed45, saved: (callsOf('storage.configure').at(-1)!.args[0] as StoragePolicy).worktrees.inactiveDays, shown: valueOf('storage-inactive-select'), inputGone: !$(tid('storage-inactive-select-custom')) }
  policy.invalid = [await customDays('storage-inactive-select', '0'), await customDays('storage-inactive-select', '4000'), await customDays('storage-inactive-select', 'abc'), await customDays('storage-inactive-select', '4.5')]
  policy.stillSaved = { daemon: daemon.policy.worktrees.inactiveDays, configureCalls: callsOf('storage.configure').length }
  // A valid number after a refusal goes through and clears the message.
  const typed60 = await customDays('storage-inactive-select', '60')
  await until(() => valueOf('storage-inactive-select') === '60', 'inactive shows 60')
  policy.recovered = { ...typed60, saved: daemon.policy.worktrees.inactiveDays }
  await pick('storage-inactive-select', 'off')
  await until(() => valueOf('storage-inactive-select') === 'off', 'inactive off')
  policy.inactiveOff = daemon.policy.worktrees.inactiveDays
  await pick('storage-inactive-select', '7')
  await until(() => valueOf('storage-inactive-select') === '7', 'inactive 7')
  policy.inactive7 = daemon.policy.worktrees.inactiveDays

  $('#storage-merged-switch')!.click()
  await until(() => $('#storage-merged-switch')?.getAttribute('aria-checked') === 'false', 'merged off')
  policy.mergedOff = daemon.policy.worktrees.removeMerged
  $('#storage-remove-deleted-switch')!.click()
  await until(() => $('#storage-remove-deleted-switch')?.getAttribute('aria-checked') === 'false', 'deleted threads off')
  policy.deletedOff = daemon.policy.worktrees.removeWithDeletedThreads
  await pick('storage-captures-select', '90')
  await until(() => valueOf('storage-captures-select') === '90', 'captures 90')
  policy.captures90 = daemon.policy.browser.captureDays
  await pick('storage-auto-empty-select', '7')
  await until(() => valueOf('storage-auto-empty-select') === '7', 'trash 7')
  policy.trash7 = { ...daemon.trash }
  const trashCustom = await customDays('storage-auto-empty-select', '12')
  await until(() => valueOf('storage-auto-empty-select') === '12', 'trash 12')
  policy.trash12 = { ...trashCustom, saved: { ...daemon.trash } }
  policy.otherRulesKept = structuredClone(daemon.policy)
  evidence.policy = policy

  // Clean up now with a rule on: plan first, then confirm, then the report.
  const cleanup: Record<string, unknown> = {}
  cleanup.beforeRun = text(tid('storage-last-run'))
  cleanup.enabled = !$<HTMLButtonElement>(tid('storage-cleanup-button'))!.disabled
  $<HTMLButtonElement>(tid('storage-cleanup-button'))!.click()
  await until(() => $(tid('storage-cleanup-plan')), 'plan shown')
  cleanup.plan = { text: text(tid('storage-cleanup-plan')), summary: text(tid('storage-plan-summary')), planCalls: callsOf('storage.cleanupPlan').length, runCalls: callsOf('storage.cleanupRun').length, keptFolded: $<HTMLDetailsElement>(tid('storage-plan-kept'))!.open === false, confirm: text(tid('storage-cleanup-confirm')) }
  $<HTMLButtonElement>(tid('storage-cleanup-cancel'))!.click()
  await until(() => !$(tid('storage-cleanup-plan')), 'plan dismissed')
  cleanup.afterCancel = { runCalls: callsOf('storage.cleanupRun').length, report: text(tid('storage-last-run')) }
  $<HTMLButtonElement>(tid('storage-cleanup-button'))!.click()
  await until(() => $(tid('storage-cleanup-confirm')), 'plan shown again')
  const usageCallsBefore = callsOf('storage.usage').length
  $<HTMLButtonElement>(tid('storage-cleanup-confirm'))!.click()
  await until(() => $(tid('storage-report-list')) || $(tid('storage-last-run-sentence')), 'report shown')
  await until(() => !$(tid('storage-cleanup-plan')), 'dialog closed after run')
  $<HTMLDetailsElement>('.storage-last-run-list')!.open = true
  cleanup.report = {
    runCalls: callsOf('storage.cleanupRun').length, sentence: text(tid('storage-last-run-sentence')), omitted: text(tid('storage-report-omitted')),
    items: $$(tid('storage-report-list') + ' li').map((item) => ({ outcome: item.dataset.outcome, text: (item.textContent ?? '').replace(/\s+/g, ' ').trim() }))
  }
  await until(() => callsOf('storage.usage').length > usageCallsBefore, 'usage re-read after a run')
  cleanup.usageReread = true
  // A failing run says so and keeps the last report.
  daemon.runShouldFail = true
  $<HTMLButtonElement>(tid('storage-cleanup-button'))!.click()
  await until(() => $(tid('storage-cleanup-confirm')), 'plan for failing run')
  $<HTMLButtonElement>(tid('storage-cleanup-confirm'))!.click()
  await until(() => $(tid('storage-cleanup-error')), 'failure shown')
  cleanup.failure = text(tid('storage-cleanup-error'))
  daemon.runShouldFail = false
  evidence.cleanup = cleanup

  // Disk usage: Group by changes both the table and the chart.
  const usage: Record<string, unknown> = {}
  const project = { rows: rowsOf(), arcs: arcsOf() }
  await pick('storage-groupby-select', 'thread')
  await until(() => rowsOf().some((row) => row.label === 'Fix storage'), 'thread rows')
  const thread = { rows: rowsOf(), arcs: arcsOf() }
  await pick('storage-groupby-select', 'kind')
  await until(() => rowsOf().some((row) => row.label === 'Worktrees'), 'kind rows')
  const kind = { rows: rowsOf(), arcs: arcsOf() }
  usage.byGroup = { project, thread, kind }
  usage.legend = $$(tid('storage-legend-item')).length
  usage.sortedBy = ''
  $<HTMLButtonElement>(tid('storage-sort-name'))!.click()
  await sleep(40)
  usage.sortedByName = rowsOf().map((row) => row.label)
  $<HTMLButtonElement>(tid('storage-sort-name'))!.click()
  await sleep(40)
  usage.sortedByNameDesc = rowsOf().map((row) => row.label)

  // Refresh asks the daemon to measure again, for this computer only.
  await pick('storage-groupby-select', 'project')
  const localUsageBefore = callsOf('storage.usage').length
  $<HTMLButtonElement>(tid('storage-usage-refresh'))!.click()
  await until(() => callsOf('storage.usage').length > localUsageBefore, 'refresh sent')
  await settled()
  usage.refreshLocal = { options: callsOf('storage.usage').at(-1)!.args[0], measured: text(tid('storage-measured-at')) }

  // A remote machine.
  const machineOptions = async () => { $(tid('storage-machine-select'))!.click(); const values = (await until(() => { const list = $$('[role="option"]'); return list.length ? list : null }, 'machine options')).map((option) => option.dataset.value); $(tid('storage-machine-select'))!.click(); await until(() => !$('[role="listbox"]'), 'closed'); return values }
  usage.machineOptions = await machineOptions()
  await pick('storage-machine-select', 'nod_laptop')
  await until(() => rowsOf().some((row) => row.label === 'Laptop project'), 'laptop rows')
  const hubBefore = callsOf('bridge.hub.storage').length
  usage.laptop = { hubCalls: callsOf('bridge.hub.storage').map((call) => call.args[0]), rows: rowsOf(), localCalls: callsOf('storage.usage').length }
  const localCallsBeforeRefresh = callsOf('storage.usage').length
  $<HTMLButtonElement>(tid('storage-usage-refresh'))!.click()
  await until(() => callsOf('bridge.hub.storage').length > hubBefore, 'laptop refreshed')
  await settled()
  usage.laptopRefresh = { localCallsAdded: callsOf('storage.usage').length - localCallsBeforeRefresh, hubCallsAdded: callsOf('bridge.hub.storage').length - hubBefore, hubParams: callsOf('bridge.hub.storage').at(-1)!.args[0] }

  // A remote machine that refuses is Unavailable, never zero.
  await pick('storage-machine-select', 'nod_server')
  await until(() => $(tid('storage-usage-none')), 'server unavailable')
  usage.server = { text: unavailable(), chart: Boolean($(tid('storage-donut'))), none: text(tid('storage-usage-none')) }
  // One that is offline is not even asked.
  const phoneBefore = callsOf('bridge.hub.storage').filter((call) => (call.args[0] as { target: string }).target === 'nod_phone').length
  await pick('storage-machine-select', 'nod_phone')
  await until(() => unavailable().includes('Phone'), 'phone offline')
  usage.phone = { text: unavailable(), asked: callsOf('bridge.hub.storage').filter((call) => (call.args[0] as { target: string }).target === 'nod_phone').length - phoneBefore }
  // All machines: sums what answered and lists what did not.
  await pick('storage-machine-select', 'all')
  await until(() => unavailable().includes('Server') && unavailable().includes('Phone'), 'all machines answered')
  const allProject = { rows: rowsOf(), arcs: arcsOf(), unavailable: unavailable(), total: text(tid('storage-usage-total')), machineColumn: Boolean($(tid('storage-sort-machine'))) }
  await pick('storage-groupby-select', 'kind')
  await until(() => rowsOf().some((row) => row.label === 'Worktrees'), 'all by kind')
  usage.all = { project: allProject, kind: { rows: rowsOf(), machineColumn: Boolean($(tid('storage-sort-machine'))) } }

  // A reply that fails validation is refused before it is drawn.
  await pick('storage-machine-select', 'self')
  await until(() => rowsOf().length > 0 && !unavailable(), 'back on this computer')
  daemon.usageMode = 'malformed'
  $<HTMLButtonElement>(tid('storage-usage-refresh'))!.click()
  await until(() => $(tid('storage-usage-none')), 'malformed refused')
  usage.malformed = { chart: Boolean($(tid('storage-donut'))), rows: rowsOf().length, text: unavailable(), none: text(tid('storage-usage-none')) }
  daemon.usageMode = 'ok'
  $<HTMLButtonElement>(tid('storage-usage-refresh'))!.click()
  await until(() => $(tid('storage-donut')), 'recovered')
  await settled()

  // Selecting a row goes somewhere.
  const links: Record<string, unknown> = {}
  await pick('storage-groupby-select', 'thread')
  await until(() => $$('.storage-row-link').some((link) => link.textContent === 'Fix storage'), 'thread links')
  $$('.storage-row-link').find((link) => link.textContent === 'Fix storage')!.click()
  await until(() => callsOf('threads.select').length > 0, 'thread opened')
  await until(() => useAppStore.getState().settingsOpen === false, 'settings closed')
  links.localThread = { select: callsOf('threads.select').at(-1)!.args[0], settingsOpen: useAppStore.getState().settingsOpen }
  useAppStore.setState({ settingsOpen: true, activeThreadId: null })
  await pick('storage-groupby-select', 'project')
  await until(() => $$('.storage-row-link').some((link) => link.textContent === 'Mousse'), 'project links')
  const selectsBefore = callsOf('threads.select').length
  $$('.storage-row-link').find((link) => link.textContent === 'Mousse')!.click()
  await until(() => callsOf('threads.select').length > selectsBefore, 'project opened')
  links.project = { select: callsOf('threads.select').at(-1)!.args[0] }
  useAppStore.setState({ settingsOpen: true, activeThreadId: null })
  await pick('storage-groupby-select', 'kind')
  await until(() => $$('.storage-row-link').some((link) => link.textContent === 'Worktrees'), 'kind links')
  $$('.storage-row-link').find((link) => link.textContent === 'Worktrees')!.click()
  await until(() => scrolled.includes('storage-worktrees'), 'scrolled to the worktree rules')
  links.kind = { scrolledTo: scrolled.at(-1), logsIsLabel: !$$('.storage-row-link').some((link) => link.textContent === 'Logs') }
  await pick('storage-machine-select', 'nod_laptop')
  await pick('storage-groupby-select', 'thread')
  await until(() => $$('.storage-row-link').some((link) => link.textContent === 'Remote thread'), 'remote thread link')
  $$('.storage-row-link').find((link) => link.textContent === 'Remote thread')!.click()
  await until(() => callsOf('bridge.hub.attach').length > 0, 'remote thread attached')
  links.remoteThread = { attach: callsOf('bridge.hub.attach').at(-1)!.args[0], dialog: Boolean($('[role="dialog"]')) }
  $<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click()
  await until(() => !$('[role="dialog"]'), 'viewer closed')
  evidence.links = links
  await pick('storage-machine-select', 'self')
  await settled()
  evidence.usage = usage

  // The trash review lists only what is in the trash, and permanent deletion leads with one line.
  const trash: Record<string, unknown> = {}
  $<HTMLButtonElement>(tid('storage-review-trash-button'))!.click()
  await until(() => $(tid('storage-trash-dialog')), 'trash dialog')
  await until(() => $$(tid('storage-thread-row')).length > 0, 'trash rows')
  trash.dialog = text(tid('storage-trash-dialog'))
  trash.rows = $$(tid('storage-thread-row')).map((row) => ({ id: row.dataset.taskId, buttons: [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')) }))
  $('[data-task-id="t9"] button[aria-label="Delete…"]')!.click()
  await until(() => $(tid('storage-deletion-preview')), 'deletion preview')
  trash.confirmation = { summary: text(tid('storage-deletion-summary')), detailsOpen: $<HTMLDetailsElement>(tid('storage-deletion-details'))!.open, hasDiscard: Boolean($('.storage-discard input')) }
  evidence.trash = trash
  $<HTMLButtonElement>('.modal-close')!.click()
  await until(() => !$(tid('storage-trash-dialog')), 'trash dialog closed')

  // With every rule off, Clean up now has nothing to do and says so.
  await pick('storage-auto-empty-select', 'never')
  await until(() => valueOf('storage-auto-empty-select') === 'never', 'trash never')
  await pick('storage-inactive-select', 'off')
  await pick('storage-captures-select', 'off')
  await until(() => valueOf('storage-captures-select') === 'off', 'captures off')
  const planCallsBefore = callsOf('storage.cleanupPlan').length
  evidence.noRule = { disabled: $<HTMLButtonElement>(tid('storage-cleanup-button'))!.disabled, text: text(tid('storage-cleanup-now')), policy: structuredClone(daemon.policy), trash: { ...daemon.trash } }
  $<HTMLButtonElement>(tid('storage-cleanup-button'))!.click()
  await sleep(100)
  evidence.noRule = { ...(evidence.noRule as object), planCallsAdded: callsOf('storage.cleanupPlan').length - planCallsBefore }

  return { ...evidence, failures, calls: calls.map((call) => call.method) }
}

Object.assign(window, { storageFixture: { run, ready: () => Boolean($(tid('storage-usage')) && $(tid('storage-cleanup-button'))) } })
// The theme tokens hang off the document's theme, and the page's spacing tokens off .settings-page.
document.documentElement.dataset.theme = 'dark'
Object.assign(document.body.style, { margin: '0', fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: '14px', background: 'var(--surface-base)', color: 'var(--text-primary)' })
createRoot(document.getElementById('root')!).render(
  <div className="app settings-page" style={{ height: '100vh', display: 'flex', flexDirection: 'column', '--accent': '#a899ee', '--accent-rgb': '168, 153, 238' } as CSSProperties}>
    <div className="settings-body"><div className="settings-content"><StorageSettings /></div></div>
  </div>
)
