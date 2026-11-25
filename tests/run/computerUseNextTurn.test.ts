/**
 * Computer use set up while a thread is open reaches its agent at the next turn: while Cua Driver is missing the thread
 * lists only `computer_use_request` and keeps its credential from turn to turn; the request opens the thread's setup
 * card and answers at once; once the driver is found, the next turn gets a new credential that lists `computer_tools`
 * and `computer_use`.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputerUseDriver } from '../../src/mms/computerUse/ComputerUseDriver'
import { parseComputerUseOutcome } from '../../src/shared/computerUse'
import { callTool, listTools, VendorAdapter, vendorDaemon, type Mcp, type ToolCallResult, type VendorDaemon } from './appToolVendorFixture'

describe('computer use reaches a thread at its next turn', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('missing: only the request, the same credential; found: the next turn lists the tools with a new credential', async () => {
    const turns: Array<{ token: string; tools: string[] }> = []
    const results: Record<string, ToolCallResult> = {}
    let instructions = ''
    const vendor = new VendorAdapter(async ({ input, mcp }) => {
      if (!mcp) throw new Error('no Mousse server')
      turns.push({ token: (mcp as Mcp).token, tools: await listTools(mcp) })
      if (input.prompt === 'Open Figma') results.request = await callTool(mcp, 'computer_use_request', { reason: 'Open Figma to export the logo' })
      if (input.prompt === 'Hello') {
        // What the server tells the agent when it connects.
        const response = await fetch(mcp.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vendor', version: '1' } } })
        })
        instructions = ((await response.json()) as { result?: { instructions?: string } }).result?.instructions ?? ''
      }
      return 'Done.'
    })
    d = await vendorDaemon([vendor])
    // Cua Driver on a computer where it is not installed yet; nothing is run.
    const home = join(d.home, 'user')
    const exe = join(home, '.local', 'bin', 'cua-driver')
    const files = new Set<string>()
    ;(d.orch as unknown as { computerDriver: ComputerUseDriver }).computerDriver = new ComputerUseDriver({
      settings: () => ({ enabled: true }), platform: 'linux', env: { PATH: '' }, home,
      version: async () => 'cua-driver 0.38.0', telemetryOff: async () => undefined, exists: (path) => files.has(path)
    })

    // Turns a person sent from a window.
    let sends = 0
    const send = (content: string) => d!.orch.send({ content, mode: 'agent' }, false, { threadId: d!.thread.id, clientRequestId: `person-${++sends}`, source: 'gui' })
    await send('Hello')
    await send('Open Figma')
    expect(turns).toHaveLength(2)
    const line = instructions.split(/\r?\n/).find((entry) => entry.startsWith('- Computer use:'))
    expect(line).toMatch(/computer_tools/)
    expect(line).toMatch(/computer_use runs/)
    expect(line).toMatch(/when computer_use_request is listed/i)
    for (const turn of turns) {
      expect(turn.tools).toContain('computer_use_request')
      expect(turn.tools).not.toContain('computer_use')
      expect(turn.tools).not.toContain('computer_tools')
    }
    expect(turns[1]!.token).toBe(turns[0]!.token)
    expect(parseComputerUseOutcome(results.request?.text)?.outcome).toBe('setup_needed')
    expect(d.orch.computerUseSetup().peek(d.thread.id)).toMatchObject({ reason: 'Open Figma to export the logo' })

    // Installed outside Mousse; the card's recheck finds it.
    files.add(exe)
    expect(await d.orch.computerUse().status(true)).toMatchObject({ state: 'found' })
    await send('Go on')
    expect(turns).toHaveLength(3)
    expect(turns[2]!.tools).toEqual(expect.arrayContaining(['computer_use_request', 'computer_tools', 'computer_use']))
    expect(turns[2]!.token).not.toBe(turns[1]!.token)
  }, 60_000)
})
