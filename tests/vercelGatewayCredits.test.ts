import { describe, expect, it, vi } from 'vitest'
import { parseVercelCredits, readVercelGatewayCredits, VERCEL_GATEWAY_CREDITS_URL, type CreditsFetch } from '../src/mms/providers/vercelGatewayCredits'
import { usageText } from '../src/mms/providers/usageText'

/**
 * Vercel AI Gateway credits (`GET /v1/credits`): the balance and lifetime spend as USD decimal
 * strings, read with the stored gateway key. Every request here goes to a fake: no network.
 */

const reply = (status: number, body: unknown): CreditsFetch => vi.fn(async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }))

describe('the credits reply', () => {
  it('reads balance and total_used as the documented decimal strings, or numbers', () => {
    expect(parseVercelCredits({ balance: '95.50', total_used: '4.50' })).toEqual({ balanceUsd: 95.5, usedUsd: 4.5 })
    expect(parseVercelCredits({ balance: 12.4, total_used: 37.6 })).toEqual({ balanceUsd: 12.4, usedUsd: 37.6 })
    expect(parseVercelCredits({ balance: '0.00' })).toEqual({ balanceUsd: 0 })
    // The live gateway sends ten decimal places.
    expect(parseVercelCredits({ balance: '4.2034567812', total_used: '37.7965432188' })).toEqual({ balanceUsd: 4.2034567812, usedUsd: 37.7965432188 })
  })

  it('has nothing without a usable balance', () => {
    for (const body of [{}, { balance: 'lots' }, { balance: null, total_used: '1' }, [], null, 'text'])
      expect(parseVercelCredits(body)).toBeUndefined()
    expect(parseVercelCredits({ balance: '5', total_used: 'x' })).toEqual({ balanceUsd: 5 })
  })
})

describe('reading the credits with the stored key', () => {
  it('asks the documented address with the key as a bearer token, and follows no redirect', async () => {
    const fetch = reply(200, { balance: '12.40', total_used: '37.60' })
    expect(await readVercelGatewayCredits('vck_secret', { fetch })).toEqual({ status: 'available', windows: [], credit: { balanceUsd: 12.4, usedUsd: 37.6 } })
    expect(fetch).toHaveBeenCalledWith(VERCEL_GATEWAY_CREDITS_URL, expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer vck_secret' }) }))
  })

  it('says "Key rejected", "Not reachable" or why, in a few words, and never the key', async () => {
    expect(await readVercelGatewayCredits('k', { fetch: reply(401, {}) })).toEqual({ status: 'error', windows: [], message: 'Key rejected', problem: 'key_rejected' })
    expect(await readVercelGatewayCredits('k', { fetch: reply(403, {}) })).toMatchObject({ message: 'Key rejected' })
    expect(await readVercelGatewayCredits('k', { fetch: reply(502, {}) })).toMatchObject({ message: 'Not reachable' })
    expect(await readVercelGatewayCredits('k', { fetch: reply(429, {}) })).toMatchObject({ message: 'Rate limited' })
    expect(await readVercelGatewayCredits('k', { fetch: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND with k') }) })).toEqual({ status: 'error', windows: [], message: 'Not reachable', problem: 'unavailable' })
    expect(await readVercelGatewayCredits('k', { fetch: reply(200, '<html>') })).toMatchObject({ message: 'No balance reported' })
  })

  it('gives up after its timeout', async () => {
    const hang: CreditsFetch = vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    expect(await readVercelGatewayCredits('k', { fetch: hang, timeoutMs: 20 })).toMatchObject({ message: 'Not reachable' })
  })

  it('reads as one line of text for agents', () => {
    expect(usageText('Vercel AI Gateway', { status: 'available', windows: [], credit: { balanceUsd: 12.4, usedUsd: 37.6 } })).toBe('Vercel AI Gateway credits: $12.40 left, $37.60 used')
  })
})
