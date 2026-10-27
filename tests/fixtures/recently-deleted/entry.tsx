import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RecentlyDeletedSection } from '../../../src/renderer/components/sidebar/RecentlyDeletedSection'
import type { AppErrorShape } from '../../../src/shared/errors'
import type { LifecyclePurgeItem, LifecyclePurgePreview, TaskLifecycleRecord } from '../../../src/shared/resourceLifecycle'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/settings.css'
import '../../../src/renderer/styles/threads-sidebar.css'

// A scripted daemon: the sidebar reads and changes it only through the same calls the real preload exposes.
const DAY = 86_400_000
const now = Date.now()
const trashed = (taskId: string, daysAgo: number): TaskLifecycleRecord => ({
  schemaVersion: 1, minimumWriterVersion: 1, profileId: 'fixture', taskId, generation: 4, state: 'trashed',
  originalLocation: `/t/${taskId}`, location: `/t/${taskId}`, locations: [`/t/${taskId}`], operations: [],
  createdAt: new Date(now - 90 * DAY).toISOString(), updatedAt: new Date(now - DAY).toISOString(), trashedAt: new Date(now - daysAgo * DAY).toISOString()
})
const records: TaskLifecycleRecord[] = [trashed('oldest', 5), trashed('newest', 1), trashed('middle', 3)]
const names: Record<string, string> = { newest: 'Newest thread', middle: 'Middle thread', oldest: 'Oldest thread' }
const item = (kind: LifecyclePurgeItem['kind'], id: string, extra: Partial<LifecyclePurgeItem> = {}): LifecyclePurgeItem => ({ id, kind, identity: `/fixture/${id}`, ownerTaskId: 't', status: 'pending', ...extra })
const previewFor = (taskId: string): LifecyclePurgePreview => ({
  schemaVersion: 1, taskId, generation: 4, digest: `digest-${taskId}`, ownedTaskIds: [taskId], blockers: [], retained: [], exclusiveBytes: 3 * 1024 * 1024,
  items: taskId === 'middle'
    ? [item('path', 'middle-data'), item('worktree', 'middle-wt', { discardRequired: true, reason: 'This result may contain unpublished work' })]
    : [item('path', `${taskId}-data`), item('worktree', `${taskId}-wt`)]
})
const calls = { inventory: 0, restore: [] as string[], preview: [] as string[], purge: [] as Array<Record<string, unknown>> }
const purgeFailures = new Map<string, AppErrorShape>()
const set = (taskId: string, state: TaskLifecycleRecord['state']) => { const index = records.findIndex((entry) => entry.taskId === taskId); records[index] = { ...records[index]!, state } }

Object.assign(window, {
  mousse: { threads: {
    inventory: async () => {
      calls.inventory += 1
      return { lifecycles: records.map((entry) => ({ ...entry })), taskNames: names, trashPolicy: { schemaVersion: 1, graceDays: 30, automaticPurge: true }, trashSweepStatus: { suspended: false } }
    },
    restore: async (taskId: string) => { calls.restore.push(taskId); set(taskId, 'active') },
    purge: async (taskId: string, options: Record<string, unknown> = {}) => {
      if (options.preview) { calls.preview.push(taskId); return { preview: previewFor(taskId), reclaim: { bytes: 3 * 1024 * 1024, estimated: false, partial: false } } }
      calls.purge.push({ taskId, ...options })
      const failure = purgeFailures.get(taskId)
      if (failure) throw failure
      set(taskId, 'purged')
      return {}
    },
    onUpdated: () => () => {}
  } },
  trashFixture: {
    calls,
    failPurge: (taskId: string, failure: AppErrorShape | null) => { if (failure) purgeFailures.set(taskId, failure); else purgeFailures.delete(taskId) },
    active: () => {
      const element = document.activeElement as HTMLElement | null
      return {
        tag: element?.tagName ?? null,
        action: element?.dataset?.action ?? null,
        task: element?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null,
        label: element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? null,
        type: (element as HTMLInputElement | null)?.type ?? null,
        inDialog: Boolean(element?.closest('[role="dialog"]'))
      }
    },
    rows: () => [...document.querySelectorAll<HTMLElement>('[data-testid="sidebar-trash-row"]')].map((row) => ({ task: row.dataset.taskId, meta: row.querySelector('[data-testid="sidebar-trash-meta"]')?.textContent ?? null })),
    dialog: () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
      if (!dialog) return null
      const confirm = dialog.querySelector<HTMLButtonElement>('[data-testid="trash-delete-confirm"]')!
      return {
        title: dialog.querySelector('h3')?.textContent ?? null,
        text: dialog.querySelector('[data-testid="storage-deletion-preview"]')?.textContent ?? '',
        confirmDisabled: confirm.disabled,
        checkbox: dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? null,
        error: dialog.querySelector('[data-testid="trash-delete-error"]')?.textContent ?? null,
        detailsOpen: dialog.querySelector<HTMLDetailsElement>('details.trash-delete-details')?.open ?? null
      }
    }
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="app" style={{ width: 300 }}>
      <aside className="threads-sidebar">
        <RecentlyDeletedSection />
      </aside>
    </div>
  </StrictMode>
)
