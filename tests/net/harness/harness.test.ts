import { describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { existsSync, realpathSync } from 'node:fs'
import { FakeClock, MemoryNetwork, MemoryTransport, NetTestBed, memoryPair } from './index'

const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('fault injection harness', () => {
  it('fires nested timers in deadline/insertion order and cancels deterministically', () => {
    const clock = new FakeClock(1_000),
      order: string[] = []
    clock.setTimeout(() => {
      order.push('first')
      clock.setTimeout(() => order.push('nested'), 0)
    }, 5)
    clock.setTimeout(() => order.push('second'), 5)
    clock.setTimeout(() => order.push('cancelled'), 2).cancel()
    clock.advance(10)
    expect(order).toEqual(['first', 'second', 'nested'])
    expect(clock.now()).toBe(1_010)
    expect(clock.monotonic()).toBe(10)
    clock.setWallTime(500)
    expect(clock.monotonic()).toBe(10)
    expect(clock.pending()).toBe(0)
  })
  it('stalls, resumes, silently drops one direction and heals without closing', async () => {
    const pair = memoryPair(),
      received: string[] = []
    pair.b.on('data', (chunk) => received.push(chunk.toString()))
    pair.forward.stall()
    pair.a.write('held')
    await flush()
    expect(received).toEqual([])
    pair.forward.resume()
    await flush()
    expect(received).toEqual(['held'])
    pair.forward.halfOpen()
    pair.a.write('dropped')
    await flush()
    expect(received).toEqual(['held'])
    const reverse = once(pair.a, 'data')
    pair.b.write('reverse')
    expect((await reverse)[0].toString()).toBe('reverse')
    expect(pair.a.destroyed).toBe(false)
    pair.forward.heal()
    pair.a.write('healed')
    await flush()
    expect(received).toEqual(['held', 'healed'])
    pair.cut()
  })
  it('delivers exactly the configured bytes per tick', async () => {
    const clock = new FakeClock(),
      pair = memoryPair(clock),
      received: Buffer[] = []
    pair.b.on('data', (chunk) => received.push(chunk))
    pair.forward.slow(2)
    pair.a.write('abcde')
    await flush()
    expect(Buffer.concat(received).length).toBe(0)
    clock.advance(1)
    await flush()
    expect(Buffer.concat(received).toString()).toBe('ab')
    clock.advance(1)
    await flush()
    expect(Buffer.concat(received).toString()).toBe('abcd')
    clock.advance(1)
    await flush()
    expect(Buffer.concat(received).toString()).toBe('abcde')
    pair.cut()
    expect(clock.pending()).toBe(0)
  })
  it('corrupts only the next requested bytes and transforms chunks deterministically', async () => {
    const pair = memoryPair()
    pair.forward.corrupt(2)
    const first = once(pair.b, 'data')
    pair.a.write(Buffer.from([4, 5, 6]))
    expect([...((await first)[0] as Buffer)]).toEqual([5, 4, 6])
    pair.forward.tamper((bytes) => Buffer.concat([bytes, Buffer.from('!')]))
    const second = once(pair.b, 'data')
    pair.a.write('x')
    expect((await second)[0].toString()).toBe('x!')
    pair.cut()
  })
  it('partitions live links, refuses new dials, heals and tears down listeners', async () => {
    const network = new MemoryNetwork(),
      a = new MemoryTransport(network, 'a'),
      b = new MemoryTransport(network, 'b')
    await a.provision()
    await b.provision()
    let receiver!: NodeJS.ReadableStream
    const listener = await b.listen((stream) => {
      receiver = stream
    })
    const route = { transport: 'memory', address: 'b', priority: 0 }
    const stream = await a.dial(route, new AbortController().signal)
    network.partition('a', 'b')
    await expect(a.dial(route, new AbortController().signal)).rejects.toMatchObject({
      code: 'route_unreachable'
    })
    let bytes = 0
    receiver.on('data', (chunk) => {
      bytes += chunk.length
    })
    stream.write('lost')
    await flush()
    expect(bytes).toBe(0)
    network.heal()
    stream.write('ok')
    await flush()
    expect(bytes).toBe(2)
    network.refuseDial('b')
    await expect(a.dial(route, new AbortController().signal)).rejects.toMatchObject({
      code: 'route_unreachable'
    })
    network.allowDial('b')
    await listener.close()
    await expect(a.dial(route, new AbortController().signal)).rejects.toMatchObject({
      code: 'route_unreachable'
    })
    await a.teardown()
    await b.teardown()
    expect(stream.destroyed).toBe(true)
  })
  it('cuts both directions and clears a blocked write', async () => {
    const pair = memoryPair()
    pair.forward.stall()
    const written = new Promise<Error | null | undefined>((resolve) => {
      pair.a.write('blocked', resolve)
    })
    pair.cut()
    expect(await written).toBeInstanceOf(Error)
    expect(pair.a.destroyed && pair.b.destroyed).toBe(true)
  })
  it('runs a two-node pinned TLS echo and owns realpath-resolved profiles', async () => {
    const bed = new NetTestBed()
    try {
      for (const node of bed.nodes) expect(realpathSync(node.profileDir)).toBe(node.profileDir)
      bed.nodes[0].attach('marker', 42)
      expect(bed.nodes[0].get('marker')).toBe(42)
      const [a, b] = await bed.connect(0, 1)
      b.stream.on('data', (bytes) => b.stream.write(bytes))
      const echoed = once(a.stream, 'data')
      a.stream.write('P0 echo')
      expect((await echoed)[0].toString()).toBe('P0 echo')
    } finally {
      await bed.dispose()
    }
    for (const node of bed.nodes) expect(existsSync(node.profileDir)).toBe(false)
  })
})
