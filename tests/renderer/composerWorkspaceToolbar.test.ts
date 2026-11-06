// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerWorkspaceToolbar } from '../../src/renderer/components/ComposerWorkspaceToolbar'
import type { ComposerWorkspace } from '../../src/renderer/lib/newThread'
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

function render(workspace: ComposerWorkspace) {
  const onChange = vi.fn()
  act(() => root.render(createElement(ComposerWorkspaceToolbar, {
    projects: [project],
    workspace,
    disabled: false,
    onChange,
    onOpenProject: async () => {},
    onError: () => {}
  })))
  return { onChange }
}

const worktree = () => host.querySelector<HTMLButtonElement>('[aria-label="Start in a worktree"]')

describe('composer workspace toolbar', () => {
  it('shows the worktree toggle only once a project is picked', () => {
    render({ worktreeEnabled: false })
    expect(worktree()).toBeNull()
    const { onChange } = render({ projectId: 'p1', worktreeEnabled: false })
    expect(worktree()!.getAttribute('aria-pressed')).toBe('false')
    expect(worktree()!.title).toBe('Worktree: Off')
    act(() => worktree()!.click())
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: true })
  })
})
