import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { signedDocument } from '../../../../src/mms/net/identity/crypto'
import type { SpaceInviteAuthorization } from '../../../../src/shared/net'
import { newId } from '../../../../src/shared/net'
import { profile, peer, trust, signed, cleanup } from './helpers'
afterEach(cleanup)
const oracle = JSON.parse(
  readFileSync(
    new URL('../../../../test-vectors/net/security/invite-decisions.json', import.meta.url),
    'utf8'
  )
)
describe('real signed materialization of every frozen invite decision', () => {
  for (const c of oracle.cases)
    it(c.id, async () => {
      const a = await profile(),
        issuer = c.input.issuerRoleAtIssue === 'owner' ? a : await profile(a.clock, 'Issuer'),
        joiner = await profile(a.clock, 'Joiner'),
        space = a.host.create({ name: 'Invites' })
      if (issuer !== a) trust(a, issuer)
      if (issuer !== a)
        a.host.postMeta(space.space, 'member.joined', {
          member: {
            user: peer(issuer).user,
            rootKey: issuer.keys.rootKey()!,
            role: c.input.issuerRoleAtIssue,
            displayName: 'Issuer'
          }
        })
      const author = peer(issuer),
        root = issuer.keys.rootKey()!,
        roster = issuer.identity.verifySigned<any>(issuer.identity.roster()!, root),
        delegation = roster.nodes.find(
          (s: any) => issuer.identity.verifySigned<any>(s, root).subject === author.node
        ),
        before = a.projection.position(space.space)!,
        at = a.clock.now()
      const doc: SpaceInviteAuthorization = {
        v: 1,
        invite: newId('invite'),
        space: space.space,
        epoch: c.input.inviteEpoch,
        issuer: { user: author.user, node: author.node, delegation },
        auth: { metaEpoch: before.epoch, metaSeq: before.seq },
        role: c.input.role,
        issuedAt: at,
        expiresAt: at + c.input.expiresAt - c.input.issuedAt,
        uses: c.input.uses,
        ...(!c.input.optionalJoinerMatches ? { joiner: newId('user') } : {})
      }
      let authorization = issuer.identity.signAsNode(doc)
      if (!c.input.inviteSignatureValid) {
        const sig = Buffer.from(authorization.sig, 'base64url')
        sig[0] ^= 1
        authorization = { ...authorization, sig: sig.toString('base64url') }
      }
      if (c.input.issuerRoleNow !== c.input.issuerRoleAtIssue)
        a.host.postMeta(space.space, 'member.roleChanged', {
          user: author.user,
          role: c.input.issuerRoleNow
        })
      if (!c.input.issuerDelegationCurrent) {
        const higher = { ...author.delegation, keyEpoch: author.delegation.keyEpoch + 1 },
          current = {
            ...roster,
            version: roster.version + 1,
            nodes: [signedDocument(higher, (b) => issuer.keys.signAsRoot(b))]
          }
        a.identity.acceptRoster(
          signedDocument(current, (b) => issuer.keys.signAsRoot(b)),
          root
        )
      }
      const member = {
        user: peer(joiner).user,
        rootKey: joiner.keys.rootKey()!,
        role: doc.role,
        displayName: 'Joiner'
      }
      if (c.input.usedSlots.length) {
        const p = a.projection.position(space.space)!,
          record = signed(
            a,
            space.meta,
            'member.joined',
            { member, invite: authorization, inviteUse: 1 },
            { metaEpoch: p.epoch, metaSeq: p.seq }
          )
        a.projection.apply(space.space, { ...record, epoch: 1, seq: p.seq + 1 })
      }
      const p = a.projection.position(space.space)!,
        record = signed(
          c.input.receiptSignedByCurrentHost ? a : issuer,
          space.meta,
          'member.joined',
          { member, invite: authorization, inviteUse: c.input.inviteUse },
          { metaEpoch: p.epoch, metaSeq: p.seq }
        ),
        candidate = {
          ...record,
          epoch: 1,
          seq: p.seq + 1,
          recvTs: c.input.receiptAt === c.input.expiresAt ? doc.expiresAt : at + 1000
        }
      if (!c.input.issuerCurrentRosterAvailable) {
        const get = a.identity.roster.bind(a.identity)
        a.identity.roster = (user?: any) => (user === author.user ? undefined : get(user))
      }
      if (c.input.inviteUse === 0) {
        expect(() =>
          a.projection.checkInvite(space.space, authorization, member, 0, candidate.recvTs)
        ).toThrow(expect.objectContaining({ code: c.expected.code }))
        expect(() => a.projection.validate(space.space, candidate)).toThrow(
          expect.objectContaining({ code: 'bad_request' })
        )
        return
      }
      if (c.expected.decision === 'allow')
        expect(() => a.projection.validate(space.space, candidate)).not.toThrow()
      else
        expect(() => a.projection.validate(space.space, candidate)).toThrow(
          expect.objectContaining({ code: c.expected.code })
        )
      expect(a.projection.member(space.space, member.user) !== undefined).toBe(
        c.input.usedSlots.length > 0
      )
    })
})
