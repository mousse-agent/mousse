// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerWorkspaceToolbar, type ComposerDeviceProps } from '../../src/renderer/components/ComposerWorkspaceToolbar'
import type { Device } from '../../src/renderer/lib/netDevices'
import type { ComposerWorkspace } from '../../src/renderer/lib/newThread'
import type { NodeId } from '../../src/shared/net'
import type { Project } from '../../src/shared/types'

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

const project: Project = { id: 'p1', name: 'acme-web', path: '/work/acme-web', createdAt: '2026-11-01T00:00:00Z', order: 0 }

function computer(node: string, name: string, self = false): Device {
  return { node: node as NodeId, name, caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self, revoked: false, state: 'open' }
}

function deviceProps(devices: Device[]): ComposerDeviceProps {
  return {
    localName: 'Studio Mac',
    devices,
    onRefresh: () => {},
    onSelect: () => {},
    onOpenRemoteProject: async () => undefined
  }
}

function render(workspace: ComposerWorkspace, device?: ComposerDeviceProps) {
  const onChange = vi.fn()
  act(() => root.render(createElement(ComposerWorkspaceToolbar, {
    projects: [project],
    workspace,
    disabled: false,
    device,
    onChange,
    onOpenProject: async () => {},
    onError: () => {}
  })))
  return { onChange }
}

const workspaceChoice = () => host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Where to work"]')
const option = (name: string) => Array.from(workspaceChoice()!.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  .find((button) => button.textContent === name)!
const computerButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Run on"]')

describe('composer workspace toolbar', () => {
  it('offers Local or Worktree only once a project is picked', () => {
    render({ worktreeEnabled: false })
    expect(workspaceChoice()).toBeNull()
    const { onChange } = render({ projectId: 'p1', worktreeEnabled: false })
    expect(option('Local').getAttribute('aria-checked')).toBe('true')
    expect(option('Worktree').getAttribute('aria-checked')).toBe('false')
    act(() => option('Worktree').click())
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: true })
  })

  it('goes back to the current checkout from Worktree', () => {
    const { onChange } = render({ projectId: 'p1', worktreeEnabled: true })
    expect(option('Worktree').getAttribute('aria-checked')).toBe('true')
    act(() => option('Local').click())
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: false })
  })

  it('ends the project menu with "Add project"', () => {
    render({ projectId: 'p1', worktreeEnabled: false })
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Project"]')!.click())
    const add = document.querySelector('[role="menu"][aria-label="Select project"] [data-project-id="__open_project__"]')
    expect(add!.textContent).toBe('Add project')
  })

  it('reads "This computer", not a menu, when there is no other one to pick', () => {
    for (const device of [undefined, deviceProps([computer('n-self', 'Studio Mac', true)])]) {
      render({ projectId: 'p1', worktreeEnabled: false }, device)
      const item = host.querySelector<HTMLElement>('[aria-label="Runs on this computer"]')!
      expect(item.textContent).toBe('This computer')
      expect(item.tagName).not.toBe('BUTTON')
      expect(item.querySelector('button')).toBeNull()
      expect(item.querySelector('svg')).not.toBeNull()
      expect(computerButton()).toBeNull()
    }
  })

  it('offers the computer when another one is connected', () => {
    render({ projectId: 'p1', worktreeEnabled: false }, deviceProps([computer('n-self', 'Studio Mac', true), computer('n-linux', 'Build Linux')]))
    expect(computerButton()!.textContent).toBe('Studio Mac')
    expect(computerButton()!.getAttribute('aria-haspopup')).toBe('menu')
    expect(host.querySelector('[aria-label="Runs on this computer"]')).toBeNull()
  })
})
