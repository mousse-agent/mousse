import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { isNetErrorCode } from '../../../src/shared/net/errors'
import { decodeEnvelope } from '../../../src/mms/net/sync/codec'

// These are catalogue integrity checks, not an implementation of admission.
// P1/P6 must feed the same fixtures into the real ledgers/runtime admission path.
const bytes = readFileSync(
  new URL('../../../test-vectors/net/admission/cases.json', import.meta.url)
)
const fixtures = JSON.parse(bytes.toString('utf8'))
const schema = JSON.parse(
  readFileSync(new URL('../../../test-vectors/net/admission/schema.json', import.meta.url), 'utf8')
)

interface Expected {
  decision: string
  code?: string
  state?: string
  deltas: Record<string, number>
}
interface AdmissionCase {
  id: string
  input: {
    space: string
    bot: string
    event: string
    envelopeUtf8: string
    payloadHash: string
    eventType: string
    authorKind: string
    authorTs: number
    eventMetaSeq: number
    eventMetaEpoch: number
    mentionsBot: boolean
    existing: { state: string; payloadHash: string } | null
  }
  expected: Expected
}

describe('P0 admission fixture catalogue', () => {
  it('loads a bounded strict-schema catalogue with unique cases and registered errors', () => {
    expect(bytes.length).toBeLessThanOrEqual(256 * 1024)
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)
    expect(validate(fixtures), JSON.stringify(validate.errors)).toBe(true)
    const ids = new Set<string>()
    for (const group of [
      'admissionCases',
      'multiBotCases',
      'approvalCases',
      'recoveryCases',
      'compartmentCases',
      'transactionCases'
    ]) {
      for (const item of fixtures[group]) {
        expect(ids.has(`${group}/${item.id}`)).toBe(false)
        ids.add(`${group}/${item.id}`)
        if (item.expected.code) expect(isNetErrorCode(item.expected.code)).toBe(true)
      }
    }
  })

  it('keeps extracted policy evidence and exact envelope hashes consistent', () => {
    for (const { id, input } of fixtures.admissionCases as AdmissionCase[]) {
      const { envelope } = decodeEnvelope(Buffer.from(input.envelopeUtf8, 'utf8'))
      const digest = createHash('sha256').update(input.envelopeUtf8, 'utf8').digest('hex')
      expect(input.payloadHash, id).toBe(digest)
      expect(envelope.id, id).toBe(input.event)
      expect(envelope.type, id).toBe(input.eventType)
      expect(envelope.ts, id).toBe(input.authorTs)
      expect(envelope.auth, id).toEqual({
        metaSeq: input.eventMetaSeq,
        metaEpoch: input.eventMetaEpoch
      })
      expect(
        envelope.refs?.mentions?.some((bot) => bot === input.bot),
        id
      ).toBe(input.mentionsBot)
      expect(Boolean(envelope.author.bot), id).toBe(input.authorKind === 'bot')
    }
  })

  it('declares atomic outcomes without treating receipt creation as a model call', () => {
    for (const { id, input, expected } of fixtures.admissionCases as AdmissionCase[]) {
      expect(expected.deltas.modelCalls, id).toBe(0)
      if (expected.decision === 'admit') {
        expect(expected.state, id).toBe('accepted')
        expect(expected.deltas, id).toEqual({
          executions: 1,
          reservations: 1,
          receipts: 1,
          rateCharges: 1,
          concurrencySlots: 1,
          modelCalls: 0
        })
      } else if (expected.decision === 'expired') {
        expect(expected.state, id).toBe('expired')
        expect(expected.deltas, id).toEqual({
          executions: 1,
          reservations: 0,
          receipts: 1,
          rateCharges: 0,
          concurrencySlots: 0,
          modelCalls: 0
        })
      } else {
        expect(
          Object.values(expected.deltas).every((value) => value === 0),
          id
        ).toBe(true)
      }
      if (expected.decision === 'duplicate') {
        expect(input.existing?.payloadHash, id).toBe(input.payloadHash)
        expect(expected.state, id).toBe(input.existing?.state)
      }
    }
  })

  it('materializes distinct per-bot prestate for independent admission', () => {
    const [both, limited] = fixtures.multiBotCases
    expect(both.targets.map((target: { bot: string }) => target.bot)).toEqual(both.bots)
    expect(limited.targets.map((target: { bot: string }) => target.bot)).toEqual(limited.bots)
    expect(
      both.targets.every(
        (target: { dailyRemainingUnits: number; runCeilingUnits: number }) =>
          target.dailyRemainingUnits >= target.runCeilingUnits
      )
    ).toBe(true)
    expect(limited.targets[0].dailyRemainingUnits).toBe(0)
    expect(limited.targets[1].dailyRemainingUnits).toBeGreaterThanOrEqual(
      limited.targets[1].runCeilingUnits
    )
    for (const group of fixtures.multiBotCases) {
      expect(group.targets.length).toBe(group.bots.length)
      for (const target of group.targets) {
        const { envelope } = decodeEnvelope(Buffer.from(target.envelopeUtf8, 'utf8'))
        expect(target.payloadHash).toBe(
          createHash('sha256').update(target.envelopeUtf8).digest('hex')
        )
        expect(envelope.id).toBe(group.trigger)
        expect(envelope.refs?.mentions).toEqual(group.bots)
      }
    }
  })

  it('retains required boundary and failure scenarios for later real conformance', () => {
    const byId = new Map<string, AdmissionCase>(
      fixtures.admissionCases.map((item: AdmissionCase) => [item.id, item])
    )
    for (const [id, decision] of [
      ['delivery-exactly-thirty-seconds', 'admit'],
      ['delivery-one-ms-too-old', 'expired'],
      ['author-delay-one-ms-too-old', 'expired'],
      ['future-host-receipt', 'reject'],
      ['future-author-timestamp', 'reject'],
      ['meta-head-known-not-applied', 'reject'],
      ['runtime-unqualified', 'reject'],
      ['provider-spend-unbounded', 'reject'],
      ['duplicate-uncertain-after-window', 'duplicate'],
      ['same-key-different-exact-bytes', 'reject'],
      ['rollback-at-budget-reserve', 'reject'],
      ['rollback-at-accepted-outbox-insert', 'reject'],
      ['rollback-at-commit', 'reject'],
      ['snapshot-display-never-triggers', 'ignore'],
      ['bot-authored-handoff', 'ignore']
    ])
      expect(byId.get(id)?.expected.decision, id).toBe(decision)

    for (const item of fixtures.recoveryCases) {
      expect(item.expected.automaticRetry, item.id).toBe(false)
      expect(item.expected.retainDedup, item.id).toBe(true)
      if (item.input.cost === 'unknown') expect(item.expected.retainReservation, item.id).toBe(true)
    }
    for (const item of fixtures.compartmentCases) {
      expect(item.expected.publicMayReadPrivate, item.id).toBe(false)
      if (item.expected.context === 'fresh')
        expect(item.expected.loadPreviousPrivateTurns, item.id).toBe(false)
    }
    for (const item of fixtures.transactionCases) {
      expect(item.expected.heldUnits, item.id).toBeLessThanOrEqual(item.input.remainingUnits)
      expect(item.expected.modelCallsBeforeCommit, item.id).toBe(0)
      expect(item.expected.newReceipts, item.id).toBe(item.expected.admitted)
    }
  })
})
