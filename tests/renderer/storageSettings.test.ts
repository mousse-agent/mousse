import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LifecyclePurgePreview } from '../../src/shared/resourceLifecycle'
import { STORAGE_POLICY_DEFAULTS, storagePolicyHasRule, type StorageCleanupItem, type StorageCleanupPlanItem, type StorageCleanupReport, type StoragePolicy, type StorageUsageSnapshot } from '../../src/shared/storage'
import { DeletionConfirmation, deletionSummary } from '../../src/renderer/components/storage/DeletionConfirmation'
import { StorageCleanupView } from '../../src/renderer/components/storage/StorageCleanupSection'
import { sliceArcs } from '../../src/renderer/components/storage/StorageDonut'
import { DaysSelect, StoragePolicyRows, parseCustomDays } from '../../src/renderer/components/storage/StoragePolicyRows'
import { StorageUsageView } from '../../src/renderer/components/storage/StorageUsageSection'
import { KEEP_WHEN_COPY, STORAGE_RULE_COPY, WORKTREE_GROUP_DESCRIPTION, type StorageRuleId } from '../../src/renderer/lib/storageCopy'
import { SELF_MACHINE, offlineUsage, type MachineUsage } from '../../src/renderer/lib/storageUsage'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const noop = () => undefined
/** The opening tag that carries a test id or an id, so attribute order never matters. */
const tagOf = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
const idTag = (html: string, id: string) => html.match(new RegExp(`<[^>]* id="${id}"[^>]*>`))?.[0] ?? ''

const trash = { schemaVersion: 1 as const, graceDays: 30, automaticPurge: true }
const rows = (patch: Partial<ComponentProps<typeof StoragePolicyRows>> = {}) => renderToStaticMarkup(createElement(StoragePolicyRows, {
  trash, policy: STORAGE_POLICY_DEFAULTS, trashPaused: false, storagePaused: false, busy: false,
  onTrash: noop, onPolicy: noop, onResumeTrash: noop, onResumeStorage: noop, reviewTrash: null, ...patch
}))
const policy = (patch: Partial<StoragePolicy['worktrees']> = {}, captureDays: number | null = 30): StoragePolicy => ({ schemaVersion: 1, worktrees: { ...STORAGE_POLICY_DEFAULTS.worktrees, ...patch }, browser: { captureDays } })

describe('policy rows', () => {
  it('shows one control per rule with the saved values', () => {
    const html = rows()
    expect(html).toContain('data-testid="storage-auto-empty-select"')
    for (const id of ['storage-auto-empty-select', 'storage-inactive-select', 'storage-captures-select']) expect(tagOf(html, id), id).toContain('data-value="30"')
    expect(idTag(html, 'storage-remove-deleted-switch')).toContain('aria-checked="true"')
    expect(idTag(html, 'storage-merged-switch')).toContain('aria-checked="true"')
    for (const id of ['storage-trash', 'storage-worktrees', 'storage-browser']) expect(html).toContain(`id="${id}"`)
  })

  it('shows rules that are off as off', () => {
    const html = rows({ trash: { ...trash, automaticPurge: false }, policy: policy({ removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false }, null) })
    expect(tagOf(html, 'storage-auto-empty-select')).toContain('data-value="never"')
    expect(tagOf(html, 'storage-inactive-select')).toContain('data-value="off"')
    expect(tagOf(html, 'storage-captures-select')).toContain('data-value="off"')
    expect(idTag(html, 'storage-remove-deleted-switch')).toContain('aria-checked="false"')
    expect(idTag(html, 'storage-merged-switch')).toContain('aria-checked="false"')
  })

  it('shows a number of days that is not a preset as its own choice', () => {
    expect(text(rows({ policy: policy({ inactiveDays: 45 }) }))).toContain('After 45 days')
    expect(text(rows({ policy: policy({ inactiveDays: 1 }) }))).toContain('After 1 day')
  })

  it('waits for the saved values before offering a choice', () => {
    const html = rows({ trash: undefined, policy: undefined })
    expect(text(html)).toContain('Loading…')
    expect(idTag(html, 'storage-merged-switch')).toContain('disabled')
  })

  it('offers Resume only while a clock pause is in effect', () => {
    expect(text(rows())).not.toContain('Resume')
    expect(text(rows({ trashPaused: true }))).toContain('Paused after a system clock change.')
    expect(text(rows({ trashPaused: true }))).toContain('Resume')
    const stopped = rows({ storagePaused: true })
    expect(stopped).toContain('data-testid="storage-clock-paused"')
    expect(text(stopped)).toContain('Time-based cleanup is paused')
  })

  it('shows the custom days input with its label', () => {
    const html = renderToStaticMarkup(createElement(DaysSelect, { id: 'x', testId: 'x-select', value: 30, offLabel: 'Off', offValue: 'off', label: 'Remove worktrees inactive for', onChange: noop, initialCustom: true, initialDraft: '45' }))
    expect(html).toContain('data-testid="x-select-custom"')
    expect(html).toContain('aria-label="Remove worktrees inactive for: number of days"')
    expect(html).toContain('value="45"')
    expect(tagOf(html, 'x-select')).toContain('data-value="custom"')
  })

  it('accepts only whole days from 1 to 3650', () => {
    expect(['1', '45', ' 3650 ', '007'].map(parseCustomDays)).toEqual([1, 45, 3650, 7])
    expect(['0', '3651', '-3', '4.5', '1e3', '', 'abc', '30 days', '99999', '١٢'].map(parseCustomDays)).toEqual(Array(10).fill(undefined))
  })
})

