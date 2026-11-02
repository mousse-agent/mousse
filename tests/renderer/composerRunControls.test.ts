// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
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
const standardSpeed: LlmModelOption = { id: 'fast-model', label: 'Fast 1', efforts: ['low', 'high'], thinkingOff: false }
const fastSpeed: LlmModelOption = { id: 'fast-model:fast', label: 'Fast 1 (fast)', efforts: ['low', 'high'], speed: 'fast', thinkingOff: false }

function provider(models: LlmModelOption[], autoPermissionMode = true, label = 'Claude Code', id = 'claude-subscription'): ProviderWithStatus {
  return { id, label, models, caps: { toolControl: 'exact', autoPermissionMode, contextUsage: 'none' } as ProviderWithStatus['caps'] }
}

function render(options: { models?: LlmModelOption[]; modelId?: string; mode?: PermissionMode; auto?: boolean; permission?: boolean; ceiling?: PermissionMode; agent?: string; open?: boolean; readOnly?: boolean; providers?: ProviderWithStatus[] } = {}) {
  const onModelMenuOpenChange = vi.fn()
  const onModelSelect = vi.fn()
  const onPermission = vi.fn()
  const props: ComposerFooterProps = {
    providers: options.providers ?? [provider(options.models ?? [opus, sonnet, plain], options.auto ?? true, options.agent)],
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
/** The reasoning column beside the model list (not its hidden sizing copy). */
const column = () => document.querySelector<HTMLElement>('.model-picker-run-settings')
const columnModel = () => column()!.querySelector('.model-picker-run-model')!.textContent
const levelItems = () => [...column()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
const levels = () => levelItems().map((item) => item.textContent)
const level = (name: string) => levelItems().find((item) => item.textContent!.startsWith(name))!
const checkedLevel = () => column()!.querySelector('[aria-checked="true"]')!.textContent
const note = () => column()!.querySelector('[role="note"]')?.textContent ?? null
const footer = () => document.querySelector<HTMLElement>('.model-picker-footer')
const speeds = () => [...document.querySelectorAll<HTMLElement>('.model-picker-footer [role="radiogroup"][aria-label="Speed"] [role="radio"]')]
const permissionButton = () => document.querySelector<HTMLButtonElement>('.model-picker-permission-btn')!
const permissionMenu = () => document.querySelector<HTMLElement>('.model-picker-permission-menu')
const openPermissions = () => act(() => permissionButton().click())
const modes = () => [...permissionMenu()!.querySelectorAll<HTMLElement>('.composer-run-menu-permission')]
const lineItems = () => [...permissionMenu()!.querySelectorAll<HTMLElement>('.composer-run-menu-permission-line-item')]
/** The one line shown: the chosen mode's, or the hovered or focused one's. */
const line = () => lineItems().filter((item) => !item.classList.contains('is-hidden')).map((item) => item.textContent).join('|')
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.model-picker-row')].find((entry) => entry.querySelector('.model-picker-row-title')!.textContent === name)!
const search = () => document.querySelector<HTMLInputElement>('.model-picker-search input')!
const key = (target: Element, name: string, init: KeyboardEventInit = {}) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init })) })
/** Types into the model search. */
const type = (text: string) => act(() => {
  const input = search()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
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
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Opus 5.5 High')
    // The button names only the model and level; the permission mode lives in the picker's footer.
    expect(modelButton().querySelector('svg.lucide')).toBeNull()
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

  it('lists the models, checks the selected one, and shows its reasoning levels beside them', () => {
    render()
    expect([...document.querySelectorAll('.model-picker-row-title')].map((title) => title.textContent)).toEqual(['Opus 5.5', 'Sonnet 5', 'Plain 1'])
    // The selected model carries a check, the others an empty slot.
    expect([...document.querySelectorAll('.model-picker-row-check')].map((check) => Boolean(check.querySelector('svg')))).toEqual([true, false, false])
    expect(column()!.querySelector('.model-picker-run-title')!.textContent).toBe('Reasoning')
    expect(columnModel()).toBe('Opus 5.5')
    expect(levels()).toEqual(['Low', 'MediumDefault', 'High', 'Extra high', 'Max', 'Ultracode'])
    expect(checkedLevel()).toBe('High')
    expect(level('High').querySelector('.model-picker-level-check svg')).not.toBeNull()
    expect(level('Low').querySelector('.model-picker-level-check svg')).toBeNull()
    // Speed and permissions are not in the column; Opus has one speed, so the footer holds only the permission button.
    expect(column()!.querySelector('[aria-label="Speed"], .composer-run-menu-permission')).toBeNull()
    expect(speeds()).toHaveLength(0)
    expect(permissionButton().textContent).toBe('Auto-accept edits')
    expect(document.querySelector('[role="menu"][aria-label="Run options"]')).toBeNull()
  })

  it('puts the favorites star at the top of the provider rail, with no "All" item', () => {
    render({ providers: [provider([opus, sonnet]), provider([{ id: 'gpt', label: 'GPT-5.5' }], false, 'Codex', 'codex')] })
    const rail = document.querySelector('.model-picker-rail')!
    expect(rail.firstElementChild!.getAttribute('aria-label')).toBe('Show favorites only')
    expect([...rail.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex'])
    expect(document.querySelector('.model-picker-search .model-picker-favorites-toggle')).toBeNull()
  })

  it('shows a hovered model own levels, and picks the model and a level together', async () => {
    const { onModelSelect } = render({ modelId: 'opus:high' })
    await hover('Sonnet 5')
    expect(columnModel()).toBe('Sonnet 5')
    expect(levels()).toEqual(['Low', 'MediumDefault', 'High'])
    // Sonnet offers High, so it keeps it.
    expect(checkedLevel()).toBe('High')
    expect(note()).toBeNull()
    act(() => level('Low').click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'sonnet:low', undefined)
  })

  it('keeps the current level when the new model offers it', () => {
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

  it('shows Speed as a small toggle in the footer when the model lists more than one speed', () => {
    const { onModelSelect } = render({ models: [standardSpeed, fastSpeed], modelId: 'fast-model:high' })
    // No "Off" where the model cannot turn thinking off.
    expect(levels()).toEqual(['Low', 'High'])
    expect(document.querySelector('.model-picker-speed')!.getAttribute('role')).toBe('radiogroup')
    expect(speeds().map((segment) => segment.textContent)).toEqual(['Standard', 'Fast'])
    expect(speeds().map((segment) => segment.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    // Only the chosen segment is a tab stop; Fast carries the lightning icon.
    expect(speeds().map((segment) => segment.tabIndex)).toEqual([0, -1])
    expect(speeds()[1]!.querySelector('svg')).not.toBeNull()
    act(() => speeds()[1]!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'fast-model:fast:high', undefined)
  })

  it('starts another model at its standard speed, never Fast by default', async () => {
    const { onModelSelect } = render({ models: [opus, standardSpeed, fastSpeed], modelId: 'opus:high' })
    await hover('Fast 1')
    expect(speeds().map((segment) => segment.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    act(() => row('Fast 1').querySelector<HTMLButtonElement>('.model-picker-row-main')!.click())
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'fast-model:high', undefined)
  })

  it('adds a faster tier to the Speed toggle only when the model lists it', () => {
    const standard: LlmModelOption = { id: 'gpt', label: 'GPT 9', efforts: ['low', 'high'], thinkingOff: false }
    const fast: LlmModelOption = { id: 'gpt-fast', label: 'GPT 9 (fast)', efforts: ['low', 'high'], speed: 'fast', thinkingOff: false }
    const ultra = { id: 'gpt-ultra', label: 'GPT 9', efforts: ['low', 'high'], speed: 'ultrafast', thinkingOff: false } as unknown as LlmModelOption
    render({ models: [standard, fast, ultra], modelId: 'gpt-ultra:high' })
    expect(speeds().map((segment) => segment.textContent)).toEqual(['Standard', 'Fast', 'Ultrafast'])
    expect(modelButton().querySelector('.composer-model-btn-level')!.textContent).toBe('High')
    expect(modelButton().getAttribute('aria-label')).toContain('GPT 9 Ultrafast High')
  })

  it('shows a lightning icon after the model name on Fast, and none on Standard', () => {
    render({ models: [standardSpeed, fastSpeed], modelId: 'fast-model:fast:high', open: false })
    const label = () => modelButton().querySelector('.composer-model-btn-label')!
    // Name, icon, then the lighter level; the icon has no text of its own.
    const parts = ['composer-model-btn-name', 'composer-model-btn-speed', 'composer-model-btn-level']
    expect([...label().children].map((child) => parts.find((part) => child.classList.contains(part)))).toEqual(parts)
    expect(label().textContent).toBe('Fast 1High')
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Fast 1 Fast High')
    expect(modelButton().getAttribute('title')).toContain('Fast 1 Fast High')
    act(() => root.unmount())
    root = createRoot(host)
    render({ models: [standardSpeed, fastSpeed], modelId: 'fast-model:high', open: false })
    expect(modelButton().querySelector('.composer-model-btn-speed')).toBeNull()
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Fast 1 High')
  })

  it('keeps the picker one fixed box whatever is inside it', () => {
    render()
    const panel = () => document.querySelector('.model-picker-panel')!
    expect(panel().classList.contains('is-fixed')).toBe(true)
    // A search with no results keeps the column (its header alone) and the footer in place.
    type('nothing like this')
    expect(document.querySelectorAll('.model-picker-row')).toHaveLength(0)
    expect(panel().classList.contains('is-fixed')).toBe(true)
    expect(document.querySelector('.model-picker-run-head')!.textContent).toBe('Reasoning')
    expect(footer()).not.toBeNull()
    // The box's size comes from the stylesheet alone: a fixed width and height, the list and column scrolling inside.
    const css = readFileSync('src/renderer/styles/composer-run-controls.css', 'utf8')
    const rule = css.slice(css.indexOf('.model-picker-panel.is-fixed {'), css.indexOf('}', css.indexOf('.model-picker-panel.is-fixed {')))
    expect(rule).toMatch(/\n  width: min\(720px, calc\(100vw - 48px\)\);/)
    expect(rule).toMatch(/\n  height: min\(440px, calc\(100vh - 16px\)\);/)
    expect(rule).not.toMatch(/fit-content|max-content|min-content|auto/)
  })

  it('keeps a long model name to one line, with the full name in the tooltip', () => {
    const long: LlmModelOption = { id: 'long', label: 'Opus 5.5 Extended Thinking Research Preview Edition' }
    render({ models: [opus, long] })
    const longRow = row('Opus 5.5 Extended Thinking Research Preview Edition')
    expect(longRow.querySelector('.model-picker-row-main')!.getAttribute('title')).toContain('Opus 5.5 Extended Thinking Research Preview Edition')
    const css = readFileSync('src/renderer/styles/app.css', 'utf8')
    const title = css.slice(css.indexOf('.model-picker-row-title {'), css.indexOf('}', css.indexOf('.model-picker-row-title {')))
    expect(title).toContain('text-overflow: ellipsis')
    expect(title).toContain('white-space: nowrap')
  })

  it('shows only the model list when no listed model has run settings', async () => {
    render({ models: [plain], modelId: 'plain', permission: false })
    expect(document.querySelector('.model-picker-run')).toBeNull()
    expect(footer()).toBeNull()
    expect(document.querySelector('.model-picker-panel')!.classList.contains('has-run-settings')).toBe(false)
  })

  it('says a hovered model without levels has none, and keeps the column in place', async () => {
    render({ permission: false })
    await hover('Plain 1')
    expect(columnModel()).toBe('Plain 1')
    expect(column()!.querySelector('.model-picker-run-empty')!.textContent).toBe('None for this model')
    expect(levelItems()).toHaveLength(0)
  })

  it('shows only the permission button for a model without reasoning or speeds', () => {
    render({ models: [plain], modelId: 'plain' })
    expect(modelButton().querySelector('.composer-model-btn-level')).toBeNull()
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Plain 1')
    expect(document.querySelector('.model-picker-run')).toBeNull()
    expect(speeds()).toHaveLength(0)
    expect(permissionButton()).not.toBeNull()
  })

  it('moves through models, into their levels and on to the footer with the keyboard', () => {
    const { onModelMenuOpenChange } = render({ modelId: 'opus:high' })
    // The search field drives the list as a combobox.
    expect(search().getAttribute('role')).toBe('combobox')
    const activeOption = () => document.getElementById(search().getAttribute('aria-activedescendant')!)!
    expect(activeOption().textContent).toContain('Opus 5.5')
    key(search(), 'ArrowDown')
    expect(activeOption().textContent).toContain('Sonnet 5')
    expect(columnModel()).toBe('Sonnet 5')
    // Right moves into the levels on the one the model would run at; Down past the last reaches the footer.
    act(() => search().focus())
    key(search(), 'ArrowRight')
    expect(document.activeElement!.textContent).toBe('High')
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(permissionButton())
    // Up from the footer goes back to the levels, Left back to the list.
    key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement!.textContent).toBe('High')
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement).toBe(search())
    key(search(), 'Escape')
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(modelButton())
  })

  it('moves between speeds with Left and Right', () => {
    render({ models: [standardSpeed, fastSpeed], modelId: 'fast-model:high' })
    act(() => search().focus())
    key(search(), 'ArrowRight')
    // Down past the last level lands on the chosen speed.
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement!.textContent).toBe('Standard')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement!.textContent).toBe('Fast')
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement!.textContent).toBe('Standard')
  })

  it('opens the permission modes above the footer, keeps focus inside, and closes on Escape back to the button', () => {
    const { onModelMenuOpenChange } = render({ mode: 'ask' })
    expect(permissionButton().getAttribute('aria-expanded')).toBe('false')
    expect(permissionButton().textContent).toBe('Ask before acting')
    openPermissions()
    expect(permissionButton().getAttribute('aria-expanded')).toBe('true')
    expect(permissionMenu()!.getAttribute('role')).toBe('menu')
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Ask before acting')
    // Tab cycles through the modes without leaving the menu.
    key(document.activeElement!, 'Tab', { shiftKey: true })
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Full access')
    key(document.activeElement!, 'Tab')
    expect(document.activeElement!.getAttribute('aria-label')).toBe('Ask before acting')
    key(document.activeElement!, 'Escape')
    expect(permissionMenu()).toBeNull()
    expect(document.activeElement).toBe(permissionButton())
    // Only the permission menu closed, not the picker.
    expect(onModelMenuOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('offers permission modes as a row of named icon buttons, highlighted without a check', () => {
    const { onPermission, onModelSelect, onModelMenuOpenChange } = render({ mode: 'ask' })
    openPermissions()
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    const selected = modes().filter((mode) => mode.getAttribute('aria-checked') === 'true')
    expect(selected.map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting'])
    expect(selected[0]!.classList.contains('selected')).toBe(true)
    expect(permissionMenu()!.querySelector('.composer-mode-menu-check, svg.lucide-check')).toBeNull()
    // The chosen mode is named and described; hovering another previews it.
    expect(line()).toBe('Ask before actingAsks before every command and file edit.')
    act(() => { modes()[3]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(line()).toBe('Full accessRuns everything without asking.')
    act(() => modes()[3]!.click())
    expect(onPermission).toHaveBeenCalledWith('full')
    // The permission belongs to the thread: the model stays as it is.
    expect(onModelSelect).not.toHaveBeenCalled()
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(false)
  })

  it('draws every mode line in one place and shows only the active one, so the menu never resizes on hover', () => {
    render({ mode: 'ask' })
    openPermissions()
    // All four lines are rendered (the menu takes the size of the longest); one is visible and read out.
    expect(lineItems().map((item) => item.querySelector('.composer-run-menu-permission-name')!.textContent)).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    const shown = () => lineItems().filter((item) => !item.classList.contains('is-hidden') && item.getAttribute('aria-hidden') !== 'true')
    expect(shown().map((item) => item.textContent)).toEqual(['Ask before actingAsks before every command and file edit.'])
    expect(lineItems().filter((item) => item.getAttribute('aria-hidden') === 'true')).toHaveLength(3)
    act(() => { modes()[2]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(shown().map((item) => item.textContent)).toEqual(['AutoEdits go ahead; Claude Code runs the commands it judges safe.'])
    expect(lineItems()).toHaveLength(4)
  })

  it('hides Auto on an agent without an auto mode and shows a thread set to Auto as Auto-accept edits', () => {
    const { onPermission } = render({ mode: 'auto', auto: false, agent: 'Grok' })
    expect(permissionButton().textContent).toBe('Auto-accept edits')
    openPermissions()
    expect(modes().map((mode) => mode.getAttribute('aria-label'))).toEqual(['Ask before acting', 'Auto-accept edits', 'Full access'])
    expect(modes().find((mode) => mode.getAttribute('aria-checked') === 'true')!.getAttribute('aria-label')).toBe('Auto-accept edits')
    expect(document.body.textContent).not.toContain('no auto mode')
    act(() => modes()[1]!.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('keeps a mode above the limit in the row, dimmed, and says why on hover', () => {
    const { onPermission } = render({ mode: 'accept_edits', ceiling: 'accept_edits' })
    openPermissions()
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
    expect(modelButton().getAttribute('aria-label')).toBe('Assigned model: Opus 5.5 High')
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
