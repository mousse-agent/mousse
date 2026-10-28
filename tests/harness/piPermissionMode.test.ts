import { describe, expect, it } from 'vitest'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import type { PermissionMode } from '../../src/shared/permissionMode'

/**
 * The Pi RPC engine under a permission mode: its gate asks the thread's user before a built-in the
 * mode does not allow without asking, and denies when the turn cannot ask.
 */
const engine = new PiRpcEngine({ instanceId: 'pi:x', provider: 'x', label: 'X', capabilities: PI_RPC_CAPS, catalog: () => ({ revision: 1, provider: { id: 'x', builtin: false, models: [] as never } }) } as unknown as PiRpcEngineOptions)
type Gate = (turn: unknown, toolName: string, input: Record<string, unknown>) => Promise<{ allow: false; reason: string } | null>
const askPermission = (turn: unknown, toolName: string, input: Record<string, unknown>) =>
  (engine as unknown as { askPermission: Gate }).askPermission(turn, toolName, input)

function turnIn(permissionMode: PermissionMode, permission: PermissionPrompter | undefined) {
  const asked: Array<{ title: string; approval: unknown }> = []
  const prompter: PermissionPrompter | undefined = permission && {
    ...(permission.approvals ? { approvals: permission.approvals } : {}),
    choose: async (request) => {
      asked.push({ title: request.title, approval: request.approval })
      return permission.choose(request)
    }
  }
  return { asked, turn: { input: { permissionMode, threadId: 't1', signal: new AbortController().signal }, host: { bridge: { permission: prompter } } } }
}
const answer = (optionId: string | undefined): PermissionPrompter => ({ choose: async () => optionId })

describe('Pi RPC engine permission mode', () => {
  it('asks before a command under Ask and Auto-accept edits, and an edit only under Ask', async () => {
    for (const mode of ['ask', 'accept_edits'] as const) {
      const { turn, asked } = turnIn(mode, answer('allow'))
      expect(await askPermission(turn, 'bash', { command: 'echo hi' })).toBeNull()
      expect(asked).toEqual([{ title: expect.stringContaining('echo hi'), approval: { action: 'command', permissionKey: 'pi:command', tool: { name: 'bash', input: { command: 'echo hi' }, cwd: undefined } } }])
    }
    const accepting = turnIn('accept_edits', answer('reject'))
    expect(await askPermission(accepting.turn, 'write', { path: 'a.txt', content: 'x' })).toBeNull()
    expect(accepting.asked).toEqual([])
    const asking = turnIn('ask', answer('allow'))
    expect(await askPermission(asking.turn, 'edit', { path: 'a.txt' })).toBeNull()
    expect(asking.asked).toEqual([{ title: expect.stringContaining('a.txt'), approval: { action: 'edit', permissionKey: 'pi:edit', tool: { name: 'edit', input: { path: 'a.txt' }, cwd: undefined } } }])
  })

  it('never asks under Full access, and never about a read', async () => {
    const full = turnIn('full', answer('reject'))
    expect(await askPermission(full.turn, 'bash', { command: 'rm -rf x' })).toBeNull()
    const asking = turnIn('ask', answer('reject'))
    expect(await askPermission(asking.turn, 'read', { path: 'a.txt' })).toBeNull()
    expect(full.asked.concat(asking.asked)).toEqual([])
  })

  it('denies a rejected or dismissed request, with the reason', async () => {
    const rejected = turnIn('ask', answer('reject'))
    expect(await askPermission(rejected.turn, 'bash', { command: 'make' })).toMatchObject({ allow: false, reason: expect.stringContaining('rejected') })
    const dismissed = turnIn('ask', answer(undefined))
    expect(await askPermission(dismissed.turn, 'bash', { command: 'make' })).toMatchObject({ allow: false })
  })

  it('denies when the turn cannot ask: no prompter, or approvals refused', async () => {
    const none = turnIn('ask', undefined)
    expect(await askPermission(none.turn, 'bash', { command: 'make' })).toMatchObject({ allow: false, reason: expect.stringContaining('cannot ask') })
    const refusing = turnIn('accept_edits', { approvals: 'never', choose: async () => 'allow' })
    expect(await askPermission(refusing.turn, 'bash', { command: 'make' })).toMatchObject({ allow: false })
    expect(refusing.asked).toEqual([])
  })
})
