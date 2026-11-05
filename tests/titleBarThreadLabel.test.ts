import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { titlebarThreadLabel } from '../src/renderer/components/TitleBar'
import type { Project, Thread } from '../src/shared/types'

const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

const thread = { id: 't1', name: 'Fix login', projectId: 'p1' } as Thread
const loose = { id: 't2', name: 'Scratch notes' } as Thread
const project = { id: 'p1', name: 'acme-web' } as Project
const base = {
  threadsSidebarOpen: false,
  sidebarMode: 'projects' as const,
  usageOpen: false,
  activeThreadId: 't1',
  threads: [thread, loose],
  projects: [project]
}

describe('title bar thread label', () => {
  it('names the open thread and its project while the sidebar is closed', () => {
    expect(titlebarThreadLabel(base)).toBe('Fix login · acme-web')
    expect(titlebarThreadLabel({ ...base, activeThreadId: 't2' })).toBe('Scratch notes')
  })

  it('shows nothing with the sidebar open, no thread open, or another view in place', () => {
    expect(titlebarThreadLabel({ ...base, threadsSidebarOpen: true })).toBeNull()
    expect(titlebarThreadLabel({ ...base, activeThreadId: null })).toBeNull()
    expect(titlebarThreadLabel({ ...base, activeThreadId: 'gone' })).toBeNull()
    expect(titlebarThreadLabel({ ...base, sidebarMode: 'chats' })).toBeNull()
    expect(titlebarThreadLabel({ ...base, usageOpen: true })).toBeNull()
  })

  it('is muted, one ellipsized line, and leaves dragging to the title bar', () => {
    const rule = appStyles.match(/\.titlebar-thread-label\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/font-size:\s*12\.5px/)
    expect(rule).toMatch(/color:\s*var\(--text-secondary\)/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/pointer-events:\s*none/)
    expect(rule).not.toMatch(/app-region:\s*no-drag/)
  })
})