describe('plain-words copy', () => {
  const rules = Object.keys(STORAGE_RULE_COPY) as StorageRuleId[]

  it('says what every rule deletes and what it never deletes, on the page', () => {
    const page = text(rows())
    for (const id of rules) {
      const copy = STORAGE_RULE_COPY[id]
      expect(copy.deletes.length, id).toBeGreaterThan(20)
      expect(copy.never.length, id).toBeGreaterThan(20)
      expect(page, `${id} deletes`).toContain(`Deletes ${copy.deletes}`)
      expect(page, `${id} never deletes`).toContain(`Never deletes ${copy.never}`)
      expect(page, `${id} title`).toContain(copy.title)
    }
  })

  it('names what the worktree rules always keep, in terms a person uses', () => {
    for (const id of ['deletedThreads', 'inactive', 'merged'] as const) {
      const never = STORAGE_RULE_COPY[id].never
      expect(never).toContain('uncommitted')
      expect(never).toContain('untracked')
      expect(never).toContain('ignored')
      expect(never).toContain('node_modules')
      expect(never).toContain('commits that are not in the default branch')
      expect(never).toContain('running or waiting')
    }
  })

  it('explains merged, restore, capture links and older downloads', () => {
    expect(STORAGE_RULE_COPY.merged.note).toContain('A pull request’s state is not checked')
    expect(STORAGE_RULE_COPY.merged.deletes).toContain('restored the next time you use the thread')
    expect(STORAGE_RULE_COPY.inactive.deletes).toContain('restored the next time you use the thread')
    expect(STORAGE_RULE_COPY.captures.deletes).toContain('Older capture links will no longer open.')
    expect(STORAGE_RULE_COPY.captures.never).toContain('download')
    expect(STORAGE_RULE_COPY.captures.note).toContain('.png')
    expect(STORAGE_RULE_COPY.trash.never).toContain('not been published')
  })

  it('shows the keep-when statement, as a statement and not a control', () => {
    const html = rows()
    const statement = html.slice(html.indexOf('data-testid="storage-keep-when"'))
    expect(text(statement.slice(0, statement.indexOf('</div></div>') + 12))).toContain(KEEP_WHEN_COPY.title)
    expect(text(html)).toContain(KEEP_WHEN_COPY.description)
    expect(text(html)).toContain(WORKTREE_GROUP_DESCRIPTION)
    expect(KEEP_WHEN_COPY.title).toBe('Keep a worktree when it has any local files')
  })

  it('keeps the plain sentences free of jargon a person would not use', () => {
    const everything = JSON.stringify([STORAGE_RULE_COPY, KEEP_WHEN_COPY, WORKTREE_GROUP_DESCRIPTION])
    for (const word of ['HEAD', 'ref ', 'lease', 'manifest', 'digest', 'ancestor', 'retire']) expect(everything).not.toContain(word)
  })
})

