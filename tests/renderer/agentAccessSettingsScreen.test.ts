// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAccessSettings } from '../../src/renderer/components/settings/AgentAccessSettings'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { NO_COMPUTERS, useComputersStore } from '../../src/renderer/lib/computers'
import { getDefaultSettings, normalizeAgentAccessSettings, type AgentAccessSettings as AccessSetting, type MousseSettings } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  useComputersStore.setState(NO_COMPUTERS)
  host.remove()
  rmSync(home, { recursive: true, force: true })
})

/** The screen wired to a real settings store, the way Settings wires it to the daemon. */
function show(initial?: Partial<AccessSetting>) {
  if (initial) store.set({ agentAccess: initial })
  const updates = vi.fn()
  const draw = () => act(() => root.render(createElement(AgentAccessSettings, {
    settings: store.get() as MousseSettings,
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
/** The computer switches, each named by its row. */
const rows = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="switch"][id^="agent-access-computer-"]'))
const row = (name: string) => rows().find((entry) => entry.getAttribute('aria-label') === name)!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
describe('Settings > Agents > Access', () => {
  it('has no access level or project list: agents read and manage every thread', () => {
    show()
    expect(host.querySelector('[aria-label="Agent access level"]')).toBeNull()
    expect(text()).not.toContain('All projects')
    expect(text()).not.toContain('Lineage only')
  })

  it('an older profile that stored a level and projects reads as the switches alone', () => {
    show({ level: 'read', projectIds: ['p2'], answerApprovals: true } as Partial<AccessSetting>)
    expect(savedByDaemon()).toEqual({ answerApprovals: true, remoteSubagents: false, computerUse: true, computers: [] })
  })

  describe('answering approvals on other threads', () => {
    const answerSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Answer approvals on other threads"]')
    const on = () => answerSwitch()!.getAttribute('aria-checked') === 'true'

    it('is off for a profile that never touched it, with a clear warning', () => {
      show()
      expect(answerSwitch()).not.toBeNull()
      expect(on()).toBe(false)
      expect(normalizeAgentAccessSettings(getDefaultSettings().agentAccess).answerApprovals).toBe(false)
      expect(text()).toContain('Use with care.')
      expect(text()).toContain('within their own permission mode')
      expect(text()).toContain('approve a command, a file change or a tool that another thread asked to run')
      expect(text()).toContain('never its own thread')
      expect(text()).toContain('Off by default')
    })

    it('saves the whole setting when switched, and the daemon reads it back', () => {
      const { updates } = show({ computers: ['node-a'] })
      click(answerSwitch()!)
      expect(updates).toHaveBeenCalledTimes(1)
      expect(updates).toHaveBeenCalledWith({ agentAccess: { answerApprovals: true, remoteSubagents: false, computerUse: true, computers: ['node-a'] } })
      expect(on()).toBe(true)
      expect(savedByDaemon()).toEqual({ answerApprovals: true, remoteSubagents: false, computerUse: true, computers: ['node-a'] })
      click(answerSwitch()!)
      expect(savedByDaemon().answerApprovals).toBe(false)
    })
  })

  describe('let agents work on your other devices', () => {
    const remoteSwitch = () => host.querySelector<HTMLElement>('#agent-access-remote-subagents')
    const on = () => remoteSwitch()!.getAttribute('aria-checked') === 'true'

    it('is off for a profile that never touched it, in its own Subagents group after Access', () => {
      show()
      expect(remoteSwitch()).not.toBeNull()
      expect(on()).toBe(false)
      expect(remoteSwitch()!.getAttribute('aria-label')).toBe('Let agents work on your other devices')
      expect(host.querySelector('label[for="agent-access-remote-subagents"]')?.textContent).toBe('Let agents work on your other devices')
      expect(remoteSwitch()!.closest('section.settings-group')?.querySelector('h3')?.textContent?.trim()).toBe('Subagents')
      expect(host.querySelector('#agent-access-answer-approvals')!.closest('section.settings-group')?.querySelector('h3')?.textContent?.trim()).toBe('Access')
      expect(normalizeAgentAccessSettings(getDefaultSettings().agentAccess).remoteSubagents).toBe(false)
    })

    it('saves the whole setting when switched, under the key it always had, and says to pair computers when none are connected', () => {
      const { updates } = show({ answerApprovals: true })
      click(remoteSwitch()!)
      expect(updates).toHaveBeenCalledWith({ agentAccess: { answerApprovals: true, remoteSubagents: true, computerUse: true, computers: [] } })
      expect(savedByDaemon().remoteSubagents).toBe(true)
      expect(text()).toContain('Pair them in Settings → Devices')
    })

    /** The user's devices as the daemon lists them: this computer and the named others. */
    const devices = (...others: string[]) => useComputersStore.setState({
      loaded: true,
      routed: true,
      byNode: Object.fromEntries(others.map((node) => [node, { node, name: node, online: true }])),
      devices: [{ node: 'node-self', self: true } as never, ...others.map((node) => ({ node, self: false }) as never)]
    })

    it('hides the computer list while off and keeps it, so switching back on restores the same computers', () => {
      devices('node-a')
      show({ remoteSubagents: false, computers: ['node-a'] })
      expect(rows()).toEqual([])
      click(remoteSwitch()!)
      expect(row('node-a').getAttribute('aria-checked')).toBe('true')
      click(remoteSwitch()!)
      expect(savedByDaemon()).toMatchObject({ remoteSubagents: false, computers: ['node-a'] })
    })

    it('drops a computer removed from the devices on its own, with no row for it', () => {
      devices('node-a')
      show({ remoteSubagents: true, computers: ['node-a', 'node-gone'] })
      expect(rows().map((entry) => entry.getAttribute('aria-label'))).toEqual(['node-a'])
      expect(savedByDaemon().computers).toEqual(['node-a'])
    })

    it('keeps allowed computers while the device list is not known yet, and shows none as removed', () => {
      show({ remoteSubagents: true, computers: ['node-a'] })
      expect(rows()).toEqual([])
      expect(savedByDaemon().computers).toEqual(['node-a'])
    })
  })

  it('keeps each rule in one line, with the exact terms one keyboard step away', () => {
    show()
    const approvals = host.querySelector('#agent-access-answer-approvals')!.closest('.settings-item')!
    const toggle = approvals.querySelector<HTMLButtonElement>('.settings-more-btn')!
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body.hidden).toBe(true)
    expect(body.textContent).toContain('Requests the provider asks for itself')
    act(() => toggle.focus())
    click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body.hidden).toBe(false)
    // The words always shown stay short: no paragraph of rules.
    const shown = (element: Element) => [...element.childNodes].map((node) => (node instanceof HTMLElement && node.hidden ? '' : node.textContent ?? '')).join('')
    for (const desc of host.querySelectorAll('.settings-item-desc')) {
      act(() => { for (const entry of desc.querySelectorAll<HTMLElement>('.settings-more-body')) entry.hidden = true })
      expect(shown(desc).split(/[.!?](?:\s|$)/).filter((part) => part.trim().length > 1).length, shown(desc)).toBeLessThanOrEqual(3)
    }
  })
})
