// @vitest-environment jsdom
/**
 * Antigravity in the composer's model picker: every model it offers is a row of its own, and every
 * row shows Antigravity's logo, whoever made the model (Gemini, Claude, GPT-OSS).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerFooter, type ComposerFooterProps, type ComposerRunProps } from '../../src/renderer/components/ComposerFooter'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'

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

/** The models native `agy` listed for a signed-in account on 2026-11-26 (ids and names as it sent them). */
const AGY_MODELS: Array<[string, string]> = [
  ['gemini-4-neon', 'Gemini 4 Neon'],
  ['gemini-4-carbon', 'Gemini 4 Carbon'],
  ['gemini-4-argon', 'Gemini 4 Argon'],
  ['gemini-4-hydrogen', 'Gemini 4 Hydrogen'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)']
]

const antigravity: ProviderWithStatus = {
  id: 'antigravity',
  instanceId: 'antigravity',
  label: 'Google Antigravity',
  models: AGY_MODELS.map(([id, label]) => ({ id, label })),
  caps: { toolControl: 'exact', autoPermissionMode: false, contextUsage: 'none' } as ProviderWithStatus['caps']
}

function openPicker(onModelSelect = vi.fn()) {
  const props: ComposerFooterProps = {
    run: {
      providers: [antigravity],
      selectedProviderId: 'antigravity',
      selectedInstanceId: 'antigravity',
      selectedModelId: 'gemini-4-neon',
      modelMenuOpen: true,
      onModelMenuOpenChange: vi.fn(),
      onModelSelect,
      modelReadOnly: false,
      onOpenSettings: vi.fn(),
      contextUsage: { used: 0, limit: 0, percent: 0 } as unknown as ComposerRunProps['contextUsage'],
      contextOpen: false,
      onContextOpenChange: vi.fn()
    } as ComposerRunProps,
    onAttachClick: vi.fn()
  }
  act(() => root.render(createElement(ComposerFooter, props)))
  return onModelSelect
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.model-picker-row-main[role="option"]')]
const titleOf = (row: HTMLElement) => row.querySelector('.model-picker-row-title')?.textContent ?? ''

describe('Antigravity in the model picker', () => {
  it('lists every model agy offers, the three Orchestrators each on its own row', () => {
    const onModelSelect = openPicker()
    const titles = rows().map(titleOf)
    expect(titles).toHaveLength(AGY_MODELS.length)
    expect(titles).toEqual(expect.arrayContaining(['Orchestrator (Neon)', 'Orchestrator (Carbon)', 'Orchestrator (Argon)', 'Claude Opus 5.5']))
    act(() => rows().find((row) => titleOf(row) === 'Orchestrator (Argon)')!.click())
    expect(onModelSelect).toHaveBeenCalledWith('antigravity', 'gemini-pro-orchestrator-argon', 'antigravity')
  })

  it("shows Antigravity's logo on every row, whoever made the model", () => {
    openPicker()
    const logos = rows().map((row) => row.querySelector('[data-provider-icon]')?.getAttribute('data-provider-icon'))
    expect(logos).toHaveLength(AGY_MODELS.length)
    expect(new Set(logos)).toEqual(new Set(['antigravity']))
  })
})
