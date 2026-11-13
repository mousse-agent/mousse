import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { ChatMessage } from '../src/shared/types'
import { writtenFilePaths, type TurnFileResult } from '../src/shared/turnFiles'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { threadWroteFile, turnFilePath } from '../src/mms/git/turnFile'

/**
 * `review.turnFile`: a file a thread's agent wrote, wherever it is, is a diff against its own repository's last commit,
 * a plain file, or gone. Real repositories on disk; the thread's transcript names the files it wrote.
 */
describe('review.turnFile through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let threadId: string
  /** A second repository the thread does not work in, and a folder in no repository. */
  let other: string
  let loose: string

  const write = (path: string): ChatMessage => ({
    id: `w:${path}`, role: 'system', kind: 'tool_call', content: '', timestamp: '2026-11-13T00:00:00.000Z',
    toolCall: { title: 'Write', summary: 'Write', details: [], status: 'complete', toolName: 'Write', input: { file_path: path, content: 'x' } }
  })

  beforeEach(async () => {
    f = gitFoundationFixture()
    other = join(f.root, 'other')
    loose = join(f.root, 'loose')
    mkdirSync(other)
    mkdirSync(loose)
    git(other, 'init', '-q')
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.test')
    git(other, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(other, 'notes.txt'), 'one\n')
    writeFileSync(join(other, 'kept.txt'), 'kept\n')
    writeFileSync(join(other, '.gitignore'), 'scratch/\n')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'base')

    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
    threadId = mms.threads.createThread('Outside files', mms.projects.openProject(f.repo).id).id
  }, 30_000)
  afterEach(async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  const wrote = (...paths: string[]) =>
    mms.orchestrator.replaceConversationState(threadId, paths.map(write), { version: 2, fidelity: 'native', activeStartIndex: 0, messages: [] })
  const ask = (path: string, by = client) => by.request<TurnFileResult>('review.turnFile', { threadId, path })

  // What the agent wrote, where, and what opens.
  const rows: Array<{ name: string; setup: () => string; expected: 'diff' | 'plain' | 'missing'; original?: string | null; modified?: string }> = [
    { name: 'a changed tracked file in another repository', setup: () => { writeFileSync(join(other, 'notes.txt'), 'two\n'); return join(other, 'notes.txt') }, expected: 'diff', original: 'one\n', modified: 'two\n' },
    { name: 'a new untracked file in another repository', setup: () => { writeFileSync(join(other, 'new.txt'), 'new\n'); return join(other, 'new.txt') }, expected: 'diff', original: null, modified: 'new\n' },
    { name: 'a new file in a folder of another repository', setup: () => { mkdirSync(join(other, 'docs')); writeFileSync(join(other, 'docs', 'a.md'), '# a\n'); return join(other, 'docs', 'a.md') }, expected: 'diff', original: null, modified: '# a\n' },
    { name: 'a file the other repository ignores', setup: () => { mkdirSync(join(other, 'scratch')); writeFileSync(join(other, 'scratch', 'test.txt'), 'x\n'); return join(other, 'scratch', 'test.txt') }, expected: 'plain' },
    { name: 'a file that matches the last commit', setup: () => join(other, 'kept.txt'), expected: 'plain' },
    { name: 'a file in no repository', setup: () => { writeFileSync(join(loose, 'free.txt'), 'free\n'); return join(loose, 'free.txt') }, expected: 'plain' },
    { name: 'a file that was deleted since', setup: () => { writeFileSync(join(loose, 'gone.txt'), 'x\n'); rmSync(join(loose, 'gone.txt')); return join(loose, 'gone.txt') }, expected: 'missing' },
    { name: 'a file whose folder was deleted since', setup: () => join(loose, 'nowhere', 'gone.txt'), expected: 'missing' }
  ]
  for (const row of rows) {
    it(`${row.name}: ${row.expected}`, async () => {
      const path = row.setup()
      wrote(path)
      const result = await ask(path)
      expect(result.kind).toBe(row.expected)
      if (result.kind !== 'diff') return
      const side = (value: typeof result.version.original) => (value && 'content' in value ? value.content : value)
      expect(side(result.version.original)).toBe(row.original)
      expect(side(result.version.modified)).toBe(row.modified)
    })
  }

  it('reads a path the agent wrote relative to the thread folder against the thread repository', async () => {
    writeFileSync(join(f.repo, 'value.txt'), 'changed\n')
    wrote('value.txt')
    const result = await ask('value.txt')
    expect(result.kind).toBe('diff')
    expect(result.kind === 'diff' && result.version.path).toBe('value.txt')
  })

  it('refuses a file the thread never wrote, and a caller that is not a window of this computer', async () => {
    writeFileSync(join(other, 'notes.txt'), 'two\n')
    wrote(join(other, 'kept.txt'))
    await expect(ask(join(other, 'notes.txt'))).rejects.toThrow(/wrote/)
    wrote(join(other, 'notes.txt'))
    const cli = new LocalMmsClient({ homeDir: f.home, endpoint: server.endpoint!, ownerToken: mms.getOwnerLease()!.owner.token, clientType: 'cli' })
    await cli.connect()
    try {
      await expect(ask(join(other, 'notes.txt'), cli)).rejects.toThrow(/window/)
    } finally {
      await cli.close()
    }
  })
})

