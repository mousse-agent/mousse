import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  linkSync,
  readdirSync,
  existsSync,
  fstatSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  NativeReader,
  loadNativeReader,
  type NativeReaderModule
} from '../../../../src/mms/bots/runtime/NativeReader'
const directories: string[] = []
let native: NativeReaderModule, binaryDir: string
function temp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'bot-reader-')))
  directories.push(path)
  return path
}
beforeAll(async () => {
  binaryDir = temp()
  const caches = [join(homedir(), 'Library/Caches/node-gyp'), join(homedir(), '.cache/node-gyp')]
  let headers = process.env.NODE_HEADERS
  for (const cache of caches) {
    if (headers || !existsSync(cache)) continue
    headers = readdirSync(cache)
      .filter((version) => version.startsWith('24.'))
      .map((version) => join(cache, version, 'include/node'))
      .find((path) => existsSync(join(path, 'node_api.h')))
  }
  if (!headers) throw Error('Node headers unavailable: reader qualification cannot run')
  const helper = new URL('../../../../src/mms/bots/runtime/buildNativeReader.mjs', import.meta.url)
  const { buildNativeReader } = await import(helper.href),
    path = buildNativeReader({ headers, outfile: join(binaryDir, 'reader.node') })
  native = loadNativeReader(path, {
    platform: process.platform as 'darwin' | 'linux',
    napi: 8,
    artifactSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    packaged: false
  })
})
afterEach(() => {
  for (const path of directories.filter((path) => path !== binaryDir)) {
    rmSync(path, { recursive: true, force: true })
    directories.splice(directories.indexOf(path), 1)
  }
})
afterAll(() => {
  rmSync(binaryDir, { recursive: true, force: true })
})
describe('native openat reader backend', () => {
  it('reads/list/searches bounded files without Pi tools or process search', () => {
    const root = temp(),
      profile = temp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'file.txt'), 'alpha\nneedle\nomega')
    const reader = new NativeReader(native, root, [profile])
    try {
      expect(reader.read('sub/file.txt')).toContain('needle')
      expect(reader.list('sub')).toEqual([{ name: 'file.txt', kind: 'file' }])
      expect(reader.search('needle')).toEqual([{ path: 'sub/file.txt', line: 2, text: 'needle' }])
      expect(() => reader.read('sub/file.txt', 2)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      )
      expect(() => reader.search('needle', { maxDepth: 0 })).toThrowError(
        expect.objectContaining({ code: 'bad_request' })
      )
    } finally {
      reader.close()
    }
  })
  it('denies traversal, symlinks, hardlinks, and profile root aliases', () => {
    const root = temp(),
      profile = temp()
    writeFileSync(join(profile, 'keys.json'), 'PRIVATE')
    mkdirSync(join(root, 'sub'))
    symlinkSync(profile, join(root, 'linked'))
    linkSync(join(profile, 'keys.json'), join(root, 'hard'))
    const reader = new NativeReader(native, root, [profile])
    try {
      for (const path of [
        '../keys.json',
        '/etc/passwd',
        'linked/keys.json',
        'hard',
        'sub/../../keys.json',
        'sub\\keys.json',
        'C:/keys.json'
      ])
        expect(() => reader.read(path)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
      expect(
        reader
          .list()
          .filter((row) => row.kind === 'blocked')
          .map((row) => row.name)
          .sort()
      ).toEqual(['hard', 'linked'])
    } finally {
      reader.close()
    }
    const alias = temp()
    symlinkSync(profile, join(alias, 'profile'))
    expect(() => new NativeReader(native, join(alias, 'profile'), [profile])).toThrowError(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(() => new NativeReader(native, join(profile), [join(alias, 'profile')])).toThrowError(
      expect.objectContaining({ code: 'forbidden' })
    )
  })
  it('holds an ancestor handle across a verified swap barrier and never opens the replacement symlink', () => {
    const root = temp(),
      outside = temp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'file'), 'PROJECT')
    writeFileSync(join(outside, 'file'), 'PRIVATE')
    const fd = native.openRoot(root)
    try {
      let swapped = false
      const result = native.read(fd, 'sub/file', 1024, (component) => {
        if (component === 0 && !swapped) {
          swapped = true
          renameSync(join(root, 'sub'), join(root, 'old'))
          symlinkSync(outside, join(root, 'sub'))
        }
      })
      expect(swapped).toBe(true)
      expect(result.toString()).toBe('PROJECT')
      expect(() => native.read(fd, 'sub/file', 1024)).toThrowError(
        expect.objectContaining({ code: 'forbidden' })
      )
    } finally {
      native.closeRoot(fd)
    }
  })
  it('reads only the opened file handle through replacement and rejects a later hardlink', () => {
    const root = temp(),
      outside = temp()
    writeFileSync(join(root, 'file'), 'PROJECT')
    writeFileSync(join(outside, 'secret'), 'PRIVATE')
    const fd = native.openRoot(root)
    try {
      const bytes = native.read(fd, 'file', 1024, () => {
        renameSync(join(root, 'file'), join(root, 'old'))
        linkSync(join(outside, 'secret'), join(root, 'file'))
      })
      expect(bytes.toString()).toBe('PROJECT')
      expect(() => native.read(fd, 'file', 1024)).toThrowError(
        expect.objectContaining({ code: 'forbidden' })
      )
    } finally {
      native.closeRoot(fd)
    }
  })
  it('fences root replacement and abort, and closes its root handle', () => {
    const parent = temp(),
      profile = temp(),
      root = join(parent, 'project')
    mkdirSync(root)
    writeFileSync(join(root, 'file'), 'PROJECT')
    const reader = new NativeReader(native, root, [profile])
    renameSync(root, join(parent, 'old'))
    mkdirSync(root)
    writeFileSync(join(root, 'file'), 'PRIVATE')
    expect(() => reader.read('file')).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    reader.close()
    const abort = new AbortController(),
      cancelled = new NativeReader(native, root, [profile], abort.signal)
    abort.abort()
    expect(() => cancelled.list()).toThrowError(expect.objectContaining({ code: 'cancelled' }))
    cancelled.close()
    const fd = native.openRoot(root)
    native.closeRoot(fd)
    expect(() => fstatSync(fd)).toThrowError(expect.objectContaining({ code: 'EBADF' }))
  })
})

