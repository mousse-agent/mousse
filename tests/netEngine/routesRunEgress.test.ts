/**
 * A routes run guards egress in every file of the run, not only in routes-app's own cases: over ssh those cases do
 * not run, and on Linux the kit's network fence keeps a request from reaching the kit's Plus recorder, so the
 * `plus-probe` control's request must be recorded in the app's own process (1b §14).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE = 'ssh'
  // The kit's Plus recorder, which a fenced run cannot reach.
  process.env.MOUSSE_ID_ORIGIN = 'http://127.0.0.1:9'
})

import { Fabric } from './checks/harness'

describe('a routes run over ssh', () => {
  const out = mkdtempSync(join(tmpdir(), 'engine-routes-egress-'))
  let fabric: Fabric | undefined
  afterAll(async () => {
    await fabric?.close()
    delete process.env.MOUSSE_NET_ENGINE_CHECK_OUT
    rmSync(out, { recursive: true, force: true })
  })

  it('records a request to Plus as plus_contacted', async () => {
    process.env.MOUSSE_NET_ENGINE_CHECK_OUT = out
    fabric = new Fabric()
    await fetch('http://127.0.0.1:9/v1/net/routes').catch(() => undefined)
    expect(readFileSync(join(out, 'reason'), 'utf8')).toBe('plus_contacted')
  })
})
