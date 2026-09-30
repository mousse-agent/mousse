import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { ERROR_INFO_CAPABILITY, createErrorProvider } from '../src/shared/errors'

describe('public error descriptors across the actual daemon socket', () => {
  let home: string
  let main: MousseMainService
  let server: MmsProtocolServer
  const clients: LocalMmsClient[] = []
  let endpoint: string
  let ownerToken: string
  const provider = createErrorProvider({ fixture_denied: { message: 'Fixture access denied.', category: 'denied', retryable: false } })

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-error-boundary-'))
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await main.start()
    main.domains.register({ method: 'fixture.error', scope: 'installation', validate: () => ({}), handle: () => {
      throw provider.create('fixture_denied', new Error('private raw exception'), { operationId: 'fixture-operation', token: 'private' })
    } })
    main.domains.register({ method: 'fixture.unknown', scope: 'installation', validate: () => ({}), handle: () => {
      throw Object.assign(new Error('Bearer privateRawToken /Users/private/path'), { code: 'claimed_safe_code' })
    } })
    ownerToken = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken, version: 'fixture' })
    endpoint = await server.start()
  }, 30_000)

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close()
    await server?.stop(); await main?.stop()
    vi.restoreAllMocks()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  async function connect(modern: boolean): Promise<LocalMmsClient> {
    const client = new LocalMmsClient({ homeDir: home, ownerToken, endpoint, clientType: 'test',
      requestedCapabilities: modern ? [ERROR_INFO_CAPABILITY] : [] })
    clients.push(client)
    const hello = await client.connect()
    // hello advertises what the server supports; per-session response metadata
    // below establishes whether the caller actually negotiated it.
    expect(hello.capabilities).toContain(ERROR_INFO_CAPABILITY)
    return client
  }

  it('preserves typed codes, audited messages and additive classification for negotiated clients', async () => {
    const client = await connect(true)
    await expect(client.request('fixture.error')).rejects.toMatchObject({
      code: 'fixture_denied', message: 'Fixture access denied.', details: { operationId: 'fixture-operation' },
      errorInfo: { category: 'denied', retryable: false }
    })
  })

  it('keeps legacy peers on code/message/details without negotiated metadata', async () => {
    const client = await connect(false)
    const error = await client.request('fixture.error').catch((error: unknown) => error) as Record<string, unknown>
    expect(error).toMatchObject({ code: 'fixture_denied', message: 'Fixture access denied.', details: { operationId: 'fixture-operation' } })
    expect(error.errorInfo).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('replaces unknown coded exception text with a safe handler error and support ID', async () => {
    const client = await connect(true)
    const error = await client.request('fixture.unknown').catch((error: unknown) => error) as Record<string, unknown>
    expect(error).toMatchObject({ code: 'handler_error', details: { supportId: expect.any(String) }, errorInfo: { category: 'internal', retryable: false } })
    expect(error.message).toContain('Reference:')
    expect(JSON.stringify(error)).not.toMatch(/privateRawToken|private\/path|claimed_safe_code/)
  })
})
