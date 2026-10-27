import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { DAEMON_PROTOCOL_VERSION, probeMmsActiveTurn } from '../scripts/mms-dev-probe.mjs'
import { resolveLocalEndpoint } from '../src/mms/protocol/endpoint'
import { encodeFrame, FrameDecoder } from '../src/mms/protocol/framing'

describe('MMS dev restart activity probe', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-dev-probe-'))
    mms = await MousseMainService.create({
      homeDir: home,
      headless: true,
      ownerKind: 'daemon'
    })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    mms.getOwnerLease()!.setEndpoint(endpoint)
  })

  afterEach(async () => {
    await server.stop()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it('reports idle and active orchestrator turns', async () => {
    const thread = mms.threads.createThread('Dev restart guard')
    expect(await probeMmsActiveTurn(home)).toEqual({ active: false })

    const session = mms.orchestrator.getOrCreateSession(thread.id)
    session.activeTurn = { abort: new AbortController(), pendingSteer: [] }
    expect(await probeMmsActiveTurn(home)).toEqual({ active: true, threadId: thread.id })
    session.activeTurn = null
  })
})

describe('MMS dev restart probe against a daemon from before a protocol bump', () => {
  it('speaks the version the running daemon names, so the rebuilt one can replace it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-dev-probe-old-'))
    const endpoint = resolveLocalEndpoint(home).path
    const hellos: number[] = []
    // The daemon still running is one protocol version behind this checkout.
    const older = DAEMON_PROTOCOL_VERSION - 1
    const server = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk) => {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll() as Array<{ kind: string; id?: string; method?: string; protocolVersion?: number }>) {
          if (frame.kind === 'hello') {
            hellos.push(frame.protocolVersion!)
            socket.write(encodeFrame(frame.protocolVersion === older
              ? { kind: 'hello_ok', protocolVersion: older, instanceId: 'old-daemon', capabilities: [], globalSequence: 0 }
              : { kind: 'hello_err', code: 'protocol_version', message: `Unsupported protocol version ${frame.protocolVersion}; server is ${older}` }))
          } else if (frame.kind === 'req') {
            socket.write(encodeFrame({ kind: 'res', id: frame.id, ok: true, result: frame.method === 'threads.list' ? { threads: [{ id: 't1' }] } : { active: false } }))
          }
        }
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    try {
      // The lease carries its own version, which is not the daemon protocol's.
      writeFileSync(join(home, 'mms.owner.json'), JSON.stringify({ token: 'fixture-token', endpoint, protocolVersion: 1 }))
      expect(await probeMmsActiveTurn(home)).toEqual({ active: false })
      expect(hellos).toEqual([DAEMON_PROTOCOL_VERSION, older])
    } finally {
      await new Promise((resolve) => server.close(resolve))
      rmSync(home, { recursive: true, force: true })
    }
  })
})
