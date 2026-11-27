import { createBotJournal } from '../../src/mms/bots/memory/capture'
import { memoryFixture, disposeFixtures } from '../bots/memory/memoryFixture'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
/**
 * A personal bot's secrets, through the real path (bot/thread parity, "use secrets you give it").
 *
 * 1. A bot's `secret_run` goes through the real tool, the profile's real secret host and `runWithSecrets`. It never gets
 *    the service's environment: only the bot's locked command environment plus the secrets it names. On Linux with
 *    bubblewrap it runs in Mousse's sandbox with only its folders and no network; elsewhere it runs as the bot's other
 *    commands do, from its files folder. A thread's agent (the control row) runs as before, with the service's
 *    environment and every folder.
 * 2. A secret the owner gave the bot (filed under its chat thread) is masked in what a turn of its work thread keeps:
 *    the stored messages, the run's recorded result, the native history, the reply to the caller and every file of the
 *    profile. Without the bot's chat thread (the control row), the same turn keeps it in the clear.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import { botSecretContainment, bubblewrapArgs, findBubblewrap } from '../../src/mms/secrets/botSecretCommand'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from '../run/phase6Fixture'

const VALUE = 'ghp_B0tSecretValue-that-must-never-leak'
/** An ambient credential of the owner's that no bot was given. */
const AMBIENT = 'ambient-credential-the-bot-was-never-given'
const WINDOWS = process.platform === 'win32'
const BUBBLEWRAP = process.platform === 'linux' ? findBubblewrap() : undefined

