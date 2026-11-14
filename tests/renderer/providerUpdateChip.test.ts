// @vitest-environment jsdom
/**
 * An available update is a chip beside the version in the provider editor's heading. A runnable
 * update starts on a click; pointing at the chip or focusing it opens a card with the target version
 * and the command to copy. An update Mousse can't run only opens the card.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentEditor } from '../../src/renderer/components/providers/ProviderEditor'
import type { InstanceActions } from '../../src/renderer/components/providers/CliSections'
import { describeStatus, type UpdateAffordance } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'

describe('Update chip in the provider heading', () => {
  let host: HTMLDivElement
  let root: Root
  let update: ReturnType<typeof vi.fn>

  const mount = (affordance: UpdateAffordance) => {
    const entry = snapshot({ update: affordance })
    const actions = {
      enable: vi.fn(), install: vi.fn(), cancelInstall: vi.fn(), update, signIn: vi.fn(), signOut: vi.fn(), recheck: vi.fn(),
      allowKnownProblem: vi.fn(), configure: vi.fn(), removeInstall: vi.fn()
    } as unknown as InstanceActions
    act(() => root.render(createElement(AgentEditor, { snapshot: entry, status: describeStatus(entry), actions, onSaveModelPrefs: async () => {}, onRefreshModels: async () => {} })))
  }
  const chip = () => host.querySelector<HTMLButtonElement>('.prov-update-chip')!
  const card = () => document.querySelector<HTMLElement>('.prov-update-card')

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    ;(window as unknown as { mousse: unknown }).mousse = { platform: 'linux' }
    update = vi.fn(async () => {})
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('sits in the heading before Setup, and the status does not say the update again', () => {
    mount({ kind: 'advisory', command: 'npm i -g @anthropic-ai/claude-code', latestVersion: '2.2.0' })
    const heading = host.querySelector('.prov-editor-section')!
    expect(heading.contains(chip())).toBe(true)
    expect(chip().textContent).toBe('Update now')
    expect(host.textContent).not.toContain('Update available: 2.2.0')
  })

  it('opens a card with the version and the command to copy when pointed at, and closes after the pointer leaves', async () => {
    mount({ kind: 'advisory', command: 'npm i -g @anthropic-ai/claude-code', latestVersion: '2.2.0' })
    expect(card()).toBeNull()
    const wrap = chip().parentElement!
    act(() => { wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(card()!.textContent).toContain('Update to v2.2.0')
    expect(card()!.textContent).toContain('npm i -g @anthropic-ai/claude-code')
    expect(card()!.querySelector('[aria-label="Copy update command"]')).not.toBeNull()
    act(() => { wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    await act(async () => { await new Promise((done) => setTimeout(done, 200)) })
    expect(card()).toBeNull()
  })

  it('runs the update on a click', () => {
    mount({ kind: 'one_click', owner: 'npm', latestVersion: '2.2.0' })
    act(() => chip().click())
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('only opens the card when Mousse cannot run the update', () => {
    for (const affordance of [
      { kind: 'notice', latestVersion: '2.2.0' },
      { kind: 'advisory', command: 'sudo npm i -g @anthropic-ai/claude-code', latestVersion: '2.2.0', manual: true }
    ] satisfies UpdateAffordance[]) {
      mount(affordance)
      expect(chip().textContent).toBe('Update available')
      act(() => chip().click())
      expect(update).not.toHaveBeenCalled()
      expect(card()!.textContent).toContain('Update to v2.2.0')
      act(() => chip().click())
    }
  })

  it('shows no chip without an update', () => {
    const entry = snapshot()
    act(() => root.render(createElement(AgentEditor, { snapshot: entry, status: describeStatus(entry), actions: {} as InstanceActions, onSaveModelPrefs: async () => {}, onRefreshModels: async () => {} })))
    expect(host.querySelector('.prov-update-chip')).toBeNull()
  })
})
