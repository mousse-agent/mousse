/**
 * A project is one color wherever the sidebar shows it: its folder icon in Projects, and the mark and tint of its
 * threads' cards in Threads and Archived. The color comes from the project, never from its place in the list, and
 * an archived thread whose project was removed has none.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { projectHueColor, projectHues } from '../../src/renderer/lib/projectHues'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Project, Thread } from '../../src/shared/types'

vi.mock('../../src/renderer/lib/floatingLayer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/lib/floatingLayer')>()),
  FloatingPortal: ({ children }: { children: unknown }) => children
}))
// Server rendering keeps Archived closed; render every group open so its cards are in the markup.
vi.mock('../../src/renderer/components/ui/Collapse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/components/ui/Collapse')>()),
  Collapse: ({ children }: { children: ReactNode }) => createElement('div', null, children)
}))

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`
const now = at(25)
const project = (id: string, name: string, createdAt: string, order: number): Project => ({ id, name, path: `/p/${name}`, createdAt, order })
const thread = (id: string, projectId: string | undefined, over: Partial<Thread> = {}): Thread => ({
  id, name: id, createdAt: now, updatedAt: now, order: 0, startedAt: now, ...(projectId ? { projectId } : {}), ...over
})

type AppPatch = Partial<ReturnType<typeof useAppStore.getState>>
const appInitial = useAppStore.getInitialState()
const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, appInitial[key]])) as AppPatch
function setApp(app: AppPatch) {
  useAppStore.setState(app)
  Object.assign(appInitial, app)
}
afterEach(() => {
  useAppStore.setState(appOriginal)
  Object.assign(appInitial, appOriginal)
})

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const folderHue = (html: string, projectId: string) =>
  html.match(new RegExp(`<div class="threads-sidebar-project" data-project-id="${escape(projectId)}" style="--project-hue:([^;"]+)`))?.[1]
// The thread's card (Threads or Archived), not its row in the Projects tree.
const card = (threadId: string) => `<button[^>]*class="[^"]*threads-sidebar-card[ "][^>]*data-thread-id="${escape(threadId)}"[^>]*>`
const cardButton = (html: string, threadId: string) => html.match(new RegExp(card(threadId)))?.[0] ?? ''
const cardTint = (html: string, threadId: string) => cardButton(html, threadId).match(/--project-tint:([^;"]+)/)?.[1]
const cardMark = (html: string, threadId: string) =>
  html.match(new RegExp(`${card(threadId)}\\s*<span class="threads-sidebar-card-mark[^"]*"(?: style="color:([^;"]+))?`))

describe('a project’s color', () => {
  // Listed in an order of their own (dragged), unlike the order they were added in.
  const projects = [
    project('poppins', 'Poppins', at(3), 0),
    project('smiletrack', 'smiletrack', at(1), 1),
    project('mousse', 'mousse', at(2), 2)
  ]
  const threads = [
    thread('live-mousse', 'mousse'),
    thread('old-mousse', 'mousse', { settledAt: now }),
    thread('old-smiletrack', 'smiletrack', { settledAt: now }),
    thread('old-removed', 'removed-project', { settledAt: now })
  ]

  it('is the same in Projects, Threads and Archived, from the project and not its place in the list', () => {
    setApp({ projects, threads, threadsSidebarView: 'threads' })
    const html = renderToStaticMarkup(createElement(ThreadsSidebar))
    const hues = projectHues(projects.map((entry) => ({ id: entry.id, createdAt: entry.createdAt })))
    for (const id of ['mousse', 'smiletrack', 'poppins']) expect(folderHue(html, id)).toBe(projectHueColor(hues.get(id)))

    const mousse = folderHue(html, 'mousse')
    expect(mousse).toMatch(/^var\(--hue-[1-6]\)$/)
    expect(cardTint(html, 'live-mousse')).toBe(mousse)
    expect(cardMark(html, 'live-mousse')?.[1]).toBe(mousse)
    expect(cardTint(html, 'old-mousse')).toBe(mousse)
    expect(cardMark(html, 'old-mousse')?.[1]).toBe(mousse)
    expect(cardTint(html, 'old-smiletrack')).toBe(folderHue(html, 'smiletrack'))
    expect(cardTint(html, 'old-smiletrack')).not.toBe(mousse)

    // Reordering the list leaves every color as it was.
    setApp({ projects: projects.map((entry) => ({ ...entry, order: -entry.order })), threads, threadsSidebarView: 'threads' })
    const reordered = renderToStaticMarkup(createElement(ThreadsSidebar))
    for (const id of ['mousse', 'smiletrack', 'poppins']) expect(folderHue(reordered, id)).toBe(folderHue(html, id))
  })

  it('is none on an archived thread whose project was removed', () => {
    setApp({ projects, threads, threadsSidebarView: 'threads' })
    const html = renderToStaticMarkup(createElement(ThreadsSidebar))
    expect(cardButton(html, 'old-removed')).not.toBe('')
    expect(cardTint(html, 'old-removed')).toBeUndefined()
    expect(cardMark(html, 'old-removed')?.[0]).toContain('threads-sidebar-card-mark-empty')
  })
})
