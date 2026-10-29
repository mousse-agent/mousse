// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryOf, WorkspaceRecoveryBanner, WorkspaceRecoveryBannerView, type WorkspaceRecoveryBannerViewProps } from '../../src/renderer/chat/components/WorkspaceRecoveryBanner'
import type { WorkspaceRecovery } from '../../src/shared/workspace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const branchCase: WorkspaceRecovery = {
  reason: 'The worktree is on branch agent/task instead of mousse/thread/t1/main.',
  operationId: 'op-1',
  operationType: 'action-checkpoint',
  branch: { expected: 'mousse/thread/t1/main', actual: 'agent/task' }
}
const otherCase: WorkspaceRecovery = { reason: 'Workspace history diverged during execution; recovery is required.', operationId: 'op-2', operationType: 'action-checkpoint' }

let root: Root
let host: HTMLElement
const mousse = { workspace: { getStatus: vi.fn() }, operations: { recover: vi.fn() } }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mousse.workspace.getStatus.mockReset()
  mousse.operations.recover.mockReset()
  ;(window as unknown as { mousse: unknown }).mousse = mousse
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const text = () => host.textContent ?? ''
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

function view(recovery: WorkspaceRecovery, patch: Partial<WorkspaceRecoveryBannerViewProps> = {}) {
  const props: WorkspaceRecoveryBannerViewProps = { recovery, busy: null, error: null, onSwitchBack: vi.fn(), onRecover: vi.fn(), ...patch }
  act(() => root.render(createElement(WorkspaceRecoveryBannerView, props)))
  return props
}

describe('the workspace recovery banner', () => {
  it('names the branch the agent switched to and offers to switch back', () => {
    const props = view(branchCase)
    expect(text()).toContain('This thread is paused because the agent switched its worktree to agent/task.')
    expect(text()).toContain('Your commits stay on agent/task.')
    expect(text()).toContain('returns the worktree to mousse/thread/t1/main')
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Switch back and continue'])
    click(buttons()[0])
    expect(props.onSwitchBack).toHaveBeenCalledTimes(1)
    expect(props.onRecover).not.toHaveBeenCalled()
  })

  it('gives the reason and a generic Try recovery for anything else', () => {
    const props = view(otherCase)
    expect(text()).toContain('This thread is paused because its worktree needs recovery.')
    expect(text()).toContain('Workspace history diverged during execution; recovery is required.')
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Try recovery'])
    click(buttons()[0])
    expect(props.onRecover).toHaveBeenCalledTimes(1)
    expect(props.onSwitchBack).not.toHaveBeenCalled()
  })

  it('ignores presses while one is in flight and shows a failure', () => {
    const props = view(branchCase, { busy: 'switch', error: 'agent/task has uncommitted changes (a.txt). Commit or discard them, then switch back.' })
    expect(buttons()[0].textContent).toBe('Switching…')
    click(buttons()[0])
    expect(props.onSwitchBack).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('has uncommitted changes')
  })
})

describe('reading the recovery of a workspace status', () => {
  it('keeps the reason, the operation and the branches, and ignores anything malformed', () => {
    expect(recoveryOf({ recovery: branchCase })).toEqual(branchCase)
    expect(recoveryOf({ recovery: otherCase })).toEqual(otherCase)
    expect(recoveryOf({ recovery: { reason: 'x', branch: { expected: 'a' } } })).toEqual({ reason: 'x' })
    expect(recoveryOf({ recovery: { operationId: 'x' } })).toBeUndefined()
    expect(recoveryOf({ metadata: {} })).toBeUndefined()
    expect(recoveryOf(null)).toBeUndefined()
  })
})

describe('the banner of a thread', () => {
  it('shows only while the workspace needs recovery', async () => {
    mousse.workspace.getStatus.mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
    expect(mousse.workspace.getStatus).toHaveBeenCalledWith('t1')
  })

  it('switches back with one press, then goes away once the workspace is ready', async () => {
    mousse.workspace.getStatus.mockResolvedValueOnce({ recovery: branchCase }).mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    mousse.operations.recover.mockResolvedValue({ ok: true, switchedFrom: 'agent/task' })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    expect(text()).toContain('Your commits stay on agent/task.')
    click(buttons()[0])
    await settle()
    await settle()
    expect(mousse.operations.recover).toHaveBeenCalledExactlyOnceWith('t1', { switchBack: true })
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
  })

  it('calls plain recovery for other reasons and shows the refusal in the banner', async () => {
    mousse.workspace.getStatus.mockResolvedValue({ recovery: otherCase })
    mousse.operations.recover.mockRejectedValue(new Error("Error invoking remote method 'operations:recover': Interrupted commit needs recovery: it landed and the workspace still has uncommitted changes."))
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    click(buttons()[0])
    await settle()
    await settle()
    expect(mousse.operations.recover).toHaveBeenCalledExactlyOnceWith('t1', undefined)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Interrupted commit needs recovery: it landed and the workspace still has uncommitted changes.')
    expect(buttons()[0].textContent).toBe('Try recovery')
  })

  it('reads the status again while shown, so a fix made by hand clears it', async () => {
    vi.useFakeTimers()
    mousse.workspace.getStatus.mockResolvedValueOnce({ recovery: otherCase }).mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    expect(host.querySelector('.chat-workspace-recovery')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500) })
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
  })
})
