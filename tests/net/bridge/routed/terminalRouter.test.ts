/**
 * A window of one computer opens, reads and types into a terminal on the computer that runs the thread,
 * over two real daemons linked by a real session. The terminal switch is the owner's, per device, and off
 * by default; output arrives on the terminal's own stream; input is numbered.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import { parseTerminalOffMessage } from '../../../../src/shared/bridge/routed'
import { PROJECT_SHELL_AGENT_ID } from '../../../../src/shared/types'
import { cleanups, cleanupAll, linked } from './routerFixture'
import { fakeShells, type Spawned } from './terminalFixture'

/** Waits for a thing that crosses a real session: long enough for a loaded machine. */
const eventually = (check: () => void, options: { timeout?: number } = {}) =>
  vi.waitFor(check, { timeout: 15_000, ...options })

let t: Awaited<ReturnType<typeof linked>>
let shells: Spawned[]
beforeAll(async () => {
  t = await linked()
  shells = fakeShells(t.owner.ptyManager, cleanups)
}, 120_000)
afterAll(cleanupAll)

/** A thread with a folder of its own on the owner. */
function folderThread(name = 'Terminal thread') {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-router-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'owner@example.test')
  git('config', 'user.name', 'Owner')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  const project = t.owner.projects.openProject(path)
  return t.owner.threads.createThread(name, project.id, path, {})
}

const agentId = `${PROJECT_SHELL_AGENT_ID}:tab-1`
const terminalEvents = (type?: string) =>
  t.events.filter((event) => event.type.startsWith('pty.') && (!type || event.type === type))
const output = (ptyId: string) =>
  terminalEvents('pty.data')
    .filter((event) => event.data.ptyId === ptyId)
    .map((event) => event.data.data as string)
    .join('')
const attached = (ptyId: string) =>
  t.router.terminals.state().some((term) => term.ptyId === ptyId && term.attached)

/** Opens a terminal on a thread of the owner, the way a window does. */
async function open(thread = folderThread()) {
  const before = shells.length
  const created = await t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId })
  const shell = shells[before]
  await eventually(() => expect(attached(created.ptyId)).toBe(true), { timeout: 20_000 })
  return { thread, shell, ptyId: created.ptyId as string, created }
}

describe('a device whose terminals are off', () => {
  it('is refused, with words that say how to turn them on', async () => {
    const thread = folderThread()
    const refused = await t.refused(
      t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId })
    )
    expect(refused).toMatchObject({ code: 'computer_forbidden', details: { reason: 'terminal_off' } })
    expect(parseTerminalOffMessage(refused.message)).toEqual({ computer: expect.any(String) })
    // Reading the list of terminals is behind the switch too.
    expect(
      await t.refused(t.dispatch('pty.list', { threadId: t.qualified(thread.id) }))
    ).toMatchObject({ code: 'computer_forbidden' })
    expect(shells).toHaveLength(0)
  }, 60_000)
})

