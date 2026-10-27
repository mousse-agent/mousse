// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoveProviderDialog } from '../../src/renderer/components/providers/MoveProviderDialog'
import { snapshot } from '../providerSnapshotFixture'

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

const noop = async () => undefined
/** A retired Cursor model API entry signed in with an API key. */
const retiredCursor = snapshot({
  instanceId: 'pi:cursor',
  driver: 'pi',
  displayName: 'Cursor',
  auth: { state: 'signed_in', account: undefined, methodLabel: 'API key' },
  nextStep: { action: 'move', label: 'Move', title: 'Retired by this update', detail: 'Move to Cursor to keep chatting. Your chats stay.' }
})
const agent = (overrides: Parameters<typeof snapshot>[0] = {}) =>
  snapshot({ instanceId: 'cursor', driver: 'cursor', displayName: 'Cursor agent', auth: { state: 'signed_out', account: undefined, canSignIn: true, canTakeKey: true }, ...overrides })

function show(target: ReturnType<typeof agent>) {
  act(() => root.render(createElement(MoveProviderDialog, { snapshot: retiredCursor, targets: [target], agentLabel: 'Cursor', onMove: noop as never, onSignIn: noop, onRecheck: noop, onClose: () => {} })))
  const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  act(() => box.click())
  const move = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Move')!
  return { move, text: document.body.textContent ?? '' }
}

describe('Moving a retired entry with its API key copied', () => {
  it('is ready once the box is ticked when the agent is installed, with no separate sign-in', () => {
    const { move, text } = show(agent())
    expect(move.disabled).toBe(false)
    expect(text).not.toContain('Sign in to Cursor agent first')
  })

  it('keeps the install step, and Move off, while the agent is not installed', () => {
    const { move, text } = show(agent({ install: { state: 'not_installed', canInstall: true } }))
    expect(text).toContain('Install Cursor agent first')
    expect(move.disabled).toBe(true)
  })
})
