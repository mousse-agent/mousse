import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import * as nativePty from 'node-pty'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { tryAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { createMmsChatResourceService } from '../src/mms/chats/resources/createMmsChatResourceService'
import { chatFileRevision, type ChatResourceService } from '../src/mms/chats/resources/ChatResourceService'

const fixtures: Array<{ service: ChatResourceService; pty: PtyManager; root: string }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.dispose()
    await fixture.pty.shutdown({ timeoutMs: 10_000 })
    await rm(fixture.root, { force: true, recursive: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-chat-resources-'))
  const workspace = join(root, 'workspace'), threadDirectory = join(root, 'thread')
  await mkdir(workspace); await mkdir(threadDirectory)
  // A real fixture shell avoids executing the developer's interactive shell startup.
  const pty = new PtyManager({ spawnPty: (_shell, _args, options) => nativePty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/bash', process.platform === 'win32' ? ['/d', '/q'] : ['--noprofile', '--norc'], options) })
  const profileId = '11111111-1111-4111-8111-111111111111'
  const mms = { profileId, ptyManager: pty,
    threads: { getThreadDir: () => threadDirectory }, threadRuntimes: { registerPty() {} },
    platform: { browser: { listPublicSessions: () => [] } }
  } as unknown as MmsProfileServices
  const service = createMmsChatResourceService(mms, (groupId) => ({
    profileId, chatId: groupId, threadId: 'group-thread', workspaceRoot: workspace,
    participants: [{ id: 'self', kind: 'person', name: 'Me' }]
  }))
  fixtures.push({ service, pty, root })
  const context = { profileId, groupId: 'group-a', clientId: 'client-a', participantId: 'self' }
  return { root, workspace, threadDirectory, service, pty, context }
}

describe('real daemon group resource adapters', () => {
  it('performs revisioned writes on real files and respects the thread writer lease', async () => {
    const { service, context, workspace, threadDirectory } = await fixture()
    await writeFile(join(workspace, 'notes.txt'), 'Original')
    const initial = await service.fileRead(context, 'notes.txt')
    const lease = tryAcquireExecutionLease(threadDirectory, { source: 'agent-fixture' })!
    try {
      await expect(service.fileWrite(context, initial.path, 'Attempt', initial.revision)).rejects.toMatchObject({ code: 'workspace_busy' })
      expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('Original')
    } finally { releaseExecutionLeaseHandle(lease) }
    expect(await service.fileWrite(context, initial.path, 'Shared edit', initial.revision)).toMatchObject({ status: 'saved', file: { content: 'Shared edit' } })
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('Shared edit')
    await writeFile(join(workspace, 'notes.txt'), 'External edit')
    expect(await service.fileWrite({ ...context, clientId: 'client-b' }, initial.path, 'Conflicting draft', chatFileRevision('Shared edit'))).toMatchObject({ status: 'conflict', file: { content: 'External edit' } })
  })

  it('refuses symlinks escaping the group workspace for reads and writes', async () => {
    const { service, context, root, workspace } = await fixture()
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'Outside')
    await symlink(outside, join(workspace, 'link.txt'))
    await expect(service.fileRead(context, 'link.txt')).rejects.toThrow('outside')
    await expect(service.fileWrite(context, 'link.txt', 'Bad', chatFileRevision('Outside'))).rejects.toThrow('outside')
    expect(await readFile(outside, 'utf8')).toBe('Outside')
  })

  it('refreshes agent/external filesystem edits and invalidates old file cursors for another viewer', async () => {
    const { service, context, workspace } = await fixture()
    const path = 'notes.txt'
    await writeFile(join(workspace, path), 'Original')
    const original = await service.fileRead(context, path)
    await service.presenceUpdate(context, { kind: 'file', id: path }, { kind: 'file', revision: original.revision, line: 1, column: 2 })
    await writeFile(join(workspace, path), 'Agent changed this file')
    const secondViewer = await service.snapshot({ ...context, clientId: 'client-b' })
    expect(secondViewer.files).toEqual([{ path, content: 'Agent changed this file', revision: chatFileRevision('Agent changed this file') }])
    expect(secondViewer.presence[0].cursor).toBeUndefined()
    await rm(join(workspace, path))
    const afterDeletion = await service.snapshot({ ...context, clientId: 'client-b' })
    expect(afterDeletion.files).toHaveLength(0)
    expect(afterDeletion.presence).toHaveLength(0)
  })

  it('shares a real shell PTY and releases its workspace writer lease only after close', async () => {
    const { service, context, workspace } = await fixture()
    await writeFile(join(workspace, 'notes.txt'), 'Original')
    const initial = await service.fileRead(context, 'notes.txt')
    const terminal = await service.terminalCreate(context, 100, 30)
    const other = { ...context, clientId: 'client-b' }
    await service.terminalWrite(context, terminal.id, process.platform === 'win32' ? "echo MOUSSE_SHARED_PTY_VERIFIED\r" : "printf 'MOUSSE_SHARED_PTY_VERIFIED\\n'\r")
    let output = ''
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const current = await service.terminalOutput(other, terminal.id)
      output = current.chunks.map((chunk) => chunk.data).join('')
      if (output.includes('MOUSSE_SHARED_PTY_VERIFIED\r\n')) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(output).toContain('MOUSSE_SHARED_PTY_VERIFIED\r\n')
    await expect(service.terminalWrite(other, terminal.id, 'bad')).rejects.toMatchObject({ code: 'control_busy' })
    await expect(service.fileWrite(other, initial.path, 'Blocked edit', initial.revision)).rejects.toMatchObject({ code: 'workspace_busy' })
    await service.terminalClose(context, terminal.id)
    expect(await service.fileWrite(other, initial.path, 'Allowed edit', initial.revision)).toMatchObject({ status: 'saved' })
  }, 15_000)
})
