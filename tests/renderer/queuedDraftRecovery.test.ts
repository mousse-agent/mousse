// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreQueuedDraft } from '../../src/renderer/lib/queuedDraftRecovery'
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
    restoreQueuedDraft('t1', { text: 'Look at that', markers, images: [{ name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }] }, addFiles)

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

  it('leaves the composer text alone when only the images come back', () => {
    const addFiles = vi.fn()
    restoreQueuedDraft('t1', { text: '', markers: '', images: [{ name: 'shot.png', mimeType: 'image/png', data: btoa('png bytes') }] }, addFiles)
    expect(useAppStore.getState().composerDrafts.t1).toBe('already typed')
    expect(addFiles).toHaveBeenCalledTimes(1)
  })

  it('fills an empty composer with the text alone and adds no files when the message had none', () => {
    useAppStore.setState({ composerDrafts: {} })
    const addFiles = vi.fn()
    restoreQueuedDraft('t2', { text: 'Then deploy', markers: '' }, addFiles)
    expect(useAppStore.getState().composerDrafts.t2).toBe('Then deploy')
    expect(addFiles).not.toHaveBeenCalled()
  })
})
