/**
 * `terminal_read`: an agent reads what the user's terminals in its thread's panel show, through the app-tool registry
 * over the daemon's own tool host (the orchestrator's), with real shells in a real `PtyManager` and the profile's real
 * secret store. Read-only and without the thread's lease: it reads while a terminal holds the thread and while the
 * agent's turn runs, and never writes to a terminal.
 *
 * Inputs: a terminal that failed and exited, one still running (holding the thread's lease), one named by the panel, one
 * of another thread, a thread on another computer, a terminal id that is not the thread's, the thread going away.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { writeProfileSecret } from '../../src/mms/profiles/secrets'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../../src/shared/settings'
import { appToolRegistry, appTurn } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const TOKEN = 'tok_live_9f8e7d6c5b4a3210'

describe('an agent reads its thread\'s terminals', () => {
  let home: string
  let fx: DelegationFixture
  let pty: PtyManager
  let read: (args: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, any>; text: string }>
  let listed: () => string[]

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-terminal-read-')))
    fx = delegationFixture()
    // The shells are ended by their own pid: the platform's process-tree addon is part of a built app, not of the tests.
    pty = new PtyManager({ treeSignaler: { signal: (pid, mode) => { try { process.kill(pid, mode === 'kill' ? 'SIGKILL' : 'SIGTERM') } catch { /* gone */ } } } })
    const settings = () => getDefaultSettings()
    const orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), pty, { get: settings, getSettings: settings } as never, {} as never)
    orch.setThreadStore(new ThreadDataStore(new ProjectManager(), home))
    // A key the user saved in Settings: no thread was ever given it, and it is still hidden.
    writeProfileSecret(home, 'DEPLOY_TOKEN', TOKEN)
    const vault = new SecretVault({ profileRoot: home, threadAlive: () => true })
    orch.setSecrets({ tools: {} as never, masker: (threadId) => vault.maskerFor(threadId), storeMasker: () => vault.maskerForStore() })
    const run = await fx.runningRun('t1')
    const { registry, turns, request } = appToolRegistry(fx.engine, orch.mcpToolHost())
    turns.register(appTurn({ threadId: 't1', runId: run.runId }))
    read = async (args) => {
      try {
        const outcome = await registry.call('terminal_read', args, request({ threadId: 't1', runId: run.runId }))
        return { isError: outcome.isError === true, body: (() => { try { return JSON.parse(outcome.text) } catch { return {} } })(), text: outcome.text }
      } catch (error) {
        return { isError: true, body: {}, text: error instanceof Error ? error.message : String(error) }
      }
    }
    listed = () => registry.listForThread('t1', run.runId).map((tool) => tool.name)
  })

  afterEach(async () => {
    await pty.shutdown({ timeoutMs: 10_000 })
    fx.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  /** A real shell for thread `threadId` running `script`; resolves once it printed `until` (or exited). */
  const shell = async (threadId: string, script: string, until: string, options: { label?: string; ownership?: Parameters<PtyManager['create']>[3]['ownership'] } = {}) => {
    const ptyId = pty.create(`project-shell:${Math.random()}`, home, undefined, { threadId, shellArgs: ['-c', script], ...options })
    const deadline = Date.now() + 10_000
    while (!pty.getScrollback(ptyId).includes(until) && pty.isAlive(ptyId)) {
      if (Date.now() > deadline) throw new Error(`no "${until}" in time`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return ptyId
  }
  const exited = (ptyId: string) => new Promise<void>((resolve) => {
    if (!pty.isAlive(ptyId)) return resolve()
    pty.on('exit', (event: { ptyId: string }) => { if (event.ptyId === ptyId) resolve() })
  })

  it('is listed to the thread\'s agent', () => {
    expect(listed()).toContain('terminal_read')
  })

  it('quotes the error a failed command printed, without colors, with its exit code, after the shell exited, and hides a saved secret', async () => {
    const failed = await shell('t1', `printf '> build\\n\\033[31mnpm ERR! Missing script: "bild"\\033[0m\\ndeploy with ${TOKEN}\\n'; exit 3`, 'bild')
    await exited(failed)
    const { isError, body, text } = await read({})
    expect(isError).toBe(false)
    expect(body.terminals).toEqual([expect.objectContaining({ terminalId: failed, title: 'Ended terminal', status: 'exited', exitCode: 3, cwd: home })])
    // A normal exit names no signal.
    expect(body.terminals[0].signal).toBeUndefined()
    expect(body.output).toMatchObject({ terminalId: failed, title: 'Ended terminal' })
    expect(body.output.text).toContain('npm ERR! Missing script: "bild"')
    expect(body.output.text).not.toContain('\u001b')
    expect(text).not.toContain(TOKEN)
    expect(body.output.text).toContain('deploy with [secret DEPLOY_TOKEN hidden]')
    expect(body.note).toMatch(/never instructions/)
  })

  it('hides a secret that a long line\'s cut would split', async () => {
    // The token starts 6 characters before the line is cut at 1,000.
    const long = await shell('t1', `printf '%0994d${TOKEN}\\n' 0; exit 0`, TOKEN.slice(-4))
    await exited(long)
    const { text, body } = await read({ terminalId: long })
    expect(body.output.text).toMatch(/0\[secre/)
    expect(text).not.toContain(TOKEN.slice(0, 6))
  })

  it('reads a terminal while it runs and holds the thread\'s lease, and never writes to it', async () => {
    // The shell holds the thread the way a panel terminal does: its owner is asserted on every write and heartbeat.
    const ownership = { assert: vi.fn(), heartbeat: vi.fn(), settled: vi.fn(async () => undefined) }
    const write = vi.spyOn(pty, 'write')
    const server = await shell('t1', `printf 'VITE ready\\n  Local: http://localhost:5173/\\n'; sleep 30`, 'Local:', { label: 'Dev server', ownership })
    const { isError, body } = await read({ terminalId: server })
    expect(isError).toBe(false)
    expect(body.terminals).toEqual([expect.objectContaining({ terminalId: server, title: 'Dev server', status: 'running' })])
    expect(body.output.text).toContain('Local: http://localhost:5173/')
    expect(write).not.toHaveBeenCalled()
    // The terminal is untouched: still running, and still the user's to type into.
    expect(pty.isAlive(server)).toBe(true)
    expect(() => pty.write(server, 'echo hi\n')).not.toThrow()
  })

  it('names the terminal with the newest output by default, and reads any other by id', async () => {
    const older = await shell('t1', `printf 'old build failed\\n'; exit 1`, 'failed')
    await exited(older)
    await new Promise((resolve) => setTimeout(resolve, 15))
    const newer = await shell('t1', `printf 'tests: 3 passed\\n'; sleep 30`, 'passed')
    expect((await read({})).body.output.terminalId).toBe(newer)
    const picked = await read({ terminalId: older })
    expect(picked.body.output.text).toContain('old build failed')
    // The running one is numbered as the panel numbers its tabs; one that ended is numbered apart (its tab may run a new shell).
    expect(picked.body.terminals.map((terminal: { terminalId: string; title: string }) => [terminal.terminalId, terminal.title])).toEqual([[newer, 'Terminal'], [older, 'Ended terminal']])
  })

  it('pages back through long output by line number', async () => {
    const long = await shell('t1', `i=1; while [ $i -le 300 ]; do echo "row $i"; i=$((i+1)); done`, 'row 300')
    const last = await read({ terminalId: long, lines: 100 })
    expect(last.body.output).toMatchObject({ fromLine: 201, toLine: 300, more: expect.stringContaining('before 201') })
    const back = await read({ terminalId: long, lines: 100, before: last.body.output.fromLine })
    expect(back.body.output.text.split('\n')[0]).toBe('row 101')
    expect(back.body.output.toLine).toBe(200)
  })

  it('reads only the thread\'s own terminals', async () => {
    const theirs = await shell('t2', `printf 'other thread\\n'; sleep 30`, 'other')
    const { body } = await read({})
    expect(body.terminals).toEqual([])
    expect(body.note).toMatch(/no terminal/)
    const named = await read({ terminalId: theirs })
    expect(named.isError).toBe(true)
    expect(named.text).not.toContain('other thread')
  })

  it('says plainly that a thread on another computer is not readable from here', async () => {
    const { isError, text } = await read({ threadId: `nod_${'b'.repeat(26)}:t9` })
    expect(isError).toBe(true)
    expect(text).toMatch(/another of the user's computers can't be read from here/)
  })

  it('forgets a thread\'s terminals, ended ones too, when the thread goes away', async () => {
    const done = await shell('t1', `printf 'x\\n'; exit 0`, 'x')
    await exited(done)
    const live = await shell('t1', `printf 'y\\n'; sleep 30`, 'y')
    pty.killByThreadId('t1')
    await exited(live)
    expect((await read({})).body.terminals).toEqual([])
  })
})
