// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryOf, WorkspaceRecoveryBanner, WorkspaceRecoveryBannerView, type WorkspaceRecoveryBannerViewProps } from '../../src/renderer/chat/components/WorkspaceRecoveryBanner'
import type { WorkspaceRecovery } from '../../src/shared/workspace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const paused: WorkspaceRecovery = { kind: 'paused', reason: "error: Entry 'value.txt' not uptodate. Cannot merge.", operationId: 'undo-1', operationType: 'undo' }
const merge: WorkspaceRecovery = {
  kind: 'merge',
  reason: 'A merge from an earlier version of Mousse is still in progress in /work/app. Abort it, or finish it with Git.',
  folder: '/work/app', operationId: 'old-publish', operationType: 'publish'
}
const publish: WorkspaceRecovery = { kind: 'publish', reason: 'A Publish did not finish.', operationId: 'publish-1', operationType: 'publish' }

let root: Root
let host: HTMLElement
const mousse = { workspace: { getStatus: vi.fn() }, operations: { recover: vi.fn(), abort: vi.fn() } }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mousse.workspace.getStatus.mockReset()
  mousse.operations.recover.mockReset()
  mousse.operations.abort.mockReset()
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
  const props: WorkspaceRecoveryBannerViewProps = { recovery, busy: null, error: null, onRecover: vi.fn(), onAbort: vi.fn(), ...patch }
  act(() => root.render(createElement(WorkspaceRecoveryBannerView, props)))
  return props
}

describe('the workspace recovery banner', () => {
  it('says a thread is paused, gives the reason, and offers Try recovery', () => {
    const props = view(paused)
    expect(text()).toContain('This thread is paused until its worktree is recovered.')
    expect(text()).toContain("error: Entry 'value.txt' not uptodate. Cannot merge.")
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Try recovery'])
    click(buttons()[0])
    expect(props.onRecover).toHaveBeenCalledTimes(1)
    expect(props.onAbort).not.toHaveBeenCalled()
  })

  it('names the folder of a merge an earlier version left and offers to abort it', () => {
    const props = view(merge)
    expect(text()).toContain('A merge from an earlier version of Mousse is still in progress.')
    expect(text()).toContain('in /work/app. Abort it, or finish it with Git.')
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Abort the merge'])
    click(buttons()[0])
    expect(props.onAbort).toHaveBeenCalledTimes(1)
    expect(props.onRecover).not.toHaveBeenCalled()
  })

  it('says a Publish did not finish and that turns keep working', () => {
    view(publish)
    expect(text()).toContain('A Publish did not finish.')
    expect(text()).toContain('Recovery checks whether it reached the branch and records what happened. Turns keep working meanwhile.')
    expect(text()).not.toContain('paused')
    expect(buttons().map((entry) => entry.textContent)).toEqual(['Try recovery'])
  })

  it('never offers to switch branches', () => {
    for (const recovery of [paused, merge, publish]) {
      view(recovery)
      expect(text()).not.toMatch(/switch/i)
    }
  })

  it('ignores presses while one is in flight and shows a failure', () => {
    const props = view(merge, { busy: 'abort', error: 'The matching Git sequencer is no longer active.' })
    expect(buttons()[0].textContent).toBe('Aborting…')
    click(buttons()[0])
    expect(props.onAbort).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The matching Git sequencer is no longer active.')
  })
})

describe('reading the recovery of a workspace status', () => {
  it('keeps the kind, the reason, the operation and the folder, and ignores anything malformed', () => {
    expect(recoveryOf({ recovery: paused })).toEqual(paused)
    expect(recoveryOf({ recovery: merge })).toEqual(merge)
    expect(recoveryOf({ recovery: publish })).toEqual(publish)
    // A merge without the operation to abort cannot offer its button.
    expect(recoveryOf({ recovery: { kind: 'merge', reason: 'x' } })).toBeUndefined()
    // A daemon from before kinds only reported a paused thread; anything it sends that is not a kind reads as one.
    expect(recoveryOf({ recovery: { reason: 'x', branch: { expected: 'a', actual: 'b' } } })).toEqual({ kind: 'paused', reason: 'x' })
    expect(recoveryOf({ recovery: { operationId: 'x' } })).toBeUndefined()
    expect(recoveryOf({ metadata: {} })).toBeUndefined()
    expect(recoveryOf(null)).toBeUndefined()
  })
})

describe('the banner of a thread', () => {
  it('shows only while something waits', async () => {
    mousse.workspace.getStatus.mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
    expect(mousse.workspace.getStatus).toHaveBeenCalledWith('t1')
  })

  it('aborts a left merge with one press, by its operation, then goes away', async () => {
    mousse.workspace.getStatus.mockResolvedValueOnce({ recovery: merge }).mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    mousse.operations.abort.mockResolvedValue({ ok: true })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    click(buttons()[0])
    await settle()
    await settle()
    expect(mousse.operations.abort).toHaveBeenCalledExactlyOnceWith({ threadId: 't1', operationId: 'old-publish' })
    expect(mousse.operations.recover).not.toHaveBeenCalled()
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
  })

  it('settles a Publish that did not finish with plain recovery', async () => {
    mousse.workspace.getStatus.mockResolvedValueOnce({ recovery: publish }).mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    mousse.operations.recover.mockResolvedValue({ ok: true })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    click(buttons()[0])
    await settle()
    await settle()
    expect(mousse.operations.recover).toHaveBeenCalledExactlyOnceWith('t1')
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
  })

  it('shows a refused recovery in the banner and keeps the button', async () => {
    mousse.workspace.getStatus.mockResolvedValue({ recovery: paused })
    mousse.operations.recover.mockRejectedValue(new Error("Error invoking remote method 'operations:recover': Undo recovery intent is missing."))
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    click(buttons()[0])
    await settle()
    await settle()
    expect(mousse.operations.recover).toHaveBeenCalledExactlyOnceWith('t1')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Undo recovery intent is missing.')
    expect(buttons()[0].textContent).toBe('Try recovery')
  })

  it('reads the status again while shown, so a fix made by hand clears it', async () => {
    vi.useFakeTimers()
    mousse.workspace.getStatus.mockResolvedValueOnce({ recovery: paused }).mockResolvedValue({ metadata: { lifecycle: 'ready' } })
    act(() => root.render(createElement(WorkspaceRecoveryBanner, { threadId: 't1' })))
    await settle()
    expect(host.querySelector('.chat-workspace-recovery')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500) })
    expect(host.querySelector('.chat-workspace-recovery')).toBeNull()
  })
})
