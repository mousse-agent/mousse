import { closeSync, fsyncSync, openSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syncDirectory } from '../../../src/mms/net/store/directorySync'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  openSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn()
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const platform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value })
}
const failure = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`Owned directory failure: ${code}`), { code })

beforeEach(() => {
  vi.mocked(openSync).mockReset().mockReturnValue(17)
  vi.mocked(fsyncSync).mockReset()
  vi.mocked(closeSync).mockReset()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

it('flushes and closes an opened directory', () => {
  platform('linux')
  syncDirectory('owned-directory')
  expect(openSync).toHaveBeenCalledWith('owned-directory', 'r')
  expect(fsyncSync).toHaveBeenCalledWith(17)
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(17)
})

it.each(['EPERM', 'EINVAL'])(
  'tolerates only unsupported Windows directory operations (%s)',
  (code) => {
    platform('win32')
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw failure(code)
    })
    expect(() => syncDirectory('owned-directory')).not.toThrow()
    expect(fsyncSync).not.toHaveBeenCalled()
    expect(closeSync).not.toHaveBeenCalled()
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw failure(code)
    })
    expect(() => syncDirectory('owned-directory')).not.toThrow()
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(17)
  }
)

it.each(['EPERM', 'EINVAL', 'EIO', 'ENOSPC', 'EACCES', 'ENOENT'])(
  'preserves directory failures outside Windows (%s)',
  (code) => {
    platform('linux')
    const error = failure(code)
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw error
    })
    expect(() => syncDirectory('owned-directory')).toThrow(error)
    expect(closeSync).not.toHaveBeenCalled()
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw error
    })
    expect(() => syncDirectory('owned-directory')).toThrow(error)
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(17)
  }
)

it.each(['EIO', 'ENOSPC', 'EACCES', 'ENOENT'])(
  'preserves unexpected Windows directory failures (%s)',
  (code) => {
    platform('win32')
    const error = failure(code)
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw error
    })
    expect(() => syncDirectory('owned-directory')).toThrow(error)
    expect(closeSync).not.toHaveBeenCalled()
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw error
    })
    expect(() => syncDirectory('owned-directory')).toThrow(error)
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(17)
  }
)

it('never treats a descriptor-close failure as unsupported directory flushing', () => {
  platform('win32')
  const error = failure('EPERM')
  vi.mocked(closeSync).mockImplementationOnce(() => {
    throw error
  })
  expect(() => syncDirectory('owned-directory')).toThrow(error)
})
