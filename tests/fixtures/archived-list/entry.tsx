// The real sidebar in a real window, with 600 archived threads: Archived is opened, scrolled, focused and its last
// row's menu opened, and what is drawn is read back (archived-list-electron.test.ts).
import { createRoot } from 'react-dom/client'
import { ThreadsSidebar } from '../../../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import type { Thread } from '../../../src/shared/types'
import '../../../src/renderer/styles/app.css'

const ARCHIVED = 600
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

// Every bridge call answers nothing; event subscriptions return their unsubscribe.
const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
const group = () => new Proxy({}, { get: (_target, key: string) => call(key) })
;(window as unknown as { mousse: unknown }).mousse = new Proxy({}, { get: () => group() })

const at = '2026-11-05T10:00:00.000Z'
const thread = (id: string, name: string, over: Partial<Thread> = {}): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, order: 0, startedAt: at, projectId: 'p1', ...over })
// Newest first, so old-0 lists first and old-599 last. Every seventh title is long enough to wrap, so cards are not
// all one height.
const archived = Array.from({ length: ARCHIVED }, (_, index) => {
  const started = new Date(Date.parse(at) - index * 60_000).toISOString()
  const name = index % 7 === 3 ? `Archived thread ${index} with a title long enough to wrap onto a second line of the card` : `Archived ${index}`
  return thread(`old-${index}`, name, { createdAt: started, startedAt: started, settledAt: at })
})
useAppStore.setState({
  projects: [{ id: 'p1', name: 'Mousse', path: '/p/mousse', createdAt: at, order: 0 }],
  threads: [thread('live', 'Live thread'), ...archived],
  threadActivity: {},
  activeThreadId: null,
  threadsSidebarView: 'projects',
  sidebarMode: 'projects',
})
const host = document.getElementById('root')!
host.style.cssText = 'display:flex;height:640px;width:300px'
createRoot(host).render(<ThreadsSidebar />)

const frames = (count: number) => new Promise<void>((done) => {
  const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : done())
  step(count)
})
const footer = () => document.querySelector<HTMLElement>('.threads-sidebar-footer')!
const drawn = () => [...document.querySelectorAll<HTMLElement>('.threads-sidebar-settled-list button[data-thread-id]')]
const idOf = (row: HTMLElement) => row.dataset.threadId!

/** What the footer shows: every point down its middle that is not the heading lands on a card or a gap between two. */
function view() {
  const box = footer().getBoundingClientRect()
  const heading = document.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading')!.getBoundingClientRect()
  const blank: number[] = []
  for (let y = Math.max(box.top, heading.bottom) + 1; y < box.bottom - 1; y += 6) {
    const hit = document.elementFromPoint(box.left + box.width / 2, y)
    if (!hit || hit.closest('.threads-sidebar-settled-spacer') || !hit.closest('.threads-sidebar-settled-list')) blank.push(Math.round(y - box.top))
  }
  const shown = drawn().filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > box.top && rect.top < box.bottom
  })
  return {
    drawn: drawn().length,
    blank,
    first: shown[0] ? { id: idOf(shown[0]), top: Math.round(shown[0].getBoundingClientRect().top - box.top) } : null,
    last: shown.length ? idOf(shown[shown.length - 1]) : null,
    scrollTop: footer().scrollTop,
    room: footer().scrollHeight - footer().clientHeight,
  }
}

Object.assign(window, { qa: {
  ready: () => Boolean(document.querySelector('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')),
  async open() {
    document.querySelector<HTMLElement>('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')!.click()
    await frames(4)
    return { count: document.querySelector('.threads-sidebar-settled-count')?.textContent, ...view() }
  },
  // Scrolled to the end; again once the cards drawn there are measured, as a person keeps scrolling.
  async end() {
    for (let pass = 0; pass < 3; pass++) {
      footer().scrollTop = footer().scrollHeight
      await frames(4)
    }
    return view()
  },
  // Halfway down, then a moment later: the row at the top stays where it is while heights are measured.
  async middle() {
    footer().scrollTop = footer().scrollHeight / 2
    await frames(4)
    const before = view()
    await frames(20)
    return { before, after: view() }
  },
  // A row with keyboard focus, scrolled far away: it keeps focus.
  async focusAway() {
    const row = drawn().find((item) => item.getBoundingClientRect().top > footer().getBoundingClientRect().top)!
    row.focus()
    footer().scrollTop = 0
    await frames(4)
    return { id: idOf(row), focused: document.activeElement === row && row.isConnected, ...view() }
  },
  async lastRowMenu() {
    footer().scrollTop = footer().scrollHeight
    await frames(4)
    footer().scrollTop = footer().scrollHeight
    await frames(4)
    const last = drawn().find((row) => idOf(row) === `old-${ARCHIVED - 1}`)
    if (!last) return { found: false, items: [] }
    const rect = last.getBoundingClientRect()
    last.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    await frames(4)
    return { found: true, items: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent) }
  },
  errors: () => errors,
} })
