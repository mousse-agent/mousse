import { afterEach, expect, it, vi } from 'vitest'
import { setup } from '../admission/helpers'
import { cleanup } from '../../spaces/host/helpers'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { NetError, newId } from '../../../../src/shared/net'

afterEach(cleanup)

it.each(['verifyOnly', 'revoked', 'wrongRoot', 'wrongUser', 'wrongNode'] as const)('rejects a trusted scoped callback returning %s before any admission effects', async failure => {
  const f = await setup(), input = f.message(), envelope = decodeEnvelope(input.record.envelope).envelope
  const author = f.p.identity.verifyAuthor(envelope.author, input.record.envelope, input.record.sig, envelope.ts, 'newWork')
  if (author.kind !== 'node') throw Error('Fixture author must be an actual signed node')
  const root = f.p.identity.pinnedRootKey(author.user)!
  f.service.options.verifyMentionAuthor = () => ({ author: { ...author,
    ...(failure === 'verifyOnly' ? { verifyOnly: true } : {}), ...(failure === 'revoked' ? { revoked: true } : {}),
    ...(failure === 'wrongUser' ? { user: newId('user') } : {}),
    ...(failure === 'wrongNode' ? { node: newId('node') } : {}) }, rootKey: failure === 'wrongRoot' ? 'different-root' : root })
  expect(() => f.service.admit(input)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
  expect(f.budgets.remaining(f.bot, f.space.space, f.p.clock.now())).toBe(1000)
})

it('revalidates exact current proof after pure planning and rolls back when current authority changes before the SQL admission', async () => {
  const f = await setup(), input = f.message()
  const verify = vi.fn((record: typeof input) => {
    const envelope = decodeEnvelope(record.record.envelope).envelope
    return { author: f.p.identity.verifyAuthor(envelope.author, record.record.envelope, record.record.sig, envelope.ts, 'newWork'), rootKey: f.p.identity.pinnedRootKey(envelope.author.user!)! }
  })
  f.service.options.verifyMentionAuthor = verify
  f.service.preview(input)
  verify.mockImplementation(() => { throw new NetError('bad_delegation') })
  expect(() => f.service.admit(input)).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
  expect(verify.mock.calls.length).toBeGreaterThan(1)
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_executions').get()!.n).toBe(0)
  expect(f.p.db.database.prepare('SELECT count(*) AS n FROM net_bot_admission_slots').get()!.n).toBe(0)
})
