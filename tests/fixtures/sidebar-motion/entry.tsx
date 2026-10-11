import { StrictMode, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { SlidingThreadsPane } from '../../../src/renderer/components/SlidingThreadsPane'
import { House, FolderOpen, MessageSquare } from '../../../src/renderer/lib/icons'
import '../../../src/renderer/styles/app.css'
import '../../../src/renderer/styles/threads-sidebar.css'
import '../../../src/renderer/styles/navigation-rail.css'
import '../../../src/renderer/styles/compact-shell.css'

let mounts = 0
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

function Sidebar({ width, kind }: { width: number; kind: string }) {
  useEffect(() => { mounts += 1 }, [])
  return <aside className="threads-sidebar" style={{ width }} data-kind={kind}>
    <div className="threads-sidebar-project-row expanded"><button><FolderOpen size={16} />Project</button></div>
    <button className="threads-sidebar-thread active sidebar-focus">
      <span className="threads-sidebar-selected-dot" /><MessageSquare size={16} />Thread
      <span className="threads-sidebar-status-dot threads-sidebar-status-dot--question" />
    </button>
  </aside>
}

function Fixture() {
  const [dock, setDock] = useState(true)
  const [peek, setPeek] = useState(false)
  const [width, setWidth] = useState(280)
  const [resizing, setResizing] = useState(false)
  const navigationRef = useRef<SVGSVGElement>(null)
  const measure = () => {
    const docked = document.querySelector<HTMLElement>('.sliding-threads-pane:not(.sliding-threads-pane--overlay)')!
    const overlay = document.querySelector<HTMLElement>('.sliding-threads-pane--overlay')!
    const rail = document.querySelector<HTMLElement>('.navigation-rail')!
    const middle = document.querySelector<HTMLElement>('.fixture-middle')!
    const railRect = rail.getBoundingClientRect()
    return {
      width: docked.getBoundingClientRect().width,
      centerLeft: middle.getBoundingClientRect().left,
      railRight: railRect.right,
      railHit: rail.contains(document.elementFromPoint(railRect.right - 2, railRect.top + 90)),
      children: docked.querySelectorAll('.threads-sidebar').length,
      inert: docked.inert,
      overlayInert: overlay.inert,
      overlayVisible: getComputedStyle(overlay).visibility,
      overlayHit: overlay.contains(document.elementFromPoint(railRect.right + 12, railRect.top + 90)),
      contentLeft: docked.querySelector('.sliding-threads-pane-content')!.getBoundingClientRect().left,
      overlayContentLeft: overlay.querySelector('.sliding-threads-pane-content')!.getBoundingClientRect().left,
      clip: getComputedStyle(docked.querySelector('.sliding-threads-pane-clip')!).overflow,
      focus: document.activeElement?.className,
      mounts,
      savedWidth: width,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      navigationIconWidth: navigationRef.current?.getBoundingClientRect().width,
      svgRefReady: navigationRef.current instanceof SVGSVGElement,
      rowIconWidth: docked.querySelector('.threads-sidebar-project-row .mousse-icon')?.getBoundingClientRect().width
    }
  }
  const sample = async (kind: 'dock' | 'peek', value: boolean, duration = 350) => {
    ;(kind === 'dock' ? setDock : setPeek)(value)
    const snapshots: ReturnType<typeof measure>[] = []
    const start = performance.now()
    do { await frame(); snapshots.push(measure()) } while (performance.now() - start < duration)
    return snapshots
  }
  ;(window as any).sidebarFixture = {
    measure, sample,
    focus: () => document.querySelector<HTMLButtonElement>('[data-kind="dock"] .sidebar-focus')!.focus(),
    resize: async (next: number, active: boolean) => { setResizing(active); setWidth(next); await frame(); return (window as any).sidebarFixture.measure() },
    reverse: async () => {
      const close = await sample('dock', false, 70)
      const before = measure()
      const open = await sample('dock', true)
      return { close, before, open }
    }
  }
  return <div className="app" style={{
    '--accent': '#a899ee', '--accent-rgb': '168, 153, 238', '--accent-pale-rgb': '180, 176, 205',
    '--surface-strong': '#151519', '--surface-strong-rgb': '21, 21, 25', '--surface-base-rgb': '12, 12, 15',
    '--text-primary': '#eee', '--text-secondary': '#aaa', '--app-window-bg': '#111'
  } as CSSProperties}>
    <header className="titlebar"><button className="titlebar-sidebar-toggle" style={{ opacity: 1, pointerEvents: 'auto' }}>Toggle sidebar</button></header>
    <div className="app-content">
      <nav className="navigation-rail"><button className="navigation-rail-button active" aria-label="Home"><House size={18} ref={navigationRef} /></button></nav>
      <SlidingThreadsPane open={dock} width={width} resizing={resizing} resizer={<div className="resizer resizer-threads" />}>
        <Sidebar width={width} kind="dock" />
      </SlidingThreadsPane>
      <SlidingThreadsPane open={peek} width={width} overlay><Sidebar width={width} kind="peek" /></SlidingThreadsPane>
      <main className="fixture-middle" style={{ flex: 1, minWidth: 0 }}>Center pane</main>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
