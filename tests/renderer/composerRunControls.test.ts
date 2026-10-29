// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerFooter, type ComposerFooterProps } from '../../src/renderer/components/ComposerFooter'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { LlmModelOption } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const opus: LlmModelOption = { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], defaultEffort: 'medium', thinkingOff: false }
const plain: LlmModelOption = { id: 'plain', label: 'Plain 1' }

function provider(models: LlmModelOption[], autoPermissionMode = true, label = 'Claude Code'): ProviderWithStatus {
  return { id: 'claude-subscription', label, models, caps: { toolControl: 'exact', autoPermissionMode, contextUsage: 'none' } as ProviderWithStatus['caps'] }
}

function render(options: { models?: LlmModelOption[]; modelId?: string; mode?: PermissionMode; auto?: boolean; permission?: boolean; ceiling?: PermissionMode; agent?: string } = {}) {
  const onModelMenuOpenChange = vi.fn()
  const onModelSelect = vi.fn()
  const onPermission = vi.fn()
  const props: ComposerFooterProps = {
    providers: [provider(options.models ?? [opus], options.auto ?? true, options.agent)],
    selectedProviderId: 'claude-subscription',
    selectedModelId: options.modelId ?? 'opus:high',
    modelMenuOpen: false,
    onModelMenuOpenChange,
    onModelSelect,
    onOpenSettings: vi.fn(),
    contextUsage: { used: 0, limit: 0, percent: 0 } as unknown as ComposerFooterProps['contextUsage'],
    contextOpen: false,
    onContextOpenChange: vi.fn(),
    onAttachClick: vi.fn(),
    ...(options.permission === false ? {} : { permission: { mode: options.mode ?? 'accept_edits', ...(options.ceiling ? { ceiling: options.ceiling, ceilingReason: 'This computer allows up to Auto-accept edits.' } : {}), onSelect: onPermission } })
  }
  act(() => root.render(createElement(ComposerFooter, props)))
  return { onModelMenuOpenChange, onModelSelect, onPermission }
}

const modelButton = () => host.querySelector<HTMLButtonElement>('.composer-model-btn')!
const runButton = () => host.querySelector<HTMLButtonElement>('.composer-run-btn')
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Run options"]')
const sections = () => [...menu()!.querySelectorAll<HTMLElement>('[role="group"]')].map((group) => group.getAttribute('aria-label'))
const modes = () => [...menu()!.querySelectorAll<HTMLElement>('.composer-run-menu-permission')]
const line = () => menu()!.querySelector('.composer-run-menu-permission-line')!.textContent
const openMenu = () => act(() => runButton()!.click())
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })

