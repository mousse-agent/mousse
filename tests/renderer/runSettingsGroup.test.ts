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
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Resume after usage limits reset"]')!
const capTrigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Automatic resumes in a row"]')!
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const pickCap = (label: string) => {
  click(capTrigger())
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((entry) => entry.textContent === label)!
  click(option)
}

describe('Settings > General > Runs', () => {
  it('is off by default, with the cap of three', () => {
    show()
    expect(host.textContent).toContain('Runs')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(capTrigger().textContent).toContain('3')
    expect(host.textContent).toContain('at most 3 times in a row')
    expect(host.textContent).toContain('Runs already paused are not resumed; press Resume now.')
  })

  it('turning it on saves it, and the daemon reads it from disk', () => {
    const { updates } = show()
    click(toggle())
    // The whole setting travels, so the cap is never dropped.
    expect(updates).toHaveBeenCalledWith({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 3 } })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 3 })
    click(toggle())
    expect(saved().resumeAfterUsageLimit).toBe(false)
  })

  it('the cap can only be changed while the setting is on', () => {
    show()
    expect(capTrigger().disabled).toBe(true)
    click(toggle())
    expect(capTrigger().disabled).toBe(false)
  })

  it('choosing a cap saves it and the description follows', () => {
    const { updates } = show({ resumeAfterUsageLimit: true })
    pickCap('5')
    expect(updates).toHaveBeenCalledWith({ runs: { resumeAfterUsageLimit: true, usageLimitPauseCap: 5 } })
    expect(saved()).toEqual({ resumeAfterUsageLimit: true, usageLimitPauseCap: 5 })
    expect(host.textContent).toContain('at most 5 times in a row')
    pickCap('1')
    expect(saved().usageLimitPauseCap).toBe(1)
    expect(host.textContent).toContain('at most 1 time in a row')
  })

  it('choosing the cap that is already saved writes nothing', () => {
    const { updates } = show({ resumeAfterUsageLimit: true })
    pickCap('3')
    expect(updates).not.toHaveBeenCalled()
  })

  it('offers 1, 3 and 5, and keeps a cap saved by hand in the list', () => {
    expect(capChoices(3)).toEqual([1, 3, 5])
    expect(capChoices(2)).toEqual([1, 2, 3, 5])
    expect(capChoices(10)).toEqual([1, 3, 5, 10])
  })
})
