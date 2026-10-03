import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserViewerSnapshot } from '../src/shared/browser/viewer'
import type { ChatResourceContext, ChatSharedTerminal, ChatTerminalOutput } from '../src/shared/chatResources'
import { ChatResourceService, chatFileRevision, type ChatResourceHost } from '../src/mms/chats/resources/ChatResourceService'

const profileId = 'profile-a'
const client = (clientId: string): ChatResourceContext => ({ profileId, groupId: 'group-a', clientId, participantId: 'self' })
const services: ChatResourceService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.dispose() })

function fixture() {
  let time = 1000, member = true, content = 'first line\nsecond line'
  let browser: BrowserViewerSnapshot | undefined
  const terminals = new Map<string, ChatSharedTerminal>()
  const outputs = new Map<string, ChatTerminalOutput>()
  let backendWrites = 0
  const browserSnapshot = (): BrowserViewerSnapshot => ({
    mode: 'managed', connection: 'connected', history: [], artifacts: [], updatedAt: 'now', controlOwner: 'agent',
    session: { id: 'browser-a', profileId, threadId: 'thread-a', persistent: false, backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'ready', createdAt: 'now', updatedAt: 'now' },
    tabs: [{ id: 'tab-a', title: 'Shared', url: 'https://example.test' }],
    observation: { sessionId: 'browser-a', tabId: 'tab-a', generation: 1, observationId: 'observation-a', documentId: 'doc-a', capturedAt: 'now',
      url: 'https://example.test', title: 'Shared', tabs: [], elements: [], viewport: { cssWidth: 800, cssHeight: 600, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 },
      truncated: false, warnings: [], provenance: 'untrusted-page' }
  })
  const host: ChatResourceHost = {
    admit(context) {
      if (!member || context.groupId !== 'group-a' || context.participantId !== 'self') throw new Error('Not a group member')
      return { profileId, groupId: context.groupId, threadId: 'thread-a', workspaceRoot: '/owned/group-a', participant: { id: 'self', kind: 'person', name: 'Me' } }
    },
    browser: {
      async list() { return browser ? [structuredClone(browser)] : [] },
      async open() { browser = browserSnapshot(); return structuredClone(browser) },
      async observe() { return structuredClone(browser!) },
      async control(_binding, _id, owner) { browser!.controlOwner = owner; return structuredClone(browser!) },
      async action() { backendWrites++; return structuredClone(browser!) },
      async close() { browser = undefined }
    },
    terminal: {
      async list() { return [...terminals.values()] },
      async create(_binding, columns, rows) {
        const terminal = { id: `pty-${terminals.size + 1}`, threadId: 'thread-a', title: 'Shell', alive: true, columns, rows }
        terminals.set(terminal.id, terminal); outputs.set(terminal.id, { sequence: 0, gap: false, chunks: [] })
        return terminal
      },
      async output(_binding, id, sequence) { const output = outputs.get(id)!; return { ...output, chunks: output.chunks.filter((chunk) => chunk.sequence > sequence) } },
      async write(_binding, id, data) { backendWrites++; const output = outputs.get(id)!; output.chunks.push({ sequence: ++output.sequence, data }) },
      async resize(_binding, id, columns, rows) { Object.assign(terminals.get(id)!, { columns, rows }) },
      async close(_binding, id) { terminals.delete(id) }
    },
    file: {
      async read() { return content },
      async write(_binding, path, next, expectedRevision) {
        if (chatFileRevision(content) !== expectedRevision) return { status: 'conflict', file: { path, content, revision: chatFileRevision(content) } }
        content = next; backendWrites++
        return { status: 'saved', file: { path, content, revision: chatFileRevision(content) } }
      }
    }
  }
  const service = new ChatResourceService(profileId, host, { now: () => time, presenceTtlMs: 2000, controlTtlMs: 3000 })
  services.push(service)
  return { service, host, setTime: (next: number) => { time = next }, removeMember: () => { member = false }, externalEdit: (next: string) => { content = next },
    writes: () => backendWrites, foreignBrowser: () => { browser = browserSnapshot(); browser.session!.threadId = 'another-thread' } }
}

