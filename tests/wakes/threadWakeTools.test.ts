/**
 * `wake`, `reminder_list` and `reminder_cancel` are one tool each for a personal bot and any thread: a bot reads and
 * calls its own, a thread the thread's, which acts on the caller's own thread only and checks its arguments as the
 * bot's do. Who holds them by kind of turn is pinned in toolAuthorityParity.
 */
import { describe, expect, it, vi } from 'vitest'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import { SUBAGENT_WAKE_REFUSAL, shareWakeTools, threadWakeTools } from '../../src/mms/run/mcp/appTools/threadWakes'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { ThreadWakeError, type ThreadWakes } from '../../src/mms/wakes/ThreadWakes'

function setup(options: { subagent?: boolean } = {}) {
  const add = vi.fn(async (_threadId: string, input: { brief: string; dueAt?: string; event?: unknown }) => {
    if (input.brief === 'loop') throw new ThreadWakeError('that is a loop')
    return { wakeId: 'wake-1', dueAt: input.dueAt ?? '2026-11-21T10:00:00.000Z', label: input.event ? 'when acme/app#12 merges' : '' }
  })
  const cancel = vi.fn((_threadId: string, wakeId: string) => wakeId === 'wake-1')
  const service = { add, cancel, list: () => [{ wakeId: 'wake-1', brief: 'Merge it', setAt: '', dueAt: '2026-11-21T10:00:00.000Z', waitsFor: 'when acme/app#12 merges' }] } as unknown as ThreadWakes
  const host = { threadWakes: () => service, subagentThread: () => options.subagent === true } as unknown as AppToolHost
  const tools = new Map(shareWakeTools(botTools(), threadWakeTools(host)).map((tool) => [tool.name, tool]))
  const ctx = { transport: 'mcp', caller: { threadId: 'thread-a' }, turn: { threadId: 'thread-a' } } as unknown as ToolCallContext
  const call = (name: string, args: Record<string, unknown>) => Promise.resolve(tools.get(name)!.handler(args, ctx))
  return { tools, add, cancel, call }
}

describe('thread wake tools', () => {
  it('keeps one tool per name: a bot\'s listing reads the bot\'s words, a thread\'s its own', () => {
    const { tools } = setup()
    const wake = tools.get('wake')! as MousseTool
    expect(wake.description).toMatch(/^Carry on later, here in this thread, without the person writing/)
    expect(wake.botDescription).toMatch(/^Wake yourself up later to carry on, here in this chat, without your owner writing/)
    expect(wake.listed?.({ botRole: 'activation' } as never)).toBe(true)
    expect(wake.listed?.({ threadId: 'thread-a' } as never)).toBe(true)
    expect([...tools.keys()].filter((name) => name === 'wake')).toHaveLength(1)
  })

  it('a subagent neither sees nor sets one', async () => {
    const { tools, call, add } = setup({ subagent: true })
    expect(tools.get('wake')!.listed?.({ threadId: 'child-1' } as never)).toBe(false)
    expect(tools.get('wake')!.available?.({ threadId: 'child-1' } as never)).toBe(SUBAGENT_WAKE_REFUSAL)
    expect(await call('wake', { brief: 'x', inMinutes: 5 })).toEqual({ text: SUBAGENT_WAKE_REFUSAL, isError: true })
    expect(add).not.toHaveBeenCalled()
  })

  it('checks its arguments as the bot\'s wake does, and sets it on the caller\'s own thread', async () => {
    const { call, add } = setup()
    expect(await call('wake', { brief: ' ', inMinutes: 5 })).toMatchObject({ isError: true, text: expect.stringContaining('needs a brief') })
    expect(await call('wake', { brief: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('Give one of') })
    expect(await call('wake', { brief: 'x', inMinutes: 5, pr: 'acme/app#12' })).toMatchObject({ isError: true, text: expect.stringContaining('Give one of') })
    expect(await call('wake', { brief: 'x', inMinutes: 5, on: 'checks' })).toMatchObject({ isError: true, text: 'on needs pr and is merged, checks or review.' })
    expect(await call('wake', { brief: 'x', pr: 'not a pr' })).toMatchObject({ isError: true })
    expect(await call('wake', { brief: 'loop', inMinutes: 5 })).toEqual({ text: 'that is a loop', isError: true })
    expect(add).toHaveBeenCalledTimes(1)
    const set = await call('wake', { brief: 'Merge if green', pr: 'https://github.com/acme/app/pull/12', on: 'checks', hours: 48 })
    expect(set.isError).toBeFalsy()
    expect(add).toHaveBeenLastCalledWith('thread-a', { brief: 'Merge if green', event: { kind: 'pr', repo: 'acme/app', number: 12, on: 'checks' }, hours: 48 })
    expect(JSON.parse(set.text)).toMatchObject({ wakeId: 'wake-1', waitsFor: 'when acme/app#12 merges' })
  })

  it('lists and cancels only the caller\'s thread\'s wake-ups', async () => {
    const { call, cancel } = setup()
    expect(JSON.parse((await call('reminder_list', {})).text)).toEqual([expect.objectContaining({ reminderId: 'wake-1', text: 'Merge it', wake: 'when acme/app#12 merges' })])
    expect((await call('reminder_cancel', { reminderId: 'wake-1' })).isError).toBeFalsy()
    expect(cancel).toHaveBeenLastCalledWith('thread-a', 'wake-1')
    expect(await call('reminder_cancel', { reminderId: 'wake-9' })).toMatchObject({ isError: true })
  })
})
