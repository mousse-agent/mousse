import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputerBadgeView, ThreadComputerBadge, computerBadgeTitle } from '../../src/renderer/components/ComputerBadge'
import { ComputerNotice } from '../../src/renderer/components/ComputerNotice'
import { ComputerSurfaceNote, surfaceNoteFor } from '../../src/renderer/components/ComputerSurfaceNote'
import { EarlierMessagesBarView } from '../../src/renderer/components/EarlierMessagesBar'
import { ThreadComputerBarView } from '../../src/renderer/components/ThreadComputerBar'
import { OpenInEditorElsewhere } from '../../src/renderer/components/sideCard/EditorMenuButton'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { outdatedComputerName } from '../../src/shared/bridge/computerErrors'
import { isComputerOffline, sendErrorLine } from '../../src/renderer/lib/errorText'
import type { Thread } from '../../src/shared/types'

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('the computer badge', () => {
  it('says where a thread runs, by its icon alone in a row and with the name in a card', () => {
    const row = html(createElement(ComputerBadgeView, { name: 'Studio', state: 'online' }))
    expect(row).toContain('title="Runs on Studio"')
    expect(row).not.toContain('computer-badge-name')
    const card = html(createElement(ComputerBadgeView, { name: 'Studio', state: 'online', withName: true }))
    expect(card).toContain('<span class="computer-badge-name">Studio</span>')
    expect(card).not.toContain('computer-badge-state')
  })

  it('marks a computer that cannot be reached, in the tooltip and beside the name', () => {
    expect(computerBadgeTitle('Studio', 'offline', 'Offline · last seen 5m ago')).toBe('Runs on Studio · Offline · last seen 5m ago')
    expect(computerBadgeTitle('Studio', 'not-shared')).toBe('Runs on Studio · Studio is not sharing its threads with this computer')
    const card = html(createElement(ComputerBadgeView, { name: 'Studio', state: 'offline', withName: true }))
    expect(card).toContain('data-state="offline"')
    expect(card).toContain('computer-badge-state">offline<')
    expect(html(createElement(ComputerBadgeView, { name: 'Studio', state: 'not-shared', withName: true }))).toContain('not shared')
  })

  it('shows nothing for a thread of this computer, and the node-less fallback name for an unknown one', () => {
    expect(html(createElement(ThreadComputerBadge, { thread: {} }))).toBe('')
    expect(html(createElement(ThreadComputerBadge, { thread: { node: 'nod_unknown' }, withName: true }))).toContain('Another computer')
    expect(html(createElement(ThreadComputerBadge, { thread: { node: 'nod_unknown', offline: true } }))).toContain('data-state="offline"')
  })
})

describe('the bar above a thread of another computer', () => {
  const view = (props: Partial<Parameters<typeof ThreadComputerBarView>[0]> = {}) =>
    html(createElement(ThreadComputerBarView, { name: 'Studio', state: 'online', onRetry: () => undefined, ...props }))

  it('names the computer while it is connected, with no Retry', () => {
    const bar = view()
    expect(bar).toContain('Runs on Studio')
    expect(bar).not.toContain('Retry')
    expect(bar).not.toContain('role="status"')
  })

  it('says the computer is offline, when it was last seen, and offers Retry', () => {
    const bar = view({ state: 'offline', offline: 'Offline · last seen 5m ago' })
    expect(bar).toContain('Studio · Offline · last seen 5m ago')
    expect(bar).toContain('Retry')
    expect(bar).toContain('role="status"')
    expect(bar).not.toContain('disabled')
    expect(view({ state: 'offline', retrying: true })).toContain('disabled')
  })

  it('says a computer that stopped sharing is not sharing, and still offers Retry', () => {
    const bar = view({ state: 'not-shared' })
    expect(bar).toContain('Studio is not sharing its threads with this computer right now')
    expect(bar).toContain('Retry')
  })
})

describe('the line above the composer', () => {
  it('shows what the other computer said as it said it', () => {
    const notice = html(createElement(ComputerNotice, { message: 'Studio refused this device.' }))
    expect(notice).toContain('Studio refused this device.')
    expect(notice).not.toContain('<button')
  })

  it('offers to open Devices for an action only an updated computer can do, and for nothing else', () => {
    const notice = html(createElement(ComputerNotice, { message: 'Update Mousse on Build Linux to do this.' }))
    expect(notice).toContain('Update Build Linux…')
    expect(notice).toContain('Update Mousse on Build Linux to do this.')
    expect(html(createElement(ComputerNotice, { message: 'Build Linux is offline.' }))).not.toContain('Update')
  })

  it('reads the computer from the error, or from its message once it has crossed to the window', () => {
    expect(outdatedComputerName({ code: 'computer_outdated', message: 'Update Mousse on Studio to do this.', details: { name: 'Studio' } })).toBe('Studio')
    expect(outdatedComputerName(new Error("Error invoking remote method 'orchestrator:sendToThread': Error: Update Mousse on Build Linux to do this."))).toBe('Build Linux')
    expect(outdatedComputerName(new Error('Studio is offline.'))).toBeUndefined()
    expect(outdatedComputerName(undefined)).toBeUndefined()
  })

  it('shows a refusal of the other computer without a code in front of it', () => {
    for (const code of ['computer_offline', 'computer_forbidden', 'computer_outdated', 'outcome_uncertain', 'permission_mode_above_ceiling', 'workflow_not_available_remotely'])
      expect(sendErrorLine({ code, message: 'Words for a person.' })).toBe('Words for a person.')
    // The owner's other refusals read as they do for a thread of this computer.
    expect(sendErrorLine({ code: 'queue_conflict', message: 'The queue changed.' })).toBe('[queue_conflict] The queue changed.')
  })
})

