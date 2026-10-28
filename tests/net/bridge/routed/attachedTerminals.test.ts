/**
 * The caller's side of a terminal on another computer, with the network replaced: what its output becomes
 * for a window, how a gap is filled, how the end is told, and how input is numbered.
 */
import { describe, expect, it, vi } from 'vitest'
import { AttachedTerminals } from '../../../../src/mms/bridge/routed/attachedTerminals'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import {
  ROUTED_PTY_INPUT_MAX_CHARS,
  ROUTED_PTY_PASTE_MAX_BYTES
} from '../../../../src/shared/bridge/routed'
import { newId, type NodeId } from '../../../../src/shared/net'
import { qualifyId } from '../../../../src/shared/threadRef'
import { PROJECT_SHELL_AGENT_ID } from '../../../../src/shared/types'

const node = newId('node') as NodeId
const threadId = 'thread-1'
const ptyId = 'pty-1'
const qualified = qualifyId(node, threadId)

interface Pushed {
  type: string
  data: Record<string, unknown>
  threadId?: string
}

function harness(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({}),
  options: { retryMs?: number; initialWaitMs?: number } = {}
) {
  const events: Pushed[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let update: (value: unknown) => void = () => undefined
  let error: () => void = () => undefined
  const closed = { handles: 0, owner: 0 }
  let attaches = 0
  const hub = {
    attach: vi.fn(async (_ref: unknown, onUpdate: typeof update, onError: typeof error) => {
      attaches += 1
      update = onUpdate
      error = onError
      return { close: () => (closed.handles += 1), descriptor: {} }
    })
  }
  const client = {
    call: vi.fn(async (_node: NodeId, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return call(method, params)
    }),
    openStream: vi.fn(async () => ({ descriptor: {}, head: { epoch: 1, seq: 0 } })),
    closeStream: vi.fn(async () => {
      closed.owner += 1
    })
  }
  const terminals = new AttachedTerminals({
    services: { events: { emit: (event: { data: Pushed }) => events.push(event.data) } } as never,
    hub: hub as never,
    client: client as never,
    ...options
  })
  const snapshot = (value: Record<string, unknown>) =>
    update({ kind: 'snapshot', value: { kind: 'mousse.terminal', alive: true, ...value } })
  const record = (type: 'pty.data' | 'pty.exit', data: Record<string, unknown>) =>
    update({ kind: 'event', type, data })
  const output = () =>
    events
      .filter((event) => event.type === 'pty.data')
      .map((event) => event.data.data as string)
      .join('')
  const attached = async () => {
    terminals.ensure(node, threadId, ptyId)
    await vi.waitFor(() => expect(attaches).toBeGreaterThan(0))
    await vi.waitFor(() => expect(terminals.state()[0]?.attached).toBe(true))
  }
  return { terminals, events, calls, snapshot, record, output, attached, error: () => error(), closed, client, hub, attaches: () => attaches }
}

describe('output', () => {
  it('names the thread as windows here do, and the agent as a project shell by default', async () => {
    const h = harness()
    await h.attached()
    h.snapshot({ sequence: 0, scrollback: '' })
    h.record('pty.data', { ptyId, sequence: 1, data: 'hi' })
    expect(h.events).toEqual([
      {
        type: 'pty.data',
        threadId: qualified,
        data: { data: 'hi', sequence: 1, ptyId, agentId: PROJECT_SHELL_AGENT_ID, threadId: qualified }
      }
    ])
  })

  it('keeps earlier output until the window is ready (it resizes), and delivers it first', async () => {
    const h = harness()
    await h.attached()
    h.snapshot({ sequence: 3, scrollback: 'prompt> ' })
    h.record('pty.data', { ptyId, sequence: 4, data: 'later' })
    expect(h.output()).toBe('')
    // The window mounts the terminal and fits it.
    await h.terminals.input(node, threadId, ptyId, 'pty.resize', { threadId, ptyId, cols: 80, rows: 24 })
    expect(h.output()).toBe('prompt> later')
    // After that, output goes straight through.
    h.record('pty.data', { ptyId, sequence: 5, data: '!' })
    expect(h.output()).toBe('prompt> later!')
  })

  it('delivers it anyway after a moment when the window never asks', async () => {
    const h = harness(undefined, { initialWaitMs: 20 })
    await h.attached()
    h.snapshot({ sequence: 1, scrollback: 'text' })
    await vi.waitFor(() => expect(h.output()).toBe('text'))
  })

  it('does not deliver a piece twice: a stream that is read again repeats what it had', async () => {
    const h = harness()
    await h.attached()
    h.snapshot({ sequence: 5, scrollback: '' })
    h.record('pty.data', { ptyId, sequence: 5, data: 'old' })
    h.record('pty.data', { ptyId, sequence: 6, data: 'six' })
    h.record('pty.data', { ptyId, sequence: 6, data: 'six' })
    // A chunk in pieces: each piece once, in order.
    h.record('pty.data', { ptyId, sequence: 7, part: 0, parts: 2, data: 'a' })
    h.record('pty.data', { ptyId, sequence: 7, part: 1, parts: 2, data: 'b' })
    h.record('pty.data', { ptyId, sequence: 7, part: 0, parts: 2, data: 'a' })
    h.record('pty.data', { ptyId, sequence: 7, part: 1, parts: 2, data: 'b' })
    h.record('pty.data', { ptyId, sequence: 8, data: 'eight' })
    expect(h.output()).toBe('sixabeight')
  })

  it('fills what it missed with pty.outputSince before anything newer, in order', async () => {
    let release: (value: unknown) => void = () => undefined
    const h = harness(
      (method) =>
        method === 'pty.outputSince'
          ? new Promise((resolve) => (release = resolve))
          : Promise.resolve({})
    )
    await h.attached()
    h.snapshot({ sequence: 2, scrollback: '' })
    h.record('pty.data', { ptyId, sequence: 3, data: 'c' })
    // The link was lost and came back: the terminal moved on to 6 meanwhile.
    h.snapshot({ sequence: 6, scrollback: 'abcdef' })
    // Output that arrives while the missing part is fetched waits behind it.
    h.record('pty.data', { ptyId, sequence: 7, data: 'g' })
    expect(h.calls.at(-1)).toEqual({
      method: 'pty.outputSince',
      params: { threadId, ptyId, afterSequence: 3 }
    })
    expect(h.output()).toBe('c')
    release({
      sequence: 6,
      gap: false,
      scrollback: 'abcdef',
      chunks: [
        { sequence: 4, data: 'd' },
        { sequence: 5, data: 'e' },
        { sequence: 6, data: 'f' }
      ]
    })
    await vi.waitFor(() => expect(h.output()).toBe('cdefg'))
  })

  it('clears the terminal and writes what the owner still holds when the gap is more than it kept', async () => {
    const h = harness(async (method) =>
      method === 'pty.outputSince' ? { sequence: 900, gap: true, scrollback: 'tail', chunks: [] } : {}
    )
    await h.attached()
    h.snapshot({ sequence: 1, scrollback: '' })
    h.snapshot({ sequence: 900, scrollback: 'tail' })
    await vi.waitFor(() => expect(h.output()).toBe('\u001bctail'))
    // Nothing at or before 900 is delivered again.
    h.record('pty.data', { ptyId, sequence: 900, data: 'dup' })
    h.record('pty.data', { ptyId, sequence: 901, data: '!' })
    expect(h.output()).toBe('\u001bctail!')
  })
})

describe('the end', () => {
  it('tells the window once, after everything the terminal printed, and lets go of the stream', async () => {
    const h = harness()
    await h.attached()
    h.snapshot({ sequence: 0, scrollback: '' })
    h.record('pty.data', { ptyId, sequence: 1, data: 'bye' })
    h.record('pty.exit', { ptyId, exitCode: 2, signal: null })
    h.record('pty.exit', { ptyId, exitCode: 2, signal: null })
    expect(h.events.map((event) => event.type)).toEqual(['pty.data', 'pty.exit'])
    expect(h.events[1]).toMatchObject({
      threadId: qualified,
      data: { ptyId, agentId: PROJECT_SHELL_AGENT_ID, exitCode: 2, signal: null, threadId: qualified }
    })
    expect(h.terminals.state()).toEqual([])
    expect(h.closed.handles).toBe(1)
    await vi.waitFor(() => expect(h.closed.owner).toBe(1))
  })

  it('finds out whether a terminal is still there when its stream goes away, and reports one that is not', async () => {
    const h = harness(async (method) => {
      if (method === 'pty.isAlive')
        throw new DomainRpcError('computer_forbidden', 'Terminals from this device are off on Laptop.')
      return {}
    })
    await h.attached()
    h.snapshot({ sequence: 0, scrollback: '' })
    h.error()
    await vi.waitFor(() => expect(h.events.map((event) => event.type)).toEqual(['pty.exit']))
    expect(h.events[0].data).toMatchObject({ ptyId, exitCode: null, signal: 'terminated' })
    expect(h.terminals.state()).toEqual([])
  })

  it('waits for a computer that cannot be reached, and reads the terminal again when it is back', async () => {
    let offline = true
    const h = harness(
      async (method) => {
        if (method !== 'pty.isAlive') return {}
        if (offline) throw new DomainRpcError('computer_offline', 'Laptop is offline.')
        return { alive: true }
      },
      { retryMs: 5 }
    )
    await h.attached()
    h.snapshot({ sequence: 0, scrollback: '' })
    h.error()
    await vi.waitFor(() => expect(h.calls.filter((c) => c.method === 'pty.isAlive')).toHaveLength(1))
    // No end is reported while the computer is away.
    expect(h.events).toEqual([])
    offline = false
    h.terminals.nodeOnline(node)
    await vi.waitFor(() => expect(h.attaches()).toBe(2))
    expect(h.events).toEqual([])
  })

  it('reports a terminal that was already over when the stream was attached', async () => {
    const h = harness()
    await h.attached()
    h.snapshot({ sequence: 4, scrollback: 'done', alive: false })
    expect(h.events.map((event) => event.type)).toEqual(['pty.data', 'pty.exit'])
    expect(h.output()).toBe('done')
  })
})

describe('input', () => {
  const write = (h: ReturnType<typeof harness>, data: string) =>
    h.terminals.input(node, threadId, ptyId, 'pty.write', { threadId, ptyId, data })
  const sent = (h: ReturnType<typeof harness>) =>
    h.calls.filter((call) => call.method === 'pty.write').map((call) => call.params)

  it('takes the next number the moment the window types, sends without waiting for replies, and cuts a long paste', async () => {
    let running = 0
    let overlapped = false
    const h = harness(async (method) => {
      if (method !== 'pty.write') return {}
      running += 1
      overlapped ||= running > 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      running -= 1
      return { ok: true }
    })
    const paste = 'p'.repeat(ROUTED_PTY_INPUT_MAX_CHARS * 2 + 5)
    await Promise.all([write(h, 'a'), write(h, paste), write(h, 'z')])
    // Calls were in flight together: the numbers, not the replies, are the order.
    expect(overlapped).toBe(true)
    const calls = sent(h)
    expect(calls.map((call) => (call.data as string).length)).toEqual([
      1,
      ROUTED_PTY_INPUT_MAX_CHARS,
      ROUTED_PTY_INPUT_MAX_CHARS,
      5,
      1
    ])
    expect(calls.map((call) => call.data).join('')).toBe(`a${paste}z`)
    // From 1, one after the other, no number twice: a count of the terminal's own, not a clock.
    expect(calls.map((call) => call.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('refuses a paste too large for the owner’s budget whole, before any of it is sent', async () => {
    const h = harness()
    const paste = 'x'.repeat(ROUTED_PTY_PASTE_MAX_BYTES + 1)
    await expect(write(h, paste)).rejects.toMatchObject({ code: 'paste_too_large' })
    expect(sent(h)).toEqual([])
    // One that fits goes through whole.
    await write(h, 'x'.repeat(ROUTED_PTY_PASTE_MAX_BYTES))
    expect(sent(h).map((call) => (call.data as string).length).reduce((a, b) => a + b, 0)).toBe(
      ROUTED_PTY_PASTE_MAX_BYTES
    )
  })

  it('does not split a character in two', async () => {
    const h = harness()
    // A character outside the basic plane is two code units; the cut falls between them.
    const text = 'x'.repeat(ROUTED_PTY_INPUT_MAX_CHARS - 1) + '😀' + 'y'
    await write(h, text)
    const pieces = sent(h).map((call) => call.data as string)
    expect(pieces.join('')).toBe(text)
    expect(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece))).toBe(true)
  })

  it('does not let one that failed hold up the ones after it, and never reuses its number', async () => {
    let fail = true
    const h = harness(async (method) => {
      if (method !== 'pty.write') return {}
      if (fail) {
        fail = false
        throw new DomainRpcError('rate_limited', 'Slow down.')
      }
      return { ok: true }
    })
    await expect(write(h, 'a')).rejects.toMatchObject({ code: 'rate_limited' })
    await write(h, 'b')
    expect(sent(h).map((call) => call.seq)).toEqual([1, 2])
  })

  it('counts without a clock: the same numbers whatever the time does, even backwards', async () => {
    const h = harness()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(5_000_000_000_000)
    await write(h, 'a')
    now.mockReturnValue(1_000)
    await write(h, 'b')
    now.mockRestore()
    await write(h, 'c')
    expect(sent(h).map((call) => call.seq)).toEqual([1, 2, 3])
  })

  it('counts on from where the owner says it is for a terminal it finds alive', async () => {
    const h = harness()
    h.terminals.ensure(node, threadId, ptyId, undefined, 40)
    await write(h, 'a')
    expect(sent(h).map((call) => call.seq)).toEqual([41])
  })

  it('sends again under the next number when the owner says a number was taken before any was accepted', async () => {
    // This computer forgot where the owner is (a restart that never asked): the owner has seen 50.
    const h = harness(async (method, params) => {
      if (method !== 'pty.write') return {}
      return (params.seq as number) <= 50 ? { ok: true, duplicate: true, lastSeq: 50 } : { ok: true }
    })
    await write(h, 'typed')
    expect(sent(h).map((call) => call.seq)).toEqual([1, 51])
    expect(sent(h).map((call) => call.data)).toEqual(['typed', 'typed'])
    // From then on its numbers are the owner's, and nothing is sent twice.
    await write(h, 'next')
    expect(sent(h).at(-1)).toMatchObject({ seq: 52, data: 'next' })
  })

  it('takes "already applied" for an accepted number as a resend whose reply was lost, and does not send it again', async () => {
    let calls = 0
    const h = harness(async (method) => {
      if (method !== 'pty.write') return {}
      calls += 1
      return calls === 1 ? { ok: true } : { ok: true, duplicate: true, lastSeq: 5 }
    })
    await write(h, 'a')
    await write(h, 'b')
    // The second was a duplicate of something the owner had applied: it is not typed a second time.
    expect(sent(h).map((call) => call.seq)).toEqual([1, 2])
  })

  it('gives up with a plain message when the owner and this computer cannot agree', async () => {
    const h = harness(async (method) => (method === 'pty.write' ? { ok: true, duplicate: true, lastSeq: 10 ** 9 } : {}))
    await expect(write(h, 'x')).rejects.toMatchObject({ code: 'terminal_out_of_step' })
  })
})
