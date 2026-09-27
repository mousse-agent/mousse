import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchManagedChrome } from '../src/browser-worker/cdp/launch'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'mousse-chrome-logs-'))
  roots.push(path)
  return path
}

describe('managed Chrome log ownership', () => {
  it('uses file descriptors for inherited logs and still waits for the child close event', async () => {
    const path = root()
    const input = new PassThrough(), output = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, exitCode: null as number | null, signalCode: null,
      stdio: [null, null, null, input, output], kill: vi.fn()
    })
    let logDescriptors: number[] = []
    vi.mocked(childProcess.spawn).mockImplementation((_file, _args, options) => {
      const stdio = options!.stdio as Array<unknown>
      expect(stdio.slice(3)).toEqual(['pipe', 'pipe'])
      expect(typeof stdio[1]).toBe('number')
      expect(typeof stdio[2]).toBe('number')
      logDescriptors = [stdio[1], stdio[2]] as number[]
      writeSync(logDescriptors[0], 'browser stdout')
      writeSync(logDescriptors[1], 'browser stderr diagnostic')
      return child as unknown as childProcess.ChildProcess
    })
    input.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\0').filter(Boolean)) {
        const request = JSON.parse(raw)
        if (request.method === 'Browser.close') {
          child.exitCode = 0
          child.emit('exit', 0, null)
        } else output.write(JSON.stringify({ id: request.id, result: { product: 'Chrome/fixture' } }) + '\0')
      }
    })
    const chrome = await launchManagedChrome({ executablePath: '/fixture/chrome', userDataDir: path })
    for (const fd of logDescriptors) expect(() => writeSync(fd, 'leak')).toThrow()
    expect(readFileSync(join(path, 'mousse-logs', 'stdout.log'), 'utf8')).toBe('browser stdout')
    expect(readFileSync(join(path, 'mousse-logs', 'stderr.log'), 'utf8')).toBe('browser stderr diagnostic')
    let stopped = false
    const pending = chrome.stop().then(() => { stopped = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.exitCode).toBe(0)
    expect(stopped).toBe(false)
    child.emit('close', 0, null)
    await pending
    expect(stopped).toBe(true)
  })

  it('closes parent log descriptors when spawning throws', async () => {
    const descriptors: number[] = []
    vi.mocked(childProcess.spawn).mockImplementation((_file, _args, options) => {
      descriptors.push(...(options!.stdio as number[]).slice(1, 3))
      throw new Error('fixture spawn failure')
    })
    await expect(launchManagedChrome({ executablePath: '/fixture/chrome', userDataDir: root() })).rejects.toThrow('fixture spawn failure')
    expect(descriptors).toHaveLength(2)
    for (const fd of descriptors) expect(() => writeSync(fd, 'leak')).toThrow()
  })
})
