import { describe, expect, it } from 'vitest'
import type { NetStatus } from '../../src/shared/net'
import {
  createWakeableSleep,
  formatCountdown,
  mousseIdPreparation,
  mousseIdSetupStep,
  normalizePlusOrigin,
  pollPlusSignIn,
  resolvePlusOrigin,
  secondsLeft,
  signInErrorMessage,
  withSignInCallback
} from '../../src/renderer/lib/plusSignIn'

function clock() {
  let time = 1_000_000
  const waits: number[] = []
  return {
    now: () => time,
    waits,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'cancelled' })
      waits.push(ms)
      time += ms
    }
  }
}
const pending = () => Promise.reject({ code: 'peer_offline', message: 'Approve first' })

describe('Mousse ID sign-in polling', () => {
  it('waits with backoff until the approval lands', async () => {
    const c = clock()
    let calls = 0
    const result = await pollPlusSignIn(
      () => (++calls < 5 ? pending() : Promise.resolve('connected')),
      { intervalMs: 1000, expiresAt: c.now() + 600_000, signal: new AbortController().signal, maxIntervalMs: 3000, ...c }
    )
    expect(result).toBe('connected')
    expect(c.waits).toEqual([1000, 1500, 2250, 3000])
  })

  it('stops at expiry and on cancel', async () => {
    const c = clock()
    await expect(
      pollPlusSignIn(pending, { intervalMs: 1000, expiresAt: c.now() + 2500, signal: new AbortController().signal, ...c })
    ).rejects.toMatchObject({ code: 'expired' })
    expect(c.waits).toEqual([1000, 1500])
    const controller = new AbortController()
    let calls = 0
    await expect(
      pollPlusSignIn(
        () => {
          if (++calls === 2) controller.abort()
          return pending()
        },
        { intervalMs: 1000, expiresAt: c.now() + 600_000, signal: controller.signal, ...c }
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).toBe(2)
  })

  it('ends on a real failure', async () => {
    const c = clock()
    await expect(
      pollPlusSignIn(() => Promise.reject({ code: 'forbidden' }), {
        intervalMs: 1000,
        expiresAt: c.now() + 600_000,
        signal: new AbortController().signal,
        ...c
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(c.waits).toEqual([])
  })

  it('aborts a real sleep promptly', async () => {
    const controller = new AbortController()
    const run = pollPlusSignIn(pending, { intervalMs: 60_000, expiresAt: Date.now() + 600_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('Mousse ID origin', () => {
  it('accepts https and loopback http origins only', () => {
    expect(normalizePlusOrigin(' https://plus.example.test/ ')).toBe('https://plus.example.test')
    expect(normalizePlusOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    for (const bad of ['', 'plus.example.test', 'http://plus.example.test', 'https://u:p@x.test', 'https://x.test/path', 'https://x.test/?a=1'])
      expect(normalizePlusOrigin(bad)).toBeUndefined()
  })

  it('prefers a valid override, then the build default, else nothing', () => {
    expect(resolvePlusOrigin('https://mine.test', 'https://default.test')).toBe('https://mine.test')
    expect(resolvePlusOrigin('nonsense', 'https://default.test')).toBe('https://default.test')
    expect(resolvePlusOrigin(null, '')).toBe('')
  })

  it('formats the countdown', () => {
    expect(secondsLeft(10_500, 1000)).toBe(10)
    expect(secondsLeft(0, 1000)).toBe(0)
    expect(formatCountdown(605)).toBe('10:05')
  })
})

describe('phone QR code', () => {
  it('draws a QR code with a quiet zone for a join URL', async () => {
    const { qrSvgPath } = await import('../../src/renderer/lib/plusQr')
    const url = 'mousse://net/join?v=1&plus=https%3A%2F%2Fplus.example.test&offer=off_01HZXTESTOFFER00000000000&key=' + 'A'.repeat(43)
    const { size, path } = qrSvgPath(url)
    expect((size - 8 - 17) % 4).toBe(0)
    expect(path).toMatch(/^M4 4h1v1h-1z/)
  })
})

describe('sign-in callback', () => {
  it('adds the loopback callback to the approval link', () => {
    const link = withSignInCallback('https://mousse.work/net-approve?code=ABCD-EFGH', 'http://127.0.0.1:4100/mousse-id/callback/abc')
    const url = new URL(link)
    expect(url.searchParams.get('code')).toBe('ABCD-EFGH')
    expect(url.searchParams.get('callback')).toBe('http://127.0.0.1:4100/mousse-id/callback/abc')
    expect(withSignInCallback('https://mousse.work/net-approve', undefined)).toBe('https://mousse.work/net-approve')
  })

  it('wakes a running wait early, and the next wait when none is running', async () => {
    const { sleep, wake } = createWakeableSleep()
    const signal = new AbortController().signal
    const started = Date.now()
    const waiting = sleep(60_000, signal)
    wake()
    await waiting
    wake()
    await sleep(60_000, signal)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rejects a wait as cancelled when aborted', async () => {
    const { sleep } = createWakeableSleep()
    const controller = new AbortController()
    const waiting = sleep(60_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('sign-in errors', () => {
  const origin = 'https://api.mousse.work'

  it('names the service when it cannot be reached or refuses', () => {
    expect(signInErrorMessage({ code: 'route_unreachable', message: 'No route to the peer is reachable.' }, origin))
      .toBe('Can’t reach Mousse ID at api.mousse.work. Check your internet connection and try again.')
    expect(signInErrorMessage({ code: 'forbidden' }, origin)).toContain('api.mousse.work didn’t accept')
  })

  it('points to the setup step when the keystore is locked', () => {
    const net = { enabled: true, self: {}, keystore: 'locked', protected: true } as never
    expect(signInErrorMessage({ code: 'keystore_locked' }, origin, net)).toBe(mousseIdSetupStep(net))
    expect(mousseIdSetupStep(undefined)).toBe('Create a network identity under Devices first.')
  })

  it('keeps other messages as they are', () => {
    expect(signInErrorMessage(new Error('Something else'), origin)).toBe('Something else')
  })
})

describe('networking preparation', () => {
  const base = { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [],
    self: { node: 'n', user: 'u', isAuthority: true } } as unknown as NetStatus
  it('sets up networking itself unless the profile is locked', () => {
    expect(mousseIdPreparation(base)).toBe('ready')
    expect(mousseIdPreparation(undefined)).toBe('automatic')
    expect(mousseIdPreparation({ ...base, self: undefined, enabled: false, keystore: 'missing' })).toBe('automatic')
    expect(mousseIdPreparation({ ...base, enabled: false })).toBe('automatic')
    expect(mousseIdPreparation({ ...base, protected: false })).toBe('automatic')
    expect(mousseIdPreparation({ ...base, keystore: 'locked' })).toBe('manual')
  })
})