describe('the files a thread wrote, as the daemon reads them from its transcript', () => {
  const row = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({ id, role: 'system', kind: 'tool_call', content: '', timestamp: '2026-11-13T00:00:00.000Z', ...extra })
  const call = (toolName: string, input?: Record<string, unknown>, details: string[] = []) => ({ title: toolName, summary: toolName, details, status: 'complete' as const, toolName, ...(input ? { input } : {}) })
  const started = '2026-11-13T00:00:00.000Z'

  it('takes typed changes without failed ones, raw Edit and Write inputs and File: details, and nothing a Read names', () => {
    const messages: ChatMessage[] = [
      row('typed', {
        toolCall: call('apply_patch'),
        activity: { id: 'typed', callId: 'typed', toolName: 'apply_patch', startedAt: started, status: 'done', kind: 'file_change', changes: [
          { path: '/a/one.ts', change: 'update' },
          { path: '/a/failed.ts', change: 'update', error: 'old text not found' }
        ] }
      }),
      row('edit', { toolCall: call('Edit', { file_path: 'src/two.ts', old_string: 'a', new_string: 'b' }) }),
      row('write', { toolCall: call('write_file', { path: 'C:\\x\\three.txt', content: 'x' }) }),
      row('older', { toolCall: call('Write', undefined, ['File: /a/four.md']) }),
      row('read', { toolCall: call('Read', { file_path: '/a/read-only.ts' }) }),
      row('bash', { toolCall: call('Bash', { command: 'echo > /a/shell.txt' }) })
    ]
    expect(writtenFilePaths(messages)).toEqual(['/a/one.ts', 'src/two.ts', 'C:\\x\\three.txt', '/a/four.md'])
  })
})

describe('which written file a Windows path names', () => {
  // Raw strings: the backslashes are the path's own.
  const folder = String.raw`C:\repo`
  const written = [String.raw`J:\ryspa\mousse\scratch\mousse-test.txt`, 'src/app.ts']
  it.each([
    ['the same path', String.raw`J:\ryspa\mousse\scratch\mousse-test.txt`, true],
    ['another case of drive and folder', String.raw`j:\RYSPA\mousse\scratch\mousse-test.txt`, true],
    ['forward slashes', 'J:/ryspa/mousse/scratch/mousse-test.txt', true],
    ['a relative path inside the thread folder', String.raw`C:\repo\src\app.ts`, true],
    ['a file the thread did not write', String.raw`J:\ryspa\mousse\scratch\other.txt`, false],
    ['a path that climbs out to a written name', String.raw`C:\repo\..\src\app.ts`, false],
  ] as const)('%s', (_name, target, expected) => {
    const path = turnFilePath(target, folder, 'win32')!
    expect(threadWroteFile(written, path, folder, 'win32')).toBe(expected)
  })
})