describe('older messages of a long thread', () => {
  it('says how many are left and offers to load them', () => {
    const bar = html(createElement(EarlierMessagesBarView, { count: 40, busy: false, onLoad: () => undefined }))
    expect(bar).toContain('40 earlier messages are not loaded')
    expect(bar).toContain('Load earlier messages')
    expect(html(createElement(EarlierMessagesBarView, { count: 1, busy: false, onLoad: () => undefined }))).toContain('1 earlier message is not loaded')
  })

  it('shows progress and a failure', () => {
    const busy = html(createElement(EarlierMessagesBarView, { count: 3, busy: true, onLoad: () => undefined }))
    expect(busy).toContain('Loading…')
    expect(busy).toContain('disabled')
    expect(html(createElement(EarlierMessagesBarView, { count: 3, busy: false, error: 'Studio is offline.', onLoad: () => undefined }))).toContain('role="alert">Studio is offline.')
  })
})

describe('what the app panel says for a thread of another computer', () => {
  it('says where the browser runs, and that a thread without a project has no folder to browse', () => {
    expect(surfaceNoteFor('browser', { node: 'nod_a' }, 'Studio')).toEqual({
      title: 'The browser for this thread runs on Studio',
      detail: "Pages the agent opens appear in Studio's window. Screenshots it takes stay in the transcript."
    })
    expect(surfaceNoteFor('files', { node: 'nod_a' }, 'Studio')?.title).toBe('This thread has no folder on Studio')
  })

  it('says nothing where the surface works: files of a project, Git, the terminal, and every surface of this computer', () => {
    expect(surfaceNoteFor('files', { node: 'nod_a', projectId: 'nod_a:p' }, 'Studio')).toBeUndefined()
    expect(surfaceNoteFor('git', { node: 'nod_a' }, 'Studio')).toBeUndefined()
    expect(surfaceNoteFor('terminal', { node: 'nod_a' }, 'Studio')).toBeUndefined()
    expect(surfaceNoteFor('browser', {}, 'Studio')).toBeUndefined()
    expect(surfaceNoteFor('browser', undefined, 'Studio')).toBeUndefined()
  })

  describe('as mounted', () => {
    const initial = useAppStore.getInitialState()
    const seed = (state: Partial<ReturnType<typeof useAppStore.getState>>) => { useAppStore.setState(state); Object.assign(initial, state) }
    afterEach(() => seed({ activeThreadId: null, threads: [], mainView: 'browser' }))
    const thread = (patch: Partial<Thread>) => ({ id: 't', name: 'T', createdAt: '', updatedAt: '', ...patch }) as Thread

    it('covers the browser for a thread of another computer, and not for a local one', () => {
      seed({ activeThreadId: 'nod_a:t', mainView: 'browser', threads: [thread({ id: 'nod_a:t', node: 'nod_a' } as Partial<Thread>)] })
      expect(html(createElement(ComputerSurfaceNote))).toContain('The browser for this thread runs on Another computer')
      seed({ activeThreadId: 't', threads: [thread({})] })
      expect(html(createElement(ComputerSurfaceNote))).toBe('')
    })
  })
})

describe('opening the thread folder in an editor', () => {
  it('is off for a thread of another computer, and says where the folder is', () => {
    const item = html(createElement(OpenInEditorElsewhere, { computer: 'Studio' }))
    expect(item).toContain('Open in editor on Studio')
    expect(item).toContain('disabled')
    expect(item).toContain('The folder is on Studio. Open it in an editor there.')
  })
})

describe('a computer that is away', () => {
  it('is told apart from other failures, also after the error crossed to the window', () => {
    expect(isComputerOffline({ code: 'computer_offline', message: 'x' })).toBe(true)
    expect(isComputerOffline(new Error("Error invoking remote method 'actions:list': MmsProtocolError: Computer B is offline."))).toBe(true)
    expect(isComputerOffline(new Error('Computer B refused this device.'))).toBe(false)
    expect(isComputerOffline(undefined)).toBe(false)
  })
})
