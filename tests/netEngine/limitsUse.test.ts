/**
 * Limits the engine reads from its named defaults: the stderr kept from a helper that failed to start
 * (`MOUSSE_NET_ENGINE_HELPER_STDERR_MAX_BYTES`), and the camera scan interval the status carries to a window
 * (`MOUSSE_NET_ENGINE_SCAN_INTERVAL_MS`).
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readEngineLimits } from '../../src/mms/netEngine/limits'

// Read once, the first time a limit is needed: set before anything in this file reads them.
process.env.MOUSSE_NET_ENGINE_HELPER_STDERR_MAX_BYTES = '12'

const { initEndpoint, launchHelper } = await import('../../src/mms/netEngine/helper/process')

describe('engine limits in use', () => {
  it('reads both from their variables', () => {
    const { limits, problems } = readEngineLimits({
      MOUSSE_NET_ENGINE_HELPER_STDERR_MAX_BYTES: '8192',
      MOUSSE_NET_ENGINE_SCAN_INTERVAL_MS: '500'
    })
    expect(problems).toEqual([])
    expect(limits.helperStderrMaxBytes).toBe(8192)
    expect(limits.scanIntervalMs).toBe(500)
  })

  // Node stands in for a helper that fails at once: it refuses the helper's arguments on stderr.
  it('keeps only the end of what a helper that failed wrote on stderr', async () => {
    const state = join(mkdtempSync(join(tmpdir(), 'limits-use-')), 'endpoint')
    const launched = launchHelper(process.execPath, state, false)
    const exit = await launched.exited
    expect(exit.code).not.toBe(0)
    expect(exit.stderr.length).toBeGreaterThan(0)
    expect(exit.stderr.length).toBeLessThanOrEqual(12)
    const refused = await initEndpoint(process.execPath, state, 'p', false).catch(
      (error: Error) => error
    )
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message.length).toBeLessThanOrEqual(12)
  })
})
