import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { probeMmsActiveTurn } from '../scripts/mms-dev-probe.mjs'

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