describe('a bot\'s secret command is held as its commands are', () => {
  let base: string
  let files: string
  let scratch: string
  let outside: string
  let vault: SecretVault
  let requests: SecretRequests

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-secret-')))
    files = join(base, 'profile', 'bots', 'files', 'alpha')
    scratch = join(base, 'profile', 'bots', 'scratch', 'act-1')
    mkdirSync(files, { recursive: true })
    mkdirSync(join(scratch, 'tmp'), { recursive: true })
    // A file of the owner's, outside the bot's folders.
    mkdirSync(join(base, 'owner'))
    outside = join(base, 'owner', 'private.txt')
    writeFileSync(outside, 'OWNER-PRIVATE-CONTENT\n')
    vault = new SecretVault({ profileRoot: join(base, 'profile'), threadAlive: () => true })
    requests = new SecretRequests(vault)
    // Given to the bot: filed under its chat thread.
    vault.store('API_TOKEN', VALUE, { keep: 'thread', threadId: 'home' })
  })

  afterEach(() => {
    requests.dispose()
    rmSync(base, { recursive: true, force: true })
  })

  /** `secret_run` as the bot's work (thread `work`) or a thread's agent (thread `home`, as its own) calls it. */
  const tool = (options: { containment?: Parameters<typeof createSecretToolHost>[0]['containment'] } = {}) => {
    const host = createSecretToolHost({ vault, requests, scratchRoot: join(base, 'profile', 'secrets', 'run'), baseEnv: { ...process.env, MOUSSE_TEST_AMBIENT: AMBIENT }, ...options })
    const [, run] = secretTools({ secrets: () => host, botHomeOf: (id: string) => (id === 'work' ? 'home' : undefined) } as unknown as AppToolHost)
    return (args: Record<string, unknown>, caller: 'bot' | 'thread') => run!.handler(args, {
      caller: { threadId: caller === 'bot' ? 'work' : 'home', runId: 'r', provider: 'pi', accessLevel: 'manage' },
      turn: {
        threadId: caller === 'bot' ? 'work' : 'home',
        runId: 'r',
        modeFacts: { readOnly: false, agent: true, build: false },
        ...(caller === 'bot'
          ? { bot: { appTools: new Set(['secret_run']), workspace: { roots: [], access: 'write', writeRoots: [], scratch, files } } }
          : { projectPath: files })
      } as never,
      toolCallId: 'c',
      signal: new AbortController().signal,
      transport: 'mcp'
    } as ToolCallContext)
  }

  /** Prints the ambient variable, reads the owner's file, prints the secret (masked), and leaves a mark where it ran. */
  const probe = () => WINDOWS
    ? `echo u=%MOUSSE_TEST_AMBIENT%& type "${outside}"& echo t=%API_TOKEN%& echo ran> ran.txt`
    : `printf "u=%s|" "$MOUSSE_TEST_AMBIENT"; cat "${outside}"; printf "|t=%s|" "$API_TOKEN"; echo ran > ran.txt`

  it('a thread\'s agent runs as before: the service\'s environment and every folder (the control row)', async () => {
    const ran = await tool()({ command: probe(), secrets: [{ name: 'API_TOKEN' }] }, 'thread')
    expect(ran.text).toContain(`u=${AMBIENT}`)
    expect(ran.text).toContain('OWNER-PRIVATE-CONTENT')
    expect(existsSync(join(files, 'ran.txt'))).toBe(true)
  })

  it('where Mousse has no sandbox for it, a bot\'s command runs as its other commands do: from its files folder, with the locked environment and its secret only', async () => {
    const ran = await tool({ containment: { sandbox: 'none' } })({ command: probe(), secrets: [{ name: 'API_TOKEN' }] }, 'bot')
    expect(ran.isError).toBeUndefined()
    // The secret it named is there (masked in what it prints); the owner's ambient credential is not.
    expect(ran.text).toContain('[secret API_TOKEN hidden]')
    expect(ran.text).not.toContain(VALUE)
    expect(ran.text).not.toContain(AMBIENT)
    expect(existsSync(join(files, 'ran.txt'))).toBe(true)
  })

  it('on this computer, a bot\'s command gets its secret and never the ambient credential; in the Linux sandbox, not the owner\'s file either', async () => {
    const ran = await tool()({ command: probe(), secrets: [{ name: 'API_TOKEN' }] }, 'bot')
    expect(ran.isError).toBeUndefined()
    expect(ran.text).toContain('[secret API_TOKEN hidden]')
    expect(ran.text).not.toContain(VALUE)
    expect(ran.text).not.toContain(AMBIENT)
    expect(existsSync(join(files, 'ran.txt'))).toBe(true)
    if (BUBBLEWRAP) {
      expect(ran.text).toContain('u=|')
      expect(ran.text).not.toContain('OWNER-PRIVATE-CONTENT')
    }
  })

  it.runIf(BUBBLEWRAP !== undefined)('in the sandbox it has no network, its secret file is there for the command only, and it writes only its folders', async () => {
    const ran = await tool()({
      command: `cat "$API_TOKEN_FILE" | wc -c; (echo > /dev/tcp/1.1.1.1/443) 2>&1 | head -1 || true; ls /home 2>&1 | head -1; touch "${join(base, 'owner', 'written.txt')}" 2>&1 | head -1`,
      secrets: [{ name: 'API_TOKEN', as: 'file' }]
    }, 'bot')
    expect(ran.text).toContain(String(VALUE.length))
    expect(ran.text).not.toContain(VALUE)
    expect(existsSync(join(base, 'owner', 'written.txt'))).toBe(false)
  })

  // Where Mousse runs a bot's secret command in its sandbox, by platform: only Linux with bubblewrap. Elsewhere it runs as
  // the bot's other commands do. (Where bubblewrap is found only matters on Linux.)
  const where: Array<[string, NodeJS.Platform, string | undefined, 'bubblewrap' | 'none']> = [
    ['Linux with bubblewrap', 'linux', '/usr/bin/bwrap', 'bubblewrap'],
    ['Linux without bubblewrap', 'linux', undefined, 'none'],
    ['macOS, even with a program named bwrap', 'darwin', '/usr/local/bin/bwrap', 'none'],
    ['Windows', 'win32', undefined, 'none']
  ]
  it.each(where)('%s', (_name, platform, bwrap, sandbox) => {
    expect(botSecretContainment(platform, () => bwrap).sandbox).toBe(sandbox)
  })

  it('the sandbox has no network and none of the owner\'s folders: only the system\'s, read-only, and the bot\'s own', () => {
    const args = bubblewrapArgs('true', { cwd: '/bots/files/alpha', writable: ['/bots/files/alpha', '/bots/scratch/act-1'], readOnly: ['/profile/secrets/run/run-x'] }, { exists: (path) => ['/usr', '/etc', '/bin'].includes(path), link: (path) => (path === '/bin' ? 'usr/bin' : undefined) })
    expect(args).toEqual(expect.arrayContaining(['--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session']))
    const pairs = (flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []))
    expect(pairs('--bind')).toEqual(['/bots/files/alpha', '/bots/scratch/act-1'])
    expect(pairs('--ro-bind')).toEqual(['/usr', '/etc', '/profile/secrets/run/run-x'])
    // `/bin` stays the system's link into `/usr`; nothing else of this computer (no home folder, `/mnt`, `/var`, `/run`).
    expect(pairs('--symlink')).toEqual(['usr/bin'])
    expect(args).not.toContain('--share-net')
  })
})