describe('reader approval and dispatch boundary', () => {
  it('checks exact owned tools before approval and consumes one action-bound grant before I/O', async () => {
    const { ReaderToolPort } = await import('../../../../src/mms/bots/runtime/NativeBotRuntime'),
      { NetDatabase } = await import('../../../../src/mms/net/store/database'),
      { newId } = await import('../../../../src/shared/net')
    const root = temp(),
      profile = temp()
    writeFileSync(join(root, 'a'), 'A')
    writeFileSync(join(root, 'b'), 'B')
    const reader = new NativeReader(native, root, [profile]),
      db = new NetDatabase({ profileDir: profile })
    db.database.exec(
      'CREATE TABLE grants(id TEXT PRIMARY KEY,action TEXT,expires INTEGER,consumed INTEGER)'
    )
    const abort = new AbortController(),
      approval = newId('event')
    let captured = '',
      asked = 0,
      cancelled = false
    const definition: any = { readerTools: ['safe_read'], approval: 'always', maxToolCalls: 10 },
      request: any = {
        execution: newId('execution'),
        outputStream: newId('stream'),
        compartment: 'bound-private',
        profileDigest: 'a'.repeat(43),
        visibilityEpoch: 2,
        approvals: {
          requestAction: async (input: any) => {
            asked++
            captured = input.actionHash
            db.database
              .prepare('INSERT OR IGNORE INTO grants VALUES(?,?,?,0)')
              .run(approval, input.actionHash, Date.now() + 10000)
            return { decision: 'approved', approval, expiresAt: Date.now() + 10000 }
          },
          consume: async (id: string, hash: string) =>
            db.transaction(() => {
              const row = db.database.prepare('SELECT * FROM grants WHERE id=?').get(id)!
              if (!row || row.action !== hash || row.consumed || Number(row.expires) <= Date.now())
                throw Object.assign(Error('forbidden'), { code: 'forbidden' })
              db.database.prepare('UPDATE grants SET consumed=1 WHERE id=?').run(id)
            })
        }
      }
    const port = new ReaderToolPort(
      reader,
      definition,
      request,
      { onProgress() {}, onToolSummary() {}, onWaitingApproval() {} },
      () => {},
      abort.signal,
      () => {
        cancelled = true
        abort.abort()
      }
    )
    try {
      for (const name of [
        'read',
        'bash',
        'find',
        'grep',
        'mcp_read',
        'safe_search',
        'write',
        'create_subagent'
      ])
        await expect(
          port.execute({ type: 'toolCall', id: name, name, arguments: { path: 'a' } })
        ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        port.execute({
          type: 'toolCall',
          id: 'alias',
          name: 'safe_read',
          namespace: 'mcp',
          arguments: { path: 'a' }
        })
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        port.execute({
          type: 'toolCall',
          id: 'bad-path',
          name: 'safe_read',
          arguments: { path: '/etc/passwd' }
        })
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        port.execute({
          type: 'toolCall',
          id: 'bad-bound',
          name: 'safe_read',
          arguments: { path: 'a', maxBytes: 262145 }
        })
      ).rejects.toMatchObject({ code: 'bad_request' })
      expect(asked).toBe(0)
      const result = await port.execute({
        type: 'toolCall',
        id: 'one',
        name: 'safe_read',
        arguments: { path: 'a' }
      })
      expect(result.content).toEqual([{ type: 'text', text: 'A' }])
      expect(captured).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(db.database.prepare('SELECT consumed FROM grants').get()!.consumed).toBe(1)
      await expect(
        port.execute({ type: 'toolCall', id: 'two', name: 'safe_read', arguments: { path: 'b' } })
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(cancelled).toBe(true)
    } finally {
      reader.close()
      db.close()
    }
  })
  it('freezes approval arguments across a real asynchronous mutation barrier and rejects exact-expiry grants', async () => {
    const { ReaderToolPort } = await import('../../../../src/mms/bots/runtime/NativeBotRuntime'),
      { newId } = await import('../../../../src/shared/net')
    const root = temp(),
      profile = temp()
    writeFileSync(join(root, 'a'), 'A')
    writeFileSync(join(root, 'b'), 'B')
    const reader = new NativeReader(native, root, [profile])
    let release: (value: any) => void = () => {},
      consumed = 0,
      asked = false
    const request: any = {
        execution: newId('execution'),
        outputStream: newId('stream'),
        compartment: 'bound',
        profileDigest: 'a'.repeat(43),
        approvals: {
          requestAction: () => {
            asked = true
            return new Promise((resolve) => {
              release = resolve
            })
          },
          consume: async () => {
            consumed++
          }
        }
      },
      definition: any = { readerTools: ['safe_read'], approval: 'always', maxToolCalls: 10 },
      controller = new AbortController(),
      port = new ReaderToolPort(
        reader,
        definition,
        request,
        { onProgress() {}, onToolSummary() {}, onWaitingApproval() {} },
        () => {},
        controller.signal,
        () => controller.abort()
      )
    try {
      const call: any = {
          type: 'toolCall',
          id: 'read',
          name: 'safe_read',
          arguments: { path: 'a' }
        },
        pending = port.execute(call)
      expect(asked).toBe(true)
      call.arguments.path = 'b'
      release({ decision: 'approved', approval: newId('event'), expiresAt: Date.now() + 10000 })
      expect((await pending).content).toEqual([{ type: 'text', text: 'A' }])
      expect(consumed).toBe(1)
      asked = false
      const expired = port.execute({
        type: 'toolCall',
        id: 'expired',
        name: 'safe_read',
        arguments: { path: 'a' }
      })
      release({ decision: 'approved', approval: newId('event'), expiresAt: Date.now() })
      await expect(expired).rejects.toMatchObject({ code: 'cancelled' })
      expect(consumed).toBe(1)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      reader.close()
    }
  })
  it('aborts a pending approval without consuming a late grant or dispatching a read', async () => {
    const { ReaderToolPort } = await import('../../../../src/mms/bots/runtime/NativeBotRuntime'),
      { newId } = await import('../../../../src/shared/net')
    const root = temp(),
      profile = temp()
    writeFileSync(join(root, 'a'), 'A')
    const reader = new NativeReader(native, root, [profile]),
      controller = new AbortController()
    let release: (value: any) => void = () => {},
      consumed = 0,
      summaries = 0
    const request: any = {
        execution: newId('execution'),
        outputStream: newId('stream'),
        compartment: 'bound',
        profileDigest: 'a'.repeat(43),
        approvals: {
          requestAction: () =>
            new Promise((resolve) => {
              release = resolve
            }),
          consume: async () => {
            consumed++
          }
        }
      },
      port = new ReaderToolPort(
        reader,
        { readerTools: ['safe_read'], approval: 'always', maxToolCalls: 10 } as any,
        request,
        {
          onProgress() {},
          onToolSummary() {
            summaries++
          },
          onWaitingApproval() {}
        },
        () => {},
        controller.signal
      )
    try {
      const pending = port.execute({
        type: 'toolCall',
        id: 'read',
        name: 'safe_read',
        arguments: { path: 'a' }
      })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      release({ decision: 'approved', approval: newId('event'), expiresAt: Date.now() + 10000 })
      await Promise.resolve()
      expect(consumed).toBe(0)
      expect(summaries).toBe(0)
    } finally {
      reader.close()
    }
  })
})
