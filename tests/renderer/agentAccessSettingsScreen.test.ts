// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAccessSettings, AGENT_ACCESS_LEVELS, CAPPED_THREADS } from '../../src/renderer/components/settings/AgentAccessSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { getDefaultSettings, normalizeAgentAccessSettings, type AgentAccessSettings as AccessSetting, type MousseSettings } from '../../src/shared/settings'
import type { Project } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (id: string, name: string, order: number): Project => ({ id, name, path: `/work/${id}`, createdAt: '2026-10-01T00:00:00.000Z', order })
const PROJECTS = [project('p1', 'Alpha', 0), project('p2', 'Beta', 1), project('p3', 'Gamma', 2)]

let root: Root
let host: HTMLElement
let home: string
let store: SettingsStore

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-screen-'))
  store = new SettingsStore(MousseConfigStore.load(home))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  rmSync(home, { recursive: true, force: true })
})

/** The screen wired to a real settings store, the way Settings wires it to the daemon. */
function show(initial?: Partial<AccessSetting>, projects: readonly Project[] = PROJECTS) {
  if (initial) store.set({ agentAccess: initial })
  const updates = vi.fn()
  const draw = () => act(() => root.render(createElement(AgentAccessSettings, {
    settings: store.get() as MousseSettings,
    projects,
    updateSettings: async (partial) => {
      updates(partial)
      store.set(partial)
      draw()
    }
  })))
  draw()
  return { updates }
}

/** What the daemon reads when it grants a new turn: the saved setting, reloaded from disk. */
const savedByDaemon = (): AccessSetting => normalizeAgentAccessSettings(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess)

const text = () => host.textContent ?? ''
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Agent access level"]')!
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-access-projects [role="checkbox"]'))
const row = (name: string) => rows().find((entry) => entry.textContent === name)!
const checked = () => rows().filter((entry) => entry.getAttribute('aria-checked') === 'true').map((entry) => entry.textContent)
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const pickLevel = (label: string) => {
  click(trigger())
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((entry) => entry.textContent?.startsWith(label))!
  click(option)
}

