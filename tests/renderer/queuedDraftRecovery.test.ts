// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreQueuedDraft, type QueuedImageFetch } from '../../src/renderer/lib/queuedDraftRecovery'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { formatBrowserElementBlock } from '../../src/renderer/utils/messageAttachments'
import { formatChatReferences, type ChatReference } from '../../src/shared/chatReferences'

const original = useAppStore.getState()
const reference: ChatReference = { id: 'file:1', kind: 'file', title: 'money.ts', path: 'src/money.ts' }
const element = { url: 'https://shop.test/checkout', selector: '#pay', tagName: 'button', text: 'Pay now' }

describe('an unsaved edit of a queued message, back in the composer', () => {
  beforeEach(() => {
    useAppStore.setState({ composerDrafts: { t1: 'already typed' }, composerReferences: {}, browserElementAttachmentsByThread: {} })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview') }))
  })
  afterEach(() => {
    useAppStore.setState(original, true)
    vi.unstubAllGlobals()
  })

  it("gets the message's image as an attached file, its references and browser element back, and keeps what the composer had", async () => {
    const addFiles = vi.fn()
    const markers = ['[Attached files: notes.txt]', formatBrowserElementBlock(element), formatChatReferences([reference])].join('\n\n')
    await restoreQueuedDraft('t1', { text: 'Look at that', markers, images: [{ name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }] }, addFiles)

    const state = useAppStore.getState()
    // The file names it cannot rebuild stay as the text the agent reads.
    expect(state.composerDrafts.t1).toBe('already typed\nLook at that\n\n[Attached files: notes.txt]')
    expect(state.composerReferences.t1).toEqual([expect.objectContaining({ id: 'file:1', kind: 'file', title: 'money.ts', path: 'src/money.ts' })])
    expect(state.browserElementAttachmentsByThread.t1).toEqual([expect.objectContaining({ url: element.url, selector: '#pay', tagName: 'button', text: 'Pay now' })])

    expect(addFiles).toHaveBeenCalledTimes(1)
    const [thread, files] = addFiles.mock.calls[0]!
    expect(thread).toBe('t1')
    expect(files).toHaveLength(1)
    expect(files[0].file.name).toBe('shot.png')
    expect(files[0].file.type).toBe('image/png')
    expect(await files[0].file.text()).toBe('png bytes')
    expect(files[0].previewUrl).toBe('blob:preview')
  })

  it('gives files sent with paths back as attached files that keep their paths, not as text', async () => {
    const addFiles = vi.fn()
    await restoreQueuedDraft('t1', { text: 'Cut it', markers: '[Attached files: clip.mp4 (/tmp/mousse-attachments/t1/1a2b3c4d-clip.mp4), b.pdf (C:\\docs\\b.pdf)]' }, addFiles)
    expect(useAppStore.getState().composerDrafts.t1).toBe('already typed\nCut it')
    const [, files] = addFiles.mock.calls[0]!
    expect(files.map((attached: { file: File; path?: string }) => [attached.file.name, attached.path])).toEqual([
      ['clip.mp4', '/tmp/mousse-attachments/t1/1a2b3c4d-clip.mp4'],
      ['b.pdf', 'C:\\docs\\b.pdf']
    ])
  })

  it('leaves the composer text alone when only the images come back', async () => {
    const addFiles = vi.fn()
    await restoreQueuedDraft('t1', { text: '', markers: '', images: [{ name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }] }, addFiles)
    expect(useAppStore.getState().composerDrafts.t1).toBe('already typed')
    expect(addFiles).toHaveBeenCalledTimes(1)
  })

  it('fills an empty composer with the text alone and adds no files when the message had none', async () => {
    useAppStore.setState({ composerDrafts: {} })
    const addFiles = vi.fn()
    await restoreQueuedDraft('t2', { text: 'Then deploy', markers: '' }, addFiles)
    expect(useAppStore.getState().composerDrafts.t2).toBe('Then deploy')
    expect(addFiles).not.toHaveBeenCalled()
  })

  // A queue list sends large images by name only. Inputs: the queued message still waits (fetched from the queue), it
  // started (fetched from the message it became), and neither answers (counted, never dropped silently).
  it('fetches images that came by name only, and says how many could not be restored', async () => {
    const bytes = (name: string) => ({ name, mimeType: 'image/png', data: btoa(`${name} bytes`) })
    const fetch: QueuedImageFetch = {
      fromQueue: vi.fn(async (_thread, _item, index) => { if (index === 0) return bytes('waiting.png'); throw new Error('not in the queue') }),
      fromMessage: vi.fn(async (_thread, _message, index) => { if (index === 1) return bytes('started.png'); throw new Error('no such image') }),
      startedMessageId: vi.fn(() => 'message-7')
    }
    const addFiles = vi.fn()
    const lost = vi.fn()
    const named = (name: string) => ({ name, mimeType: 'image/png' }) as never
    await restoreQueuedDraft('t1', { text: 'Again', markers: '', itemId: 'item-3', images: [named('waiting.png'), named('started.png'), named('gone.png')] }, addFiles, lost, fetch)

    expect(fetch.fromQueue).toHaveBeenCalledWith('t1', 'item-3', 0)
    expect(fetch.fromMessage).toHaveBeenCalledWith('t1', 'message-7', 1)
    const [, files] = addFiles.mock.calls[0]!
    expect(await Promise.all(files.map((attached: { file: File }) => attached.file.text()))).toEqual(['waiting.png bytes', 'started.png bytes'])
    expect(lost).toHaveBeenCalledWith(1)
  })
})
