// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppTooltip } from '../../src/renderer/components/AppTooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let send: HTMLButtonElement
let titleBar: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  send = document.createElement('button')
  send.title = 'Send'
  titleBar = document.createElement('div')
  document.body.append(host, send, titleBar)
  root = createRoot(host)
  act(() => root.render(createElement(AppTooltip)))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})

const fire = (target: EventTarget, type: string) => act(() => { target.dispatchEvent(new Event(type, { bubbles: true })) })
const tooltip = () => document.querySelector('[role="tooltip"]')?.textContent ?? null
const flushObserver = () => act(async () => { await Promise.resolve() })
const hoverSend = () => {
  fire(send, 'pointerover')
  act(() => { vi.advanceTimersByTime(400) })
}

describe('the app tooltip', () => {
  it('shows the title of the element under the pointer', () => {
    hoverSend()
    expect(tooltip()).toBe('Send')
    expect(send.hasAttribute('title')).toBe(false)
  })

  it('closes on a key press and stays closed when the button changes under it', async () => {
    hoverSend()
    fire(document, 'keydown')
    expect(tooltip()).toBeNull()
    // Send turns into Stop and back while the run starts and ends.
    send.title = 'Stop'
    await flushObserver()
    send.title = 'Send'
    await flushObserver()
    expect(tooltip()).toBeNull()
    // The title is put back once the pointer leaves.
    fire(send, 'pointerout')
    expect(send.getAttribute('title')).toBe('Send')
  })

  it('closes on a click', () => {
    hoverSend()
    fire(send, 'pointerdown')
    expect(tooltip()).toBeNull()
  })

  it('closes when the pointer reaches an element without a title', () => {
    hoverSend()
    fire(titleBar, 'pointerover')
    expect(tooltip()).toBeNull()
    expect(send.getAttribute('title')).toBe('Send')
  })

  it('closes when its element is removed', async () => {
    hoverSend()
    send.remove()
    await flushObserver()
    expect(tooltip()).toBeNull()
  })

  it('follows a title that changes while it shows', async () => {
    hoverSend()
    send.title = 'Queue'
    await flushObserver()
    expect(tooltip()).toBe('Queue')
  })
})
