// @vitest-environment jsdom
/**
 * Add provider, for an agent already added: its further entry is offered as "<Label> 2", and picking it adds the
 * entry under that name (another account, with a home of its own) and starts its sign-in, with no step between.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProviderDialog, type AddProviderHandlers } from '../../src/renderer/components/providers/AddProviderDialog'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { ProviderOperationEvent } from '../../src/shared/harness/types'
import { applyOperationEvent } from '../../src/renderer/lib/providerSnapshots'
import { snapshot } from '../providerSnapshotFixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const install = vi.fn(async (_instanceId: string): Promise<{ operationId: string; instanceId: string; kind: 'install' }> => ({ operationId: 'install', instanceId: 'x', kind: 'install' }))
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  install.mockClear()
  ;(window as unknown as { mousse: unknown }).mousse = { providers: { instances: { install } } }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function open(snapshots: InstanceSnapshot[]) {
  const handlers = {
    add: vi.fn(async (driver: string) => `${driver}:added`),
    connectApi: vi.fn(),
    connectLocal: vi.fn(),
    signIn: vi.fn()
  } satisfies AddProviderHandlers
  const onFinished = vi.fn()
  const onClose = vi.fn()
  act(() => root.render(createElement(AddProviderDialog, { open: true, snapshots, addOptions: [], handlers, onClose, onFinished })))
  return { handlers, onFinished, onClose }
}

const choice = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === label)
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)
const click = async (element: HTMLElement | undefined) => {
  expect(element).toBeDefined()
  await act(async () => { element!.click() })
}

const antigravity = snapshot({ instanceId: 'antigravity', driver: 'antigravity', displayName: 'Google Antigravity', binary: { path: 'C:/agy/agy.exe', version: '1.5.17', source: 'path' } })

describe('adding another account of an agent', () => {
  it('adds "Antigravity 2" with a home of its own and opens its sign-in, from the Provider step', async () => {
    const { handlers, onFinished } = open([snapshot(), antigravity])
    await click(choice('Antigravity 2'))
    expect(button('Next')).toBeUndefined()
    await click(button('Add'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('antigravity', { displayName: 'Antigravity 2', home: 'private' })
    expect(onFinished).toHaveBeenCalledWith('antigravity:added')
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('antigravity:added', 'Antigravity 2')
    expect(install).not.toHaveBeenCalled()
  })

  it('adds it on a double-click too, with the executable the first entry was set to', async () => {
    const manual = snapshot({ binary: { path: 'D:/tools/claude.exe', version: '2.1.0', source: 'override' }, config: { home: 'default', args: [], env: {}, binaryPath: 'D:/tools/claude.exe' } })
    const { handlers } = open([manual])
    await act(async () => { choice('Claude Code 2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('claude', { displayName: 'Claude Code 2', home: 'private', binaryPath: 'D:/tools/claude.exe' })
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('claude:added', 'Claude Code 2')
  })

  it('adds a further ChatGPT subscription as managed: its download starts and its sign-in opens', async () => {
    const codex = snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })
    const { handlers } = open([snapshot(), codex])
    await click(choice('ChatGPT subscription 2'))
    await click(button('Add'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('codex', { displayName: 'ChatGPT subscription 2', setup: 'managed' })
    expect(install).toHaveBeenCalledWith('codex:added')
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('codex:added', 'ChatGPT subscription 2')
  })

  it.each([
    ['completed', { phase: 'completed' }, true],
    ['failed', { phase: 'failed', error: { code: 'protocol', message: 'Download failed' } }, false],
    ['cancelled', { phase: 'cancelled' }, false]
  ] as const)('when the agent is not on this computer yet, installs first and opens the sign-in only once the install %s', async (_name, end, signsIn) => {
    const missing = { ...antigravity, install: { state: 'not_installed' as const, canInstall: true }, binary: undefined }
    const started = { operationId: `install-${_name}`, instanceId: 'antigravity:added', kind: 'install' as const }
    install.mockResolvedValueOnce(started)
    const { handlers } = open([snapshot(), missing])
    await click(choice('Antigravity 2'))
    await click(button('Add'))
    expect(install).toHaveBeenCalledWith('antigravity:added')
    expect(handlers.signIn).not.toHaveBeenCalled()
    await act(async () => { applyOperationEvent({ ...started, ...end } as ProviderOperationEvent) })
    if (signsIn) expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('antigravity:added', 'Antigravity 2')
    else expect(handlers.signIn).not.toHaveBeenCalled()
  })

  it('keeps the first entry of an agent on the usual steps', async () => {
    const { handlers } = open([snapshot()])
    await click(choice('Antigravity'))
    expect(button('Add')).toBeUndefined()
    await click(button('Next'))
    expect(handlers.add).not.toHaveBeenCalled()
  })
})
