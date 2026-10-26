/**
 * Whether a browser screenshot can reach an ACP agent's model (PR 2 §2): the generic ACP driver has
 * no `mcpImageResults`, so the agent's own `initialize` answer decides. Image input announced is
 * yes; announced as no, or not announced, is no.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { Harness } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A harness with one generic ACP instance whose agent answers `initialize` with `agentCapabilities`. */
function fixture(agentCapabilities: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-acp-images-'))
  homes.push(home)
  const agent = inProcessAgent((app) => {
    app.onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: agentCapabilities as never, authMethods: [] }))
  })
  let stored: unknown = { 'acp:fake': { driver: 'acp', enabled: true, config: { binaryPath: process.execPath, args: ['agent.js'] } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [acpDriver({ connect: (_context, request) => agent.connect(request) })], instances, profileHome: home })
  harnesses.push(harness)
  return harness
}

describe('tool result images for an ACP agent', () => {
  it('reach the model when the agent announces image input', async () => {
    const harness = fixture({ promptCapabilities: { image: true } })
    // Before the agent has said anything: unknown, so no.
    expect(harness.catalog.toolImages('acp:fake', 'm')).toBe(false)
    await harness.instances.recheck('acp:fake')
    expect(harness.catalog.toolImages('acp:fake', 'm')).toBe(true)
  })

  it('do not when the agent announces no image input, or says nothing about it', async () => {
    const without = fixture({ promptCapabilities: { image: false, embeddedContext: true } })
    await without.instances.recheck('acp:fake')
    expect(without.catalog.toolImages('acp:fake', 'm')).toBe(false)
    const silent = fixture({})
    await silent.instances.recheck('acp:fake')
    expect(silent.catalog.toolImages('acp:fake', 'm')).toBe(false)
  })
})
