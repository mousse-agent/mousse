import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { joinTarget, MousseIdJoin } from '../../../src/mms/net/plus/MousseIdJoin'
import { sealInviteForRequest } from '../../../src/mms/net/plus/enrollmentSeal'
import { verifyBytes, rawPublicKey } from '../../../src/mms/net/identity/crypto'
import { canonicalJson } from '../../../src/mms/net/sync/codec'

const configuration = {
  apiOrigin: 'http://127.0.0.1:23456',
  audience: 'ws://127.0.0.1:23456/v1/net/relay',
  installationId: 'local-installation',
  gatewayId: 'gateway-one'
}
const accountId = '08e9bdf6-81f3-4497-815e-7d3d4c398119'

const binding = (user: string, authorityNode: string, nodes: number, consentAt: number, extra = {}) => ({
  userId: user,
  revokedAt: null,
  conflict: false,
  consentAt,
  frontier: { authorityNode, nodes: Array.from({ length: nodes }, () => ({})) },
  ...extra
})
const computer = (user: string, node: string, extra = {}) => ({
  userId: user,
  nodeId: node,
  kind: 'computer',
  online: true,
  revokedAt: null,
  deviceName: `Desk ${node}`,
  ...extra
})

describe('joinTarget', () => {
  it('picks the authority of the network with the most devices, the oldest on a tie', () => {
    expect(
      joinTarget({
        bindings: [binding('usr_a', 'nod_a', 1, 1), binding('usr_b', 'nod_b', 2, 2), binding('usr_c', 'nod_c', 2, 3)],
        registrations: [computer('usr_a', 'nod_a'), computer('usr_b', 'nod_b'), computer('usr_c', 'nod_c')]
      })
    ).toEqual({ node: 'nod_b', name: 'Desk nod_b', online: true })
  })

  it('skips revoked and conflicted networks and networks whose owner is not registered', () => {
    expect(
      joinTarget({
        bindings: [
          binding('usr_a', 'nod_a', 5, 1, { revokedAt: 10 }),
          binding('usr_b', 'nod_b', 5, 1, { conflict: true }),
          binding('usr_c', 'nod_c', 5, 1),
          binding('usr_d', 'nod_d', 1, 1)
        ],
        registrations: [
          computer('usr_a', 'nod_a'),
          computer('usr_b', 'nod_b'),
          computer('usr_c', 'nod_c', { revokedAt: 5 }),
          computer('usr_d', 'nod_d', { online: false })
        ]
      })
    ).toEqual({ node: 'nod_d', name: 'Desk nod_d', online: false })
  })

  it('finds nothing on an account with no network', () => {
    expect(joinTarget({ bindings: [], registrations: [] })).toBeUndefined()
    expect(joinTarget({ devices: { used: 0, limit: 5 } })).toBeUndefined()
    expect(joinTarget(undefined)).toBeUndefined()
  })
})

