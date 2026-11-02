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
const sonnet: LlmModelOption = { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }
const plain: LlmModelOption = { id: 'plain', label: 'Plain 1' }

function provider(models: LlmModelOption[], autoPermissionMode = true, label = 'Claude Code'): ProviderWithStatus {
  return { id: 'claude-subscription', label, models, caps: { toolControl: 'exact', autoPermissionMode, contextUsage: 'none' } as ProviderWithStatus['caps'] }
}

function render(options: { models?: LlmModelOption[]; modelId?: string; mode?: PermissionMode; auto?: boolean; permission?: boolean; ceiling?: PermissionMode; agent?: string; open?: boolean; readOnly?: boolean } = {}) {
  const onModelMenuOpenChange = vi.fn()
  const onModelSelect = vi.fn()
  const onPermission = vi.fn()
  const props: ComposerFooterProps = {
    providers: [provider(options.models ?? [opus, sonnet, plain], options.auto ?? true, options.agent)],
    selectedProviderId: 'claude-subscription',
    selectedModelId: options.modelId ?? 'opus:high',
    modelMenuOpen: options.open ?? true,
    onModelMenuOpenChange,
    onModelSelect,
    modelReadOnly: options.readOnly ?? false,
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
/** The run settings column beside the model list (not its hidden sizing copy). */
const column = () => document.querySelector<HTMLElement>('.model-picker-run-settings')
const sections = () => [...column()!.querySelectorAll<HTMLElement>('[role="group"]')].map((group) => group.getAttribute('aria-label'))
const levels = () => [...column()!.querySelectorAll('[aria-label="Reasoning"] [role="menuitemradio"]')].map((item) => item.textContent)
const level = (name: string) => [...column()!.querySelectorAll<HTMLButtonElement>('[aria-label="Reasoning"] [role="menuitemradio"]')].find((item) => item.textContent!.startsWith(name))!
const checkedLevel = () => column()!.querySelector('[aria-label="Reasoning"] [aria-checked="true"]')!.textContent
const note = () => column()!.querySelector('[role="note"]')?.textContent ?? null
const modes = () => [...column()!.querySelectorAll<HTMLElement>('.composer-run-menu-permission')]
const line = () => column()!.querySelector('.composer-run-menu-permission-line')!.textContent
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.model-picker-row')].find((entry) => entry.querySelector('.model-picker-row-title')!.textContent === name)!
const search = () => document.querySelector<HTMLInputElement>('.model-picker-search input')!
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })
/** Rests the pointer on a model long enough for its run settings to show. */
async function hover(name: string) {
  await act(async () => {
    row(name).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
}

describe('composer model picker', () => {
  it('shows "Opus 5.5 High" with no separator, the level apart, and opens one picker', () => {
    const { onModelMenuOpenChange } = render({ open: false })
    expect(host.querySelector('.composer-run-controls')!.textContent).toBe('Opus 5.5High')
    expect(modelButton().querySelector('.composer-model-btn-level')!.textContent).toBe('High')
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Opus 5.5 High. Permission mode: Auto-accept edits')
    // The permission mode's icon follows the level; there is no separate reasoning button.
    expect(modelButton().querySelector('svg.composer-model-btn-mode')).not.toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(3)
    expect(host.querySelector('.composer-run-btn, .composer-run-sep, .composer-pill-btn')).toBeNull()
    act(() => modelButton().click())
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(true)
  })

  it('names a model the picker does not list, never by its stored string', () => {
    render({ modelId: 'gpt-6.1-sol:low', open: false })
    expect(modelButton().textContent).toContain('GPT-6.1 Sol')
    expect(modelButton().textContent).not.toContain('gpt-6.1-sol')
  })

  it('lists the models and, beside them, the selected model run settings', () => {
    render()
    expect([...document.querySelectorAll('.model-picker-row-title')].map((title) => title.textContent)).toEqual(['Opus 5.5', 'Sonnet 5', 'Plain 1'])
    expect(column()!.getAttribute('aria-label')).toBe('Claude Opus 5.5 settings')
    expect(sections()).toEqual(['Reasoning', 'Permissions'])
    expect(levels()).toEqual(['Low', 'MediumDefault', 'High', 'Extra high', 'Max', 'Ultracode'])
    expect(checkedLevel()).toBe('High')
    expect(document.querySelector('[role="menu"][aria-label="Run options"]')).toBeNull()
  })

  it('shows a hovered model own levels, and picks the model and a level together', async () => {
    const { onModelSelect } = render({ modelId: 'opus:high' })
    await hover('Sonnet 5')
    expect(column()!.getAttribute('aria-label')).toBe('Claude Sonnet 5 settings')
    expect(levels()).toEqual(['Low', 'MediumDefault', 'High'])
    // Sonnet offers High, so it keeps it.
    expect(checkedLevel()).toBe('High')
    expect(note()).toBeNull()
    act(() => level('Low').click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet:low', undefined)
  })

  it('keeps the current level when the new model offers it', async () => {
    const { onModelSelect } = render({ modelId: 'opus:high' })
    act(() => row('Sonnet 5').querySelector<HTMLButtonElement>('.model-picker-row-main')!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet:high', undefined)
  })

  it('saves the default level as chosen when picked, and changes nothing for the level already chosen', () => {
    const { onModelSelect } = render({ modelId: 'opus' })
    act(() => level('Medium').click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus:medium', undefined)
    act(() => root.unmount())
    root = createRoot(host)
    const chosen = render({ modelId: 'opus:high' })
    act(() => level('High').click())
    expect(chosen.onModelSelect).not.toHaveBeenCalled()
  })

  it('saves no level for the next model when none was chosen', async () => {
    const { onModelSelect } = render({ modelId: 'opus' })
    await hover('Sonnet 5')
    expect(checkedLevel()).toBe('MediumDefault')
    expect(note()).toBeNull()
    act(() => row('Sonnet 5').querySelector<HTMLButtonElement>('.model-picker-row-main')!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet', undefined)
  })

  it('uses the new model default when it does not offer the current level, and says so', async () => {
    const { onModelSelect } = render({ modelId: 'opus:max' })
    await hover('Sonnet 5')
    expect(checkedLevel()).toBe('MediumDefault')
    expect(note()).toBe("Max isn't offered for Claude Sonnet 5; using its default.")
    act(() => row('Sonnet 5').querySelector<HTMLButtonElement>('.model-picker-row-main')!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet', undefined)
  })

  it('runs a saved level the model does not offer at its default, and says so', () => {
    const { onModelSelect } = render({ modelId: 'opus:ultra' })
    expect(modelButton().querySelector('.composer-model-btn-level')!.textContent).toBe('Medium')
    expect(note()).toBe("Ultra isn't offered for Claude Opus 5.5; using its default.")
    expect(checkedLevel()).toBe('MediumDefault')
    // Picking the default stores it, so the note goes away.
    act(() => level('Medium').click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus:medium', undefined)
  })

  it('shows Speed when the model has a fast mode', () => {
    const standard: LlmModelOption = { id: 'fast-model', label: 'Fast 1', efforts: ['low', 'high'], thinkingOff: false }
    const fast: LlmModelOption = { id: 'fast-model:fast', label: 'Fast 1 (fast)', efforts: ['low', 'high'], speed: 'fast', thinkingOff: false }
    render({ models: [standard, fast], modelId: 'fast-model:high' })
    expect(sections()).toEqual(['Reasoning', 'Speed', 'Permissions'])
    // No "Off" where the model cannot turn thinking off.
    expect(levels()).toEqual(['Low', 'High'])
  })

  it('shows only the model list for a model with no run settings', async () => {
    render({ permission: false })
    expect(sections()).toEqual(['Reasoning'])
    await hover('Plain 1')
    expect(column()).toBeNull()
    expect(document.querySelector('.model-picker-run')).toBeNull()
    expect(document.querySelector('.model-picker-panel')!.classList.contains('has-run-settings')).toBe(false)
  })

  it('shows only the permission mode for a model without reasoning', async () => {
    render({ modelId: 'plain' })
    expect(modelButton().querySelector('.composer-model-btn-level')).toBeNull()
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Plain 1. Permission mode: Auto-accept edits')
    expect(sections()).toEqual(['Permissions'])
  })

  it('moves through models and into their settings with the keyboard', async () => {
    const { onModelMenuOpenChange } = render({ modelId: 'opus:high' })
    // The search field drives the list as a combobox.
    expect(search().getAttribute('role')).toBe('combobox')
    const activeOption = () => document.getElementById(search().getAttribute('aria-activedescendant')!)!
    expect(activeOption().textContent).toContain('Opus 5.5')
    key(search(), 'ArrowDown')
    expect(activeOption().textContent).toContain('Sonnet 5')
    expect(column()!.getAttribute('aria-label')).toBe('Claude Sonnet 5 settings')
    // Right moves into the settings on the level the model would run at; Left goes back.
    act(() => search().focus())
    key(search(), 'ArrowRight')
    expect(document.activeElement!.textContent).toBe('High')
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Auto-accept edits')
    key(document.activeElement!, 'ArrowUp')
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement).toBe(search())
    key(search(), 'Escape')
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(modelButton())
  })

  it('offers permission modes as a row of named icon buttons, highlighted without a check', () => {
    const { onPermission, onModelSelect, onModelMenuOpenChange } = render({ mode: 'ask' })
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    expect(modes().map((mode) => mode.getAttribute('title'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    const selected = modes().filter((mode) => mode.getAttribute('aria-checked') === 'true')
    expect(selected.map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting'])
    expect(selected[0]!.classList.contains('selected')).toBe(true)
    // No section marks its selection with a check: the chosen item is highlighted.
    expect(column()!.querySelector('.composer-mode-menu-check, svg.lucide-check')).toBeNull()
    expect(column()!.querySelector('[aria-label="Reasoning"] [aria-checked="true"]')!.classList.contains('selected')).toBe(true)
    // One line names and describes the chosen mode; hovering another previews it.
    expect(line()).toBe('Ask before actingAsks before every command and file edit.')
    act(() => { modes()[3]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(line()).toBe('Full accessRuns everything without asking.')
    act(() => modes()[3]!.click())
    expect(onPermission).toHaveBeenCalledWith('full')
    // The selected model stays as it is.
    expect(onModelSelect).not.toHaveBeenCalled()
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(false)
  })

  it('picks a hovered model along with a permission mode chosen in its settings', async () => {
    const { onPermission, onModelSelect } = render({ modelId: 'opus:high', mode: 'ask' })
    await hover('Sonnet 5')
    act(() => modes()[3]!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet:high', undefined)
    expect(onPermission).toHaveBeenCalledWith('full')
  })

  it('hides Auto on an agent without an auto mode and shows a thread set to Auto as Auto-accept edits', () => {
    const { onPermission } = render({ mode: 'auto', auto: false, agent: 'Grok' })
    expect(modelButton().getAttribute('aria-label')).toContain('Permission mode: Auto-accept edits')
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Full access'])
    expect(modes().find((mode) => mode.getAttribute('aria-checked') === 'true')!.getAttribute('aria-label')).toBe('Auto-accept edits')
    expect(document.body.textContent).not.toContain('no auto mode')
    act(() => modes()[1]!.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('keeps a mode above the limit in the row, dimmed, and says why on hover', () => {
    const { onPermission } = render({ mode: 'accept_edits', ceiling: 'accept_edits' })
    const full = modes()[3]!
    expect(full.getAttribute('aria-disabled')).toBe('true')
    expect(full.getAttribute('title')).toBe('Full access: This computer allows up to Auto-accept edits.')
    act(() => { full.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(line()).toBe('Full accessThis computer allows up to Auto-accept edits.')
    act(() => full.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('opens only the run settings for an assigned model, where just the permission mode changes', () => {
    const { onPermission } = render({ readOnly: true })
    expect(modelButton().disabled).toBe(false)
    expect(modelButton().getAttribute('aria-label')).toBe('Assigned model: Opus 5.5 High. Permission mode: Auto-accept edits')
    expect(document.querySelector('.model-picker-row')).toBeNull()
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Run options"]')!
    expect([...menu.querySelectorAll<HTMLButtonElement>('[aria-label="Reasoning"] [role="menuitemradio"]')].every((item) => item.disabled)).toBe(true)
    act(() => menu.querySelectorAll<HTMLButtonElement>('.composer-run-menu-permission')[0]!.click())
    expect(onPermission).toHaveBeenCalledWith('ask')
    act(() => root.unmount())
    root = createRoot(host)
    render({ readOnly: true, permission: false, open: false })
    expect(modelButton().disabled).toBe(true)
  })
})
