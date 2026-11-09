// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages } from '../../src/renderer/components/QueuedMessages'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../../src/renderer/components/ComposerNotice'
import { QUEUE_DRAFT_MOVED_NOTICE, useThreadQueue } from '../../src/renderer/hooks/useThreadQueue'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { QueuedMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const queued = (id: string, content: string, patch: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({ id, threadId: 't1', content, enqueuedAt: '2026-11-09T10:00:00Z', order: 1, intent: 'normal', state: 'pending', source: 'gui', ...patch }) as QueuedMessage
const image = { name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }
const workspaceKey = (profileId: string) => `mousse-profile-${profileId}-workspace`
const saved = (profileId: string) => JSON.parse(window.localStorage.getItem(workspaceKey(profileId)) ?? '{}') as { queueEditDrafts?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root
let push: ((event: { threadId: string; items: QueuedMessage[] }) => void) | null
let toComposer: ReturnType<typeof vi.fn>
let profile = 0
const original = useAppStore.getState()

function Chat() {
  const thread = useThreadQueue({ threadId: 't1', onDraftToComposer: toComposer })
  return createElement(Fragment, null,
    createElement(ComposerNoticeSource, { notice: thread.draftMoved ? { tone: 'info', title: QUEUE_DRAFT_MOVED_NOTICE, onDismiss: thread.dismissDraftMoved } : null }),
    createElement(ComposerNoticeSlot),
    createElement(QueuedMessages, { queue: thread }))
}

/** A reload: the profile's workspace is read back from storage, then the chat shows the thread's queue. */
const reloadWith = async (drafts: Record<string, unknown>, items: QueuedMessage[]) => {
  const profileId = `p${++profile}`
  window.localStorage.setItem(workspaceKey(profileId), JSON.stringify({ queueEditDrafts: drafts }))
  act(() => { useAppStore.getState().activateProfile(profileId) })
  act(() => root.render(createElement(ComposerNoticeProvider, null, createElement(Chat))))
  await act(async () => { push!({ threadId: 't1', items }) })
  return profileId
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  push = null
  toComposer = vi.fn()
  ;(window as unknown as { mousse: unknown }).mousse = {
    queue: {
      list: vi.fn(async () => []),
      edit: vi.fn(),
      onUpdated: (listener: typeof push) => { push = listener; return () => { push = null } }
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.localStorage.clear()
  useAppStore.setState(original, true)
})

describe('an open edit of a queued message across a reload', () => {
  it('is open again with its draft, and gets the message\'s images back from the queue', async () => {
    await reloadWith({ t1: { itemId: 'a', base: 'one', draft: 'one, edited', width: null } }, [queued('a', 'one', { images: [image] })])
    expect(host.querySelector<HTMLTextAreaElement>('[data-queued-id="a"] textarea')?.value).toBe('one, edited')
    expect(useAppStore.getState().queueEditDrafts.t1?.images).toEqual([image])
    expect(toComposer).not.toHaveBeenCalled()
  })

  it('goes to the composer when its message left the queue meanwhile, once', async () => {
    const profileId = await reloadWith({ t1: { itemId: 'a', base: 'one\n\n[Attached files: notes.txt]', draft: 'one, edited', width: null } }, [])
    expect(toComposer).toHaveBeenCalledWith('t1', { text: 'one, edited', markers: '[Attached files: notes.txt]' })
    expect(host.querySelector('.composer-notice')?.textContent).toContain(QUEUE_DRAFT_MOVED_NOTICE)
    // Taken out of the saved workspace as it was recovered: a later update or reload does not recover it again.
    expect(saved(profileId).queueEditDrafts).toEqual({})
    await act(async () => { push!({ threadId: 't1', items: [] }) })
    expect(toComposer).toHaveBeenCalledTimes(1)
  })

  it('is saved with the workspace without its images or a save in flight, and malformed entries are dropped', async () => {
    const profileId = await reloadWith({ bad: { itemId: 3 } }, [queued('a', 'one', { images: [image] })])
    expect(useAppStore.getState().queueEditDrafts).toEqual({})
    act(() => { useAppStore.getState().setQueueEditDraft('t1', { itemId: 'a', base: 'one', draft: 'one!', width: 200, images: [image], saving: true }) })
    expect(saved(profileId).queueEditDrafts).toEqual({ t1: { itemId: 'a', base: 'one', draft: 'one!', width: 200 } })
  })
})