describe('Settings > Agents > Agent access', () => {
  it('shows the saved level with its explanation in plain words', () => {
    for (const { value, label, summary } of AGENT_ACCESS_LEVELS) {
      show({ level: value })
      expect(trigger().textContent).toContain(label)
      expect(text()).toContain(summary)
    }
  })

  it('starts at Lineage only for a profile that never touched the setting', () => {
    show()
    expect(trigger().textContent).toContain('Lineage only')
    expect(text()).toContain('cannot see or change any other thread')
    expect(rows()).toHaveLength(0)
  })

  it('changing the level saves the whole setting, and the daemon reads it for new turns', () => {
    // A stored switch below Manage reads as off (it cannot be on while the level is lower), so raising never turns it on.
    const { updates } = show({ level: 'read', projectIds: ['p2'], answerApprovals: true })
    pickLevel('Manage')
    // The project list travels with the level, so a save never drops it.
    expect(updates).toHaveBeenCalledTimes(1)
    expect(updates).toHaveBeenCalledWith({ agentAccess: { level: 'manage', projectIds: ['p2'], answerApprovals: false, remoteSubagents: false, computers: [] } })
    expect(trigger().textContent).toContain('Manage')
    expect(text()).toContain('full events and messages of other threads')
    expect(savedByDaemon()).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: false, remoteSubagents: false, computers: [] })

    pickLevel('Lineage only')
    expect(savedByDaemon().level).toBe('lineage')
    expect(text()).toContain('Lowering this applies to agents that are already running; raising it applies from their next turn.')
  })

  it('choosing the level that is already saved writes nothing', () => {
    const { updates } = show({ level: 'read' })
    pickLevel('Read')
    expect(updates).not.toHaveBeenCalled()
  })

  it('offers the project list only when agents may reach other threads', () => {
    show({ level: 'lineage' })
    expect(rows()).toHaveLength(0)
    expect(text()).not.toContain('All projects')
    pickLevel('Read')
    expect(rows().map((entry) => entry.textContent)).toEqual(['All projects', 'Alpha', 'Beta', 'Gamma'])
  })

  it('picks projects one at a time, and saves each pick', () => {
    const { updates } = show({ level: 'manage' })
    expect(checked()).toEqual(['All projects'])
    expect(text()).toContain('every project, including threads without a project')

    click(row('Beta'))
    expect(updates).toHaveBeenLastCalledWith({ agentAccess: { level: 'manage', projectIds: ['p2'], answerApprovals: false, remoteSubagents: false, computers: [] } })
    expect(checked()).toEqual(['Beta'])
    expect(text()).toContain('only threads in the checked projects')

    click(row('Alpha'))
    expect(checked()).toEqual(['Alpha', 'Beta'])
    expect(savedByDaemon().projectIds).toEqual(['p2', 'p1'])

    click(row('Beta'))
    expect(checked()).toEqual(['Alpha'])
    expect(savedByDaemon().projectIds).toEqual(['p1'])
  })

  it('never turns a limited list into an empty one, which the daemon reads as every project', () => {
    const { updates } = show({ level: 'manage', projectIds: ['p1'] })
    expect(checked()).toEqual(['Alpha'])
    expect(row('Alpha').getAttribute('aria-disabled')).toBe('true')

    click(row('Alpha'))
    expect(updates).not.toHaveBeenCalled()
    expect(checked()).toEqual(['Alpha'])
    expect(savedByDaemon().projectIds).toEqual(['p1'])
    expect(text()).toContain('Keep at least one checked, or choose All projects.')

    // Widening to every project is its own, named choice.
    click(row('All projects'))
    expect(updates).toHaveBeenCalledWith({ agentAccess: { level: 'manage', projectIds: [], answerApprovals: false, remoteSubagents: false, computers: [] } })
    expect(checked()).toEqual(['All projects'])
    // And choosing it again changes nothing.
    updates.mockClear()
    click(row('All projects'))
    expect(updates).not.toHaveBeenCalled()
  })

  it('a stored list that cannot be read fails closed to the narrowest level, not to every project', () => {
    show()
    // Straight into the screen, as a hand-edited or damaged file would reach it.
    const damaged = { ...getDefaultSettings(), agentAccess: { level: 'manage', projectIds: 'p1', answerApprovals: true } } as unknown as MousseSettings
    act(() => root.render(createElement(AgentAccessSettings, { settings: damaged, projects: PROJECTS, updateSettings: async () => undefined })))
    expect(trigger().textContent).toContain('Lineage only')
    expect(rows()).toHaveLength(0)
  })

  it('keeps a listed project that no longer exists visible, and removable while another stays', () => {
    show({ level: 'read', projectIds: ['p1', 'gone'] })
    expect(checked()).toEqual(['Alpha', 'Removed project'])
    click(row('Removed project'))
    expect(savedByDaemon().projectIds).toEqual(['p1'])
    expect(rows().map((entry) => entry.textContent)).not.toContain('Removed project')
  })

  describe('answering approvals on other threads', () => {
    const answerSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Agents may answer approvals on other threads"]')
    const on = () => answerSwitch()!.getAttribute('aria-checked') === 'true'

    it('is offered only at the Manage level, off for a profile that never touched it, with a clear warning', () => {
      for (const level of ['lineage', 'read'] as const) {
        show({ level })
        expect(answerSwitch(), level).toBeNull()
      }
      show({ level: 'manage' })
      expect(answerSwitch()).not.toBeNull()
      expect(on()).toBe(false)
      expect(normalizeAgentAccessSettings(getDefaultSettings().agentAccess).answerApprovals).toBe(false)
      expect(text()).toContain('Use with care.')
      expect(text()).toContain('approve a command, a file change or a tool that another thread asked to run')
      expect(text()).toContain('never its own thread')
      expect(text()).toContain('Off by default')
    })

    it('saves the whole setting when switched, and the daemon reads it back', () => {
      const { updates } = show({ level: 'manage', projectIds: ['p2'] })
      click(answerSwitch()!)
      expect(updates).toHaveBeenCalledTimes(1)
      expect(updates).toHaveBeenCalledWith({ agentAccess: { level: 'manage', projectIds: ['p2'], answerApprovals: true, remoteSubagents: false, computers: [] } })
      expect(on()).toBe(true)
      expect(savedByDaemon()).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: true, remoteSubagents: false, computers: [] })
      click(answerSwitch()!)
      expect(savedByDaemon().answerApprovals).toBe(false)
    })

    it('is switched off when the level is lowered from Manage, so raising it again does not bring the permission back', () => {
      show({ level: 'manage', answerApprovals: true })
      expect(on()).toBe(true)
      pickLevel('Read')
      expect(savedByDaemon()).toEqual({ level: 'read', projectIds: [], answerApprovals: false, remoteSubagents: false, computers: [] })
      pickLevel('Manage')
      expect(on()).toBe(false)
      expect(savedByDaemon().answerApprovals).toBe(false)
    })

    it('a project pick keeps the switch as it is', () => {
      show({ level: 'manage', answerApprovals: true })
      click(row('Beta'))
      expect(savedByDaemon()).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: true, remoteSubagents: false, computers: [] })
    })
  })

  describe('subagents on other devices', () => {
    const remoteSwitch = () => host.querySelector<HTMLElement>('#agent-access-remote-subagents')
    const on = () => remoteSwitch()!.getAttribute('aria-checked') === 'true'

    it('is offered at every level, off for a profile that never touched it', () => {
      for (const level of ['lineage', 'read', 'manage'] as const) {
        show({ level })
        expect(remoteSwitch(), level).not.toBeNull()
        expect(on(), level).toBe(false)
      }
      expect(text()).toContain('Allow agents to create Subagents on other Devices')
      expect(normalizeAgentAccessSettings(getDefaultSettings().agentAccess).remoteSubagents).toBe(false)
    })

    it('saves the whole setting when switched, and says to pair computers when none are connected', () => {
      const { updates } = show({ level: 'read' })
      click(remoteSwitch()!)
      expect(updates).toHaveBeenCalledWith({ agentAccess: { level: 'read', projectIds: [], answerApprovals: false, remoteSubagents: true, computers: [] } })
      expect(savedByDaemon().remoteSubagents).toBe(true)
      expect(text()).toContain('Pair them in Settings → Devices')
    })

    it('hides the computer list while off and keeps it, so switching back on restores the same computers', () => {
      show({ remoteSubagents: false, computers: ['node-gone'] })
      expect(rows().some((entry) => entry.textContent === 'Removed computer')).toBe(false)
      click(remoteSwitch()!)
      expect(row('Removed computer').getAttribute('aria-checked')).toBe('true')
      click(remoteSwitch()!)
      expect(savedByDaemon()).toMatchObject({ remoteSubagents: false, computers: ['node-gone'] })
    })
  })

  it('shows the threads whose level stays capped, at every level', () => {
    for (const level of ['lineage', 'read', 'manage'] as const) {
      show({ level })
      const caps = Array.from(host.querySelectorAll('.agent-access-cap')).map((entry) => entry.textContent)
      expect(caps).toHaveLength(CAPPED_THREADS.length)
      expect(caps.join('|')).toContain('Threads driven by a remote send')
      expect(caps.join('|')).toContain('Bot threads')
      expect(caps.filter((entry) => entry?.endsWith('Lineage only'))).toHaveLength(2)
      expect(caps.join('|')).toContain('Read at most')
    }
  })

  describe('keyboard', () => {
    it('opens the level list, moves through it and commits with the keyboard alone', () => {
      show({ level: 'lineage' })
      act(() => trigger().focus())
      key(trigger(), 'Enter')
      expect(trigger().getAttribute('aria-expanded')).toBe('true')
      key(trigger(), 'ArrowDown')
      key(trigger(), 'ArrowDown')
      key(trigger(), 'Enter')
      expect(trigger().getAttribute('aria-expanded')).toBe('false')
      expect(savedByDaemon().level).toBe('manage')
      expect(document.activeElement).toBe(trigger())
    })

    it('Escape closes the level list without a change', () => {
      const { updates } = show({ level: 'read' })
      key(trigger(), 'Enter')
      key(trigger(), 'ArrowDown')
      key(trigger(), 'Escape')
      expect(trigger().getAttribute('aria-expanded')).toBe('false')
      expect(updates).not.toHaveBeenCalled()
    })

    it('project rows are buttons in the tab order, and the arrow keys, Home and End move between them', () => {
      show({ level: 'read' })
      for (const entry of rows()) {
        expect(entry.tagName).toBe('BUTTON')
        expect(entry.tabIndex).toBe(0)
      }
      act(() => row('All projects').focus())
      key(document.activeElement!, 'ArrowDown')
      expect(document.activeElement).toBe(row('Alpha'))
      key(document.activeElement!, 'ArrowDown')
      expect(document.activeElement).toBe(row('Beta'))
      key(document.activeElement!, 'End')
      expect(document.activeElement).toBe(row('Gamma'))
      key(document.activeElement!, 'ArrowDown')
      expect(document.activeElement).toBe(row('Gamma'))
      key(document.activeElement!, 'ArrowUp')
      expect(document.activeElement).toBe(row('Beta'))
      key(document.activeElement!, 'Home')
      expect(document.activeElement).toBe(row('All projects'))
      key(document.activeElement!, 'ArrowUp')
      expect(document.activeElement).toBe(row('All projects'))
    })

    it('a focused project row is picked by activating it', () => {
      show({ level: 'read' })
      act(() => row('Beta').focus())
      // A button's Enter and Space press is a click.
      click(document.activeElement!)
      expect(savedByDaemon().projectIds).toEqual(['p2'])
      expect(document.activeElement).toBe(row('Beta'))
    })
  })

  it('marks a selected row with a background fill only, never an edge bar', () => {
    const css = readFileSync(join(__dirname, '../../src/renderer/styles/settings.css'), 'utf8')
    const rules = [...css.matchAll(/(\.agent-access-row[^{,]*)\{([^}]*)\}/g)].filter((match) => match[1].includes('.on') || match[1].includes('[aria-'))
    const on = rules.find((match) => match[1].trim() === '.agent-access-row.on')
    expect(on?.[2]).toMatch(/background:/)
    for (const [, , body] of rules) expect(body).not.toMatch(/border|box-shadow|outline/)
  })
})
