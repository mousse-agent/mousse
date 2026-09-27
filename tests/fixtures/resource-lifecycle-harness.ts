import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import type { WorkflowBundle } from '../../src/shared/workflows'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { vi } from 'vitest'

/** Real composition and authenticated socket; no lifecycle, persistence or runtime mocks. */
export async function lifecycleHarness(options: { prepareProfile?: (profileHome: string, profileId: string) => void } = {}) {
  // Provider catalog discovery is outside this deterministic lifecycle test.
  const providerInit = vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const previousHome = process.env.MOUSSE_HOME
  const root = mkdtempSync(join(tmpdir(), 'resource-lifecycle-acceptance-'))
  const home = join(root, 'home')
  const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Lifecycle Alice', slug: 'lifecycle-alice' })
  const bob = host.manager.create({ displayName: 'Lifecycle Bob', slug: 'lifecycle-bob' })
  options.prepareProfile?.(join(home, 'profiles', alice.id), alice.id)
  const services = await main.getProfileServices(alice.id)
  const bobServices = await main.getProfileServices(bob.id)
  const ownerToken = randomUUID()
  const server = new MmsProtocolServer({ mms: main, ownerToken, commandRouter: main.browserCommandRouter })
  const endpoint = await server.start()
  const clients: LocalMmsClient[] = []
  const connect = async (profile = alice.id, additionalCapabilities: string[] = []) => {
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui',
      requestedCapabilities: ['profiles-v1', 'workflows.definitions.v1', 'workflowRuns.v1', ...additionalCapabilities] })
    clients.push(client)
    await client.connect()
    await client.request('profiles.bind', { profile })
    return client
  }
  const rpc = await connect()
  return { root, home, main, alice, bob, services, bobServices, rpc, connect,
    async close() {
      await Promise.all(clients.map((client) => client.close()))
      try { await server.stop() } finally { await main.stop() }
      providerInit.mockRestore()
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      if (!basename(root).startsWith('resource-lifecycle-acceptance-') || resolve(root) === resolve(tmpdir())) throw new Error('Unsafe fixture cleanup')
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

export function lifecycleApprovalWorkflow(): WorkflowBundle {
  const id = randomUUID()
  return { assets: [], manifest: {
    schemaVersion: 1, id, name: 'Lifecycle approval hold', slug: `lifecycle-${id.slice(0, 8)}`,
    entryNodeId: 'start', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    permissions: { capabilities: ['human.approval'] },
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'approval', type: 'approval', version: 1, config: { action: 'continue', proposal: 'Wait for lifecycle acceptance' } },
      { id: 'end', type: 'end', version: 1, config: {} }
    ],
    edges: [
      { from: 'start', port: 'next', to: 'approval' },
      { from: 'approval', port: 'approved', to: 'end' },
      { from: 'approval', port: 'denied', to: 'end' }
    ]
  } }
}
