// @vitest-environment jsdom
/**
 * The shared secret row (Settings → Providers API key, Skills & MCP web search keys): a named,
 * empty password field with Save and Cancel; Saved after success, the typed key and the reason after
 * a failure, Escape to cancel.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVED_NOTICE_MS, SecretRow } from '../../src/renderer/components/settings/SecretRow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const field = () => host.querySelector<HTMLInputElement>('input')
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const status = () => host.querySelector('[role="status"]')?.textContent ?? ''
const desc = () => host.querySelector('.settings-item-desc')?.textContent ?? ''
const type = (value: string) =>
  act(() => {
    const input = field()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const press = (key: string) =>
  act(() => {
    field()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
const click = async (element: Element | null) => {
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

function show(props: Partial<Parameters<typeof SecretRow>[0]> = {}) {
  const onSave = vi.fn(async (_value: string) => {})
  act(() =>
    root.render(
      createElement(SecretRow, {
        title: 'API key',
        inputId: 'key',
        fieldLabel: 'New OpenRouter API key',
        description: 'Signed in',
        configured: true,
        onSave,
        ...props
      })
    )
  )
  return { onSave: (props.onSave as typeof onSave | undefined) ?? onSave }
}

describe('a saved secret', () => {
  it('is never shown: Replace opens an empty, named password field with Save and Cancel', async () => {
    show()
    expect(field()).toBeNull()
    await click(byLabel('Replace key'))
    expect(field()!.type).toBe('password')
    expect(field()!.value).toBe('')
    expect(field()!.getAttribute('aria-label')).toBe('New OpenRouter API key')
    expect(host.querySelector('label[for="key"]')?.textContent).toBe('API key')
    expect(document.activeElement).toBe(field())
    expect(byLabel('Cancel')).not.toBeNull()
    expect(byLabel('Save New OpenRouter API key')!.disabled).toBe(true)
  })

  it('says Saved after a save, to screen readers too, and closes the field', async () => {
    vi.useFakeTimers()
    const { onSave } = show()
    await click(byLabel('Replace key'))
    type(' sk-new ')
    await click(byLabel('Save New OpenRouter API key'))
    expect(onSave).toHaveBeenCalledWith('sk-new')
    expect(field()).toBeNull()
    expect(desc()).toContain('Saved')
    expect(status()).toBe('Saved')
    expect(document.activeElement).toBe(byLabel('Replace key'))
    act(() => vi.advanceTimersByTime(SAVED_NOTICE_MS + 10))
    expect(status()).toBe('')
    expect(desc()).toContain('Signed in')
  })

  it('keeps what was typed and says why when the save fails', async () => {
    show({ onSave: vi.fn(async () => { throw new Error('The key was refused.') }) })
    await click(byLabel('Replace key'))
    type('sk-wrong')
    press('Enter')
    await act(async () => {})
    expect(field()!.value).toBe('sk-wrong')
    expect(desc()).toContain('The key was refused.')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The key was refused.')
    expect(field()!.getAttribute('aria-invalid')).toBe('true')
    expect(status()).toBe('')
  })

  it('Escape cancels the replacement without saving, and leaves the page alone', async () => {
    const { onSave } = show()
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    await click(byLabel('Replace key'))
    type('sk-half')
    press('Escape')
    document.removeEventListener('keydown', outside)
    expect(field()).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
    expect(outside).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(byLabel('Replace key'))
    // Opened again, the field is empty.
    await click(byLabel('Replace key'))
    expect(field()!.value).toBe('')
  })

  it('without a saved key the field stays open, with no Cancel', async () => {
    show({ configured: false, description: 'Not connected' })
    expect(field()).not.toBeNull()
    expect(byLabel('Cancel')).toBeNull()
    expect(byLabel('Replace key')).toBeNull()
  })

  it('a guided key runs its sign-in from Replace instead of opening the field', async () => {
    const onReplace = vi.fn(async () => {})
    const { onSave } = show({ onReplace })
    await click(byLabel('Replace key'))
    expect(onReplace).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
    expect(field()).toBeNull()
  })
})
