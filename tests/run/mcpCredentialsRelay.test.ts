/**
 * The MCP relay's grant on a turn's bearer (SPEC §15.5): kept in memory with the credential, set on
 * mint and on reuse, and never part of the runtime generation (turning the relay on or off keeps the
 * bearer and its epoch). The server hands out the relay's URL on the same listener.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRegistry } from '../../src/mms/run/mcp/appTools'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { McpCredentials, type BearerTurn } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer, RELAY_PATH } from '../../src/mms/run/mcp/MousseMcpServer'
import { RunStore } from '../../src/mms/run/RunStore'

describe('McpCredentials relay grant', () => {
  const homes: string[] = []
  const databases: ProfileDatabase[] = []
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    for (const db of databases.splice(0)) db.close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-mcp-relay-credentials-'))
    homes.push(home)
    const db = new ProfileDatabase({ profileHome: home, clock: () => Date.parse('2026-10-30T00:00:00.000Z') })
    databases.push(db)
    return new McpCredentials(new RunStore(db))
  }
  const turn = (overrides: Partial<BearerTurn> = {}): BearerTurn => ({
    threadId: 't1', instanceId: 'codex', runId: 'r1', modeCeiling: 'default', binding: 'per_call', generation: 'codex|default|0|0', ...overrides
  })

  it('records the grant on a fresh bearer, and none without one', () => {
    const credentials = setup()
    const granted = credentials.bearerForTurn(turn({ relay: { approvals: 'mousse' } }))
    expect(credentials.resolve(granted.token)?.relay).toEqual({ approvals: 'mousse' })
    expect(credentials.current(granted.tokenHash)?.relay).toEqual({ approvals: 'mousse' })
    const plain = credentials.bearerForTurn(turn({ threadId: 't2' }))
    expect(credentials.resolve(plain.token)).not.toHaveProperty('relay')
  })

  it('updates the grant when a bearer is reused, without a new epoch', () => {
    const credentials = setup()
    const first = credentials.bearerForTurn(turn({ relay: { approvals: 'runtime' } }))
    const changed = credentials.bearerForTurn(turn({ runId: 'r2', relay: { approvals: 'mousse' } }))
    expect(changed).toMatchObject({ token: first.token, reused: true, epoch: first.epoch })
    expect(credentials.resolve(changed.token)?.relay).toEqual({ approvals: 'mousse' })
    const off = credentials.bearerForTurn(turn({ runId: 'r3' }))
    expect(off).toMatchObject({ token: first.token, reused: true, epoch: first.epoch })
    expect(credentials.resolve(off.token)).not.toHaveProperty('relay')
    const on = credentials.bearerForTurn(turn({ runId: 'r4', relay: { approvals: 'runtime' } }))
    expect(on).toMatchObject({ token: first.token, reused: true, epoch: first.epoch })
    expect(credentials.resolve(on.token)?.relay).toEqual({ approvals: 'runtime' })
  })

  it('keeps the grant through mint', () => {
    const credentials = setup()
    const minted = credentials.mint({ threadId: 't1', runId: 'r1', provider: 'cursor', modeCeiling: 'plan', relay: { approvals: 'mousse' } })
    expect(credentials.resolve(minted.token)).toMatchObject({ provider: 'cursor', relay: { approvals: 'mousse' } })
  })

  it('the server hands out the relay URL on the same listener with the bearer', async () => {
    const credentials = setup()
    server = new MousseMcpServer({ credentials, registry: {} as ToolRegistry })
    expect(server.bearerForTurn(turn())).toBeNull()
    await server.start()
    const attachment = server.bearerForTurn(turn({ relay: { approvals: 'runtime' } }))!
    expect(RELAY_PATH).toBe('/mcp/relay')
    expect(attachment.url).toBe(server.url)
    expect(attachment.relayUrl).toBe(server.relayUrl)
    expect(attachment.relayUrl).toBe(`${new URL(server.url).origin}${RELAY_PATH}`)
    expect(attachment).not.toHaveProperty('relay')
    expect(credentials.resolve(attachment.token)?.relay).toEqual({ approvals: 'runtime' })
  })
})