describe('composer run controls', () => {
  it('shows "Opus 5.5 · High" as adjacent text with the mode icon, and each part opens its own picker', () => {
    const { onModelMenuOpenChange } = render()
    // The model keeps its provider icon and has no chevron.
    expect(modelButton().firstElementChild!.classList.contains('composer-model-btn-label')).toBe(false)
    expect(modelButton().lastElementChild!.classList.contains('composer-model-btn-label')).toBe(true)
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Opus 5.5')
    expect(host.querySelector('.composer-run-controls')!.textContent).toBe('Opus 5.5·High')
    // The level has no icon and no chevron: the one icon is the permission mode's.
    expect(runButton()!.querySelectorAll('svg')).toHaveLength(1)
    expect(runButton()!.getAttribute('aria-label')).toBe('Reasoning: High. Permission mode: Auto-accept edits')
    expect(host.querySelector('.composer-permission-picker, .composer-pill-btn')).toBeNull()

    act(() => modelButton().click())
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(true)
    expect(menu()).toBeNull()
    openMenu()
    expect(menu()).not.toBeNull()
  })

  it('shows only the model name and the mode icon for a model without reasoning', () => {
    render({ models: [plain], modelId: 'plain' })
    expect(host.querySelector('.composer-run-sep')).toBeNull()
    expect(runButton()!.textContent).toBe('')
    expect(runButton()!.getAttribute('aria-label')).toBe('Permission mode: Auto-accept edits')
    openMenu()
    expect(sections()).toEqual(['Permissions'])
  })

  it('shows each section only when the agent and model offer it', () => {
    render({ permission: false })
    openMenu()
    expect(sections()).toEqual(['Reasoning'])
    act(() => root.unmount())
    root = createRoot(host)

    const standard: LlmModelOption = { id: 'fast-model', label: 'Fast 1', efforts: ['low', 'high'], thinkingOff: false }
    const fast: LlmModelOption = { id: 'fast-model:fast', label: 'Fast 1 (fast)', efforts: ['low', 'high'], speed: 'fast', thinkingOff: false }
    render({ models: [standard, fast], modelId: 'fast-model:high' })
    openMenu()
    expect(sections()).toEqual(['Reasoning', 'Speed', 'Permissions'])
    // No "Off" where the model cannot turn thinking off.
    expect([...menu()!.querySelectorAll('[aria-label="Reasoning"] [role="menuitemradio"]')].map((item) => item.textContent)).toEqual(['Low', 'High'])
  })

  it('lists every level the agent reports for the model, ultra levels included', () => {
    render({ modelId: 'opus' })
    expect(runButton()!.textContent).toBe('Medium')
    openMenu()
    const levels = [...menu()!.querySelectorAll('[aria-label="Reasoning"] [role="menuitemradio"]')].map((item) => item.textContent)
    expect(levels).toEqual(['Low', 'MediumDefault', 'High', 'Extra high', 'Max', 'Ultracode'])
  })

  it('runs a saved level the model does not offer at its default, and says so', () => {
    const { onModelSelect } = render({ modelId: 'opus:ultra' })
    expect(runButton()!.textContent).toBe('Medium')
    openMenu()
    expect(menu()!.querySelector('[role="note"]')!.textContent).toBe("Ultra isn't offered for Opus 5.5; using its default.")
    const checked = menu()!.querySelector('[aria-label="Reasoning"] [aria-checked="true"]')!
    expect(checked.textContent).toBe('MediumDefault')
    // Picking the default stores it, so the note goes away.
    act(() => (checked as HTMLButtonElement).click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus:medium')
  })

  it('offers permission modes as a row of named icon buttons, highlighted without a check', () => {
    const { onPermission } = render({ mode: 'ask' })
    openMenu()
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    expect(modes().map((mode) => mode.getAttribute('title'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    const selected = modes().filter((mode) => mode.getAttribute('aria-checked') === 'true')
    expect(selected.map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting'])
    expect(selected[0]!.classList.contains('selected')).toBe(true)
    expect(menu()!.querySelector('.composer-run-menu-permissions .composer-mode-menu-check')).toBeNull()
    // One line names and describes the chosen mode; hovering another previews it.
    expect(line()).toBe('Ask before actingAsks before every command and file edit.')
    act(() => { modes()[3]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(line()).toBe('Full accessRuns everything without asking.')
    act(() => modes()[3]!.click())
    expect(onPermission).toHaveBeenCalledWith('full')
    expect(menu()).toBeNull()
  })

  it('moves through the menu with the arrow keys and closes on Escape', () => {
    render({ mode: 'accept_edits' })
    openMenu()
    // The chosen level takes focus when the menu opens.
    expect(document.activeElement!.textContent).toBe('High')
    for (let step = 0; step < 4; step += 1) key(document.activeElement!, 'ArrowDown')
    // Down from the last level enters the permission row on its chosen mode.
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Auto-accept edits')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Auto')
    expect(line()).toBe('AutoEdits go ahead; Claude Code runs the commands it judges safe.')
    key(document.activeElement!, 'ArrowLeft')
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Ask before acting')
    // Up leaves the row as one stop.
    key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement!.textContent).toBe('Ultracode')
    key(document.activeElement!, 'Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(runButton())
  })

  it('hides Auto on an agent without an auto mode and shows a thread set to Auto as Auto-accept edits', () => {
    const { onPermission } = render({ mode: 'auto', auto: false, agent: 'Grok' })
    expect(runButton()!.getAttribute('aria-label')).toContain('Permission mode: Auto-accept edits')
    openMenu()
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Full access'])
    expect(modes().find((mode) => mode.getAttribute('aria-checked') === 'true')!.getAttribute('aria-label')).toBe('Auto-accept edits')
    expect(document.body.textContent).not.toContain('no auto mode')
    act(() => modes()[1]!.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('keeps a mode above the limit in the row, dimmed, and says why on hover', () => {
    const { onPermission } = render({ mode: 'accept_edits', ceiling: 'accept_edits' })
    openMenu()
    const full = modes()[3]!
    expect(full.getAttribute('aria-disabled')).toBe('true')
    expect(full.getAttribute('title')).toBe('Full access: This computer allows up to Auto-accept edits.')
    act(() => { full.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(line()).toBe('Full accessThis computer allows up to Auto-accept edits.')
    act(() => full.click())
    expect(onPermission).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })
})
