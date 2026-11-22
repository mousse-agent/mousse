/**
 * Daemon protocol 2 (PR 5a-2 removed the old provider methods): a client and a service on different
 * versions refuse each other at the hello, before any method runs, and the app and the CLI say how
 * to recover instead of printing the raw refusal.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectCliClient } from '../src/cli/daemonClient'
import { connectGuiClient, GUI_REQUIRED_METHODS, readThreadEditorFile, writeThreadEditorFile } from '../src/main/mms/guiDaemonCompatibility'
import { isProtocolVersionMismatch, LocalMmsClient, ProtocolHelloError } from '../src/mms/protocol/client'
import { resolveLocalEndpoint } from '../src/mms/protocol/endpoint'
import { encodeFrame, FrameDecoder } from '../src/mms/protocol/framing'
import { MMS_PROTOCOL_VERSION } from '../src/mms/protocol/types'
import { parseEnvelope, validateHello } from '../src/mms/protocol/validators'

const homes: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A service on protocol 1: it answers every hello the way a version-1 daemon does. */
async function versionOneService(): Promise<{ home: string; endpoint: string; hellos: number[]; requests: string[] }> {
  const home = mkdtempSync(join(tmpdir(), 'mousse-version-skew-'))
  homes.push(home)
  const endpoint = resolveLocalEndpoint(home).path
  const hellos: number[] = []
  const requests: string[] = []
  const server = createServer((socket) => {
    const decoder = new FrameDecoder()
    socket.on('data', (chunk) => {
      decoder.push(chunk)
      for (const frame of decoder.shiftAll()) {
        const env = parseEnvelope(frame)
        if (env?.kind === 'hello') {
          hellos.push(env.protocolVersion)
          if (env.protocolVersion !== 1)
            socket.write(encodeFrame({ kind: 'hello_err', code: 'protocol_version', message: `Unsupported protocol version ${env.protocolVersion}; server is 1` }))
        } else if (env?.kind === 'req') requests.push(env.method)
      }
    })
    socket.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return { home, endpoint, hellos, requests }
}

describe('daemon protocol version skew', () => {
  it('lets this app open text from a service that supports files.read without workspace binding', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-version-skew-'))
    homes.push(home)
    const endpoint = resolveLocalEndpoint(home).path
    const editorRequests: Array<{ method: string; params: unknown }> = []
    const server = createServer((socket) => {
      const decoder = new FrameDecoder()
      socket.on('data', (chunk) => {
        decoder.push(chunk)
        for (const frame of decoder.shiftAll()) {
          const envelope = parseEnvelope(frame)
          if (envelope?.kind === 'hello') {
            socket.write(encodeFrame({ kind: 'hello_ok', protocolVersion: MMS_PROTOCOL_VERSION, instanceId: 'older-daemon', capabilities: [], globalSequence: 0 }))
          } else if (envelope?.kind === 'req') {
            if (envelope.method !== 'capabilities') editorRequests.push({ method: envelope.method, params: envelope.params })
            const result = envelope.method === 'capabilities' ? { protocolVersion: MMS_PROTOCOL_VERSION, methods: GUI_REQUIRED_METHODS } : { content: 'project text' }
            socket.write(encodeFrame({ kind: 'res', id: envelope.id, ok: true, result }))
          }
        }
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    const client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'fixture-token', clientType: 'gui' })
    const params = { threadId: 'draft', path: 'notes.txt' }
    try {
      await connectGuiClient(client, home)
      await expect(readThreadEditorFile(client, params)).resolves.toEqual({ content: 'project text' })
      await expect(writeThreadEditorFile(client, { ...params, content: 'changed' }, home)).rejects.toThrow(/workspace/)
      expect(editorRequests).toEqual([{ method: 'files.read', params }])
    } finally {
      await client.close()
    }
  })

  it('a version-1 hello is refused by this service before any method runs', () => {
    const refused = validateHello({ kind: 'hello', protocolVersion: 1, ownerToken: 'fixture-token', clientType: 'gui' })
    expect(refused).toMatchObject({ ok: false, code: 'protocol_version' })
    expect(validateHello({ kind: 'hello', protocolVersion: MMS_PROTOCOL_VERSION, ownerToken: 'fixture-token', clientType: 'gui' })).toMatchObject({ ok: true })
  })

  it('this app against a version-1 service shows the recovery text and sends no request', async () => {
    const service = await versionOneService()
    const client = new LocalMmsClient({ homeDir: service.home, ownerToken: 'fixture-token', endpoint: service.endpoint, clientType: 'gui' })
    const failure = await connectGuiClient(client, service.home).then(() => undefined, (error: unknown) => error as Error)
    await client.close().catch(() => {})
    expect(failure?.message).toContain('The running Mousse service is incompatible with this app')
    expect(failure?.message).toContain('service stop --home')
    expect(failure?.message).toContain(`another protocol version than this app (${MMS_PROTOCOL_VERSION})`)
    expect(failure?.message).not.toMatch(/Hello rejected/)
    expect(service.hellos).toEqual([MMS_PROTOCOL_VERSION])
    expect(service.requests).toEqual([])
  })

  it('the CLI against a version-1 service tells the same recovery', async () => {
    const service = await versionOneService()
    const client = new LocalMmsClient({ homeDir: service.home, ownerToken: 'fixture-token', endpoint: service.endpoint, clientType: 'cli' })
    const failure = await connectCliClient(client, service.home).then(() => undefined, (error: unknown) => error as Error)
    await client.close().catch(() => {})
    expect(failure?.message).toContain('another protocol version than this command')
    expect(failure?.message).toContain(`service stop --home ${JSON.stringify(service.home)}`)
    expect(failure?.message).toContain('then run the command again')
    expect(service.requests).toEqual([])
    // Any other refusal (a wrong token) is reported as it is.
    expect(isProtocolVersionMismatch(new ProtocolHelloError('protocol_version', 'x'))).toBe(true)
    expect(isProtocolVersionMismatch(new ProtocolHelloError('auth', 'bad token'))).toBe(false)
  })
})
