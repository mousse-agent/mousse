// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { MoveProviderDialog } from '../../src/renderer/components/providers/MoveProviderDialog'

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

const anthropic = {
  instanceId: 'pi:anthropic',
  driver: 'pi',
  displayName: 'Anthropic',
  auth: { state: 'signed_in', methodLabel: 'API key' },
  config: { home: 'default', args: [], env: {} }
} as unknown as InstanceSnapshot
const keyEntry = { instanceId: 'claude:api', driver: 'claude', displayName: 'Claude Code (API key)', config: { home: 'private', args: [], env: {}, loginMethod: 'api_key' } } as unknown as InstanceSnapshot

const moveButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Move')!
const copyBox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!

describe('the Move dialog for pi:anthropic', () => {
  it('starts with "Copy my API key" ticked and adds Claude Code (API key) when there is none', async () => {
    const onMove = vi.fn(async () => ({ from: 'pi:anthropic', to: 'claude:api', rewritten: [] }))
    act(() => root.render(createElement(MoveProviderDialog, { snapshot: anthropic, targets: [], agentLabel: 'Claude Code', onMove, onClose: () => {} })))
    expect(copyBox().checked).toBe(true)
    expect(document.body.textContent).toContain('Claude Code (API key) (new)')
    expect(document.body.textContent).toContain('your own Claude Code setup is not changed')
    await act(async () => moveButton().click())
    expect(onMove).toHaveBeenCalledWith(null, { copyKey: true })
  })

  it('a retry after a failed try moves to the entry that try added, never adding another', async () => {
    const onMove = vi.fn(async (_to: string | null) => {
      throw new Error('This is a Claude subscription token, not an API key.')
    })
    const props = { snapshot: anthropic, agentLabel: 'Claude Code', onMove, onClose: () => {} }
    act(() => root.render(createElement(MoveProviderDialog, { ...props, targets: [] })))
    await act(async () => moveButton().click())
    expect(onMove).toHaveBeenLastCalledWith(null, { copyKey: true })
    expect(document.body.textContent).toContain('subscription token')
    // The failed try added the entry: the dialog now lists it, and the retry goes there.
    act(() => root.render(createElement(MoveProviderDialog, { ...props, targets: [keyEntry] })))
    act(() => copyBox().click())
    await act(async () => moveButton().click())
    expect(onMove).toHaveBeenLastCalledWith('claude:api', { copyKey: false })
  })
})
