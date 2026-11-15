// #595: an agent asks for a secret through a private card; the person's value goes to the secret store and nowhere
// else. The thread's messages (as windows get them and as they are saved), the agent's tool results, the protocol's
// replies and events, and anything written to the console or to a file under the profile hold only its name.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { secretTools } from '../../src/mms/run/mcp/appTools/secrets'
import type { AppToolHost } from '../../src/mms/run/mcp/appTools/host'
import type { ToolCallContext, ToolOutcome } from '../../src/mms/run/mcp/appTools/types'
import { registerSecretMethods } from '../../src/mms/secrets/registerMethods'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { createOrchestrator, phase6Daemon, piAdapter, waitFor, type Phase6Daemon, type ScriptedAdapter } from '../run/phase6Fixture'

const VALUE = 'hf_Secr3tValue-that-must-never-leak'

/** Every file under `root` but the secret store's own value file, with its text. */
function filesUnder(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (path !== join(root, 'secrets', 'refs.json')) out.push({ path, text: readFileSync(path).toString('latin1') })
    }
  }
  walk(root)
  return out
}

describe('a secret given through the card', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let vault: SecretVault
  let requests: SecretRequests
  let domains: DomainHandlerRegistry
  let console_: string[]
  let events: string[]
  let tool: (args: Record<string, unknown>, threadId: string) => Promise<ToolOutcome>
  let agentToolResult: ToolOutcome | undefined
  let laterTurnInputs: string[] = []
  let runTool: (args: Record<string, unknown>, threadId: string, cwd: string) => Promise<ToolOutcome>

  const gui = { connection: { clientType: 'gui', binding: { profileId: 'p', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
  const cli = { connection: { clientType: 'cli', binding: { profileId: 'p', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
  const dispatch = (context: HandlerContext, method: string, params: Record<string, unknown>) => domains.dispatch(context, method, params)

  let daemon: Phase6Daemon | undefined
  /** `withEngine`: a whole daemon (run engine, effect worker), whose runs record their final text. */
  function setUp(adapter: ProviderAdapter, withEngine = false): void {
    if (withEngine) {
      process.env.MOUSSE_HOME = home
      daemon = phase6Daemon(home, [adapter])
      orch = daemon.orch
      store = daemon.store
    } else orch = createOrchestrator(home, store, [adapter])
    orch.setPersistCallback((threadId) => {
      if (!threadId) return
      const existing = store.loadThreadData(threadId)
      store.saveThreadData(threadId, { messages: orch.liveMessagesForSave(threadId) as never, agents: existing.agents, tasks: existing.tasks, llmContext: orch.getNativeContext(threadId) })
    })
    const host = createSecretToolHost({ vault, requests, scratchRoot: join(home, 'secrets', 'run') })
    orch.setSecrets({ tools: host, masker: (threadId) => vault.maskerFor(threadId) })
    for (const name of ['thread-message', 'thread-message-updated', 'thread-messages'] as const) {
      orch.on(name, (payload: unknown) => events.push(JSON.stringify(payload)))
    }
    const [request, run] = secretTools({ secrets: () => host } as unknown as AppToolHost)
    const ctx = (threadId: string, cwd?: string): ToolCallContext => ({
      caller: { threadId, runId: 'r', provider: 'pi', modeCeiling: 'default', accessLevel: 'manage' },
      turn: { threadId, runId: 'r', modeFacts: { readOnly: false, agent: true, build: false }, ...(cwd ? { projectPath: cwd } : {}) } as never,
      toolCallId: 'c',
      signal: new AbortController().signal,
      transport: 'mcp'
    })
    tool = async (args, threadId) => request.handler(args, ctx(threadId))
    runTool = async (args, threadId, cwd) => run.handler(args, ctx(threadId, cwd))
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-secret-'))
    store = new ThreadDataStore(new ProjectManager(), home)
    vault = new SecretVault({ profileRoot: home, threadAlive: (id) => Boolean(store.getThread(id)) })
    requests = new SecretRequests(vault)
    domains = new DomainHandlerRegistry()
    registerSecretMethods(domains, async () => ({
      requests: {
        list: (threadId) => requests.list(threadId),
        answer: (threadId, requestId, value, keep) => requests.answer(threadId, requestId, value, keep),
        useSaved: (threadId, requestId) => requests.useSaved(threadId, requestId),
        decline: (threadId, requestId) => requests.decline(threadId, requestId)
      },
      list: () => vault.list(),
      delete: (name) => vault.delete(name)
    }))
    console_ = []
    events = []
    agentToolResult = undefined
    laterTurnInputs = []
    requests.on('changed', (payload) => events.push(JSON.stringify(payload)))
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { console_.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')) })
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    requests.dispose()
    if (daemon) await daemon.shutdown()
    else await orch?.shutdown(5_000)
    daemon = undefined
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  /** An agent that asks for the secret, then (wrongly) echoes it in a reply split across deltas and in a tool's output. */
  function leakyAgent(threadIdOf: () => string): ScriptedAdapter {
    const adapter = piAdapter(() => 'unused')
    adapter.startTurn = async (input: TurnInput, sink): Promise<TurnResult> => {
      sink.providerRef({ provider: input.llmProvider, model: input.model })
      if (agentToolResult) {
        // A later turn: what the runtime is sent again (the history, the prompt) is kept to be checked.
        laterTurnInputs.push(JSON.stringify({ messages: input.messages, nativeHistory: input.nativeHistory, prompt: input.prompt }))
        sink.text({ phase: 'complete', content: 'ok', contentIndex: 0 })
        return { text: 'ok', aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: input.llmProvider, model: input.model } }
      }
      const result = (agentToolResult = await tool({ label: 'Hugging Face write token', reason: 'To upload the model.', link: 'https://huggingface.co/settings/tokens', format: 'starts with hf_', name: 'HF_TOKEN' }, threadIdOf()))
      const half = Math.floor(VALUE.length / 2)
      sink.tool({ kind: 'build_tool_call', phase: 'start', callId: 'echo', title: 'Bash', summary: 'echo', details: [], response: `echo ${VALUE}` })
      sink.tool({ kind: 'build_tool_result', phase: 'complete', callId: 'echo', title: 'Bash', summary: 'done', details: [], response: `token=${VALUE}\n${Buffer.from(VALUE).toString('base64')}` })
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: `Got it (${result.text.slice(0, 40)}). The token is ${VALUE.slice(0, half)}`, contentIndex: 0 })
      sink.text({ phase: 'delta', content: `${VALUE.slice(half)} and I will use it.`, contentIndex: 0 })
      const text = `Got it. The token is ${VALUE} and I will use it.`
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      return { text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: input.llmProvider, model: input.model } }
    }
    return adapter
  }

  it('reaches the store only: the agent gets its name, and the thread, its saved data, events and logs never hold it', async () => {
    let threadId = ''
    setUp(leakyAgent(() => threadId))
    threadId = store.createThread('Upload').id
    // The turn waits on the card, so the send settles only after the answer.
    const sending = orch.send('Upload my model to the Hub', false, { threadId })

    await waitFor(() => requests.list(threadId).length === 1, 'the card')
    const [card] = (await dispatch(cli, 'secrets.requests.list', { threadId }) as { requests: Array<{ requestId: string; name: string; link?: string }> }).requests
    expect(card).toMatchObject({ name: 'HF_TOKEN', link: 'https://huggingface.co/settings/tokens' })
    // Only a window answers: not the CLI, not an agent.
    await expect(dispatch(cli, 'secrets.requests.answer', { threadId, requestId: card.requestId, value: VALUE, keep: 'day' })).rejects.toThrow(/window/)
    const reply = await dispatch(gui, 'secrets.requests.answer', { threadId, requestId: card.requestId, value: VALUE, keep: 'day' })
    expect(reply).toEqual({ name: 'HF_TOKEN' })

    const sent = await sending
    // What the send returns to its caller (a window, the CLI) is masked too.
    expect(JSON.stringify(sent)).toContain('[secret HF_TOKEN hidden]')
    expect(JSON.stringify(sent)).not.toContain(VALUE)
    await waitFor(() => orch.getMessages(threadId).some((message) => message.role === 'assistant' && message.content.includes('will use it')), 'the reply')
    await waitFor(() => !orch.activeTurnThreadIds().includes(threadId), 'the turn to end')

    // The value is in the store, under the name the agent was told.
    expect(vault.value('HF_TOKEN')).toBe(VALUE)
    const messages = JSON.stringify(orch.getMessages(threadId))
    expect(messages).toContain('[secret HF_TOKEN hidden]')
    // The agent's tool result names it and never holds it.
    expect(agentToolResult?.text).toContain('kept by Mousse as HF_TOKEN')
    expect(agentToolResult?.text).not.toContain(VALUE)
    expect(messages).not.toContain(VALUE)
    expect(messages).not.toContain(Buffer.from(VALUE).toString('base64'))
    expect(JSON.stringify(orch.getNativeContext(threadId))).not.toContain(VALUE)
    // A window never received it, in any event; the protocol's replies and the card events never held it.
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) expect(event).not.toContain(VALUE)
    expect(JSON.stringify(await dispatch(cli, 'secrets.list', {}))).not.toContain(VALUE)
    // Nothing logged it, and no file under the profile but the secret store holds it.
    for (const line of console_) expect(line).not.toContain(VALUE)
    const files = filesUnder(home)
    expect(files.some((file) => file.path.includes('thread'))).toBe(true)
    for (const file of files) expect({ path: file.path, leaked: file.text.includes(VALUE) }).toEqual({ path: file.path, leaked: false })
  })

  it('a reply that repeats it is masked in the run\'s recorded result and in what the next turn is sent', async () => {
    let threadId = ''
    setUp(leakyAgent(() => threadId), true)
    const results: Array<string | undefined> = []
    const markTerminal = daemon!.engine.markTerminal.bind(daemon!.engine)
    vi.spyOn(daemon!.engine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
      results.push(args[3]?.resultText)
      return markTerminal(...args)
    })
    threadId = store.createThread('Upload').id
    const sending = orch.send('Upload my model to the Hub', false, { threadId })
    await waitFor(() => requests.list(threadId).length === 1, 'the card')
    await dispatch(gui, 'secrets.requests.answer', { threadId, requestId: requests.list(threadId)[0].requestId, value: VALUE, keep: 'day' })
    await sending
    await waitFor(() => results.length >= 1, 'the run to end')
    await orch.send('And now?', false, { threadId })
    await waitFor(() => laterTurnInputs.length === 1, 'the next turn')

    expect(results[0]).toContain('[secret HF_TOKEN hidden]')
    for (const result of results) expect(result ?? '').not.toContain(VALUE)
    expect(laterTurnInputs[0]).toContain('[secret HF_TOKEN hidden]')
    expect(laterTurnInputs[0]).not.toContain(VALUE)
    for (const file of filesUnder(home)) expect({ path: file.path, leaked: file.text.includes(VALUE) }).toEqual({ path: file.path, leaked: false })
  })

  it('declining, a refusal and a request that ends store nothing, and the agent is told plainly', async () => {
    setUp(piAdapter(() => 'ok'))
    const threadId = store.createThread('Decline').id
    const declined = tool({ label: 'GitHub token', reason: 'To open the PR.' }, threadId)
    await waitFor(() => requests.list(threadId).length === 1, 'the card')
    const [card] = requests.list(threadId)
    // A value too short is refused in words that do not repeat it; the card stays open.
    await expect(dispatch(gui, 'secrets.requests.answer', { threadId, requestId: card.requestId, value: 'ab', keep: 'day' })).rejects.toThrow(/at least 4/)
    await expect(dispatch(gui, 'secrets.requests.answer', { threadId, requestId: card.requestId, value: VALUE, keep: 'forever' })).rejects.toThrow(/how long/)
    // A NUL cannot go into a command's environment, and a refusal to start would quote it: refused here.
    await expect(dispatch(gui, 'secrets.requests.answer', { threadId, requestId: card.requestId, value: 'demo\u0000password', keep: 'day' })).rejects.toThrow(/NUL/)
    await dispatch(gui, 'secrets.requests.decline', { threadId, requestId: card.requestId })
    expect(await declined).toMatchObject({ isError: true, text: expect.stringMatching(/declined.*Nothing was stored/) })

    // Stop or the turn ending: the request's signal aborts.
    const stop = new AbortController()
    const ended = requests.request(threadId, { label: 'GitHub token', reason: 'x' }, { signal: stop.signal })
    await waitFor(() => requests.list(threadId).length === 1, 'the second card')
    const [late] = requests.list(threadId)
    stop.abort()
    expect(await ended).toEqual({ kind: 'ended', why: 'stopped' })
    // An answer that arrives after the end stores nothing.
    await expect(dispatch(gui, 'secrets.requests.answer', { threadId, requestId: late.requestId, value: VALUE, keep: 'saved' })).rejects.toThrow(/ended/)
    expect(vault.list()).toEqual([])
  })

  it('gives a command the secret by name only, masks its output, and refuses a thread it was not given to', async () => {
    setUp(piAdapter(() => 'ok'))
    const threadId = store.createThread('Use').id
    const other = store.createThread('Other').id
    const asked = tool({ label: 'API token', reason: 'To call the API.', name: 'API_TOKEN' }, threadId)
    await waitFor(() => requests.list(threadId).length === 1, 'the card')
    await dispatch(gui, 'secrets.requests.answer', { threadId, requestId: requests.list(threadId)[0].requestId, value: VALUE, keep: 'thread' })
    expect((await asked).text).toContain('API_TOKEN')
    expect((await asked).text).not.toContain(VALUE)

    const ran = await runTool({ command: 'printf "%s|" "$API_TOKEN"; cat "$API_TOKEN_FILE"; printf "|%s" "$API_TOKEN_FILE"', secrets: [{ name: 'API_TOKEN' }, { name: 'API_TOKEN', as: 'file' }] }, threadId, home)
    expect(ran.isError).toBeUndefined()
    expect(ran.text).toContain('[secret API_TOKEN hidden]|[secret API_TOKEN hidden]|')
    expect(ran.text).not.toContain(VALUE)
    // The private file is gone once the command ends.
    const filePath = ran.text.split('|').pop()!.trim()
    expect(() => statSync(filePath)).toThrow()
    expect(vault.list()[0]).toMatchObject({ name: 'API_TOKEN', keep: 'thread', threadId, lastUsedAt: expect.any(String) })

    // Forms a command prints without meaning to: hex, and HTTP Basic (base64 of user:password) in a verbose header.
    const encoded = await runTool({ command: 'printf "%s" "$API_TOKEN" | od -An -tx1 | tr -d " \\n"; echo; printf "> Authorization: Basic %s\\n" "$(printf "me:%s" "$API_TOKEN" | base64)"', secrets: [{ name: 'API_TOKEN' }] }, threadId, home)
    expect(encoded.text).toContain('[secret API_TOKEN hidden]')
    expect(encoded.text).toContain('> Authorization: Basic [hidden]')
    expect(encoded.text).not.toContain(Buffer.from(VALUE).toString('hex'))
    expect(encoded.text).not.toContain(Buffer.from(`me:${VALUE}`).toString('base64').slice(0, 20))

    const refused = await runTool({ command: 'printf "%s" "$API_TOKEN"', secrets: [{ name: 'API_TOKEN' }] }, other, home)
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('no secret named API_TOKEN') })
  })
})
