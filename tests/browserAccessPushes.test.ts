import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'

type Event = { type: string }

describe('windows hear when the agents browser access changes', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let window: LocalMmsClient
  let seen: Event[]

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-browser-access-pushes-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    seen = []
    window = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
    window.onEvent((event) => seen.push(event as Event))
    await window.connect()
    await window.subscribe()
  }, 30_000)

  afterEach(async () => {
    await window?.close()
    await server?.stop()
    await mms?.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const pushes = () => seen.filter((event) => event.type === 'browser.access.changed').length

  it('pushes a change once, for a request and its answer made together', async () => {
    const access = mms.platform.browser.access
    const asked = access.request('thread-1')
    access.set(true)
    await expect(asked).resolves.toBe('allowed')
    await vi.waitFor(() => expect(pushes()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pushes()).toBe(1)

    access.set(false)
    await vi.waitFor(() => expect(pushes()).toBe(2))
  })
})
