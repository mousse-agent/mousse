/**
 * What the renderer shows for subagent threads: the sidebar folds them under their parent (hidden,
 * rolled-up activity, parent highlighted while one is open) and an open subagent gets a breadcrumb
 * and a "Subagent of" divider.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { SubagentParentBar, SubagentParentBarView } from '../src/renderer/components/SubagentParentBar'
import { ThreadsSidebar } from '../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { Thread, ThreadActivitySnapshot } from '../src/shared/types'

const at = '2026-10-25T10:00:00.000Z'
const thread = (id: string, name: string, extra: Partial<Thread> = {}): Thread => ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, ...extra })
const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId): Thread['lineage'] => ({ parentThreadId, rootThreadId, relationship: 'subagent' })

type Patch = Partial<ReturnType<typeof useAppStore.getState>>
const initial = useAppStore.getInitialState()
const keys = ['threads', 'activeThreadId', 'threadActivity', 'subagentsByParent'] as const
const original = Object.fromEntries(keys.map((key) => [key, initial[key]])) as Patch

/** Server rendering reads the store's initial state, so patch both it and the live state. */
function setStore(patch: Patch) {
  useAppStore.setState(patch)
  Object.assign(initial, patch)
}
afterEach(() => setStore(original))

const threads = [
  thread('parent', 'Fix the build'),
  thread('child', 'API reviewer', { lineage: subagentOf('parent') }),
  thread('grandchild', 'Deep helper', { lineage: subagentOf('child', 'parent') }),
  thread('orphan', 'Left behind', { lineage: subagentOf('trashed') }),
  thread('lone', 'Unrelated')
]

describe('SubagentParentBarView', () => {
  it('links back to the parent and says whose subagent this is', () => {
    const html = renderToStaticMarkup(createElement(SubagentParentBarView, { parentName: 'Fix the build', childName: 'API reviewer', onOpenParent: () => undefined }))
    expect(html).toContain('<button')
    expect(html).toContain('title="Open Fix the build"')
    expect(html).toContain('Subagent of Fix the build')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('API reviewer')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})

describe('SubagentParentBar', () => {
  const render = () => renderToStaticMarkup(createElement(SubagentParentBar))

  it('shows nothing for a thread that has its own row', () => {
    setStore({ threads, activeThreadId: 'parent' })
    expect(render()).toBe('')
    setStore({ threads, activeThreadId: null })
    expect(render()).toBe('')
  })

  it('names the parent above an open subagent, and a nested subagent’s direct parent', () => {
    setStore({ threads, activeThreadId: 'child' })
    expect(render()).toContain('Subagent of Fix the build')
    setStore({ threads, activeThreadId: 'grandchild' })
    expect(render()).toContain('Subagent of API reviewer')
  })

  it('gives an orphan no parent to link to', () => {
    setStore({ threads, activeThreadId: 'orphan' })
    expect(render()).toBe('')
  })
})

describe('ThreadsSidebar with subagents', () => {
  const render = () => renderToStaticMarkup(createElement(ThreadsSidebar))
  // The Threads view lists every shown thread as a card; the same threads also sit in the recent list.
  const cardTitles = (html: string) => [...html.matchAll(/threads-sidebar-card-title">([^<]*)</g)].map((match) => match[1])

  it('lists threads people started and leaves subagents under their parent, keeping an orphan', () => {
    setStore({ threads, activeThreadId: 'lone', threadActivity: {} })
    const html = render()
    expect(cardTitles(html).sort()).toEqual(['Fix the build', 'Left behind', 'Unrelated'])
    expect(html).not.toContain('API reviewer')
    expect(html).not.toContain('Deep helper')
  })

  it('shows a running subagent as activity on the parent, however deep', () => {
    setStore({ threads, activeThreadId: 'lone', threadActivity: {} })
    expect(render()).not.toContain('card-status-working')
    const activity: ThreadActivitySnapshot = { grandchild: 'processing' }
    setStore({ threads, activeThreadId: 'lone', threadActivity: activity })
    const running = render()
    expect(running.match(/card-status-working/g)).toHaveLength(1)
    setStore({ threads, activeThreadId: 'lone', threadActivity: { child: 'awaiting_input' } })
    const asking = render()
    expect(asking.match(/card-status-input/g)).toHaveLength(1)
  })

  it('highlights the parent row while a subagent is open, with a background class and no selection dot', () => {
    setStore({ threads, activeThreadId: 'grandchild', threadActivity: {} })
    const html = render()
    const lit = [...html.matchAll(/has-open-subagent[^>]*>(?:(?!<button).)*?(Fix the build|Left behind|Unrelated)/g)].map((match) => match[1])
    expect(lit).toEqual(['Fix the build'])
    expect(html).not.toContain('aria-current="page"')
    expect(html).not.toContain('threads-sidebar-thread-root active')
  })

  it('marks a shown thread active as before', () => {
    setStore({ threads, activeThreadId: 'lone', threadActivity: {} })
    const html = render()
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('has-open-subagent')
  })
})