describe('a bot\'s secret is masked in what a turn of its work keeps', () => {
  let home: string
  let daemon: Phase6Daemon | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-bot-secret-mask-'))
    process.env.MOUSSE_HOME = home
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    if (daemon) await daemon.shutdown()
    daemon = undefined
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
    disposeFixtures()
  })

  /** Every file under `root` but the secret store's own value file and the threads' private copies, with its text. */
  const filesUnder = (root: string): Array<{ path: string; text: string }> => {
    const out: Array<{ path: string; text: string }> = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (path === join(root, 'secrets', 'threads')) continue
        if (statSync(path).isDirectory()) walk(path)
        else if (!path.endsWith(join('secrets', 'refs.json'))) out.push({ path, text: readFileSync(path).toString('latin1') })
      }
    }
    walk(root)
    return out
  }

  /** A bot's work turn whose runtime echoes the secret in a tool's output and in its reply. */
  const run = async (botThreads: boolean, bound = false) => {
    const adapter = piAdapter(() => 'unused')
    adapter.startTurn = async (input: TurnInput, sink): Promise<TurnResult> => {
      sink.providerRef({ provider: input.llmProvider, model: input.model })
      sink.tool({ kind: 'build_tool_call', phase: 'start', callId: 'echo', title: 'Bash', summary: 'echo', details: [], response: 'echo $API_TOKEN' })
      sink.tool({ kind: 'build_tool_result', phase: 'complete', callId: 'echo', title: 'Bash', summary: 'done', details: [], response: `token=${VALUE}` })
      const text = `Done. The token was ${VALUE}.`
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      return { text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: input.llmProvider, model: input.model } }
    }
    daemon = phase6Daemon(home, [adapter])
    const { orch, store, engine } = daemon
    const chat = store.createThread('alpha')
    const work = store.createThread('alpha: open the pull request')
    // The bot's threads as its engine reports them: its work's thread belongs to the bot whose chat is `chat`.
    if (botThreads) orch.setBotThreads({ roleOf: () => undefined, homeOf: (threadId) => (threadId === work.id || threadId === chat.id ? chat.id : undefined) })
    const vault = new SecretVault({ profileRoot: home, threadAlive: (id) => Boolean(store.getThread(id)) })
    const requests = new SecretRequests(vault)
    vault.store('API_TOKEN', VALUE, { keep: 'thread', threadId: chat.id, ...(bound ? { binding: resolveSecretBinding({service: 'github'}) } : {}) })
    orch.setSecrets({ tools: createSecretToolHost({ vault, requests, scratchRoot: join(home, 'secrets', 'run') }), masker: (threadId) => vault.maskerFor(threadId) })
    orch.setPersistCallback((threadId) => {
      if (!threadId) return
      const existing = store.loadThreadData(threadId)
      store.saveThreadData(threadId, { messages: orch.liveMessagesForSave(threadId) as never, agents: existing.agents, tasks: existing.tasks, llmContext: orch.getNativeContext(threadId) })
    })
    const results: Array<string | undefined> = []
    const markTerminal = engine.markTerminal.bind(engine)
    vi.spyOn(engine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
      results.push(args[3]?.resultText)
      return markTerminal(...args)
    })
    const reply = await orch.send('Open the pull request', false, { threadId: work.id })
    await waitFor(() => results.length >= 1, 'the run to end')
    await waitFor(() => !orch.activeTurnThreadIds().includes(work.id), 'the turn to end')
    const memory = memoryFixture()
    const journal = createBotJournal({ store: memory.store, readThread: id => store.loadThreadData(id), listThreads: () => [] })
    await journal.syncThread({ botId: 'alpha', threadId: work.id, lane: 'run', activationId: 'act' })
    requests.dispose()
    return { journal: JSON.stringify(memory.store.journal('alpha')), reply: JSON.stringify(reply), messages: JSON.stringify(orch.getMessages(work.id)), native: JSON.stringify(orch.getNativeContext(work.id)), result: results.join('\n') }
  }

  it.each([false, true])('in its messages, recorded result, native history, reply and profile files (bound: %s)', async bound => {
    const logs: unknown[][] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args) })
    const kept = await run(true, bound)
    expect(JSON.stringify(logs)).not.toContain(VALUE)
    expect(kept.journal).toContain('[secret API_TOKEN hidden]')
    for (const [where, text] of Object.entries(kept)) expect({ where, leaked: text.includes(VALUE) }).toEqual({ where, leaked: false })
    expect(kept.messages).toContain('[secret API_TOKEN hidden]')
    expect(kept.result).toContain('[secret API_TOKEN hidden]')
    for (const file of filesUnder(home)) expect({ path: file.path, leaked: file.text.includes(VALUE) }).toEqual({ path: file.path, leaked: false })
  })

  it('the control row: without the bot\'s chat thread, the same turn keeps it in the clear', async () => {
    const kept = await run(false)
    expect(kept.messages).toContain(VALUE)
    expect(kept.result).toContain(VALUE)
  })
})
