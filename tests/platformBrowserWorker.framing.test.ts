import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CdpAsciiDecoder, CdpFrameTooLargeError, encodeCdpMessage } from '../src/browser-worker/cdp/framing'
import { CdpConnection, CdpDisconnectedError } from '../src/browser-worker/cdp/connection'
import { encodeWorkerFrame, WorkerFrameDecoder, WorkerFrameTooLargeError } from '../src/browser-worker/ipc/framing'
import { validateBrowserWorkerRequest } from '../src/shared/browser/envelope'
import { BrowserReferenceStore } from '../src/browser-worker/observation/ReferenceStore'

describe('browser worker isolation', () => {
  it('does not import Electron, Playwright, Puppeteer, BrowserUse or Stagehand', () => {
    const root = join(process.cwd(), 'src/browser-worker')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      expect(source, file).not.toMatch(/from ['"]electron['"]|playwright|puppeteer|browser-use|stagehand/i)
    }
  })
})

describe('browser worker IPC framing', () => {
  it('round-trips fragmented and coalesced worker frames', () => {
    const a = encodeWorkerFrame({ version: 1, id: '1', ok: true })
    const b = encodeWorkerFrame({ version: 1, id: '2', ok: false, error: { code: 'timeout', message: 'x' } })
    const decoder = new WorkerFrameDecoder()
    decoder.push(a.subarray(0, 3))
    expect(decoder.shift()).toBeNull()
    decoder.push(Buffer.concat([a.subarray(3), b]))
    expect(decoder.shiftAll()).toEqual([
      { version: 1, id: '1', ok: true },
      { version: 1, id: '2', ok: false, error: { code: 'timeout', message: 'x' } }
    ])
  })

  it('rejects oversized worker frames', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(20 * 1024 * 1024, 0)
    const decoder = new WorkerFrameDecoder()
    expect(() => decoder.push(header)).toThrow(WorkerFrameTooLargeError)
  })

  it('validates the shared worker DTO envelope and profile binding fields', () => {
    const request = validateBrowserWorkerRequest({
      version: 1, id: 'req1', profileId: 'profile_a', method: 'observe', params: { sessionId: 'sess_1' }
    })
    expect(request.method).toBe('observe')
    expect(() => validateBrowserWorkerRequest({ ...request, version: 2 })).toThrow()
    expect(() => validateBrowserWorkerRequest({ ...request, method: 'Runtime.evaluate' })).toThrow()
    expect(() => validateBrowserWorkerRequest({ ...request, profileId: '../etc' })).toThrow()
    expect(() => validateBrowserWorkerRequest({ ...request, extra: true })).toThrow()
  })
})

describe('private CDP pipe framing and fencing', () => {
  it('decodes NUL-terminated CDP JSON with split chunks', () => {
    const first = encodeCdpMessage({ id: 1, method: 'Browser.getVersion' })
    const second = encodeCdpMessage({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 't' } } })
    const decoder = new CdpAsciiDecoder()
    decoder.push(first.subarray(0, 8))
    expect(decoder.shift()).toBeNull()
    decoder.push(Buffer.concat([first.subarray(8), second]))
    expect(decoder.shiftAll()).toEqual([
      { id: 1, method: 'Browser.getVersion' },
      { method: 'Target.targetCreated', params: { targetInfo: { targetId: 't' } } }
    ])
  })

  it('rejects oversized CDP messages', () => {
    const decoder = new CdpAsciiDecoder()
    expect(() => decoder.push(Buffer.alloc(16 * 1024 * 1024 + 2, 65))).toThrow(CdpFrameTooLargeError)
  })

  it('times out, cancels, and fails closed on disconnect without replaying commands', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const cdp = new CdpConnection(output, input)
    const seen: Buffer[] = []
    input.on('data', (chunk) => seen.push(Buffer.from(chunk)))
    const slow = cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed' }, { timeoutMs: 30 })
    await expect(slow).rejects.toThrow(/timeout/)
    const controller = new AbortController()
    const cancellable = cdp.send('Page.navigate', { url: 'https://example.com' }, { signal: controller.signal, timeoutMs: 5_000 })
    controller.abort('cancelled')
    await expect(cancellable).rejects.toThrow(/cancelled/)
    const pending = cdp.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 5_000 })
    output.end()
    await expect(pending).rejects.toBeInstanceOf(CdpDisconnectedError)
    const commands = Buffer.concat(seen).toString('utf-8').split('\0').filter(Boolean).map((line) => JSON.parse(line) as { method: string })
    expect(commands.map((entry) => entry.method)).toContain('Input.dispatchMouseEvent')
    expect(commands.map((entry) => entry.method)).toContain('Page.navigate')
    expect(commands.filter((entry) => entry.method === 'Input.dispatchMouseEvent')).toHaveLength(1)
  })

  it('keeps generation fencing independent of CDP target ids', () => {
    const store = new BrowserReferenceStore({ profileId: 'p', sessionId: 's', generation: 1 })
    const identity = { profileId: 'p', sessionId: 's', generation: 1, tabId: 'tab', documentId: 'doc', observationId: 'obs' }
    const [ref] = store.observe(identity, [{ backendNodeId: 9, frameRef: 'frame_1', fingerprint: 'button:Go', frameId: 'f1' }])
    expect(() => store.resolve({ ...identity, generation: 2 }, ref)).toThrow('stale_generation')
    store.invalidateFrame('frame_1')
    expect(() => store.resolve(identity, ref)).toThrow('stale_ref')
  })
})
