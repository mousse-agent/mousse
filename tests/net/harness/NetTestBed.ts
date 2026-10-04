import type { SecureChannel } from '../../../src/mms/net/contracts'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { FakeClock } from './FakeClock'
import { MemoryNetwork, MemoryTransport } from './MemoryTransport'
import { makeTempDir } from './tmp'

export class TestNode {
  readonly credentials
  readonly transport: MemoryTransport
  readonly profileDir: string
  private readonly services = new Map<string, unknown>()
  private readonly tmp
  constructor(
    readonly name: string,
    network: MemoryNetwork
  ) {
    this.tmp = makeTempDir(`mousse-net-${name}-`)
    this.profileDir = this.tmp.path
    this.credentials = generateSelfSignedCert(name)
    this.transport = new MemoryTransport(network, name)
  }
  attach(name: string, service: unknown): void {
    if (this.services.has(name)) throw new Error(`Service already attached: ${name}`)
    this.services.set(name, service)
  }
  get<T>(name: string): T {
    if (!this.services.has(name)) throw new Error(`Missing service: ${name}`)
    return this.services.get(name) as T
  }
  async dispose(): Promise<void> {
    await this.transport.teardown()
    this.tmp.cleanup()
  }
}

/** P0 test bed owns channels, transports and real profile directories. */
export class NetTestBed {
  readonly clock = new FakeClock()
  readonly network = new MemoryNetwork(this.clock)
  readonly nodes: TestNode[]
  private channels = new Set<SecureChannel>()
  constructor(count = 2) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 32)
      throw new RangeError('Invalid node count')
    this.nodes = Array.from({ length: count }, (_, i) => new TestNode(`node-${i}`, this.network))
  }
  async connect(a: number, b: number): Promise<[SecureChannel, SecureChannel]> {
    const client = this.nodes[a],
      server = this.nodes[b]
    if (!client || !server || client === server) throw new RangeError('Invalid node pair')
    await client.transport.provision()
    await server.transport.provision()
    let resolveServer!: (channel: SecureChannel) => void
    let rejectServer!: (error: unknown) => void
    const serverOpened = new Promise<SecureChannel>((resolve, reject) => {
      resolveServer = resolve
      rejectServer = reject
    })
    const listener = await server.transport.listen((raw) => {
      void openSecureChannel(raw, {
        role: 'server',
        credentials: server.credentials,
        expectedPeerFingerprint: fingerprint(client.credentials.publicKeySpki),
        deadlineMs: 2_000
      }).then(resolveServer, rejectServer)
    })
    try {
      const raw = await client.transport.dial(
        { transport: 'memory', address: server.name, priority: 0 },
        new AbortController().signal
      )
      const results = await Promise.allSettled([
        openSecureChannel(raw, {
          role: 'client',
          credentials: client.credentials,
          expectedPeerFingerprint: fingerprint(server.credentials.publicKeySpki),
          deadlineMs: 2_000
        }),
        serverOpened
      ])
      for (const result of results)
        if (result.status === 'fulfilled') this.channels.add(result.value)
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      return results.map((result) => (result as PromiseFulfilledResult<SecureChannel>).value) as [
        SecureChannel,
        SecureChannel
      ]
    } finally {
      await listener.close()
    }
  }
  async dispose(): Promise<void> {
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    this.network.dispose()
    for (const node of this.nodes) await node.dispose()
  }
}
