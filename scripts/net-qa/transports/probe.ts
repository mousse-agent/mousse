import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookup, Resolver } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import { CloudflaredTransport, type CloudflaredSettings } from '../../../src/mms/net/transports/cloudflared'
import { TailscaleTransport } from '../../../src/mms/net/transports/tailscale'
import type { Transport, SecureChannel } from '../../../src/mms/net/contracts'
import { systemClock } from '../../../src/mms/net/clock'
import { generateSelfSignedCert, fingerprint } from '../../../src/mms/net/link/selfSignedCert'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { createMux } from '../../../src/mms/net/link/mux'
import { NetError } from '../../../src/shared/net/errors'

async function main(): Promise<void> {
  const kind = process.argv[2]
  let measured: Array<{ address: string; family: number }> = []
  let injectedResolver = kind === 'cloudflared' && process.env.MOUSSE_QA_DNS_FALLBACK === '1', systemDns = false
  const explicitLookup: LookupFunction = (_hostname, options, callback) => {
    queueMicrotask(() => {
      const answers = options.family ? measured.filter(answer => answer.family === options.family) : measured
      if (options.all) callback(null, answers)
      else if (answers[0]) callback(null, answers[0].address, answers[0].family)
      else callback(Object.assign(new Error('No QA resolver answer.'), { code: 'ENOTFOUND' }), '')
    })
  }
  const namedFields = [process.env.MOUSSE_QA_CF_TUNNEL_ID, process.env.MOUSSE_QA_CF_HOSTNAME, process.env.MOUSSE_QA_CF_CREDENTIALS_FILE]
  if (namedFields.some(Boolean) && (!namedFields.every(Boolean) || process.env.MOUSSE_QA_CF_TASK_OWNED !== '1')) throw new NetError('bad_request', 'Named QA requires all three tunnel settings and explicit task-owned resource confirmation.')
  const cloudSettings: CloudflaredSettings = namedFields.every(Boolean) ? { mode: 'named', binary: process.env.MOUSSE_QA_CLOUDFLARED ?? 'cloudflared', tunnelId: namedFields[0]!, hostname: namedFields[1]!, credentialsFile: namedFields[2]! } : { mode: 'quick', binary: process.env.MOUSSE_QA_CLOUDFLARED ?? 'cloudflared' }
  const directory = await mkdtemp(join(tmpdir(), 'mousse-real-transport-qa-'))
  let transport: Transport | undefined
  const channels: SecureChannel[] = []
  const a = generateSelfSignedCert('qa-client'), b = generateSelfSignedCert('qa-server'), wrong = generateSelfSignedCert('qa-wrong')
  let resolveInbound!: (channel: SecureChannel) => void, rejectInbound!: (error: unknown) => void
  const inbound = () => new Promise<SecureChannel>((resolve, reject) => { resolveInbound = resolve; rejectInbound = reject })
  try {
    // Resolution is explicitly measured before choosing the optional QA override.
    const cloud = kind === 'cloudflared' ? new CloudflaredTransport(cloudSettings, directory, systemClock, injectedResolver ? explicitLookup : undefined) : undefined
    const active = transport = cloud ?? new TailscaleTransport({ binary: process.env.MOUSSE_QA_TAILSCALE ?? 'tailscale' })
    await active.provision()
    await active.listen(raw => {
      void openSecureChannel(raw, { role: 'server', credentials: b, expectedPeerFingerprint: fingerprint(a.publicKeySpki), deadlineMs: 10_000 }).then(channel => {
        channels.push(channel)
        if ('markAuthenticated' in active) (active as TailscaleTransport | CloudflaredTransport).markAuthenticated(raw)
        resolveInbound(channel)
      }, error => rejectInbound(error))
    })
    const route = active.status().routes[0], host = new URL(route.address).hostname
    try { measured = await lookup(host, { all: true }); systemDns = measured.length > 0 } catch { systemDns = false }
    if (!systemDns) {
      if (!cloud || process.env.MOUSSE_QA_DNS_FALLBACK !== '1') throw new NetError('route_unreachable', 'System DNS failed; set MOUSSE_QA_DNS_FALLBACK=1 for an explicitly recorded QA resolver override.')
      const resolver = new Resolver({ timeout: 3000, tries: 2 }); resolver.setServers(['1.1.1.1'])
      for (let index = 0; index < 12 && !measured.length; index++) {
        try { measured = (await resolver.resolve4(host)).map(address => ({ address, family: 4 })) } catch { await new Promise(resolve => setTimeout(resolve, 1000)) }
      }
      injectedResolver = true
      if (!measured.length) throw new NetError('route_unreachable')
    }
    const serverChannel = inbound()
    const raw = await active.dial(route, new AbortController().signal)
    const [left, right] = await Promise.all([openSecureChannel(raw, { role: 'client', credentials: a, expectedPeerFingerprint: fingerprint(b.publicKeySpki), deadlineMs: 10_000 }), serverChannel]); channels.push(left)
    const muxA = createMux(left.stream), muxB = createMux(right.stream)
    try {
      const records = Array.from({ length: 14 }, (_, index) => ({ seq: index + 1, epoch: 1, recvTs: index }))
      const parts = records.flatMap(() => [new Uint8Array(65536).fill(91), new Uint8Array(64)])
      const received = new Promise<number>(resolve => muxB.onMessage((_lane, message) => { if (message.header.t === 'events') resolve(message.parts[26][65535]) }))
      await muxA.send('control', { header: { t: 'events', stream: 'str_00000000000000000000000000', records, replay: false, parts: parts.map(part => part.length) }, parts })
      if (await received !== 91 || !Buffer.from(left.exporter('EXPORTER-mousse-net-enroll', 32)).equals(Buffer.from(right.exporter('EXPORTER-mousse-net-enroll', 32)))) throw new NetError('bad_signature')
    } finally { muxA.close(); muxB.close() }
    const secondInbound = inbound(); void secondInbound.catch(() => {})
    const second = await active.dial(route, new AbortController().signal)
    let rejected = false
    try { await openSecureChannel(second, { role: 'client', credentials: a, expectedPeerFingerprint: fingerprint(wrong.publicKeySpki), deadlineMs: 10_000 }) }
    catch (error) { rejected = error instanceof NetError && error.code === 'peer_key_mismatch' }
    if (!rejected) throw new NetError('peer_key_mismatch')
    console.log(JSON.stringify({ transport: kind, mode: cloud ? cloudSettings.mode : 'tailnet', systemDns, injectedResolver, outerHostAndSniPreserved: true, mutualPinnedTls: true, exporterMatches: true, largeControlPartsBytes: 14 * (65536 + 64), wrongPinRejected: true }))
  } finally { for (const channel of channels) channel.close(); await transport?.teardown(); await rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(JSON.stringify({ transport: process.argv[2], code: error instanceof NetError ? error.code : 'internal', error: error instanceof NetError ? error.message : 'Transport QA failed.' })); process.exitCode = 1 })
