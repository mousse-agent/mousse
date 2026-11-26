/**
 * The request hub of a computer being updated from another (#476): the rules that keep an install from starting early,
 * twice, for someone else, or after it should have.
 */
import { expect, it } from 'vitest'
import { RemoteUpdates, type UpdateRequester } from '../../src/mms/updates/remoteUpdates'
import { REMOTE_UPDATE_LIMITS } from '../../src/shared/remoteUpdates'

function hub() {
  let now = 1_000
  let ids = 0
  const updates = new RemoteUpdates({ now: () => now, limits: REMOTE_UPDATE_LIMITS, newId: () => `job-${++ids}` })
  const asker = (node: string, allowed = { yes: true }): UpdateRequester => ({ node, name: node, stillAllowed: () => allowed.yes })
  const ready = (from: UpdateRequester, version = '0.2.0') => {
    const { job } = updates.prepare(from, version)
    updates.progress('app', job, { phase: 'ready' })
    return job
  }
  updates.attach('app')
  return { updates, asker, ready, advance: (ms: number) => (now += ms) }
}

it('never installs before the countdown ends, and only for the app that holds the registration', () => {
  const { updates, asker, ready, advance } = hub()
  const job = ready(asker('a'))
  expect(updates.install('a', job, 0).phase).toBe('countdown')
  expect(updates.begin('app', job)).toMatchObject({ go: false, wait: true })
  advance(REMOTE_UPDATE_LIMITS.countdownMs - 1)
  expect(updates.begin('app', job)).toMatchObject({ go: false, wait: true })
  advance(1)
  expect(updates.begin('another-connection', job)).toMatchObject({ go: false, wait: false })
  expect(updates.begin('app', job)).toEqual({ go: true })
  expect(updates.status('a', job).phase).toBe('installing')
})

it('runs one request at a time, shows it only to the computer that asked, and lets that one cancel it', () => {
  const { updates, asker, ready } = hub()
  const job = ready(asker('a'))
  // The same ask again is the same request; another computer's is refused while it runs.
  expect(updates.prepare(asker('a'), '0.2.0').job).toBe(job)
  expect(updates.prepare(asker('b'), '0.2.0')).toMatchObject({ phase: 'failed', error: 'busy' })
  expect(updates.status('b', job)).toMatchObject({ phase: 'failed', error: 'unknown_job' })
  expect(updates.install('b', job, 0)).toMatchObject({ phase: 'failed', error: 'unknown_job' })
  expect(updates.cancel('a', job)).toMatchObject({ phase: 'cancelled', error: 'cancelled' })
  expect(updates.current()).toBeNull()
  // Over: the next computer may ask.
  expect(updates.prepare(asker('b'), '0.2.0').phase).toBe('preparing')
})

it('fails a request that waits past its time, or whose asker lost Full control by the end of the countdown', () => {
  const { updates, asker, ready, advance } = hub()
  const late = ready(asker('a'))
  advance(REMOTE_UPDATE_LIMITS.requestTtlMs + 1)
  expect(updates.install('a', late, 0)).toMatchObject({ phase: 'failed', error: 'expired' })

  const allowed = { yes: true }
  const job = ready(asker('a', allowed))
  updates.install('a', job, 0)
  allowed.yes = false
  advance(REMOTE_UPDATE_LIMITS.countdownMs)
  expect(updates.begin('app', job)).toMatchObject({ go: false, wait: false })
  expect(updates.status('a', job)).toMatchObject({ phase: 'failed', error: 'forbidden' })
})

it('drops a request when the app that installs goes away, and an install under way is not cancelled', () => {
  const { updates, asker, ready, advance } = hub()
  const job = ready(asker('a'))
  updates.install('a', job, 0)
  updates.detach('app')
  expect(updates.accepts()).toBe(false)
  expect(updates.status('a', job)).toMatchObject({ phase: 'failed', error: 'not_accepting' })

  updates.attach('app')
  const next = ready(asker('a'))
  updates.install('a', next, 0)
  advance(REMOTE_UPDATE_LIMITS.countdownMs)
  expect(updates.begin('app', next)).toEqual({ go: true })
  expect(updates.cancel('a', next).phase).toBe('installing')
})
