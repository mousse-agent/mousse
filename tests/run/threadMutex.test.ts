import { describe, expect, it } from 'vitest'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { ThreadMutex } from '../../src/mms/run/ThreadMutex'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('ThreadMutex', () => {
  it('runs holders of one key one at a time in FIFO order', async () => {
    const mutex = new ThreadMutex()
    const log: string[] = []
    let inside = 0
    let maxInside = 0
    const job = (name: string, ms: number) =>
      mutex.withLock('t', async () => {
        inside += 1
        maxInside = Math.max(maxInside, inside)
        log.push(`start:${name}`)
        await tick(ms)
        log.push(`end:${name}`)
        inside -= 1
        return name
      })
    const results = await Promise.all([job('a', 15), job('b', 1), job('c', 5)])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(maxInside).toBe(1)
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    expect(mutex.isLocked('t')).toBe(false)
  })

  it('releases the key when the holder throws', async () => {
    const mutex = new ThreadMutex()
    await expect(mutex.withLock('t', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(mutex.withLock('t', () => 'next')).resolves.toBe('next')
    expect(mutex.isLocked('t')).toBe(false)
  })

  it('does not serialise different keys', async () => {
    const mutex = new ThreadMutex()
    let release!: () => void
    const held = mutex.withLock('a', () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    await expect(mutex.withLock('b', () => 'b')).resolves.toBe('b')
    release()
    await held
  })

  it('times out instead of deadlocking, including on reentry, and keeps the queue intact', async () => {
    const mutex = new ThreadMutex()
    let reentry: unknown
    await mutex.withLock('t', async () => {
      try {
        await mutex.withLock('t', () => 'never', { timeoutMs: 20 })
      } catch (error) {
        reentry = error
      }
    })
    expect(reentry).toBeInstanceOf(RunStoreError)
    expect((reentry as RunStoreError).code).toBe('internal')
    expect((reentry as RunStoreError).message).toBe('thread mutex acquire timed out')

    let release!: () => void
    const held = mutex.withLock('t', () => new Promise<void>((resolve) => (release = resolve)))
    const timedOut = mutex.withLock('t', () => 'late', { timeoutMs: 10 })
    const patient = mutex.withLock('t', () => 'patient', { timeoutMs: 1_000 })
    await expect(timedOut).rejects.toMatchObject({ code: 'internal' })
    release()
    await held
    await expect(patient).resolves.toBe('patient')
    expect(mutex.isLocked('t')).toBe(false)
  })
})
