// @vitest-environment jsdom
/**
 * A provider signed in with an email shows it beside the status badge, scrambled and blurred until
 * clicked. While hidden, the real address is nowhere on the page (text, tooltip or label); a click
 * shows it, another hides it again.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEditor } from '../../src/renderer/components/providers/ProviderEditor'
import type { InstanceActions } from '../../src/renderer/components/providers/CliSections'
import { describeStatus } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'

const EMAIL = 'jane.doe@example.com'

describe('Signed-in email in the provider status', () => {
  let host: HTMLDivElement
  let root: Root

  const mount = (label: string) => {
    const entry = snapshot({ auth: { state: 'signed_in', account: { id: 'acct-1', label } } })
    const actions = {
      enable: vi.fn(), install: vi.fn(), cancelInstall: vi.fn(), update: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), recheck: vi.fn(),
      allowKnownProblem: vi.fn(), configure: vi.fn(), removeInstall: vi.fn()
    } as unknown as InstanceActions
    act(() => root.render(createElement(AgentEditor, { snapshot: entry, status: describeStatus(entry), actions, onSaveModelPrefs: async () => {}, onRefreshModels: async () => {} })))
  }
  const chip = () => host.querySelector<HTMLButtonElement>('.hidden-email')
  const exposed = () => host.innerHTML.includes(EMAIL)

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'linux' }
    // Motion off, so a click settles at once.
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows the email scrambled, same shape, and nowhere in plain text', () => {
    mount(EMAIL)
    const text = chip()!.textContent!
    expect(text).toHaveLength(EMAIL.length)
    expect(text.indexOf('@')).toBe(EMAIL.indexOf('@'))
    expect([...text].map((c, i) => (c === '.') === (EMAIL[i] === '.')).every(Boolean)).toBe(true)
    expect(text).not.toBe(EMAIL)
    expect(exposed()).toBe(false)
    expect(chip()!.getAttribute('aria-label')).toBe('Show email')
  })

  it('reveals the email on a click and hides it on the next', () => {
    mount(EMAIL)
    act(() => chip()!.click())
    expect(chip()!.textContent).toBe(EMAIL)
    expect(chip()!.getAttribute('aria-pressed')).toBe('true')
    act(() => chip()!.click())
    expect(chip()!.textContent).toHaveLength(EMAIL.length)
    expect(exposed()).toBe(false)
  })

  it('keeps an account name that is not an email in the tooltip, without the hidden chip', () => {
    mount('Max plan')
    expect(chip()).toBeNull()
    expect(host.querySelector('.prov-status-text')!.getAttribute('title')).toContain('Max plan')
  })
})
