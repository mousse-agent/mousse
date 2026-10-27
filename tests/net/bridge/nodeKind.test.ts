import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import type { HostedNetHost } from '../../../src/mms/net/hosted'
import { HostedNetController } from '../../../src/mms/net/plus/HostedNetController'
import type { Device } from '../../../src/renderer/lib/netDevices'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function service(): NetService {
  const path = mkdtempSync(join(tmpdir(), 'net-kind-')),
    net = new NetService({ profileDir: path })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return net
}

it('lists a device approved as a phone with kind phone and every device invited here as a computer', async () => {
  const a = service(),
    b = service(),
    c = service()
  await a.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.request('net.protect', { passphrase: 'test-authority-protection' })
  const plain = (await a.request('bridge.invite', {})) as { invite: string }
  const computer = (await b.request('bridge.join', {
    invite: plain.invite,
    name: 'laptop'
  })) as { node: string }
  // `bridge.invite` cannot name a kind; only an approved Mousse ID request records one.
  const asked = (await a.request('bridge.invite', { kind: 'phone' })) as { invite: string }
  const claimed = (await service().request('bridge.join', {
    invite: asked.invite,
    name: 'claims'
  })) as {
    node: string
  }
  const phone = a.runtime().enrollment.issueNodeInvite({ name: 'pocket', kind: 'phone' })
  const joined = (await c.request('bridge.join', { invite: phone.text, name: 'pocket' })) as {
    node: string
  }

  const { nodes } = (await a.request('bridge.nodes', {})) as { nodes: Device[] }
  const kind = (node: string) => nodes.find((row) => row.node === node)?.kind
  expect(kind(joined.node)).toBe('phone')
  expect(kind(computer.node)).toBe('computer')
  expect(kind(claimed.node)).toBe('computer')
  expect(nodes.find((row) => row.self)?.kind).toBe('computer')
  expect(a.runtime().enrollment.nodeKind(joined.node as never)).toBe('phone')
  // An invite made on the authority is recorded as a computer; a device with no record is unknown.
  expect(a.runtime().enrollment.nodeKind(computer.node as never)).toBe('computer')
  a.runtime()
    .db.database.prepare('DELETE FROM net_enrollment_kinds WHERE node=?')
    .run(computer.node)
  expect(a.runtime().enrollment.nodeKind(computer.node as never)).toBeUndefined()
  const after = (await a.request('bridge.nodes', {})) as { nodes: Device[] }
  expect(after.nodes.find((row) => row.node === computer.node)?.kind).toBe('unknown')
})

it('records the kind of a Mousse ID enrollment request when it is approved', async () => {
  const issue = vi.fn(async () => ({
      text: 'mj1_x',
      invite: 'inv_1',
      expiresAt: Date.now() + 60_000
    })),
    approve = vi.fn(async () => undefined),
    controller = new HostedNetController({
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
      loadedRuntime: () => undefined,
      requireEnrolled: () => ({}),
      closed: () => false,
      enabled: () => true,
      featureEnabled: () => true,
      serial: (work: () => Promise<unknown>) => work(),
      emit: () => undefined,
      fail: () => undefined,
      issueRendezvousInvite: issue
    } as unknown as HostedNetHost)
  const box = Buffer.alloc(32, 7).toString('base64url')
  ;(controller as unknown as Record<string, unknown>).enrollmentList = [
    {
      id: 'req-1',
      deviceName: 'Ada phone',
      kind: 'phone',
      boxPublicKey: box,
      transportFingerprint: box,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000
    }
  ]
  ;(controller as unknown as Record<string, unknown>).hostedProfile = {
    approveEnrollmentRequest: approve
  }
  await controller.request('net.plus.enrollment.approve', { id: 'req-1' })
  expect(issue).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Ada phone', kind: 'phone', joinerTransportFingerprint: box })
  )
  expect(approve).toHaveBeenCalledTimes(1)
})
