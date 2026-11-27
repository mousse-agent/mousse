// @vitest-environment jsdom
/**
 * Add provider, once a provider is picked: one that signs in from Mousse offers that as its primary path
 * ("Continue with ChatGPT"), which adds it with its defaults and starts its sign-in with no step between, beside
 * Configure manually (the usual settings steps). One with no sign-in offers only Next. An agent already added is
 * offered again as "<Label> 2": another account, with a home of its own.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProviderDialog, type AddProviderHandlers } from '../../src/renderer/components/providers/AddProviderDialog'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { ProviderAddOption, ProviderOperationEvent } from '../../src/shared/harness/types'
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

function open(snapshots: InstanceSnapshot[], addOptions: ProviderAddOption[] = []) {
  const handlers = {
    add: vi.fn(async (driver: string) => `${driver}:added`),
    connectApi: vi.fn(async (option: ProviderAddOption) => option.instanceId),
    connectLocal: vi.fn(),
    signIn: vi.fn()
  } satisfies AddProviderHandlers
  const onFinished = vi.fn()
  const onClose = vi.fn()
  act(() => root.render(createElement(AddProviderDialog, { open: true, snapshots, addOptions, handlers, onClose, onFinished })))
  return { handlers, onFinished, onClose }
}

const choice = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === label)
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)
const footer = () => [...document.querySelectorAll<HTMLButtonElement>('.modal-footer button')].map((entry) => entry.textContent)
const click = async (element: HTMLElement | undefined) => {
  expect(element).toBeDefined()
  await act(async () => { element!.click() })
}

const antigravity = snapshot({ instanceId: 'antigravity', driver: 'antigravity', displayName: 'Google Antigravity', binary: { path: 'C:/agy/agy.exe', version: '1.5.17', source: 'path' } })

describe('the sign-in path of a picked provider', () => {
  it.each([
    ['Codex', 'Continue with ChatGPT'],
    ['Antigravity', 'Continue with Google'],
    ['Cursor', 'Continue with Cursor'],
    ['Grok', 'Continue with Grok']
  ])('offers %s with "%s" beside Configure manually', async (label, signIn) => {
    open([snapshot()])
    await click(choice(label))
    expect(footer()).toEqual(['Cancel', 'Configure manually', signIn])
  })

  it.each(['OpenCode', 'Custom command', 'Claude Code (API key)', 'Local models'])('offers %s, which has no sign-in from Mousse, with Next only', async (label) => {
    open([snapshot()])
    await click(choice(label))
    expect(footer()).toEqual(['Cancel', 'Next'])
  })

  it('adds the first Codex as Mousse-managed: its download starts and its sign-in opens', async () => {
    const { handlers, onFinished } = open([snapshot()])
    await click(choice('Codex'))
    await click(button('Continue with ChatGPT'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('codex', { displayName: 'Codex', setup: 'managed' })
    expect(install).toHaveBeenCalledWith('codex:added')
    expect(onFinished).toHaveBeenCalledWith('codex:added')
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('codex:added', 'Codex')
  })

  it('adds the first Claude Code on the person’s own setup, and signs in only if it is not signed in already', async () => {
    const { handlers } = open([snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })])
    await click(choice('Claude Code'))
    await click(button('Continue with Claude'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('claude', { displayName: 'Claude Code', home: 'default' })
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('claude:added', 'Claude Code', { unlessSignedIn: true })
  })

  it('Configure manually goes to the settings step and adds nothing', async () => {
    const { handlers } = open([snapshot()])
    await click(choice('Codex'))
    await click(button('Configure manually'))
    expect(handlers.add).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Provider: Codex')
    expect(document.querySelector('[aria-label="Setup"]')).not.toBeNull()
  })

  it('offers no sign-in path for an agent Mousse found missing with nothing to install', async () => {
    const missing = { ...antigravity, install: { state: 'not_installed' as const, canInstall: false }, binary: undefined, checkedAt: '2026-11-27T00:00:00.000Z' }
    open([snapshot(), missing])
    await click(choice('Antigravity 2'))
    expect(footer()).toEqual(['Cancel', 'Next'])
  })

  it('signs a model API in through its browser sign-in, and lands on its Connect step when that fails', async () => {
    const copilot: ProviderAddOption = { id: 'github-copilot', label: 'GitHub Copilot', methods: ['oauth'], add: { driver: 'pi', config: { provider: 'github-copilot' } }, instanceId: 'pi:github-copilot', added: false, hasSavedKey: false }
    const { handlers } = open([snapshot()], [copilot])
    handlers.connectApi.mockRejectedValueOnce(new Error('Sign-in was cancelled.'))
    await click(choice('GitHub Copilot'))
    await click(button('Continue with GitHub Copilot'))
    expect(handlers.connectApi).toHaveBeenCalledExactlyOnceWith(copilot, 'oauth', '')
    expect(document.body.textContent).toContain('Provider: GitHub Copilot')
    expect(document.body.textContent).toContain('Sign-in was cancelled.')
    expect(button('Sign in')).toBeDefined()
  })
})

describe('adding another account of an agent', () => {
  it('adds "Antigravity 2" with a home of its own and opens its sign-in, from the Provider step', async () => {
    const { handlers, onFinished } = open([snapshot(), antigravity])
    await click(choice('Antigravity 2'))
    await click(button('Continue with Google'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('antigravity', { displayName: 'Antigravity 2', home: 'private' })
    expect(onFinished).toHaveBeenCalledWith('antigravity:added')
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('antigravity:added', 'Antigravity 2', undefined)
    expect(install).not.toHaveBeenCalled()
  })

  it('adds it on a double-click too, with the executable the first entry was set to', async () => {
    const manual = snapshot({ binary: { path: 'D:/tools/claude.exe', version: '2.1.0', source: 'override' }, config: { home: 'default', args: [], env: {}, binaryPath: 'D:/tools/claude.exe' } })
    const { handlers } = open([manual])
    await act(async () => { choice('Claude Code 2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('claude', { displayName: 'Claude Code 2', home: 'private', binaryPath: 'D:/tools/claude.exe' })
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('claude:added', 'Claude Code 2', undefined)
  })

  it('adds a further Codex as managed: its download starts and its sign-in opens', async () => {
    const codex = snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })
    const { handlers } = open([snapshot(), codex])
    await click(choice('Codex 2'))
    await click(button('Continue with ChatGPT'))
    expect(handlers.add).toHaveBeenCalledExactlyOnceWith('codex', { displayName: 'Codex 2', setup: 'managed' })
    expect(install).toHaveBeenCalledWith('codex:added')
    expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('codex:added', 'Codex 2')
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
    await click(button('Continue with Google'))
    expect(install).toHaveBeenCalledWith('antigravity:added')
    expect(handlers.signIn).not.toHaveBeenCalled()
    await act(async () => { applyOperationEvent({ ...started, ...end } as ProviderOperationEvent) })
    if (signsIn) expect(handlers.signIn).toHaveBeenCalledExactlyOnceWith('antigravity:added', 'Antigravity 2', undefined)
    else expect(handlers.signIn).not.toHaveBeenCalled()
  })
})