describe('with the terminal switch on', () => {
  it('lists, for a window, only the terminals this computer opened', async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    const mine = await open()
    // A terminal the owner's own window opened in another thread is not this device's.
    const other = folderThread('Owner terminal')
    await dispatchMethod(
      {
        mms: t.owner,
        globalSequence: () => 0,
        connection: {
          id: 'owner-window',
          clientType: 'gui',
          capabilities: new Set(),
          binding: { profileId: t.owner.getProfileId(), epoch: 1 },
          lifetime: new AbortController().signal
        }
      },
      'pty.create',
      { threadId: other.id, agentId: `${PROJECT_SHELL_AGENT_ID}:own` }
    )
    expect((await t.dispatch('pty.list', { threadId: t.qualified(other.id) })).ptys).toEqual([])
    expect(
      (await t.dispatch('pty.list', { threadId: t.qualified(mine.thread.id) })).ptys.map(
        (entry: { ptyId: string }) => entry.ptyId
      )
    ).toEqual([mine.ptyId])
    await t.dispatch('pty.kill', { threadId: t.qualified(mine.thread.id), ptyId: mine.ptyId })
  }, 120_000)

  beforeAll(async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
  }, 60_000)

  it('opens a terminal in the thread’s folder, which a window may not point elsewhere', async () => {
    const { thread, shell, created } = await open()
    // The answer names the thread as windows here do, and the shell is the owner's.
    expect(created.ptys[0]).toMatchObject({ threadId: t.qualified(thread.id), agentId })
    expect(shell.options.cwd).toContain(thread.id)

    // No folder, shell, arguments or variables: the owner decides all of them.
    for (const extra of [{ cwd: '..' }, { cwd: '.' }, { command: 'x' }, { env: { A: 'b' } }, { shellArgs: ['-c'] }])
      expect(
        await t.refused(
          t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId, ...extra })
        )
      ).toMatchObject({ code: 'invalid_params' })
    // The CLI and an agent's shell never route a terminal.
    expect(
      await t.refused(
        t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId }, t.connection('c', 'cli'))
      )
    ).toMatchObject({ code: 'forbidden' })
    await t.dispatch('pty.kill', { threadId: t.qualified(thread.id), ptyId: created.ptyId })
  }, 120_000)

  it('reads output as the terminal prints it, with the thread named as windows here name it', async () => {
    const { thread, shell, ptyId } = await open()
    shell.pty.say('hello ')
    shell.pty.say('world\r\n')
    await eventually(() => expect(output(ptyId)).toContain('hello world'))
    const first = terminalEvents('pty.data').find((event) => event.data.ptyId === ptyId)!
    expect(first).toMatchObject({
      threadId: t.qualified(thread.id),
      data: { ptyId, agentId, threadId: t.qualified(thread.id) }
    })
    await t.dispatch('pty.kill', { threadId: t.qualified(thread.id), ptyId })
  }, 120_000)

  it('keeps what the shell printed before the stream was attached until the window is ready for it', async () => {
    const thread = folderThread()
    const before = shells.length
    const created = await t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId })
    const shell = shells[before]
    // The prompt is printed before this computer has attached to the terminal's stream.
    shell.pty.say('PS prompt> ')
    await eventually(() => expect(attached(created.ptyId)).toBe(true), { timeout: 20_000 })
    shell.pty.say('then more')
    // Nothing is shown yet: the window has not mounted the terminal, which it does by resizing it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(output(created.ptyId)).toBe('')
    await t.dispatch('pty.resize', { threadId: t.qualified(thread.id), ptyId: created.ptyId, cols: 100, rows: 30 })
    await eventually(() => expect(output(created.ptyId)).toBe('PS prompt> then more'), { timeout: 10_000 })
    expect(shell.pty.resizes).toEqual([[100, 30]])
    await t.dispatch('pty.kill', { threadId: t.qualified(thread.id), ptyId: created.ptyId })
  }, 120_000)

  it('types in the order the window typed, cuts a long paste into numbered calls, and applies each once', async () => {
    const { thread, shell, ptyId } = await open()
    const q = t.qualified(thread.id)
    // Many calls at once still arrive in order, one at a time.
    const calls = Array.from({ length: 25 }, (_, index) =>
      t.dispatch('pty.write', { threadId: q, ptyId, data: `${index};` })
    )
    await Promise.all(calls)
    expect(shell.pty.written.join('')).toBe(Array.from({ length: 25 }, (_, i) => `${i};`).join(''))
    // A paste larger than one call is several, in order, and arrives whole.
    shell.pty.written.length = 0
    const paste = Array.from({ length: 40_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
    await t.dispatch('pty.write', { threadId: q, ptyId, data: paste })
    expect(shell.pty.written.length).toBeGreaterThan(2)
    expect(shell.pty.written.every((piece) => piece.length <= 16 * 1024)).toBe(true)
    expect(shell.pty.written.join('')).toBe(paste)
    // A window never names the number: the router owns it.
    expect(
      await t.refused(t.dispatch('pty.write', { threadId: q, ptyId, data: 'x', seq: 1 }))
    ).toMatchObject({ code: 'invalid_params' })
    await t.dispatch('pty.kill', { threadId: q, ptyId })
  }, 180_000)

  it('tells the window when the shell exits, once, after everything it printed', async () => {
    const { thread, shell, ptyId } = await open()
    shell.pty.say('bye\r\n')
    shell.pty.exit(3)
    await eventually(() =>
      expect(terminalEvents('pty.exit').some((event) => event.data.ptyId === ptyId)).toBe(true)
    )
    const mine = terminalEvents().filter((event) => event.data.ptyId === ptyId)
    expect(mine.at(-1)).toMatchObject({
      type: 'pty.exit',
      threadId: t.qualified(thread.id),
      data: { ptyId, agentId, exitCode: 3 }
    })
    expect(mine.filter((event) => event.type === 'pty.exit')).toHaveLength(1)
    expect(output(ptyId)).toContain('bye')
    // Nothing reads it any more.
    expect(t.router.terminals.state().some((term) => term.ptyId === ptyId)).toBe(false)
  }, 120_000)

  it('lets go of a terminal the window stops, and finds one that is already gone', async () => {
    const { thread, shell, ptyId } = await open()
    const q = t.qualified(thread.id)
    await t.dispatch('pty.kill', { threadId: q, ptyId })
    expect(shell.pty.killed).toBe(true)
    expect(t.router.terminals.state().some((term) => term.ptyId === ptyId)).toBe(false)
    expect(await t.refused(t.dispatch('pty.kill', { threadId: q, ptyId }))).toMatchObject({
      code: 'pty_not_found'
    })
  }, 120_000)

  it('keeps reading a terminal the window finds alive after a restart of its own', async () => {
    const { thread, shell, ptyId } = await open()
    const q = t.qualified(thread.id)
    await t.dispatch('pty.write', { threadId: q, ptyId, data: 'before;' })
    await t.dispatch('pty.write', { threadId: q, ptyId, data: 'restart;' })
    // Forget everything this computer knew, as a restart does.
    t.router.terminals.forget(t.node, ptyId)
    expect(t.router.terminals.state().some((term) => term.ptyId === ptyId)).toBe(false)
    expect(await t.dispatch('pty.isAlive', { threadId: q, ptyId })).toMatchObject({ alive: true })
    await eventually(() => expect(attached(ptyId)).toBe(true), { timeout: 20_000 })
    shell.pty.say('after the restart')
    // A stream that was let go of is opened again and brings its snapshot first: that takes a moment.
    await eventually(() => expect(output(ptyId)).toContain('after the restart'), { timeout: 15_000 })
    // Its input counts on from where the owner is, so the first key after the restart is typed, not taken for a resend.
    await t.dispatch('pty.write', { threadId: q, ptyId, data: 'after;' })
    expect(shell.pty.written.join('')).toBe('before;restart;after;')
    await t.dispatch('pty.kill', { threadId: q, ptyId })
  }, 120_000)

  it('is told when the owner switches terminals off: the shells end and the window sees them exit', async () => {
    const one = await open()
    const two = await open()
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    expect(one.shell.pty.killed && two.shell.pty.killed).toBe(true)
    await eventually(
      () => {
        for (const { ptyId } of [one, two])
          expect(terminalEvents('pty.exit').some((event) => event.data.ptyId === ptyId)).toBe(true)
      },
      { timeout: 20_000 }
    )
    expect(t.router.terminals.state()).toEqual([])
    // And it cannot open another until it is switched on again.
    const refused = await t.refused(
      t.dispatch('pty.create', { threadId: t.qualified(one.thread.id), agentId })
    )
    expect(refused).toMatchObject({ code: 'computer_forbidden', details: { reason: 'terminal_off' } })
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
  }, 180_000)

  it('is ended, with the owner’s record of it, when the device is blocked', async () => {
    const one = await open()
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    expect(one.shell.pty.killed).toBe(true)
    await eventually(
      () =>
        expect(terminalEvents('pty.exit').some((event) => event.data.ptyId === one.ptyId)).toBe(true),
      { timeout: 20_000 }
    )
    const audit = (t.owner.net.runtime().audit as { recent(n: number, node: string): Array<{ method: string; outcome: string }> }).recent(100, t.callerNode)
    expect(audit.some((row) => row.method === 'pty.close' && row.outcome.startsWith('blocked'))).toBe(true)
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: false })
  }, 180_000)
})
