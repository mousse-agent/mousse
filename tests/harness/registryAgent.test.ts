/**
 * A registry agent through the gateway (agent CLIs plan §4): added from the registry, installed as
 * an operation with byte progress, bound to its install record, refused with "Installed files
 * changed since install" once a file changes (Reinstall fixes it), and its downloaded files deleted
 * on request. Removing the entry drops its reference.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentInstalls, resetAgentInstallState } from '../../src/mms/harness/agents/install'
import type { RegistryAgent } from '../../src/mms/harness/agents/registry'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { Harness, HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { describeStatus } from '../../src/shared/harness/status'
import type { ProviderOperationEvent } from '../../src/shared/harness/types'
import { tarGzOf } from './archiveFixtures'

const KEY = 'linux-x86_64' as const
const dirs: string[] = []
const servers: Server[] = []
const harnesses: Harness[] = []

beforeEach(() => resetAgentInstallState())
afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const archive = tarGzOf([{ name: 'bin/demo', data: '#!/bin/sh\necho demo\n', mode: 0o755 }, { name: 'lib/helper.txt', data: 'helper' }])

async function fixture(options: { gate?: Promise<void> } = {}) {
  const server = createServer((_request, response) => {
    void (options.gate ?? Promise.resolve()).then(() => {
      response.writeHead(200, { 'content-length': String(archive.length) })
      response.end(archive)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/demo.tar.gz`
  const home = mkdtempSync(join(tmpdir(), 'mousse-registry-agent-'))
  dirs.push(home)
  const agent: RegistryAgent = {
    id: 'demo-agent', name: 'Demo', version: '1.0.0', description: '', authors: [],
    distribution: { binary: { [KEY]: { archive: url, cmd: './bin/demo', sha256: createHash('sha256').update(archive).digest('hex'), args: [], env: {} } } }
  }
  const agents = new AgentInstalls({ installationHome: home, profileId: 'p1', registry: { agent: async () => agent, cached: () => [agent] }, platformKeys: [KEY] })
  const calls: string[] = []
  const acp = inProcessAgent((app) => {
    app
      .onRequest(methods.agent.initialize, () => {
        calls.push('initialize')
        return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'demo', version: '1.0.0' }, agentCapabilities: { loadSession: false }, authMethods: [] }
      })
      .onRequest(methods.agent.session.new, () => {
        calls.push('session/new')
        return { sessionId: 's1' }
      })
  })
  let stored: unknown = {}
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [acpDriver({ agents, connect: (_context, request) => acp.connect(request) })], instances, profileHome: home })
  harnesses.push(harness)
  const events: ProviderOperationEvent[] = []
  harness.instances.subscribe((event: HarnessGatewayEvent) => {
    if (event.type === 'operation') events.push(event.data)
  })
  const snapshot = async () => (await harness.instances.snapshots({ kind: 'device' }))[0]!
  return { home, harness, agents, calls, events, snapshot, entries: () => instances.list() }
}

describe('a registry agent through the gateway', () => {
  it('installs with byte progress, binds the install record, and refuses changed files until reinstalled', async () => {
    const { home, harness, calls, events, snapshot, entries } = await fixture()
    const added = await harness.instances.add({ driver: 'acp', config: { displayName: 'Demo', source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } } })
    const id = added.instanceId
    await vi.waitFor(async () => expect((await snapshot()).install).toMatchObject({ state: 'not_installed', canInstall: true }))
    expect(describeStatus(await snapshot()).nextStep).toMatchObject({ action: 'install' })

    await harness.instances.install(id)
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'completed')).toBe(true))
    expect(events.some((event) => event.phase === 'progress' && event.receivedBytes === archive.length && event.totalBytes === archive.length)).toBe(true)
    // The entry now names the install it was made with.
    expect((entries()[id]!.config as { source: { receiptHash?: string } }).source.receiptHash).toMatch(/^[a-f0-9]{64}$/)
    await vi.waitFor(async () => expect((await snapshot())).toMatchObject({
      install: { state: 'installed', downloaded: { bytes: 26 }, checksum: 'registry' },
      runs: { state: 'yes' },
      binary: { source: 'managed', version: '1.0.0' },
      config: { source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } }
    }))
    expect(calls).toContain('initialize')

    const dist = join(home, 'agents', 'demo-agent', '1.0.0', KEY, 'dist')
    writeFileSync(join(dist, 'lib', 'helper.txt'), 'patched')
    await harness.instances.recheck(id)
    const broken = await snapshot()
    expect(broken).toMatchObject({ install: { state: 'broken' }, runs: { state: 'no', failure: 'files_changed', message: expect.stringContaining('Installed files changed since install (lib/helper.txt changed)') } })
    expect(describeStatus(broken)).toMatchObject({ headline: 'Install is broken', nextStep: { action: 'install', label: 'Reinstall' } })
    // Nothing starts from changed files: the next process start is refused.
    const startsBefore = calls.length
    await harness.instances.refreshModels(id)
    expect((await snapshot()).models.error).toMatch(/Installed files changed since install/)
    expect(calls.length).toBe(startsBefore)

    events.length = 0
    await harness.instances.install(id)
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'completed')).toBe(true))
    await vi.waitFor(async () => expect((await snapshot())).toMatchObject({ install: { state: 'installed' }, runs: { state: 'yes' } }))
  })

  it('deletes the downloaded files on request and drops the reference when the entry is removed', async () => {
    const { home, harness, events, snapshot } = await fixture()
    const { instanceId: id } = await harness.instances.add({ driver: 'acp', config: { displayName: 'Demo', source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } } })
    await harness.instances.install(id)
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'completed')).toBe(true))
    const agentDir = join(home, 'agents', 'demo-agent')
    await vi.waitFor(() => expect(existsSync(join(agentDir, 'refs', 'p1.json'))).toBe(true))
    expect(await harness.instances.removeInstall(id, { force: false })).toEqual({ removed: true, bytes: 26 })
    expect(existsSync(join(agentDir, '1.0.0', KEY))).toBe(false)
    await vi.waitFor(async () => expect((await snapshot()).install.state).toBe('not_installed'))

    await harness.instances.install(id)
    await vi.waitFor(() => expect(events.filter((event) => event.phase === 'completed')).toHaveLength(2))
    await harness.instances.remove(id)
    expect(existsSync(join(agentDir, 'refs', 'p1.json'))).toBe(false)
    // The files stay for whoever adds the agent again.
    expect(existsSync(join(agentDir, '1.0.0', KEY, 'receipt.json'))).toBe(true)
  })

  it('hashes the install once per Recheck: the start-up check reuses the file check', async () => {
    const { harness, agents, events } = await fixture()
    const { instanceId: id } = await harness.instances.add({ driver: 'acp', config: { displayName: 'Demo', source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } } })
    await harness.instances.install(id)
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'completed')).toBe(true))
    await vi.waitFor(async () => expect((await harness.instances.snapshots({ kind: 'device' }))[0]!.runs.state).toBe('yes'))
    const changed = vi.spyOn(agents, 'changed')
    const snapshot = await harness.instances.recheck(id)
    expect(snapshot.runs.state).toBe('yes')
    // The file check, not again for the handshake process right after it.
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('refuses a version change while the entry is being installed', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    const { harness, events } = await fixture({ gate })
    const { instanceId: id } = await harness.instances.add({ driver: 'acp', config: { displayName: 'Demo', source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } } })
    await harness.instances.install(id)
    await expect(harness.instances.configure(id, { source: { kind: 'registry', agentId: 'demo-agent', version: '2.0.0', distribution: 'binary' } })).rejects.toMatchObject({ code: 'operation_busy' })
    // A rename still goes through.
    await harness.instances.configure(id, { displayName: 'Demo agent' })
    open()
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'completed')).toBe(true))
  })

  it('takes a registry source only for drivers that read one, and never with an executable path', async () => {
    const { harness, entries } = await fixture()
    const { instanceId: id } = await harness.instances.add({ driver: 'acp', config: { displayName: 'Local', binaryPath: process.execPath } })
    await harness.instances.configure(id, { source: { kind: 'registry', agentId: 'demo-agent', version: '1.0.0', distribution: 'binary' } })
    expect(entries()[id]!.config).not.toHaveProperty('binaryPath')
    expect(entries()[id]!.config).toMatchObject({ source: { kind: 'registry', agentId: 'demo-agent' } })
  })
})
