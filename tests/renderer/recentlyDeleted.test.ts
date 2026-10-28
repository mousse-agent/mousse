import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LifecyclePurgeItem, LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../src/shared/resourceLifecycle'
import { RecentlyDeletedView, type RecentlyDeletedActions } from '../../src/renderer/components/sidebar/RecentlyDeletedSection'
import { PermanentDeleteDialog } from '../../src/renderer/components/sidebar/PermanentDeleteDialog'
import type { PurgeConfirmation, TrashState } from '../../src/renderer/lib/trashInventory'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const POLICY: TrashRetentionPolicy = { schemaVersion: 1, graceDays: 30, automaticPurge: true }
const noop = () => {}
const actions: RecentlyDeletedActions = { onToggle: noop, onRestore: noop, onDelete: noop, onRetry: noop }

function record(taskId: string, state: TaskLifecycleRecord['state'], extra: Partial<TaskLifecycleRecord> = {}): TaskLifecycleRecord {
  return {
    schemaVersion: 1, minimumWriterVersion: 1, profileId: 'p', taskId, generation: 1, state,
    originalLocation: '/t', location: '/t', locations: ['/t'], operations: [],
    createdAt: new Date(NOW - 90 * DAY).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), ...extra
  }
}
const trashed = (taskId: string, daysAgo: number) => record(taskId, 'trashed', { trashedAt: new Date(NOW - daysAgo * DAY).toISOString() })

function view(state: Partial<TrashState>, options: { expanded?: boolean; hidden?: boolean } = {}) {
  const full: TrashState = { loaded: true, records: [], taskNames: {}, paused: false, policy: POLICY, ...state }
  return renderToStaticMarkup(createElement(RecentlyDeletedView, { state: full, expanded: options.expanded ?? true, hidden: options.hidden ?? false, actions, now: NOW }))
}

