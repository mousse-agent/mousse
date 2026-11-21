// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyThreadLogo } from '../../src/renderer/components/EmptyThreadLogo'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useAppStore.setState({ activeThreadId: null, composerDrafts: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => vi.runAllTimers())
  vi.useRealTimers()
})

const copies = () => document.querySelectorAll('.empty-logo-pour-copy').length
const showLogo = (shown: boolean) => act(() => root.render(shown ? createElement(EmptyThreadLogo, { label: 'Mousse', incognito: false }) : null))
const setDraft = (threadId: string | null, text: string) => act(() => {
  const store = useAppStore.getState()
  if (text) store.setComposerDraft(threadId, text)
  else store.clearComposerDraft(threadId)
})
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe('the logo pour after a send', () => {
  it('plays once when the empty view leaves', () => {
    showLogo(true)
    setDraft(null, 'hello')
    setDraft(null, '')
    showLogo(false)
    wait(60)
    expect(copies()).toBe(1)
  })

  it('plays nothing when the draft is only cleared', () => {
    showLogo(true)
    setDraft(null, 'hello')
    setDraft(null, '')
    wait(1000)
    expect(copies()).toBe(0)
  })

  it('drops a waiting pour when its document goes away', () => {
    showLogo(true)
    setDraft(null, 'hello')
    setDraft(null, '')
    showLogo(false)

    vi.stubGlobal('document', undefined)
    try {
      vi.advanceTimersByTime(60)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(copies()).toBe(0)

    showLogo(true)
    setDraft(null, 'next message')
    setDraft(null, '')
    showLogo(false)
    wait(60)
    expect(copies()).toBe(1)
  })

  it('shows one logo at a time when the empty view leaves and comes back while the thread starts', () => {
    showLogo(true)
    setDraft(null, 'hello')
    // The new thread takes the draft, the blank one is cleared, and the empty view leaves for a moment.
    act(() => {
      const store = useAppStore.getState()
      store.setComposerDraft('t1', 'hello')
      store.clearComposerDraft(null)
      useAppStore.setState({ activeThreadId: 't1' })
    })
    showLogo(false)
    wait(60)
    // It comes back: no copy beside the logo.
    showLogo(true)
    expect(copies()).toBe(0)
    // The send clears the moved draft, then the turn starts and the empty view leaves for good.
    setDraft('t1', '')
    showLogo(false)
    wait(60)
    expect(copies()).toBe(1)
    // It flickers once more: still never two.
    showLogo(true)
    showLogo(false)
    wait(60)
    expect(copies()).toBe(1)
  })
})
