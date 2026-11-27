// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerFooter, type ComposerFooterProps, type ComposerRunProps } from '../../src/renderer/components/ComposerFooter'
import { modelOptions } from '../../src/mms/harness/acp/models'
import * as icons from '../../src/renderer/lib/icons'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { LlmModelOption } from '../../src/shared/settings'
import { useAppStore } from '../../src/renderer/stores/appStore'

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
  useAppStore.setState({ hidePermissionsWhileRunning: true })
})

const opus: LlmModelOption = { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], defaultEffort: 'medium', thinkingOff: false }
const sonnet: LlmModelOption = { id: 'sonnet', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }
const plain: LlmModelOption = { id: 'plain', label: 'Plain 1' }
const haiku: LlmModelOption = { id: 'haiku', label: 'Haiku 5', efforts: ['low', 'medium', 'high'], thinkingOff: false }
const deep: LlmModelOption = { id: 'deep', label: 'Deep 1', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', thinkingOff: false }
const standardSpeed: LlmModelOption = { id: 'fast-model', label: 'Fast 1', efforts: ['low', 'high'], thinkingOff: false }
const fastSpeed: LlmModelOption = { id: 'fast-model:fast', label: 'Fast 1 (fast)', efforts: ['low', 'high'], speed: 'fast', thinkingOff: false }

function provider(models: LlmModelOption[], autoPermissionMode = true, label = 'Claude Code', id = 'claude-subscription'): ProviderWithStatus {
  return { id, label, models, caps: { toolControl: 'exact', autoPermissionMode, contextUsage: 'none' } as ProviderWithStatus['caps'] }
}

function render(options: { models?: LlmModelOption[]; modelId?: string; providerId?: string; mode?: PermissionMode; auto?: boolean; permission?: boolean; ceiling?: PermissionMode; agent?: string; open?: boolean; readOnly?: boolean; providers?: ProviderWithStatus[]; footer?: Partial<ComposerFooterProps> } = {}) {
  const onModelMenuOpenChange = vi.fn()
  const onModelSelect = vi.fn()
  const onPermission = vi.fn()
  const props: ComposerFooterProps = {
    ...options.footer,
    run: {
      providers: options.providers ?? [provider(options.models ?? [opus, sonnet, plain], options.auto ?? true, options.agent)],
      selectedProviderId: options.providerId ?? 'claude-subscription',
      selectedModelId: options.modelId ?? 'opus:high',
      modelMenuOpen: options.open ?? true,
      onModelMenuOpenChange,
      onModelSelect,
      modelReadOnly: options.readOnly ?? false,
      onOpenSettings: vi.fn(),
      contextUsage: { used: 0, limit: 0, percent: 0 } as unknown as ComposerRunProps['contextUsage'],
      contextOpen: false,
      onContextOpenChange: vi.fn()
    },
    onAttachClick: vi.fn(),
    ...(options.permission === false ? {} : { permission: { mode: options.mode ?? 'accept_edits', ...(options.ceiling ? { ceiling: options.ceiling, ceilingReason: 'This computer allows up to Auto-accept edits.' } : {}), onSelect: onPermission } })
  }
  act(() => root.render(createElement(ComposerFooter, props)))
  return { onModelMenuOpenChange, onModelSelect, onPermission }
}

const modelButton = () => host.querySelector<HTMLButtonElement>('.composer-model-btn')!
/** The reasoning column beside the model list (not its hidden sizing copy). */
const column = () => document.querySelector<HTMLElement>('.model-picker-run-settings')
/** The model whose levels the column shows, as its menu is named for screen readers. */
const columnModel = () => column()!.getAttribute('aria-label')!.replace(/^Reasoning for /, '')
const levelItems = () => [...column()!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
const levels = () => levelItems().map((item) => item.textContent)
const level = (name: string) => levelItems().find((item) => item.textContent!.startsWith(name))!
const checkedLevel = () => column()!.querySelector('[aria-checked="true"]')!.textContent
const note = () => column()!.querySelector('[role="note"]')?.textContent ?? null
const footer = () => document.querySelector<HTMLElement>('.model-picker-footer')
const speeds = () => [...document.querySelectorAll<HTMLElement>('.model-picker-footer [role="radiogroup"][aria-label="Speed"] [role="radio"]')]
const permissionButton = () => host.querySelector<HTMLButtonElement>('.composer-permission-chip')!
const permissionMenu = () => document.querySelector<HTMLElement>('.composer-permission-menu')
const openPermissions = () => act(() => permissionButton().click())
const modes = () => [...permissionMenu()!.querySelectorAll<HTMLElement>('.composer-permission-mode')]
const modeName = (mode: Element) => mode.querySelector('.composer-permission-mode-name')!.textContent
const modeLine = (mode: Element) => mode.querySelector('.composer-permission-mode-desc')!.textContent
const modeNames = () => modes().map(modeName)
/** Makes `host` the composer box, 640px wide, as the footer sits in it in the app. */
const asComposer = () => {
  host.className = 'composer'
  host.getBoundingClientRect = () => ({ x: 0, y: 500, top: 500, left: 0, right: 640, bottom: 600, width: 640, height: 100, toJSON: () => ({}) })
}
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.model-picker-row')].find((entry) => entry.querySelector('.model-picker-row-title')!.textContent === name)!
const search = () => document.querySelector<HTMLInputElement>('.model-picker-search input')!
const key = (target: Element, name: string, init: KeyboardEventInit = {}) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init })) })
/** Types into the model search. */
const type = (text: string) => act(() => {
  const input = search()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
/** Rests the pointer on a model. */
async function hover(name: string) {
  await act(async () => {
    row(name).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
}
const clickModel = (name: string) => act(() => row(name).querySelector<HTMLButtonElement>('.model-picker-row-main')!.click())

describe('composer model picker', () => {
  // Model IDs and reasoning levels advertised by the legacy Antigravity ACP catalogue.
  it.each([
    { name: 'Neon', levels: ['High', 'Extra high', 'Medium', 'Low'] },
    { name: 'Hydrogen', levels: ['High', 'Extra high', 'Medium', 'Low'] },
    { name: 'Argon', levels: ['Medium', 'High', 'Low'] }
  ])('uses each advertised Gemini 4 $name model ID for its reasoning level', ({ name, levels: offered }) => {
    const id = 'antigravity'
    const model = `gemini-4-${name.toLowerCase()}`
    const models = offered.map((level) => ({
      id: `${model}-${level === 'Extra high' ? 'xhigh' : level.toLowerCase()}`,
      label: `Gemini 4 ${name} (${level === 'Extra high' ? 'XHigh' : level})`
    }))
    const { onModelSelect } = render({
      providerId: id,
      modelId: `${model}-high`,
      providers: [provider(models, false, 'Google Antigravity', id)]
    })

    expect(columnModel()).toBe(`Gemini 4 ${name}`)
    expect(levels()).toEqual(['Low', 'Medium', 'High', ...(offered.includes('Extra high') ? ['Extra high'] : [])])
    expect(checkedLevel()).toBe('High')
    act(() => level('Low').click())
    expect(onModelSelect).toHaveBeenCalledWith(id, `${model}-low`, undefined)
  })

  it('shows reasoning levels for native Antigravity agy models from session/new configOptions and availableModels', async () => {
    // Recorded agy 1.5.16 session/new response shape: base model IDs in configOptions[model],
    // active model's thought_level select, and per-level variants in models.availableModels.
    const models = modelOptions({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-4-neon',
          options: [
            { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
            { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
            { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
            { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
            { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
          ]
        },
        {
          id: 'thought_level',
          name: 'Thinking Level',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Extra' }
          ]
        }
      ],
      models: {
        currentModelId: 'gemini-4-neon-high',
        availableModels: [
          { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
          { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
          { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
          { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
          { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
          { modelId: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
          { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
          { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
          { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
        ]
      }
    } as never)

    const agy = { providerId: 'antigravity', providers: [provider(models, false, 'Google Antigravity', 'antigravity')] }
    const { onModelSelect } = render({ ...agy, modelId: 'gemini-4-neon:xhigh' })

    expect(columnModel()).toBe('Gemini 4 Neon')
    expect(levels()).toEqual(['Low', 'Medium', 'HighDefault', 'Extra high'])
    expect(checkedLevel()).toBe('Extra high')
    act(() => level('Medium').click())
    expect(onModelSelect).toHaveBeenCalledWith('antigravity', 'gemini-4-neon:medium', undefined)

    // Clicking Claude Opus 5.5 selects it at its default level. Beside Antigravity's logo it is named in full.
    clickModel('Claude Opus 5.5')
    expect(onModelSelect).toHaveBeenLastCalledWith('antigravity', 'claude-opus-5-5:high', undefined)

    // Claude Opus 5.5 shows its three levels and notes that a saved Extra high runs at the default.
    render({ ...agy, modelId: 'claude-opus-5-5:xhigh' })
    expect(columnModel()).toBe('Opus 5.5')
    expect(levels()).toEqual(['Low', 'Medium', 'HighDefault'])
    expect(checkedLevel()).toBe('HighDefault')
    expect(note()).toContain("Extra high isn't offered")

    // Models without thinking levels show none.
    render({ ...agy, modelId: 'gpt-oss-120b-medium' })
    expect(column()!.querySelector('.model-picker-run-empty')!.textContent).toBe('None for this model')
  })

  it('shows "Opus 5.5 High" with no separator, the level apart, and opens one picker', () => {
    const { onModelMenuOpenChange } = render({ open: false })
    expect(host.querySelector('.composer-run-controls')!.textContent).toBe('Opus 5.5High')
    expect(modelButton().querySelector('.composer-model-btn-level')!.textContent).toBe('High')
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Opus 5.5 High')
    // The button names only the model and level; the permission mode is its own chip.
    expect(modelButton().querySelector('svg.lucide')).toBeNull()
    expect([...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Permissions: Auto-accept edits', 'Model: Opus 5.5 High', 'Attach files', 'Send message'])
    expect(host.querySelector('.composer-run-btn, .composer-run-sep, .composer-pill-btn')).toBeNull()
    act(() => modelButton().click())
    expect(onModelMenuOpenChange).toHaveBeenCalledWith(true)
  })

  it('names a model the picker does not list, never by its stored string', () => {
    render({ modelId: 'gpt-6.1-sol:low', open: false })
    expect(modelButton().textContent).toContain('GPT-6.1 Sol')
    expect(modelButton().textContent).not.toContain('gpt-6.1-sol')
  })

  it('lists the models, checks the selected one beside its name, shows its reasoning levels, and puts Ultracode in the footer', () => {
    render()
    expect([...document.querySelectorAll('.model-picker-row-title')].map((title) => title.textContent)).toEqual(['Opus 5.5', 'Sonnet 5', 'Plain 1'])
    // The selected model carries a check beside its name, the others an empty slot.
    expect([...document.querySelectorAll('.model-picker-row-title-line .model-picker-row-check')].map((check) => Boolean(check.querySelector('svg')))).toEqual([true, false, false])
    // The header says only "Reasoning": the checked row already names the model.
    expect(column()!.querySelector('.model-picker-run-head')!.textContent).toBe('Reasoning')
    expect(columnModel()).toBe('Opus 5.5')
    expect(levels()).toEqual(['Low', 'MediumDefault', 'High', 'Extra high', 'Max'])
    expect(checkedLevel()).toBe('High')
    expect(level('High').querySelector('.model-picker-level-check svg')).not.toBeNull()
    expect(level('Low').querySelector('.model-picker-level-check svg')).toBeNull()
    // Speed and permissions are not in the column; Opus offers Ultracode as a footer toggle.
    expect(column()!.querySelector('[aria-label="Speed"], .composer-run-menu-permission')).toBeNull()
    expect(speeds()).toHaveLength(0)
    const ultracode = footer()!.querySelector<HTMLButtonElement>('.model-picker-ultracode')!
    expect(ultracode.textContent).toBe('Ultracode')
    expect(ultracode.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[role="menu"][aria-label="Run options"]')).toBeNull()
  })

  it('toggles Ultracode from the footer while preserving speed, and hides it for models without Ultracode', () => {
    const fastOpusStandard: LlmModelOption = { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'ultracode'], defaultEffort: 'medium', thinkingOff: false }
    const fastOpusFast: LlmModelOption = { id: 'opus-fast', label: 'Opus 5.5 (fast)', efforts: ['low', 'medium', 'high', 'ultracode'], defaultEffort: 'medium', speed: 'fast', thinkingOff: false }
    const first = render({ models: [fastOpusStandard, fastOpusFast, sonnet], modelId: 'opus-fast:high' })
    const ultracodeButton = () => footer()!.querySelector<HTMLButtonElement>('.model-picker-ultracode')
    expect(ultracodeButton()!.getAttribute('aria-pressed')).toBe('false')
    // Turning Ultracode on keeps the Fast speed variant.
    act(() => ultracodeButton()!.click())
    expect(first.onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus-fast:ultracode', undefined)

    act(() => root.unmount())
    root = createRoot(host)
    const second = render({ models: [fastOpusStandard, fastOpusFast, sonnet], modelId: 'opus-fast:ultracode' })
    expect(ultracodeButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(column()!.querySelector('[role="menuitemradio"][aria-checked="true"]')).toBeNull()
    // ArrowRight moves from the last speed radio to Ultracode, and ArrowLeft moves back.
    act(() => speeds()[1]!.focus())
    key(speeds()[1]!, 'ArrowRight')
    expect(document.activeElement).toBe(ultracodeButton())
    key(ultracodeButton()!, 'ArrowLeft')
    expect(document.activeElement).toBe(speeds()[1])
    // Turning Ultracode off returns to the model's default level while keeping Fast speed.
    act(() => ultracodeButton()!.click())
    expect(second.onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus-fast:medium', undefined)

    act(() => root.unmount())
    root = createRoot(host)
    // A model without Ultracode hides the toggle while keeping the footer bar steady when another listed model has it.
    render({ models: [fastOpusStandard, sonnet], modelId: 'sonnet:high' })
    expect(footer()).not.toBeNull()
    expect(ultracodeButton()).toBeNull()

    act(() => root.unmount())
    root = createRoot(host)
    // When no listed model has speed or Ultracode, there is no footer at all.
    render({ models: [sonnet, plain], modelId: 'sonnet:high' })
    expect(footer()).toBeNull()
  })

  it('puts the favorites star at the top of the provider rail, with no "All" item', () => {
    render({ providers: [provider([opus, sonnet]), provider([{ id: 'gpt', label: 'GPT-5.5' }], false, 'Codex', 'codex')] })
    const rail = document.querySelector('.model-picker-rail')!
    expect(rail.firstElementChild!.getAttribute('aria-label')).toBe('Show favorites only')
    expect([...rail.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex'])
    expect(document.querySelector('.model-picker-search .model-picker-favorites-toggle')).toBeNull()
  })

  it('keeps the selected model in the column and footer while another model is hovered, and a level applies to the selected model', async () => {
    const { onModelSelect } = render({ models: [opus, sonnet, standardSpeed, fastSpeed], modelId: 'opus:high' })
    await hover('Sonnet 5')
    await hover('Fast 1')
    expect(columnModel()).toBe('Opus 5.5')
    expect(checkedLevel()).toBe('High')
    // Fast 1 has two speeds and Opus one: the footer stays empty for Opus.
    expect(footer()).not.toBeNull()
    expect(speeds()).toHaveLength(0)
    act(() => level('Extra high').click())
    expect(onModelSelect).toHaveBeenCalledTimes(1)
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'opus:xhigh', undefined)
  })

  // Starting from Opus at Low, a level every model below offers: it never carries over.
  it.each([
    { name: 'Sonnet 5', picked: 'sonnet:medium', why: 'its default, Medium' },
    { name: 'Deep 1', picked: 'deep:high', why: 'its default, High' },
    { name: 'Haiku 5', picked: 'haiku:medium', why: 'Medium, with no default' },
    { name: 'Fast 1', picked: 'fast-model', why: 'no level, with neither a default nor Medium' },
    { name: 'Plain 1', picked: 'plain', why: 'no level, with no levels' }
  ])('clicking $name selects it at $why', ({ name, picked }) => {
    const { onModelSelect } = render({ models: [opus, sonnet, deep, haiku, standardSpeed, fastSpeed, plain], modelId: 'opus:low' })
    clickModel(name)
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', picked, undefined)
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

  it('starts another model at its standard speed, never Fast by default', () => {
    const { onModelSelect } = render({ models: [opus, standardSpeed, fastSpeed], modelId: 'opus:high' })
    clickModel('Fast 1')
    expect(onModelSelect).toHaveBeenCalledWith('claude-subscription', 'fast-model', undefined)
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

  it('pins the picker by its bottom edge just above the model button, left-aligned to it', () => {
    // The composer (top 500) has room above it, but the picker still sits by the button that opened it.
    asComposer()
    // Opened from the button, as in the app: the button is there before the picker measures it.
    render({ open: false })
    modelButton().getBoundingClientRect = () => ({ x: 40, y: 560, top: 560, left: 40, right: 150, bottom: 586, width: 110, height: 26, toJSON: () => ({}) })
    render()
    const shell = document.querySelector<HTMLElement>('.model-picker-shell')!
    expect(document.querySelector('.model-picker-panel')!.classList.contains('is-fixed')).toBe(true)
    // 6px above the button; content changes grow it upward and never move it.
    expect(shell.style.left).toBe('40px')
    expect(shell.style.bottom).toBe(`${window.innerHeight - 560 + 6}px`)
    expect(shell.style.top).toBe('')
    expect(shell.style.getPropertyValue('--floating-max-height')).toBe('400px')
    // A search with no results keeps the column (its header alone) in place.
    type('nothing like this')
    expect(document.querySelectorAll('.model-picker-row')).toHaveLength(0)
    expect(document.querySelector('.model-picker-run-head')!.textContent).toBe('Reasoning')
    expect(shell.style.bottom).toBe(`${window.innerHeight - 560 + 6}px`)
    // The stylesheet fits the box to its content up to the room it has: no fixed height.
    const css = readFileSync('src/renderer/styles/composer-run-controls.css', 'utf8')
    const ruleOf = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)))
    expect(ruleOf('.model-picker-panel.is-fixed')).toMatch(/\n  max-height: min\(400px, var\(--floating-max-height, 400px\)\);/)
    expect(ruleOf('.model-picker-panel.is-fixed')).not.toMatch(/\n  height:/)
    expect(css).not.toContain('.model-picker-panel.is-fixed.has-rail {\n  height')
  })

  it('lists the selected model provider first, one provider at a time, and searches them all', () => {
    const codex = provider([{ id: 'gpt', label: 'GPT-5.5' }, { id: 'gpt-mini', label: 'GPT-5.5 mini' }], false, 'Codex', 'codex')
    const older: LlmModelOption = { id: 'opus-old', label: 'Opus 4', older: true }
    render({ providers: [codex, provider([opus, sonnet, older])], modelId: 'opus:high' })
    const titles = () => [...document.querySelectorAll('.model-picker-row-title')].map((title) => title.textContent)
    const tab = (name: string) => document.querySelector<HTMLButtonElement>(`.model-picker-rail [aria-label="${name}"]`)!
    // The selected model's provider is chosen on the rail, and only its models are listed, Show more last.
    expect(tab('Claude Code').getAttribute('aria-selected')).toBe('true')
    expect(titles()).toEqual(['Opus 5.5', 'Sonnet 5'])
    expect(document.querySelector('.model-picker-list')!.lastElementChild!.textContent).toBe('Show more1')
    act(() => tab('Codex').click())
    expect(titles()).toEqual(['GPT-5.5', 'GPT-5.5 mini'])
    expect(tab('Codex').getAttribute('aria-selected')).toBe('true')
    // A search looks through every provider, each row naming its provider.
    type('5')
    expect(titles()).toEqual(['GPT-5.5', 'GPT-5.5 mini', 'Opus 5.5', 'Sonnet 5'])
    expect(document.querySelector('.model-picker-row-provider')!.textContent).toBe('Codex')
  })

  it('fades out after closing without taking input, then goes', async () => {
    render()
    render({ open: false })
    const shell = document.querySelector('.model-picker-shell')!
    expect(shell.classList.contains('is-closing')).toBe(true)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
    expect(document.querySelector('.model-picker-shell')).toBeNull()
  })

  it('keeps a long model name\'s full name in the tooltip', () => {
    const long: LlmModelOption = { id: 'long', label: 'Opus 5.5 Extended Thinking Research Preview Edition' }
    render({ models: [opus, long] })
    const longRow = row('Opus 5.5 Extended Thinking Research Preview Edition')
    expect(longRow.querySelector('.model-picker-row-main')!.getAttribute('title')).toContain('Opus 5.5 Extended Thinking Research Preview Edition')
  })

  it('shows only the model list when no listed model has run settings', async () => {
    render({ models: [plain], modelId: 'plain', permission: false })
    expect(document.querySelector('.model-picker-run')).toBeNull()
    expect(footer()).toBeNull()
    expect(document.querySelector('.model-picker-panel')!.classList.contains('has-run-settings')).toBe(false)
  })

  it('says a selected model without levels has none, and keeps the column in place', () => {
    render({ modelId: 'plain', permission: false })
    expect(columnModel()).toBe('Plain 1')
    expect(column()!.querySelector('.model-picker-run-empty')!.textContent).toBe('None for this model')
    expect(levelItems()).toHaveLength(0)
  })

  it('keeps room for the longest level list whichever model is selected', () => {
    render({ modelId: 'sonnet:high', permission: false })
    const run = () => document.querySelector<HTMLElement>('.model-picker-run')!
    // Opus lists five column levels (Ultracode lives in the footer); the column holds room for five while Sonnet, with three, is selected.
    expect(run().style.getPropertyValue('--model-picker-run-rows')).toBe('5')
    // The column's own content does not size the picker; the reserved rows do.
    const css = readFileSync('src/renderer/styles/composer-run-controls.css', 'utf8')
    const rule = css.slice(css.indexOf('.model-picker-run {'), css.indexOf('}', css.indexOf('.model-picker-run {')))
    expect(rule).toContain('contain: size;')
    expect(rule).toContain('var(--model-picker-run-rows, 0) * 28px')
  })

  it('has no footer for a model without speeds, and never a permission control inside the picker', () => {
    render({ models: [plain], modelId: 'plain' })
    expect(modelButton().querySelector('.composer-model-btn-level')).toBeNull()
    expect(modelButton().getAttribute('aria-label')).toBe('Model: Plain 1')
    expect(document.querySelector('.model-picker-run')).toBeNull()
    expect(speeds()).toHaveLength(0)
    expect(footer()).toBeNull()
    expect(document.querySelector('.composer-model-picker-shell .composer-permission-mode, .model-picker-shell .composer-permission-mode')).toBeNull()
  })

  it('moves through models, into their levels and on to the footer with the keyboard', () => {
    const { onModelMenuOpenChange } = render({ modelId: 'opus:high' })
    // The search field drives the list as a combobox.
    expect(search().getAttribute('role')).toBe('combobox')
    const activeOption = () => document.getElementById(search().getAttribute('aria-activedescendant')!)!
    expect(activeOption().textContent).toContain('Opus 5.5')
    key(search(), 'ArrowDown')
    expect(activeOption().textContent).toContain('Sonnet 5')
    // Moving through the list does not change the column: it stays the selected model's.
    expect(columnModel()).toBe('Opus 5.5')
    // Right moves into the selected model's levels on its chosen one; Left goes back to the list.
    act(() => search().focus())
    key(search(), 'ArrowRight')
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

  it('draws Auto-accept edits as a file with a tick, in the chip and the menu, not the pencil', () => {
    render({ mode: 'accept_edits', open: false })
    const paths = (svg: Element | null) => [...(svg?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d')).join('|')
    const markup = (Icon: typeof icons.Pencil) => {
      const box = document.createElement('div')
      box.innerHTML = renderToStaticMarkup(createElement(Icon))
      return paths(box.querySelector('svg'))
    }
    expect(paths(permissionButton().querySelector('svg'))).toBe(markup(icons.FileApproved))
    expect(markup(icons.FileApproved)).not.toBe(markup(icons.Pencil))
    openPermissions()
    const row = modes().find((mode) => modeName(mode) === 'Auto-accept edits')!
    expect(paths(row.querySelector('svg.composer-permission-mode-icon'))).toBe(markup(icons.FileApproved))
  })

  it('shows the mode as a chip left of the model button, opens the modes in one click, and closes on Escape back to the chip', () => {
    const { onModelMenuOpenChange } = render({ mode: 'ask', open: false })
    const controls = [...host.querySelectorAll<HTMLButtonElement>('.composer-footer-left button')]
    expect(controls.indexOf(permissionButton())).toBe(controls.indexOf(modelButton()) - 1)
    expect(permissionButton().getAttribute('aria-expanded')).toBe('false')
    expect(permissionButton().getAttribute('aria-label')).toBe('Permissions: Ask before acting')
    expect(permissionButton().getAttribute('title')).toBe('Permissions: Ask before acting')
    expect(permissionButton().textContent).toBe('')
    openPermissions()
    expect(permissionButton().getAttribute('aria-expanded')).toBe('true')
    expect(permissionMenu()!.getAttribute('role')).toBe('menu')
    expect(modeName(document.activeElement!)).toBe('Ask before acting')
    // Tab cycles through the modes without leaving the menu; Up and Down move between the rows.
    key(document.activeElement!, 'Tab', { shiftKey: true })
    expect(modeName(document.activeElement!)).toBe('Full access')
    key(document.activeElement!, 'Tab')
    expect(modeName(document.activeElement!)).toBe('Ask before acting')
    key(document.activeElement!, 'ArrowDown')
    expect(modeName(document.activeElement!)).toBe('Auto-accept edits')
    key(document.activeElement!, 'ArrowUp')
    expect(modeName(document.activeElement!)).toBe('Ask before acting')
    key(document.activeElement!, 'Escape')
    expect(permissionMenu()).toBeNull()
    expect(document.activeElement).toBe(permissionButton())
    // The model picker is a separate control.
    expect(onModelMenuOpenChange).not.toHaveBeenCalled()
  })

  it('after a pointer open, focuses the chosen mode once the menu shows, and Escape closes it back to the chip', () => {
    render({ mode: 'ask', open: false })
    // Record whether the menu was visible when a row took focus (a hidden row cannot take focus).
    const focus = HTMLElement.prototype.focus
    const visibleAtFocus: boolean[] = []
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      const menu = this.closest<HTMLElement>('.composer-permission-menu')
      if (menu) visibleAtFocus.push(menu.style.visibility === 'visible')
      focus.call(this, options)
    })
    act(() => { permissionButton().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    spy.mockRestore()
    expect(permissionMenu()).not.toBeNull()
    expect(visibleAtFocus).toEqual([true])
    expect(modeName(document.activeElement!)).toBe('Ask before acting')
    // Escape still closes when focus stayed on the chip.
    act(() => permissionButton().focus())
    key(permissionButton(), 'Escape')
    expect(permissionMenu()).toBeNull()
    expect(permissionButton().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(permissionButton())
  })

  it('shows Full access as plainly as every other mode, and names a limit in the tooltip', () => {
    render({ mode: 'full', open: false })
    expect(permissionButton().getAttribute('title')).toBe('Permissions: Full access')
    expect(permissionButton().classList.contains('is-full')).toBe(false)
    act(() => root.unmount())
    root = createRoot(host)
    render({ mode: 'accept_edits', ceiling: 'accept_edits', open: false })
    expect(permissionButton().classList.contains('is-full')).toBe(false)
    expect(permissionButton().getAttribute('title')).toBe('Permissions: Auto-accept edits. This computer allows up to Auto-accept edits.')
  })

  it('lists every mode as a row with its icon, name and what it does, the chosen one checked', () => {
    const { onPermission, onModelSelect } = render({ mode: 'ask', open: false })
    openPermissions()
    // Every mode is named and described without hovering.
    expect(modeNames()).toEqual(['Ask before acting', 'Auto-accept edits', 'Auto', 'Full access'])
    expect(modes().map(modeLine)).toEqual([
      'Asks before every command and file edit.',
      'Edits go ahead; commands ask first.',
      'Edits go ahead; Claude Code runs the commands it judges safe.',
      'Runs everything without asking.'
    ])
    expect(modes().every((mode) => mode.querySelector('svg.composer-permission-mode-icon'))).toBe(true)
    expect(modes()[1]!.getAttribute('aria-label')).toBe('Auto-accept edits. Edits go ahead; commands ask first.')
    const selected = modes().filter((mode) => mode.getAttribute('aria-checked') === 'true')
    expect(selected.map(modeName)).toEqual(['Ask before acting'])
    expect(selected[0]!.classList.contains('selected')).toBe(true)
    expect(modes().map((mode) => Boolean(mode.querySelector('.composer-permission-mode-check svg')))).toEqual([true, false, false, false])
    // No mode carries a tint of its own.
    expect(modes().map((mode) => mode.classList.contains('is-full'))).toEqual([false, false, false, false])
    expect(permissionMenu()!.querySelector('.composer-mode-menu-heading')).toBeNull()
    act(() => modes()[3]!.click())
    expect(onPermission).toHaveBeenCalledWith('full')
    // The permission belongs to the thread: the model stays as it is.
    expect(onModelSelect).not.toHaveBeenCalled()
    expect(permissionMenu()).toBeNull()
  })

  it('opens the permission menu above the composer, not over the draft', () => {
    asComposer()
    render({ open: false })
    openPermissions()
    expect(permissionMenu()!.style.getPropertyValue('--floating-anchor-width')).toBe('640px')
  })

  it('hides Auto on an agent without an auto mode and shows a thread set to Auto as Auto-accept edits', () => {
    const { onPermission } = render({ mode: 'auto', auto: false, agent: 'Grok', open: false })
    expect(permissionButton().getAttribute('aria-label')).toBe('Permissions: Auto-accept edits')
    openPermissions()
    expect(modeNames()).toEqual(['Ask before acting', 'Auto-accept edits', 'Full access'])
    expect(modeName(modes().find((mode) => mode.getAttribute('aria-checked') === 'true')!)).toBe('Auto-accept edits')
    expect(document.body.textContent).not.toContain('no auto mode')
    act(() => modes()[1]!.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('keeps a mode above the limit in the list, dimmed, and says why on its row', () => {
    const { onPermission } = render({ mode: 'accept_edits', ceiling: 'accept_edits', open: false })
    openPermissions()
    const full = modes()[3]!
    expect(full.getAttribute('aria-disabled')).toBe('true')
    expect(full.classList.contains('is-disabled')).toBe(true)
    expect(modeLine(full)).toBe('This computer allows up to Auto-accept edits.')
    act(() => full.click())
    expect(onPermission).not.toHaveBeenCalled()
  })

  it('names an assigned model without opening anything, and keeps its permission chip', () => {
    const { onPermission } = render({ readOnly: true })
    expect(modelButton().disabled).toBe(true)
    expect(modelButton().getAttribute('aria-label')).toBe('Assigned model: Opus 5.5 High')
    expect(document.querySelector('.model-picker-row, [role="menu"][aria-label="Run options"]')).toBeNull()
    openPermissions()
    act(() => modes()[0]!.click())
    expect(onPermission).toHaveBeenCalledWith('ask')
    act(() => root.unmount())
    root = createRoot(host)
    render({ readOnly: true, permission: false, open: false })
    expect(modelButton().disabled).toBe(true)
    expect(host.querySelector('.composer-permission-chip')).toBeNull()
  })

  it('hides the permission chip and closes its menu while running or stoppable, then shows it again when idle', () => {
    render({ mode: 'ask', open: false })
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()
    openPermissions()
    expect(permissionMenu()).not.toBeNull()

    // Running: chip and open menu go away; the model button stays.
    render({ mode: 'ask', open: false, footer: { loading: true } })
    expect(host.querySelector('.composer-permission-chip')).toBeNull()
    expect(permissionMenu()).toBeNull()
    expect(modelButton()).not.toBeNull()

    // Waiting on an approval or question (stoppable without loading): still hidden.
    render({ mode: 'ask', open: false, footer: { loading: false, stoppable: true } })
    expect(host.querySelector('.composer-permission-chip')).toBeNull()

    // Turning the Labs toggle off shows the chip even while running or stoppable.
    act(() => useAppStore.setState({ hidePermissionsWhileRunning: false }))
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()
    render({ mode: 'ask', open: false, footer: { loading: true } })
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()

    // Turning it back on hides the chip again until the run stops or finishes.
    act(() => useAppStore.setState({ hidePermissionsWhileRunning: true }))
    expect(host.querySelector('.composer-permission-chip')).toBeNull()
    render({ mode: 'ask', open: false, footer: { loading: false, stoppable: false } })
    expect(host.querySelector('.composer-permission-chip')).not.toBeNull()
    expect(permissionMenu()).toBeNull()
  })
})

describe('composer send slot', () => {
  const actions = () => [...host.querySelectorAll<HTMLButtonElement>('.composer-footer-right button')].map((button) => button.getAttribute('aria-label'))
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`.composer-footer-right button[aria-label="${label}"]`)!
  const slot = (footer: Partial<ComposerFooterProps>) => {
    const handlers = { onSend: vi.fn(), onStop: vi.fn(), onStartRecording: vi.fn(), onStopRecording: vi.fn() }
    render({ open: false, footer: { ...handlers, ...footer } })
    return handlers
  }

  afterEach(() => useAppStore.setState({ appInfo: null }))

  it('shows one Stop during a run with an empty box, with the shortcut in its tooltip', () => {
    useAppStore.setState({ appInfo: { platform: 'win32' } as never })
    const { onStop } = slot({ loading: true })
    expect(actions()).toEqual(['Attach files', 'Dictate', 'Stop run'])
    expect(button('Stop run').title).toBe('Stop · Ctrl+Shift+Backspace')
    act(() => button('Stop run').click())
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('keeps Stop beside Queue once the box has text, and Stop does not send', () => {
    const { onStop, onSend } = slot({ loading: true, canSend: true })
    expect(actions()).toEqual(['Attach files', 'Dictate', 'Stop run', 'Queue message'])
    expect(button('Queue message').title).toContain('Steer ·')
    act(() => button('Stop run').click())
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    act(() => button('Queue message').click())
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('shows Stop while a run waits on an approval, beside Send when the box has text', () => {
    slot({ stoppable: true })
    expect(actions()).toEqual(['Attach files', 'Dictate', 'Stop run'])
    act(() => root.unmount())
    root = createRoot(host)
    slot({ stoppable: true, canSend: true })
    expect(actions()).toEqual(['Attach files', 'Dictate', 'Stop run', 'Send message'])
  })

  it('uses the macOS symbols in the Stop tooltip on a Mac', () => {
    useAppStore.setState({ appInfo: { platform: 'darwin' } as never })
    slot({ loading: true })
    expect(button('Stop run').title).toMatch(/^Stop · .*⌘/)
  })

  it('gives dictation its own button when idle, and keeps Send in the slot', () => {
    const { onStartRecording, onSend } = slot({})
    expect(actions()).toEqual(['Attach files', 'Dictate', 'Send message'])
    expect(button('Send message').disabled).toBe(true)
    act(() => button('Dictate').click())
    expect(onStartRecording).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('while recording, the footer holds only Cancel and Done', () => {
    const onCancelRecording = vi.fn()
    const { onStopRecording } = slot({ isRecording: true, onCancelRecording, recordingDuration: 75 })
    expect(actions()).toEqual(['Cancel recording', 'Finish recording'])
    // The run controls make way for the time and the wave.
    expect(host.querySelector('.composer-model-btn')).toBeNull()
    expect(host.querySelector('[role="group"][aria-label="Recording"]')?.textContent).toBe('1:15')
    act(() => button('Cancel recording').click())
    expect(onCancelRecording).toHaveBeenCalledTimes(1)
    expect(onStopRecording).not.toHaveBeenCalled()
    act(() => button('Finish recording').click())
    expect(onStopRecording).toHaveBeenCalledTimes(1)
  })

  it('while the recording turns into text, says so and waits', () => {
    slot({ transcribing: true, onCancelRecording: vi.fn() })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Transcribing…')
    expect(button('Cancel recording').disabled).toBe(true)
    expect(button('Finish recording').disabled).toBe(true)
  })
})

describe('composer send button', () => {
  const sendButton = () => host.querySelector<HTMLButtonElement>('.composer-action-btn-active')!

  it('says what sending does: send, queue, or what the parent names (answering open questions)', () => {
    render({ open: false, footer: { canSend: true } })
    expect(sendButton().getAttribute('aria-label')).toBe('Send message')
    render({ open: false, footer: { canSend: true, loading: true } })
    expect(sendButton().getAttribute('aria-label')).toBe('Queue message')
    render({ open: false, footer: { canSend: true, loading: true, sendLabel: 'Answer this question' } })
    expect(sendButton().getAttribute('aria-label')).toBe('Answer this question')
    expect(sendButton().title).toBe('Answer this question')
  })
})
