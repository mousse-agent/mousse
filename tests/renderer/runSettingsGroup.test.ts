// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunSettingsGroup, capChoices } from '../../src/renderer/components/settings/RunSettingsGroup'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { MousseSettings } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let home: string
let store: SettingsStore

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  home = mkdtempSync(join(tmpdir(), 'mousse-run-settings-screen-'))
  store = new SettingsStore(MousseConfigStore.load(home))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  rmSync(home, { recursive: true, force: true })
})

/** The group wired to a real settings store, the way Settings wires it to the daemon. */
function show(initial?: Partial<MousseSettings['runs']>) {
  if (initial) store.set({ runs: { ...store.get().runs, ...initial } })
  const updates = vi.fn()
  const draw = () => act(() => root.render(createElement(RunSettingsGroup, {
    runs: store.get().runs,
    onUpdate: async (partial) => {
      updates(partial)
      store.set(partial)
      draw()
    }
  })))
  draw()
  return { updates }
}

const saved = () => new SettingsStore(MousseConfigStore.load(home)).get().runs
const worktreeToggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Start new chats in a worktree"]')!
const resume = () => host.querySelector<HTMLButtonElement>('[aria-label="Resume after usage limits reset"]')!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const optionLabels = () => {
  click(resume())
  const labels = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((entry) => entry.textContent)
  click(resume())
  return labels
}
const pick = (label: string) => {
  click(resume())
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((entry) => entry.textContent === label)!
  click(option)
}

/** The row's details live in its tooltip, not on the page. */
const tooltips = () => Array.from(host.querySelectorAll('[title]')).map((entry) => entry.getAttribute('title')).join(' ')

describe('Settings > General > Runs', () => {
  it('is off by default, as one select with no second row for the count', () => {
    show()
    expect(host.textContent).toContain('Runs')
    expect(resume().textContent).toContain('Off')
    expect(host.querySelector('[role="switch"][aria-label="Resume after usage limits reset"]')).toBeNull()
    expect(host.textContent).not.toContain('Automatic resumes in a row')
    expect(host.textContent).toContain('Continues a paused run when the limit resets.')
    expect(tooltips()).toContain('waits until you press Resume now')
    expect(optionLabels()).toEqual(['Off', 'Once', 'Up to 3 times', 'Up to 5 times'])
  })

  it('choosing a count turns it on, and the daemon reads it from disk', () => {
    const { updates } = show()
    pick('Up to 3 times')
    // The whole setting travels, so nothing else is dropped.
    expect(updates).toHaveBeenCalledWith({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 3, worktreeByDefault: true } })
    expect(resume().textContent).toContain('Up to 3 times')
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 3, worktreeByDefault: true })
    expect(tooltips()).toContain('at most 3 times in a row')
    expect(tooltips()).toContain('Runs already paused are not resumed; press Try now.')
  })

  it('Off keeps the saved count, so turning it back on offers the same one', () => {
    show({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })
    pick('Off')
    expect(saved()).toEqual({ resumeAfterUsageLimit: false, usageLimitPauseCap: 5, worktreeByDefault: true })
    expect(resume().textContent).toContain('Off')
    pick('Up to 5 times')
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5, worktreeByDefault: true })
  })

  it('starts new chats in a worktree by default, and turning it off saves it without touching the rest', () => {
    const { updates } = show()
    expect(worktreeToggle().getAttribute('aria-checked')).toBe('true')
    click(worktreeToggle())
    expect(updates).toHaveBeenCalledWith({ runs: { resumeAfterUsageLimit: false, usageLimitPauseCap: 3, worktreeByDefault: false } })
    expect(worktreeToggle().getAttribute('aria-checked')).toBe('false')
    expect(saved()).toEqual({ resumeAfterUsageLimit: false, usageLimitPauseCap: 3, worktreeByDefault: false })
  })

  it('choosing another count saves it and the description follows', () => {
    const { updates } = show({ resumeAfterUsageLimit: true })
    pick('Up to 5 times')
    expect(updates).toHaveBeenCalledWith({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 5, worktreeByDefault: true } })
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5, worktreeByDefault: true })
    expect(tooltips()).toContain('at most 5 times in a row')
    pick('Once')
    expect(saved().usageLimitPauseCap).toBe(1)
    expect(tooltips()).toContain('at most 1 time in a row')
  })

  it('choosing what is already saved writes nothing', () => {
    const { updates } = show({ resumeAfterUsageLimit: true })
    pick('Up to 3 times')
    expect(updates).not.toHaveBeenCalled()
  })

  it('keeps a count saved by hand, even while off', () => {
    show({ resumeAfterUsageLimit: false, usageLimitPauseCap: 2 })
    expect(optionLabels()).toEqual(['Off', 'Once', 'Up to 2 times', 'Up to 3 times', 'Up to 5 times'])
    pick('Up to 2 times')
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 2, worktreeByDefault: true })
  })

  it('offers 1, 3 and 5, and keeps a cap saved by hand in the list', () => {
    expect(capChoices(3)).toEqual([1, 3, 5])
    expect(capChoices(2)).toEqual([1, 2, 3, 5])
    expect(capChoices(10)).toEqual([1, 3, 5, 10])
  })
})
