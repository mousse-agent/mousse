import { afterEach, expect, it, vi } from 'vitest'
import { setup } from '../admission/helpers'
import { cleanup } from '../../spaces/host/helpers'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { BotRecordAuthorization } from '../../../../src/mms/bots/admission'
import { peer } from '../../spaces/host/helpers'
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

it.each(['verifyOnly', 'revoked', 'wrongRoot', 'wrongUser', 'wrongNode'] as const)('denies an executor output when its scoped current trigger proof has %s', async failure => {
  const f = await setup(), input = f.message(), record = f.service.admit(input).record, binding = record.binding!
  const output = f.p.store.getStream(binding.stream)!, acceptance = f.outbox.list(binding.stream)[0], envelope = decodeEnvelope(acceptance.envelope).envelope
  const original = decodeEnvelope(input.record.envelope).envelope, author = f.p.identity.verifyAuthor(original.author, input.record.envelope, input.record.sig, original.ts, 'newWork')
  if (author.kind !== 'node') throw Error('Fixture author must be an actual signed node')
  const proof = { author, rootKey: f.p.identity.pinnedRootKey(author.user)! }
  const gate = new BotRecordAuthorization({ identity: f.p.identity, meta: f.p.projection, store: f.p.store,
    binding: () => ({ space: f.space.space, stream: binding.stream, parent: input.stream, bot: f.bot, trigger: input.record.id, execution: record.id }), verifyCurrentTrigger: () => proof })
  expect(gate.canWrite(output, envelope, peer(f.p))).toBe(true)
  if (failure === 'verifyOnly') proof.author = { ...author, verifyOnly: true }
  if (failure === 'revoked') proof.author = { ...author, revoked: true }
  if (failure === 'wrongRoot') proof.rootKey = 'different-root'
  if (failure === 'wrongUser') proof.author = { ...author, user: newId('user') }
  if (failure === 'wrongNode') proof.author = { ...author, node: newId('node') }
  expect(gate.canWrite(output, envelope, peer(f.p))).toBe(false)
  expect(f.p.store.head(binding.stream).seq).toBe(0)
  expect(f.outbox.get(acceptance.id)?.state).toBe('pending')
})