const item = (patch: Partial<StorageCleanupItem>): StorageCleanupItem => ({ rule: 'worktree-inactive', label: 'Fix storage', bytes: 0, outcome: 'kept', reason: 'Has uncommitted changes (2 files)', ...patch })
const reportOf = (items: StorageCleanupItem[], patch: Partial<StorageCleanupReport> = {}): StorageCleanupReport => ({
  startedAt: '2026-10-27T10:00:00.000Z', completedAt: '2026-10-27T10:00:09.000Z', trigger: 'manual', bytesRecovered: 0, bytesApproximate: false,
  counts: { removed: items.filter((entry) => entry.outcome === 'removed').length, kept: items.filter((entry) => entry.outcome === 'kept').length, failed: items.filter((entry) => entry.outcome === 'failed').length },
  items, omittedCount: 0, ...patch
})
const cleanup = (patch: Partial<ComponentProps<typeof StorageCleanupView>> = {}) => renderToStaticMarkup(createElement(StorageCleanupView, {
  report: null, phase: 'idle', plan: undefined, error: '', hasRule: true, onStart: noop, onConfirm: noop, onCancel: noop, ...patch
}))

describe('Clean up now', () => {
  it('is disabled, with its sentence, while no rule would act', () => {
    const none = policy({ removeWithDeletedThreads: false, inactiveDays: null, removeMerged: false }, null)
    expect(storagePolicyHasRule(none, { ...trash, automaticPurge: false })).toBe(false)
    const html = cleanup({ hasRule: false })
    expect(tagOf(html, 'storage-cleanup-button')).toContain('disabled')
    expect(text(html)).toContain('Turn on a cleanup rule to use this.')
    const enabled = cleanup()
    expect(tagOf(enabled, 'storage-cleanup-button')).not.toContain('disabled')
    expect(text(enabled)).not.toContain('Turn on a cleanup rule')
  })

  it('is busy, and cannot be pressed again, while it checks or runs', () => {
    for (const phase of ['planning', 'running'] as const) expect(tagOf(cleanup({ phase }), 'storage-cleanup-button')).toContain('disabled')
    expect(text(cleanup({ phase: 'planning' }))).toContain('Checking…')
  })

  const plan: StorageCleanupPlanItem[] = [
    { rule: 'worktree-inactive', label: 'Fix storage', action: 'remove', reason: 'Inactive for 41 days', bytes: 3 * 1024 ** 3, threadId: 't1' },
    { rule: 'worktree-merged', label: 'Add search', action: 'remove', reason: 'Work is merged into the default branch', bytes: 1024 ** 3, bytesApproximate: true },
    { rule: 'worktree-inactive', label: 'Refactor', action: 'keep', reason: 'Has 2 unpublished commits', bytes: 0 }
  ]

  it('shows the dry-run plan first: what goes, why, how much, and what stays', () => {
    const html = cleanup({ phase: 'confirm', plan })
    const page = text(html)
    expect(page).toContain('Clean up now?')
    expect(page).toContain('Would remove 2 items, freeing about 4.00 GB. 1 will be kept.')
    expect(page).toContain('Inactive worktree: Fix storage')
    expect(page).toContain('Inactive for 41 days')
    expect(page).toContain('A removed worktree is restored the next time you use its thread.')
    expect(page).not.toContain('cannot be restored')
    expect(html).toContain('data-testid="storage-plan-removals"')
    // The kept items are folded away, with their reasons inside.
    expect(html).toMatch(/<details[^>]*data-testid="storage-plan-kept"[^>]*>/)
    expect(html).not.toMatch(/<details[^>]*data-testid="storage-plan-kept"[^>]*open/)
    expect(page).toContain('Has 2 unpublished commits')
  })

  it('needs a confirmation before anything is removed, and offers a way out', () => {
    const html = cleanup({ phase: 'confirm', plan })
    expect(html).toContain('data-testid="storage-cleanup-confirm"')
    expect(text(html)).toContain('Remove 2 items')
    expect(text(html)).toContain('Cancel')
    expect(cleanup({ phase: 'idle', plan })).not.toContain('data-testid="storage-cleanup-confirm"')
  })

  it('warns that emptied trash cannot be restored', () => {
    const withTrash: StorageCleanupPlanItem[] = [{ rule: 'trash', label: '2 threads in the trash', action: 'remove', reason: 'Retention passed', bytes: 10 }]
    expect(text(cleanup({ phase: 'confirm', plan: withTrash }))).toContain('Threads removed from the trash cannot be restored.')
  })

  it('says so when nothing would be removed, and offers only to close', () => {
    const html = cleanup({ phase: 'confirm', plan: [plan[2]!] })
    expect(text(html)).toContain('Nothing would be removed. 1 will be kept.')
    expect(html).not.toContain('data-testid="storage-cleanup-confirm"')
    expect(text(html)).toContain('Close')
  })

  it('locks the dialog while the run is going', () => {
    const html = cleanup({ phase: 'running', plan })
    expect(tagOf(html, 'storage-cleanup-confirm')).toContain('disabled')
    expect(tagOf(html, 'storage-cleanup-cancel')).toContain('disabled')
    expect(text(html)).toContain('Cleaning up…')
  })

  it('reports what was removed or kept and why, failed first', () => {
    const report = reportOf([
      item({ outcome: 'kept', reason: 'Has ignored files (node_modules/)', label: 'Kept one' }),
      item({ outcome: 'removed', reason: 'Inactive for 41 days', bytes: 2 * 1024 ** 3, label: 'Removed one' }),
      item({ outcome: 'failed', reason: 'Repository is busy', label: 'Failed one' })
    ], { bytesRecovered: 2 * 1024 ** 3 })
    const html = cleanup({ report })
    const page = text(html)
    expect(page).toContain('Removed 1, kept 1, failed 1. 2.00 GB recovered.')
    expect(page).toContain('Last run')
    expect(page).toContain('(Clean up now)')
    const order = ['Failed one', 'Removed one', 'Kept one'].map((label) => page.indexOf(label))
    expect(order.every((position) => position > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(page).toContain('Has ignored files (node_modules/)')
    expect(page).toContain('Repository is busy')
    expect(html).toMatch(/<details class="storage-last-run-list">/)
    expect(html).not.toMatch(/<details class="storage-last-run-list"[^>]*open/)
  })

  it('counts the results it left out', () => {
    expect(text(cleanup({ report: reportOf([item({})], { omittedCount: 37 }) }))).toContain('37 more results')
    expect(text(cleanup({ report: reportOf([item({})], { omittedCount: 1 }) }))).toContain('1 more result')
    expect(text(cleanup({ report: reportOf([item({})]) }))).not.toContain('more result')
  })

  it('says about, at least and nothing needed in the sentence', () => {
    expect(text(cleanup({ report: reportOf([item({ outcome: 'removed', bytes: 5 })], { bytesRecovered: 5 * 1024 ** 2, bytesApproximate: true }) }))).toContain('About 5.0 MB recovered.')
    expect(text(cleanup({ report: reportOf([item({ outcome: 'removed', bytes: 5 })], { bytesRecovered: 5 * 1024 ** 2, bytesApproximate: true, bytesLowerBound: true }) }))).toContain('At least 5.0 MB recovered.')
    expect(text(cleanup({ report: reportOf([]) }))).toContain('Nothing needed cleanup.')
  })

  it('shows a paused clock and an unrun state', () => {
    expect(text(cleanup({ report: reportOf([], { suspended: 'Paused after the system clock moved backwards; save the storage policy to resume' }) }))).toContain('Paused after the system clock moved backwards')
    expect(text(cleanup({ report: null }))).toContain('Cleanup has not run yet.')
    expect(text(cleanup({ report: undefined }))).toContain('Loading the last run…')
  })

  it('shows an error outside the dialog', () => {
    expect(cleanup({ error: 'Cleanup did not finish.' })).toContain('data-testid="storage-cleanup-error"')
  })
})

const preview = (items: Array<Partial<LifecyclePurgePreview['items'][number]>>): LifecyclePurgePreview => ({
  taskId: 't', generation: 1, digest: 'd', exclusiveBytes: 1234, blockers: [], retained: [],
  items: items.map((entry, index) => ({ id: `i${index}`, kind: 'worktree', identity: `/work/${index}`, ...entry })) as never
} as unknown as LifecyclePurgePreview)
const confirmation = (value: LifecyclePurgePreview, reclaim?: { bytes: number; estimated: boolean; partial: boolean }, discard = false) =>
  renderToStaticMarkup(createElement(DeletionConfirmation, { preview: value, reclaim, discard, onDiscardChange: noop }))

describe('permanent deletion confirmation', () => {
  it('leads with one line and keeps the per-item list behind Show details', () => {
    const html = confirmation(preview([{ discardRequired: true, reason: 'unpublished commits' }, { discardRequired: true }, { kind: 'ref', identity: 'mousse/t' }]), { bytes: 1.2 * 1024 ** 3, estimated: false, partial: false })
    expect(html).toContain('data-testid="storage-deletion-preview"')
    expect(html).toContain('aria-label="Permanent deletion preview"')
    expect(text(html)).toContain('Frees 1.20 GB. 2 worktrees have unpublished work.')
    const summary = html.indexOf('data-testid="storage-deletion-summary"')
    const details = html.indexOf('<details class="storage-deletion-details"')
    const firstItem = html.indexOf('/work/0')
    expect(summary).toBeGreaterThan(0)
    expect(details).toBeGreaterThan(summary)
    expect(firstItem).toBeGreaterThan(details)
    expect(html).not.toMatch(/<details class="storage-deletion-details"[^>]*open/)
    expect(text(html)).toContain('Show details')
  })

  it('says about for an estimate or a partial measurement', () => {
    const one = preview([{ discardRequired: true }])
    expect(deletionSummary(one, { bytes: 2048, estimated: true, partial: false })).toBe('Frees about 2.0 KB. 1 worktree has unpublished work.')
    expect(deletionSummary(one, { bytes: 2048, estimated: false, partial: true })).toBe('Frees about 2.0 KB. 1 worktree has unpublished work.')
    expect(deletionSummary(one, { bytes: 2048, estimated: false, partial: false })).toBe('Frees 2.0 KB. 1 worktree has unpublished work.')
  })

  it('does not call a clean deletion unpublished, and falls back to the preview size without a measurement', () => {
    expect(deletionSummary(preview([{}]))).toBe('Frees about 1.2 KB. No worktree has unpublished work.')
  })

  it('asks for the discard tick only when work would be lost, and shows blockers', () => {
    expect(confirmation(preview([{}]))).not.toContain('type="checkbox"')
    expect(confirmation(preview([{ discardRequired: true }]))).toContain('type="checkbox"')
    const blocked = { ...preview([{}]), blockers: ['A turn is running'] }
    expect(text(confirmation(blocked))).toContain('Can’t delete: A turn is running')
  })
})

const snapshot = (patch: Partial<StorageUsageSnapshot> = {}): StorageUsageSnapshot => ({
  measuredAt: new Date(Date.now() - 5 * 60_000).toISOString(), durationMs: 20, partial: false,
  entries: [
    { kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 600 * 1024 ** 2, files: 10 },
    { kind: 'threads', projectId: 'p1', threadId: 't1', bytes: 100 * 1024 ** 2, files: 10 },
    { kind: 'browser', projectId: 'p2', bytes: 200 * 1024 ** 2, files: 10 },
    { kind: 'logs', bytes: 100 * 1024 ** 2, files: 10 }
  ],
  names: { projects: { p1: 'Mousse', p2: 'Website' }, threads: { t1: 'Fix storage' } }, ...patch
})
const usageView = (results: MachineUsage[] | undefined, patch: Partial<ComponentProps<typeof StorageUsageView>> = {}) => renderToStaticMarkup(createElement(StorageUsageView, {
  machines: [], machine: 'self', by: 'project', results, loading: false, sort: { key: 'size', direction: 'desc' }, now: Date.now(),
  canOpen: () => true, onMachine: noop, onBy: noop, onRefresh: noop, onSort: noop, onOpen: noop, ...patch
}))
const ready = (value: StorageUsageSnapshot): MachineUsage => ({ machine: SELF_MACHINE, status: 'ready', snapshot: value })

describe('disk usage view', () => {
  it('draws one arc and one table row per group, with the same numbers', () => {
    const html = usageView([ready(snapshot())])
    const arcs = [...html.matchAll(/data-testid="storage-donut-arc"[^>]*data-key="([^"]+)"/g)].map((match) => match[1])
    const bodies = [...html.matchAll(/data-testid="storage-usage-row" data-key="([^"]+)" data-bytes="(\d+)"/g)].map((match) => [match[1], Number(match[2])] as const)
    expect(arcs).toEqual(['self:p1', 'self:p2', 'self:\u0000other'])
    expect(bodies.map(([key]) => key).sort()).toEqual([...arcs].sort())
    expect(Object.fromEntries(bodies)).toEqual({ 'self:p1': 700 * 1024 ** 2, 'self:p2': 200 * 1024 ** 2, 'self:\u0000other': 100 * 1024 ** 2 })
    const page = text(html)
    expect(page).toContain('Mousse')
    expect(page).toContain('700.0 MB')
    expect(page).toContain('70%')
    expect(page).toContain('1000.0 MB in total')
    expect(page).toContain('Measured 5m ago')
  })

  it('sizes the arcs by share and lays them end to end', () => {
    const arcs = sliceArcs([{ key: 'a', label: 'A', bytes: 3, share: 0.75 }, { key: 'b', label: 'B', bytes: 1, share: 0.25 }])
    expect(arcs[0]!.offset).toBe(0)
    expect(arcs[1]!.offset).toBeCloseTo(arcs[0]!.length + 1.5, 5)
    expect(arcs[0]!.length / (arcs[0]!.length + arcs[1]!.length + 3)).toBeCloseTo(0.75, 1)
    expect(sliceArcs([{ key: 'a', label: 'A', bytes: 3, share: 1 }])[0]!.length).toBeGreaterThan(0)
  })

  it('hides the chart from assistive tech and keeps the numbers in a table with a caption', () => {
    const html = usageView([ready(snapshot())])
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-testid="storage-donut"/)
    expect(html).toContain('<caption class="sr-only">Disk usage by project</caption>')
    expect(html).toContain('aria-sort="descending"')
    expect(usageView([ready(snapshot())], { by: 'thread' })).toContain('Disk usage by thread')
  })

  it('marks a row by its background only, never by a side or edge bar', () => {
    const html = usageView([ready(snapshot())])
    expect(html).not.toMatch(/border-left|border-inline-start|box-shadow|inset/)
    const css = readFileSync(resolve('src/renderer/styles/storage.css'), 'utf8')
    expect(css).not.toMatch(/border-(left|right|inline-start|inline-end)\s*:/)
    expect(css).not.toMatch(/box-shadow\s*:\s*inset/)
    expect(css).not.toMatch(/::(before|after)/)
    expect(css).toMatch(/\.storage-table tbody tr:hover\s*\{\s*background:/)
  })

  it('says partial, estimated, condensed and old, each in words', () => {
    const notesOf = (value: StorageUsageSnapshot, now = Date.now()) => [...usageView([ready(value)], { now }).matchAll(/data-note="(\w+)"/g)].map((match) => match[1])
    expect(notesOf(snapshot())).toEqual([])
    expect(notesOf(snapshot({ partial: true }))).toEqual(['partial'])
    expect(notesOf(snapshot({ condensed: true }))).toEqual(['condensed'])
    expect(notesOf(snapshot({ entries: [{ kind: 'logs', bytes: 5, files: 1, estimated: true }] }))).toEqual(['estimated'])
    expect(notesOf(snapshot({ measuredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }))).toEqual(['stale'])
    const partial = text(usageView([ready(snapshot({ partial: true }))]))
    expect(partial).toContain('Partial: some folders are not measured yet')
    expect(partial).toContain('At least 1000.0 MB in total')
    expect(text(usageView([ready(snapshot({ measuredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }))]))).toContain('Old numbers: measured 3d ago. Refresh to measure again.')
  })

  it('says it is measuring before the first answer, and nothing to show when none answered', () => {
    expect(usageView(undefined)).toContain('data-testid="storage-usage-loading"')
    expect(usageView(undefined)).not.toContain('data-testid="storage-donut"')
    const none = usageView([offlineUsage({ node: 'nod_a', name: 'Laptop' })])
    expect(none).not.toContain('data-testid="storage-donut"')
    expect(none).toContain('data-testid="storage-usage-none"')
  })

  it('shows a machine that did not answer as Unavailable with the reason, never as 0', () => {
    const html = usageView([ready(snapshot()), offlineUsage({ node: 'nod_a', name: 'Laptop' }), { machine: { node: 'nod_b', name: 'Server' }, status: 'unavailable', reason: 'Older version or no permission' }], { machine: 'all' })
    const unavailable = text(html.slice(html.indexOf('data-testid="storage-usage-unavailable"')))
    expect(unavailable).toContain('Laptop : Unavailable · Offline')
    expect(unavailable).toContain('Server : Unavailable · Older version or no permission')
    expect(html).not.toMatch(/Laptop[^<]*<\/(td|th)>\s*<td[^>]*>\s*0 B/)
    // The total counts only the machine that answered.
    expect(text(html)).toContain('1000.0 MB in total')
  })

  it('lists one row per machine in the project view and names the machine', () => {
    const laptop: MachineUsage = { machine: { node: 'nod_a', name: 'Laptop' }, status: 'ready', snapshot: snapshot({ entries: [{ kind: 'worktrees', projectId: 'p1', bytes: 50 * 1024 ** 2, files: 1 }], names: { projects: { p1: 'Mousse' }, threads: {} } }) }
    const html = usageView([ready(snapshot()), laptop], { machine: 'all', machines: [{ node: 'nod_a' as never, name: 'Laptop', online: true }] })
    const keys = [...html.matchAll(/data-testid="storage-usage-row" data-key="([^"]+)"/g)].map((match) => match[1])
    expect(keys).toContain('self:p1')
    expect(keys).toContain('nod_a:p1')
    expect(text(html)).toContain('Machine')
    expect(text(html)).toContain('Laptop')
    // The kind view sums across machines and has no machine column.
    const kinds = usageView([ready(snapshot()), laptop], { machine: 'all', by: 'kind', machines: [{ node: 'nod_a' as never, name: 'Laptop', online: true }] })
    expect([...kinds.matchAll(/data-testid="storage-usage-row" data-key="([^"]+)" data-bytes="(\d+)"/g)].find((match) => match[1] === 'worktrees')![2]).toBe(String(650 * 1024 ** 2))
    expect(kinds).not.toContain('data-testid="storage-sort-machine"')
  })

  it('offers the machine dropdown only when there is another machine', () => {
    expect(usageView([ready(snapshot())])).not.toContain('data-testid="storage-machine-select"')
    const html = usageView([ready(snapshot())], { machines: [{ node: 'nod_a' as never, name: 'Laptop', online: true }] })
    expect(html).toContain('data-testid="storage-machine-select"')
    expect(html).toContain('data-testid="storage-groupby-select"')
  })

  it('turns Refresh into Measuring while it works', () => {
    expect(text(usageView([ready(snapshot())]))).toContain('Refresh')
    const busy = usageView([ready(snapshot())], { loading: true })
    expect(tagOf(busy, 'storage-usage-refresh')).toContain('disabled')
    expect(text(busy)).toContain('Measuring…')
  })

  it('draws a link only where a row has somewhere to go', () => {
    const html = usageView([ready(snapshot())], { canOpen: (group) => group.id === 'p1' })
    expect(html.match(/class="storage-row-link"/g)).toHaveLength(1)
  })
})
