import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

describe('live mobile connection configuration', () => {
  let home = ''
  let mms: MousseMainService | null = null
  afterEach(async () => {
    await mms?.stop()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('starts and stops the HTTP listener without restarting MMS', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-mobile-config-'))
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const port = await freePort()
    await mms.configureClientConnections({ enabled: true, host: '127.0.0.1', port, serverName: 'Live test', publicBaseUrl: `http://127.0.0.1:${port}` })
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/mousse-configuration`)
    expect(response.ok).toBe(true)
    expect(mms.config.getMmsSection().http?.enabled).toBe(true)
    await mms.configureClientConnections({ enabled: false, host: '127.0.0.1', port, serverName: 'Live test' })
    expect(mms.config.getMmsSection().http?.enabled).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/.well-known/mousse-configuration`)).rejects.toThrow()
  })
})
