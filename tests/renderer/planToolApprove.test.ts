// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanTool } from '../../src/renderer/chat/components/agent-elements/tools/plan-tool'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const part = {
  state: 'output-available',
  input: { plan: { id: 'plans/storage.md', title: 'Settings storage', summary: '1. Add a projects key.\n2. Migrate old files.' } }
}

function stubOrchestrator(orchestrator: Record<string, unknown>): void {
  ;(window as unknown as { mousse: unknown }).mousse = { orchestrator }
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(PlanTool, { part })))
  // The Approve button is in the expanded plan.
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Expand plan"]')!.click() })
}

const approveButton = () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Approve')
const status = () => host.querySelector('[data-tool="plan"]')?.getAttribute('data-awaiting-approval')

async function approve(): Promise<void> {
  await act(async () => { approveButton()!.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  useAppStore.setState({ profileId: 'prf_test', activeThreadId: 'thread-a', loading: false })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { mousse?: unknown }).mousse
})

describe('plan approval', () => {
  it('marks the plan approved once the build request is sent', async () => {
    const sendToThread = vi.fn(async () => ({ message: '', actions: [] }))
    stubOrchestrator({ sendToThread, isTurnActive: vi.fn(async () => true) })
    await render()
    await approve()
    expect(sendToThread).toHaveBeenCalledWith('thread-a', expect.objectContaining({ mode: 'build' }))
    expect(host.textContent).toContain('Approved')
    expect(approveButton()).toBeUndefined()
    expect(useAppStore.getState().loading).toBe(true)
  })

  it('stays available to approve again when the send fails', async () => {
    stubOrchestrator({ sendToThread: vi.fn(async () => { throw new Error('service stopped') }), isTurnActive: vi.fn(async () => false) })
    await render()
    await approve()
    expect(host.textContent).toContain('Awaiting approval')
    expect(status()).toBe('true')
    expect(approveButton()?.disabled).toBe(false)
    expect(useAppStore.getState().loading).toBe(false)
  })

  it('stays available when the service refused the request', async () => {
    stubOrchestrator({
      sendToThread: vi.fn(async () => ({ message: '', actions: [], error: { code: 'thread_busy', message: 'Busy' }, requestAcknowledged: false })),
      isTurnActive: vi.fn(async () => false)
    })
    await render()
    await approve()
    expect(host.textContent).toContain('Awaiting approval')
    expect(approveButton()?.disabled).toBe(false)
    expect(useAppStore.getState().loading).toBe(false)
  })

  it("does not change another thread's busy state when the send settles after a switch", async () => {
    let resolveSend!: (value: unknown) => void
    stubOrchestrator({
      sendToThread: vi.fn(() => new Promise((resolve) => { resolveSend = resolve })),
      isTurnActive: vi.fn(async () => true)
    })
    await render()
    await approve()
    useAppStore.setState({ activeThreadId: 'thread-b', loading: false })
    await act(async () => { resolveSend({ message: '', actions: [] }) })
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(useAppStore.getState().loading).toBe(false)
  })
})
