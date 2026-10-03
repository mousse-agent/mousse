import { afterEach, expect, it } from 'vitest'
import { RosterEvidence } from '../../../src/mms/spaces/RosterEvidence'
import { newId, spaceMetaStream } from '../../../src/shared/net'
import { cleanup, profile, peer } from './host/helpers'

afterEach(cleanup)
it('retains authenticated foreign history without granting a global trust pin', async () => {
  const a = await profile(), b = await profile(a.clock,'Foreign'), evidence = new RosterEvidence(a.db), foreign = peer(b)
  evidence.retain(b.identity.roster()!)
  expect(a.identity.pinnedRootKey(foreign.user)).toBeUndefined()
  expect(evidence.forAuthor({user:foreign.user,node:foreign.node,keyEpoch:foreign.delegation.keyEpoch},a.clock.now(),b.keys.rootKey()!)).toEqual(b.identity.roster())
  expect(evidence.forAuthor({user:foreign.user,node:foreign.node,keyEpoch:foreign.delegation.keyEpoch},a.clock.now(),a.keys.rootKey()!)).toBeUndefined()
  expect(evidence.at(foreign.user,a.clock.now()-1,b.keys.rootKey()!)).toBeUndefined()
  const modified = structuredClone(b.identity.roster()!); modified.sig = Buffer.alloc(64).toString('base64url')
  expect(()=>evidence.retain(modified)).toThrow(expect.objectContaining({code:'bad_signature'}))
  expect(a.identity.pinnedRootKey(foreign.user)).toBeUndefined()
})
it('discovers the signed Space meta stream and retains membership at its original position', async () => {
  const a = await profile(), created = a.host.create({name:'History'}), self = peer(a)
  expect(created.meta).toBe(spaceMetaStream(created.space))
  const original = a.projection.memberAt(created.space,self.user,{metaEpoch:1,metaSeq:1})
  expect(original).toMatchObject({user:self.user,role:'owner',rootKey:a.keys.rootKey()})
  expect(a.projection.memberAt(created.space,self.user,{metaEpoch:1,metaSeq:0})).toBeUndefined()
})
it('uses a newer original self roster issued before a private control without promoting historical evidence', async () => {
  const a = await profile(), evidence = new RosterEvidence(a.db), self = a.identity.self()!, root = a.keys.rootKey()!, old = a.identity.roster()!
  evidence.retain(old)
  a.clock.advance(10)
  const bot = newId('bot'), key = a.keys.createBotKey(bot)
  a.identity.issueBotDelegation({ bot, key, name: 'Current self lease', hostNode: self.node })
  const current = a.identity.roster()!, before = a.db.database.prepare('SELECT value FROM net_identity_state').get()!.value
  expect(evidence.at(self.user, a.clock.now(), root, current)).toEqual(current)
  expect(evidence.at(self.user, a.clock.now() - 1, root, current)).toEqual(old)
  expect(evidence.at(self.user, a.clock.now(), root)).toEqual(old)
  expect(a.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
  const forged = structuredClone(current); forged.sig = Buffer.alloc(64).toString('base64url')
  expect(() => evidence.at(self.user, a.clock.now(), root, forged)).toThrow(expect.objectContaining({ code: 'bad_signature' }))
})
