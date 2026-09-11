import { expect, it } from 'vitest'
import { startFixtureSite } from './fixtures/browser/harness'

it('the oversized-download fault fixture ends at exactly 51 MiB under backpressure', async () => {
  const site = await startFixtureSite()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(site.origin + '/oversize.bin', { signal: controller.signal })
    expect(response.status).toBe(200)
    reader = response.body!.getReader()
    let bytes = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      // This ceiling aborts the old infinite fixture without filling the disk.
      expect(bytes).toBeLessThanOrEqual(51 * 1024 * 1024)
    }
    expect(bytes).toBe(51 * 1024 * 1024)
  } finally {
    clearTimeout(timeout)
    await reader?.cancel().catch(() => undefined)
    controller.abort()
    await site.close()
  }
}, 15_000)
