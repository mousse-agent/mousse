import { describe, expect, it } from 'vitest'
import { parseGrokCreditsGrpcWeb } from '../src/mms/providers/xaiBilling'

describe('parseGrokCreditsGrpcWeb', () => {
  it('reads credit_usage_percent and period end from a GetGrokCreditsConfig frame', () => {
    // Captured from grok.com GetGrokCreditsConfig with OAuth bearer (creditUsagePercent=25).
    const hex =
      '000000005a0a580d0000c84112001a00220c0885aa8fd4061090bb8eac032a0c08859fb4d4061090bb8eac033a070802150000c8413a020808421e0802120c0885aa8fd4061090bb8eac031a0c08859fb4d4061090bb8eac03580162006802800000000f677270632d7374617475733a300d0a'
    const body = Buffer.from(hex, 'hex')
    expect(parseGrokCreditsGrpcWeb(body)).toEqual([
      {
        id: 'weekly',
        label: 'Weekly',
        remainingPercent: 75,
        resetsAt: expect.any(String)
      }
    ])
    const resetsAt = parseGrokCreditsGrpcWeb(body)[0]?.resetsAt
    expect(resetsAt && Date.parse(resetsAt)).toBeGreaterThan(0)
  })

  it('treats an omitted proto3 zero usage field as 100 percent remaining', () => {
    // Current Grok response for creditUsagePercent=0. Proto3 omits the default
    // scalar field but retains the active billing-period timestamps.
    const hex =
      '00000000480a4612001a00220c08859fb4d4061090bb8eac032a0c088594d9d4061090bb8eac03421e0802120c08859fb4d4061090bb8eac031a0c088594d9d4061090bb8eac03580162006802800000000f677270632d7374617475733a300d0a'

    expect(parseGrokCreditsGrpcWeb(Buffer.from(hex, 'hex'))).toEqual([
      {
        id: 'weekly',
        label: 'Weekly',
        remainingPercent: 100,
        resetsAt: expect.any(String)
      }
    ])
  })

  it('still rejects a response with neither usage nor an active period', () => {
    const emptyConfig = Buffer.from('00000000020a00', 'hex')
    expect(parseGrokCreditsGrpcWeb(emptyConfig)).toEqual([])
  })
})
