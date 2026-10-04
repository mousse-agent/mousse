import { afterEach, describe, expect, it } from 'vitest'
import { MemoryNetwork, MemoryTransport } from '../../../src/mms/net/transports/memory'
import { FakeClock } from '../harness/FakeClock'
import type { Duplex } from 'node:stream'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const setup = async () => {
  const clock = new FakeClock(),
    network = new MemoryNetwork(clock),
    a = new MemoryTransport(network, 'a'),
    b = new MemoryTransport(network, 'b')
  cleanup.push(async () => {
    await a.teardown()
    await b.teardown()
    network.dispose()
  })
  await a.provision()
  await b.provision()
  let remote!: Duplex
  await b.listen((stream) => {
    remote = stream
  })
  const controller = new AbortController(),
    local = await a.dial({ transport: 'memory', address: 'b', priority: 0 }, controller.signal)
  return { clock, network, a, b, local, remote, controller }
}

describe('production memory transport and faults', () => {
  it('exposes real backpressured byte streams, supports stall/resume and retires closed connection records', async () => {
    const { network, local, remote, controller } = await setup(),
      received: Buffer[] = []
    remote.on('data', (bytes) => received.push(bytes))
    network.connections[0].forward.stall()
    let complete = false
    local.write(Buffer.from('payload'), () => {
      complete = true
    })
    await tick()
    expect(received).toHaveLength(0)
    expect(complete).toBe(false)
    network.connections[0].forward.resume()
    await tick()
    expect(Buffer.concat(received).toString()).toBe('payload')
    expect(complete).toBe(true)
    controller.abort()
    await tick()
    expect(local.destroyed).toBe(true)
    expect(remote.destroyed).toBe(true)
    expect(network.connections).toHaveLength(0)
  })
  it('injects deterministic slow/corrupt/partition faults without pretending dropped bytes were delivered', async () => {
    const { clock, network, local, remote } = await setup(),
      received: Buffer[] = []
    remote.on('data', (bytes) => received.push(bytes))
    const link = network.connections[0]
    link.forward.slow(1)
    link.forward.corrupt(1)
    const written = new Promise<void>((resolve, reject) =>
      local.write(Buffer.from([1, 2, 3]), (error) => (error ? reject(error) : resolve()))
    )
    clock.advance(1)
    await tick()
    expect(Buffer.concat(received)).toEqual(Buffer.from([0]))
    clock.advance(2)
    await written
    await tick()
    expect(Buffer.concat(received)).toEqual(Buffer.from([0, 2, 3]))
    network.partition('a', 'b')
    await new Promise<void>((resolve, reject) =>
      local.write(Buffer.from([4]), (error) => (error ? reject(error) : resolve()))
    )
    await tick()
    expect(Buffer.concat(received)).toEqual(Buffer.from([0, 2, 3]))
    network.heal()
    local.write(Buffer.from([5]))
    clock.advance(1)
    await tick()
    expect(Buffer.concat(received)).toEqual(Buffer.from([0, 2, 3, 5]))
  })
  it('preserves dial refusal/partition errors and listener teardown ownership', async () => {
    const { network, a, b } = await setup()
    network.refuseDial('b')
    await expect(
      a.dial({ transport: 'memory', address: 'b', priority: 0 }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'route_unreachable' })
    network.allowDial('b')
    await b.teardown()
    await expect(
      a.dial({ transport: 'memory', address: 'b', priority: 0 }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(b.status()).toEqual({ state: 'disabled', routes: [] })
  })
})