describe('group shared resources', () => {
  it('gives two clients identical native resource identities and shared terminal output', async () => {
    const { service } = fixture()
    const a = client('a'), b = client('b')
    const browser = await service.browserOpen(a, 'https://example.test')
    const terminal = await service.terminalCreate(a)
    await service.terminalWrite(a, terminal.id, 'hello\r\n')
    const left = await service.snapshot(a), right = await service.snapshot(b)
    expect(left.viewerClientId).toBe('a'); expect(right.viewerClientId).toBe('b')
    expect(left.browsers[0].session?.id).toBe(browser.session?.id)
    expect(right.browsers[0].session?.id).toBe(browser.session?.id)
    expect(right.terminals[0].id).toBe(terminal.id)
    expect(right.terminals[0].control?.clientId).toBe('a')
    expect(await service.terminalOutput(b, terminal.id)).toMatchObject({ sequence: 1, chunks: [{ sequence: 1, data: 'hello\r\n' }] })
    expect(await service.terminalOutput(b, terminal.id, 1)).toMatchObject({ sequence: 1, chunks: [] })
  })

  it('fences another client from browser and terminal mutation until control transfers', async () => {
    const { service, writes } = fixture()
    const a = client('a'), b = client('b')
    await service.browserOpen(a, 'https://example.test')
    await service.browserControl(a, 'browser-a', true)
    expect((await service.snapshot(b)).browserControls['browser-a'].clientId).toBe('a')
    await expect(service.browserControl(b, 'browser-a', true)).rejects.toMatchObject({ code: 'control_busy' })
    const action = { sessionId: 'browser-a', tabId: 'tab-a', generation: 1, observationId: 'observation-a', action: { type: 'reload' as const } }
    await expect(service.browserAction(b, action)).rejects.toMatchObject({ code: 'control_busy' })
    const terminal = await service.terminalCreate(a)
    await expect(service.terminalWrite(b, terminal.id, 'no')).rejects.toMatchObject({ code: 'control_busy' })
    expect(writes()).toBe(0)
    await service.browserControl(a, 'browser-a', false)
    await service.browserControl(b, 'browser-a', true)
    await service.browserAction(b, action)
    await service.terminalControl(a, terminal.id, false)
    await service.terminalControl(b, terminal.id, true)
    await service.terminalWrite(b, terminal.id, 'yes')
    expect(writes()).toBe(2)
  })

  it('serializes concurrent document writes and preserves the conflicting draft for the caller', async () => {
    const { service } = fixture()
    const initial = await service.fileRead(client('a'), 'source.txt')
    const [first, second] = await Promise.all([
      service.fileWrite(client('a'), initial.path, 'A edit', initial.revision),
      service.fileWrite(client('b'), initial.path, 'B edit', initial.revision)
    ])
    expect(first).toMatchObject({ status: 'saved', file: { content: 'A edit' } })
    expect(second).toMatchObject({ status: 'conflict', file: { content: 'A edit' } })
    expect((await service.fileRead(client('b'), initial.path)).content).toBe('A edit')
  })

  it('detects external edits before a shared save and rejects traversal', async () => {
    const { service, externalEdit, writes } = fixture()
    const initial = await service.fileRead(client('a'), 'source.txt')
    externalEdit('Edited on disk')
    expect(await service.fileWrite(client('a'), initial.path, 'Local draft', initial.revision)).toMatchObject({ status: 'conflict', file: { content: 'Edited on disk' } })
    for (const path of ['../outside', '/outside', 'C:\\outside', 'nested/../outside', 'nested//outside']) await expect(service.fileRead(client('a'), path)).rejects.toMatchObject({ code: 'invalid_params' })
    expect(writes()).toBe(0)
  })

  it('tracks separate client cursors, expires presence and control, and clears disconnections', async () => {
    const { service, setTime } = fixture()
    const file = await service.fileRead(client('a'), 'source.txt')
    await service.presenceUpdate(client('a'), { kind: 'file', id: file.path }, { kind: 'file', revision: file.revision, line: 1, column: 3, endLine: 2, endColumn: 4 })
    await service.presenceUpdate(client('b'), { kind: 'file', id: file.path }, { kind: 'file', revision: file.revision, line: 2, column: 2 })
    const terminal = await service.terminalCreate(client('a'))
    expect((await service.snapshot(client('b'))).presence).toHaveLength(2)
    setTime(4001); service.prune()
    expect((await service.snapshot(client('b'))).presence).toHaveLength(0)
    await service.terminalControl(client('b'), terminal.id, true)
    await service.presenceUpdate(client('b'), { kind: 'terminal', id: terminal.id }, { kind: 'terminal', row: 0, column: 1 })
    service.disconnect('b')
    const snapshot = await service.snapshot(client('a'))
    expect(snapshot.presence).toHaveLength(0)
    expect(snapshot.terminals[0].control).toBeUndefined()
    await service.terminalControl(client('a'), terminal.id, true)
  })

  it('rejects stale browser/file cursors and invalid document coordinates', async () => {
    const { service } = fixture()
    await service.browserOpen(client('a'), 'https://example.test')
    await expect(service.presenceUpdate(client('a'), { kind: 'browser', id: 'browser-a' }, { kind: 'browser', tabId: 'tab-a', generation: 2, x: 4, y: 5 })).rejects.toMatchObject({ code: 'stale_cursor' })
    await expect(service.presenceUpdate(client('a'), { kind: 'browser', id: 'browser-a' }, { kind: 'browser', tabId: 'tab-a', generation: 1, x: 801, y: 5 })).rejects.toMatchObject({ code: 'stale_cursor' })
    const file = await service.fileRead(client('a'), 'source.txt')
    await service.fileWrite(client('b'), file.path, 'short', file.revision)
    await expect(service.presenceUpdate(client('a'), { kind: 'file', id: file.path }, { kind: 'file', revision: file.revision, line: 1, column: 1 })).rejects.toMatchObject({ code: 'stale_cursor' })
    await expect(service.presenceUpdate(client('a'), { kind: 'file', id: file.path }, { kind: 'file', revision: chatFileRevision('short'), line: 1, column: 8 })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('rechecks membership and rejects profile/resource ownership mismatches before backend mutation', async () => {
    const { service, removeMember, writes, foreignBrowser } = fixture()
    await expect(service.snapshot({ ...client('a'), profileId: 'other' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(service.browserObserve(client('a'), 'unknown')).rejects.toMatchObject({ code: 'resource_not_found' })
    foreignBrowser()
    await expect(service.snapshot(client('a'))).rejects.toMatchObject({ code: 'resource_owner_mismatch' })
    removeMember()
    await expect(service.fileWrite(client('a'), 'file.txt', 'bad', chatFileRevision(''))).rejects.toThrow('Not a group member')
    expect(writes()).toBe(0)
  })

  it('keeps ownership until a dispatched file write settles during profile shutdown', async () => {
    const { service, host } = fixture()
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { finish = resolve })
    host.file.write = async (_binding, path, content) => {
      entered(); await held
      return { status: 'saved', file: { path, content, revision: chatFileRevision(content) } }
    }
    const mutation = service.fileWrite(client('a'), 'source.txt', 'settled', chatFileRevision(''))
    await started
    expect(service.getActiveCount()).toBe(1)
    service.beginShutdown()
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    await expect(service.fileRead(client('b'), 'source.txt')).rejects.toMatchObject({ code: 'profile_draining' })
    expect(disposed).toBe(false)
    finish()
    expect(await mutation).toMatchObject({ status: 'saved' })
    await disposal
    expect(service.getActiveCount()).toBe(0)
    expect(disposed).toBe(true)
  })
})