describe('MousseIdJoin', () => {
  function fixture(requestStates: Array<Record<string, unknown>> = []) {
    const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = []
    let polls = 0
    const fakeFetch: typeof fetch = async (url, input) => {
      const path = new URL(String(url)).pathname,
        method = input?.method ?? 'GET',
        body = input?.body ? JSON.parse(String(input.body)) : undefined
      calls.push({ method, path, auth: new Headers(input?.headers).get('authorization'), body })
      if (path === '/v1/net/config')
        return Response.json({
          installationId: configuration.installationId,
          gatewayId: configuration.gatewayId,
          relayAudience: configuration.audience
        })
      if (path === '/v1/net/login')
        return Response.json({
          id: 'login-one',
          pollToken: 'p'.repeat(40),
          userCode: 'ABCDEF-123456',
          verificationUri: `${configuration.apiOrigin}/net-approve?code=ABCDEF-123456`,
          expiresAt: Date.now() + 300000,
          pollIntervalMs: 2000
        })
      if (path === '/v1/net/login/login-one') return Response.json({ status: ++polls > 1 ? 'approved' : 'pending' })
      if (path === '/v1/net/login/login-one/exchange')
        return Response.json({
          accessToken: 'nl_' + 'a'.repeat(40),
          accountId,
          expiresAt: Date.now() + 600000,
          email: 'ada@example.test'
        })
      if (path === '/v1/net/enrollment-requests')
        return Response.json({ id: 'request-one', expiresAt: Date.now() + 600000 }, { status: 201 })
      if (path === '/v1/net/enrollment-requests/request-one') return Response.json(requestStates.shift())
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    }
    return { calls, join: new MousseIdJoin({ signal: new AbortController().signal, fetch: fakeFetch }) }
  }

  it('signs in without a network identity, proving the sign-in with a key held in memory', async () => {
    const { calls, join } = fixture()
    expect(await join.discover(configuration.apiOrigin)).toEqual(configuration)
    const pending = await join.begin(configuration, 'Mac mini')
    const start = calls.find((row) => row.path === '/v1/net/login')!.body
    expect(Object.keys(start).sort()).toEqual(
      ['audience', 'codeChallenge', 'deviceName', 'installationId', 'nonce', 'proof', 'signKey'].sort()
    )
    const { proof, ...claims } = start
    verifyBytes(
      canonicalJson({ domain: 'mousse-plus/native-login/v1', ...claims }),
      Buffer.from(proof, 'base64url'),
      claims.signKey
    )
    expect(join.pending(pending.id)).toBe(true)
    await expect(join.finish(pending.id)).rejects.toMatchObject({ code: 'peer_offline' })
    const grant = await join.finish(pending.id)
    expect(grant).toMatchObject({
      configuration: { ...configuration, accountId },
      deviceName: 'Mac mini',
      email: 'ada@example.test'
    })
    const exchange = calls.find((row) => row.path.endsWith('/exchange'))!.body
    verifyBytes(
      canonicalJson({
        domain: 'mousse-plus/native-exchange/v1',
        id: 'login-one',
        audience: configuration.audience,
        installationId: configuration.installationId,
        codeChallenge: claims.codeChallenge
      }),
      Buffer.from(exchange.proof, 'base64url'),
      claims.signKey
    )
    expect(join.pending()).toBe(false)
  })

  it('asks a computer to join with the grant and reads the sealed invite once approved', async () => {
    const box = generateKeyPairSync('x25519').privateKey,
      sealed = sealInviteForRequest('mj1_invite', rawPublicKey(box), 'request-one')
    const { calls, join } = fixture([
      { id: 'request-one', status: 'pending' },
      { id: 'request-one', status: 'approved', sealedInvite: sealed },
      { id: 'request-one', status: 'delivered' }
    ])
    const pending = await join.begin(configuration, 'Mac mini')
    await join.finish(pending.id).catch(() => undefined)
    const grant = await join.finish(pending.id)
    const request = await join.requestToJoin(grant, {
      target: 'nod_desk',
      deviceName: 'Mac mini',
      boxPublicKey: rawPublicKey(box),
      transportFingerprint: 'f'.repeat(43)
    })
    expect(request.id).toBe('request-one')
    const posted = calls.find((row) => row.path === '/v1/net/enrollment-requests')!
    expect(posted.auth).toBe(`Bearer ${grant.accessToken}`)
    expect(posted.body).toEqual({
      targetNodeId: 'nod_desk',
      deviceName: 'Mac mini',
      kind: 'computer',
      boxPublicKey: rawPublicKey(box),
      transportFingerprint: 'f'.repeat(43)
    })
    expect(await join.readRequest(grant, 'request-one')).toBeUndefined()
    expect(await join.readRequest(grant, 'request-one')).toBe(sealed)
    // Delivered once: a second read has nothing to join with.
    await expect(join.readRequest(grant, 'request-one')).rejects.toMatchObject({ code: 'invite_invalid' })
  })
})
