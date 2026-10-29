// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerPermissionPicker } from '../../src/renderer/components/ComposerPermissionPicker'
import type { PermissionMode } from '../../src/shared/permissionMode'

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
})

function open(mode: PermissionMode, autoPermissionMode: boolean, onSelect = vi.fn()) {
  act(() => root.render(createElement(ComposerPermissionPicker, { mode, agent: autoPermissionMode ? 'Claude Code' : 'Grok', caps: { toolControl: 'exact', autoPermissionMode }, onSelect })))
  act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  return onSelect
}

const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
const labels = () => items().map((item) => item.querySelector('.composer-mode-menu-item-text > span')!.textContent)
const checked = () => items().find((item) => item.getAttribute('aria-checked') === 'true')?.querySelector('.composer-mode-menu-item-text > span')!.textContent

describe('ComposerPermissionPicker and Auto', () => {
  it('offers Auto on an agent with an auto mode', () => {
    open('auto', true)
    expect(labels()).toContain('Auto')
    expect(checked()).toBe('Auto')
  })

  it('hides Auto on an agent without one and shows a thread set to Auto as Auto-accept edits', () => {
    const onSelect = open('auto', false)
    expect(labels()).not.toContain('Auto')
    expect(checked()).toBe('Auto-accept edits')
    expect(host.querySelector('button')!.textContent).toContain('Auto-accept edits')
    expect(document.body.textContent).not.toContain('no auto mode')
    act(() => items().find((item) => item.textContent?.startsWith('Auto-accept edits'))!.click())
    expect(onSelect).not.toHaveBeenCalled()
  })
})
