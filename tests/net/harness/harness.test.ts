import { describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { existsSync, realpathSync } from 'node:fs'
import { FakeClock, NetTestBed, memoryPair } from './index'

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