describe('Recently deleted section', () => {
  it('is collapsed by default behind a labelled toggle that shows how many threads are in it', () => {
    const html = view({ records: [trashed('a', 2), trashed('b', 4)], taskNames: { a: 'A', b: 'B' } }, { expanded: false })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Expand recently deleted threads"')
    expect(html).toContain('<span>Recently deleted</span>')
    expect(html).toMatch(/data-testid="sidebar-trash-count">2</)
    expect(html).not.toContain('sidebar-trash-row')
    expect(html).toContain('collapsed')
    expect(html).toContain('threads-sidebar-section-settled')
  })

  it('opens to a list wired to its toggle', () => {
    const html = view({ records: [trashed('a', 2)], taskNames: { a: 'A' } })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="Collapse recently deleted threads"')
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    expect(html).toContain(`id="${controls}"`)
  })

  it('is hidden when the sidebar is not showing threads', () => {
    expect(view({}, { hidden: true })).toMatch(/data-testid="sidebar-trash-section"[^>]*\shidden=""/)
    expect(view({}, { hidden: false })).not.toMatch(/data-testid="sidebar-trash-section"[^>]*\shidden=""/)
  })

  it('says so when nothing was deleted, and when the first read has not finished', () => {
    expect(view({})).toContain('No recently deleted threads')
    expect(view({})).not.toContain('sidebar-trash-row')
    expect(view({ loaded: false })).toContain('Loading…')
    expect(view({}, { expanded: false })).toMatch(/data-testid="sidebar-trash-count">0</)
  })

  it('lists a trashed thread with its name, when it was deleted, its retention days, Restore and Delete permanently', () => {
    const html = view({ records: [trashed('a', 3)], taskNames: { a: 'Fix login' } })
    expect(html).toContain('data-testid="sidebar-trash-row"')
    expect(html).toContain('data-task-id="a"')
    expect(html).toContain('Fix login')
    expect(html).toContain('Deleted 3 days ago · Permanently deleted in 27 days')
    expect(html).toContain('data-action="restore"')
    expect(html).toContain('aria-label="Restore Fix login"')
    expect(html).toContain('data-action="delete"')
    expect(html).toContain('aria-label="Delete Fix login permanently…"')
    expect(html).not.toContain('data-action="retry"')
  })

  it('lists a thread of another computer with its computer, Restore, and Delete permanently turned off with where to do it', () => {
    const remote = { ...trashed('n:a', 3), node: 'n', computerName: 'Studio Mac' }
    const html = view({ records: [remote, trashed('b', 3)], taskNames: { 'n:a': 'Remote thread', b: 'Local thread' } })
    const row = html.split('data-testid="sidebar-trash-row"').find((part) => part.includes('Remote thread'))!
    expect(row).toContain('On Studio Mac')
    expect(row).toContain('aria-label="Restore Remote thread"')
    expect(row).toMatch(/data-action="delete"[^>]*title="Delete permanently on Studio Mac"[^>]*disabled=""/)
    expect(row).not.toContain('aria-label="Delete Remote thread permanently…"')
    // A local row is as it was.
    const local = html.split('data-testid="sidebar-trash-row"').find((part) => part.includes('Local thread'))!
    expect(local).toContain('aria-label="Delete Local thread permanently…"')
    expect(local).not.toContain('On Studio Mac')
  })

  it('says the thread is kept until deleted when automatic emptying is off', () => {
    expect(view({ records: [trashed('a', 3)], policy: { ...POLICY, automaticPurge: false } })).toContain('Deleted 3 days ago · Kept until you delete it')
    expect(view({ records: [trashed('a', 3)], paused: true })).toContain('Automatic deletion is paused')
  })

  it('lists newest deletions first and unfinished deletions before them', () => {
    const half = record('half', 'purge-started', { purge: { schemaVersion: 1, taskId: 'half', generation: 1, digest: 'd', items: [], ownedTaskIds: [], blockers: [], retained: [], exclusiveBytes: 0, operationId: 'op', startedAt: new Date(NOW).toISOString(), discardAuthorized: false } })
    const html = view({ records: [trashed('old', 20), trashed('new', 1), half], taskNames: { old: 'Old one', new: 'New one', half: 'Half one' } })
    const order = ['Half one', 'New one', 'Old one'].map((name) => html.indexOf(`title="${name}"`))
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('shows an unfinished deletion with Retry and no way to restore it', () => {
    const items: LifecyclePurgeItem[] = [{ id: 'p', kind: 'path', identity: '/p', ownerTaskId: 'a', status: 'removed' }, { id: 'w', kind: 'worktree', identity: '/w', ownerTaskId: 'a', status: 'pending' }]
    const half = record('a', 'purge-started', { purge: { schemaVersion: 1, taskId: 'a', generation: 1, digest: 'd', items, ownedTaskIds: ['a'], blockers: [], retained: [], exclusiveBytes: 0, operationId: 'op', startedAt: new Date(NOW).toISOString(), discardAuthorized: false, error: 'Purge could not remove a locked resource.' } })
    const html = view({ records: [half], taskNames: { a: 'Half done' } })
    expect(html).toContain('data-action="retry"')
    expect(html).toContain('aria-label="Retry deleting Half done"')
    expect(html).toContain('Deletion started · 1 of 2 removed · can’t be restored')
    expect(html).toContain('Purge could not remove a locked resource.')
    expect(html).not.toContain('data-action="restore"')
    expect(html).not.toContain('data-action="delete"')
  })

  it('shows a failed action with its reason under the thread, and one for a thread that already left the list', () => {
    const html = view({ records: [trashed('a', 2)], notice: { taskId: 'a', message: 'Another operation owns this thread; try again.' } })
    expect(html).toMatch(/data-testid="sidebar-trash-notice"[^>]*>Another operation owns this thread; try again\.</)
    const stray = view({ records: [trashed('a', 2)], notice: { taskId: 'gone', message: 'Could not delete that thread.' } })
    expect(stray).toContain('Could not delete that thread.')
    expect(stray).not.toContain('sidebar-trash-notice')
    expect(view({ refreshError: 'Unable to refresh recently deleted threads. Please try again.' })).toContain('role="alert"')
  })

  it('disables every action while one is running, and offers none for a thread on its way into the trash', () => {
    const busy = view({ records: [trashed('a', 2), trashed('b', 3)], busyTaskId: 'a' })
    expect(busy.match(/<button[^>]*data-action="[a-z]+"[^>]*disabled=""/g)).toHaveLength(4)
    const moving = view({ records: [record('m', 'trash-moving')] })
    expect(moving).toContain('Moving to trash…')
    expect(moving).not.toContain('data-action=')
  })

  it('offers each action as a real button that keyboard users can reach and name', () => {
    const html = view({ records: [trashed('a', 2), trashed('b', 3)], taskNames: { a: 'A', b: 'B' } })
    const actionButtons = html.match(/<button[^>]*data-action="[a-z]+"[^>]*>/g) ?? []
    expect(actionButtons).toHaveLength(4)
    for (const tag of actionButtons) {
      expect(tag).toContain('type="button"')
      expect(tag).toMatch(/aria-label="[^"]+"/)
      expect(tag).not.toContain('tabindex')
    }
    const names = actionButtons.map((tag) => tag.match(/aria-label="([^"]+)"/)![1])
    expect(new Set(names).size).toBe(names.length)
  })

  it('marks rows with a background fill only, never an edge bar', () => {
    const css = readFileSync('src/renderer/styles/threads-sidebar.css', 'utf8')
    const rules = [...css.matchAll(/([^{}]*threads-sidebar-trash-row[^{}]*)\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(0)
    for (const [, selector, body] of rules) {
      expect(selector).not.toMatch(/::?(before|after)/)
      expect(body).not.toMatch(/border-(left|right|inline)|box-shadow|outline|inset/)
    }
    expect(rules.some(([, selector, body]) => /:hover/.test(selector!) && /background:/.test(body!))).toBe(true)
  })
})

function preview(items: LifecyclePurgeItem[], extra: Partial<LifecyclePurgePreview> = {}): LifecyclePurgePreview {
  return { schemaVersion: 1, taskId: 'a', generation: 1, digest: 'd', items, ownedTaskIds: ['a'], blockers: [], retained: [], exclusiveBytes: 4096, ...extra }
}
const item = (kind: LifecyclePurgeItem['kind'], id: string, extra: Partial<LifecyclePurgeItem> = {}): LifecyclePurgeItem => ({ id, kind, identity: `/x/${id}`, ownerTaskId: 'a', status: 'pending', ...extra })

function dialog(confirmation: Partial<PurgeConfirmation>) {
  const full: PurgeConfirmation = { taskId: 'a', name: 'Fix login', preview: preview([item('path', 'data'), item('worktree', 'wt')]), discard: false, submitting: false, ...confirmation }
  return renderToStaticMarkup(createElement(PermanentDeleteDialog, { confirmation: full, onDiscardChange: noop, onConfirm: noop, onCancel: noop }))
}
const confirmButton = (html: string) => html.match(/<button[^>]*data-testid="trash-delete-confirm"[^>]*>/)![0]

describe('Permanent delete confirmation', () => {
  it('leads with what is lost and what it frees, with the list of items folded', () => {
    const html = dialog({ reclaim: { bytes: 1.2 * 1024 ** 3, estimated: false, partial: false } })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Delete “Fix login” permanently')
    expect(html).toContain('Permanently deletes the transcript and worktree of “Fix login”. This can’t be undone.')
    expect(html).toContain('Frees 1.20 GB.')
    expect(html.indexOf('Permanently deletes')).toBeLessThan(html.indexOf('Frees'))
    expect(html).toMatch(/<details class="trash-delete-details"><summary>Show details<\/summary>/)
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    expect(html).toContain('/x/data')
    expect(html).not.toContain('type="checkbox"')
    expect(confirmButton(html)).not.toContain('disabled')
  })

  it('names the unpublished work that would be lost and keeps Delete off until it is accepted', () => {
    const items = [item('path', 'data'), item('worktree', 'wt', { discardRequired: true, reason: 'This result may contain unpublished work', content: [{ path: 'notes.txt', kind: 'file', digest: 'x', bytes: 2048, mode: 0o644 }] })]
    const html = dialog({ preview: preview(items) })
    expect(html).toContain('Unpublished work will be lost: 1 worktree has unpublished work.')
    expect(html).toContain('Discard the unpublished work and only-copy files listed under Show details.')
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)/)
    expect(confirmButton(html)).toContain('disabled')
    expect(html).toContain('Unpublished: This result may contain unpublished work')
    expect(html).toContain('notes.txt (2.0 KB)')
    const accepted = dialog({ preview: preview(items), discard: true })
    expect(accepted).toMatch(/<input type="checkbox"[^>]*checked/)
    expect(confirmButton(accepted)).not.toContain('disabled')
  })

  it('names only-copy files outside Git too', () => {
    const html = dialog({ preview: preview([item('path', 'scratch', { discardRequired: true, reason: 'Scratch files have no durable reconstruction proof' })]) })
    expect(html).toContain('1 folder holds files that exist nowhere else')
  })

  it('shows what keeps a thread from being deleted and refuses to go on', () => {
    const html = dialog({ preview: preview([item('worktree', 'wt')], { blockers: ['Workspace retained: /x/wt: a terminal is still open'] }) })
    expect(html).toContain('Can’t delete: Workspace retained: /x/wt: a terminal is still open')
    expect(html).toMatch(/role="alert"[^>]*>Can’t delete/)
    expect(confirmButton(html)).toContain('disabled')
  })

  it('shows a busy or failed deletion with its reason and lets the person try again', () => {
    const html = dialog({ error: 'Purge could not remove a locked or permission-protected resource. Close applications using it and retry the pending purge.' })
    expect(html).toMatch(/data-testid="trash-delete-error"[^>]*>Purge could not remove a locked or permission-protected resource/)
    expect(confirmButton(html)).not.toContain('disabled')
  })

  it('locks the dialog while the deletion is running', () => {
    const html = dialog({ submitting: true })
    expect(confirmButton(html)).toContain('disabled')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel</)
  })

  it('does not start on the destructive button', () => {
    // Focus lands on the first field or on the dialog; the delete button is in the footer and is never the first stop.
    const html = dialog({ preview: preview([item('worktree', 'wt', { discardRequired: true })]) })
    expect(html.indexOf('type="checkbox"')).toBeGreaterThan(0)
    expect(html.indexOf('type="checkbox"')).toBeLessThan(html.indexOf('trash-delete-confirm'))
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.indexOf('trash-delete-confirm'))
  })
})
