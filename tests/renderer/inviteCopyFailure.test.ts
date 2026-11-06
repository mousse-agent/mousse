// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InviteComputerDialog } from '../../src/renderer/components/devices/AddDeviceDialog'
import { COPY_FAILED, COPY_FAILED_SELECTED, CopyButton } from '../../src/renderer/components/settings/IconButtons'

const INVITATION = 'mj1_invitation_full_text_that_must_stay_whole'
let root: Root
let host: HTMLElement
const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const status = () => document.querySelector('[role="status"]')
const copyButton = () => document.querySelector<HTMLButtonElement>('button[title="Copy invitation"], button[title="Copied"]')!
const click = async (element: HTMLElement) => { await act(async () => element.click()) }

describe('Invitation copy', () => {
  const mountInvite = async () => {
    await act(async () => root.render(createElement(InviteComputerDialog, {
      invitation: { text: INVITATION, expiresAt: 10_000_000 },
      ready: true,
      busy: false,
      now: 0,
      onCreate: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })))
  }

  it('says a refused copy failed, selects the whole invitation, and a later copy says Copied', async () => {
    await mountInvite()
    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(copyButton())
    expect(writeText).toHaveBeenCalledWith(INVITATION)
    expect(status()?.textContent).toBe(COPY_FAILED_SELECTED)
    expect(status()?.className).toContain('failed')
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Device invitation"]')!
    expect(textarea.value).toBe(INVITATION)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe(INVITATION)

    writeText.mockResolvedValueOnce(undefined)
    await click(copyButton())
    expect(status()?.textContent).toBe('Copied')
    expect(status()?.className).not.toContain('failed')
  })

  it('treats a missing clipboard as a refused copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await mountInvite()
    await click(copyButton())
    expect(status()?.textContent).toBe(COPY_FAILED_SELECTED)
  })
})

describe('Icon-only copy', () => {
  it('names the failure on the button until the next try', async () => {
    await act(async () => root.render(createElement(CopyButton, { text: 'x', label: 'Copy command' })))
    const button = host.querySelector('button')!
    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(button)
    expect(button.getAttribute('aria-label')).toBe(COPY_FAILED)
    writeText.mockResolvedValueOnce(undefined)
    await click(button)
    expect(button.getAttribute('aria-label')).toBe('Copied')
  })
})
