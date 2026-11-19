import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { saveSecretFetchResponse } from '../../src/mms/secrets/secretFetchFiles'

const hooks = vi.hoisted(() => ({
  unlink: undefined as undefined | ((path: unknown) => void),
  spawnError: undefined as undefined | string,
  afterCwd: undefined as undefined | (() => void),
  write: undefined as undefined | (() => void)
}))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    unlinkSync: (path: fs.PathLike) => {
      hooks.unlink?.(path)
      return original.unlinkSync(path)
    },
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      hooks.write?.()
      return original.writeFileSync(...args)
    }
  }
})
// Hand-authored child adapter: run the exact fixed helper source in-process. A held Linux
// dirfd models the kernel-pinned child cwd, without adding a process-owning Vitest lane.
vi.mock('node:child_process', () => ({
  spawnSync: (_exe: string, args: string[], options: { cwd: string; input: Buffer }) => {
    if (hooks.spawnError) return { status: null, error: { code: hooks.spawnError } }
    const directory = fs.openSync(options.cwd, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    hooks.afterCwd?.()
    const relative = (path: string) =>
      isAbsolute(path) ? path : `/proc/self/fd/${directory}/${path}`
    const child = { argv: ['node', ...args.slice(2)], exitCode: 0, platform: process.platform }
    try {
      runInNewContext(args[1], {
        process: child,
        require: () => ({
          ...fs,
          statSync: (path: string) =>
            path === '.' ? fs.fstatSync(directory) : fs.statSync(relative(path)),
          lstatSync: (path: string) => fs.lstatSync(relative(path)),
          openSync: (path: string, flags: number, mode: number) =>
            fs.openSync(relative(path), flags, mode),
          readFileSync: () => options.input,
          unlinkSync: (path: string) => fs.unlinkSync(relative(path))
        })
      })
      return { status: child.exitCode }
    } finally {
      fs.closeSync(directory)
    }
  }
}))
const homes: string[] = []
afterEach(() => {
  hooks.unlink = undefined
  hooks.spawnError = undefined
  hooks.afterCwd = undefined
  hooks.write = undefined
  vi.unstubAllGlobals()
  homes.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true }))
})
it.each(['linux', 'darwin', 'win32'])(
  'pins pruning even when the path changes at unlink on %s',
  (platform) => {
    const home = fs.mkdtempSync(join(tmpdir(), 'fetch-portable-'))
    homes.push(home)
    const scratch = join(home, 'scratch'),
      outside = join(home, 'outside')
    fs.mkdirSync(scratch)
    fs.mkdirSync(outside)
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? platform : Reflect.get(target, key))
      })
    )
    const first = saveSecretFetchResponse(scratch, Buffer.from('response'))
    const name = basename(first),
      folder = join(scratch, 'fetches')
    fs.writeFileSync(join(outside, name), 'owner file')
    for (let i = 1; i < 20; i++) saveSecretFetchResponse(scratch, Buffer.from('response'))
    hooks.unlink = (path) => {
      if (basename(String(path)) !== name) return
      hooks.unlink = undefined
      fs.renameSync(folder, folder + '-original')
      fs.symlinkSync(outside, folder, 'dir')
    }
    // The folder may become unavailable, but the recorded name must never delete through it.
    try {
      saveSecretFetchResponse(scratch, Buffer.from('response'))
    } catch {
      /* Fixed save refusal is allowed. */
    }
    expect(fs.readFileSync(join(outside, name), 'utf8')).toBe('owner file')
    expect(fs.readdirSync(outside)).toEqual([name])
  }
)

it.each(['ENOENT', 'ENOTDIR'])(
  'treats a folder lost before child startup as an uncounted refusal: %s',
  (code) => {
    const home = fs.mkdtempSync(join(tmpdir(), 'fetch-portable-lost-'))
    homes.push(home)
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key))
      })
    )
    hooks.spawnError = code
    let error: unknown
    try {
      saveSecretFetchResponse(home, Buffer.from('response'))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ unsafe: true })
  }
)

it('leaves a folder lost during the child identity check uncounted', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'fetch-portable-cwd-check-'))
  homes.push(home)
  const scratch = join(home, 'scratch')
  fs.mkdirSync(scratch)
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key))
    })
  )
  hooks.afterCwd = () => {
    fs.renameSync(join(scratch, 'fetches'), join(scratch, 'moved'))
  }
  let error: unknown
  try {
    saveSecretFetchResponse(scratch, Buffer.from('response'))
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ unsafe: true })
  expect(fs.readdirSync(join(scratch, 'moved'))).toEqual([])
})

it.each(['linux', 'darwin', 'win32'])(
  'writes through the open fd when the path changes at the write on %s',
  (platform) => {
    const home = fs.mkdtempSync(join(tmpdir(), 'fetch-write-fd-'))
    homes.push(home)
    const scratch = join(home, 'scratch'),
      outside = join(home, 'outside'),
      folder = join(scratch, 'fetches')
    fs.mkdirSync(scratch)
    fs.mkdirSync(outside)
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? platform : Reflect.get(target, key))
      })
    )
    let swapped = false
    hooks.write = () => {
      hooks.write = undefined
      swapped = true
      fs.renameSync(folder, folder + '-original')
      fs.symlinkSync(outside, folder, 'dir')
    }
    let refusal: unknown
    try {
      saveSecretFetchResponse(scratch, Buffer.from('response'))
    } catch (error) {
      refusal = error
    }
    expect(swapped).toBe(true)
    expect(refusal).toMatchObject({ unsafe: true })
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.readdirSync(folder + '-original')).toEqual([])
  }
)
