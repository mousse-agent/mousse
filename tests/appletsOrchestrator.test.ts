import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { modelFacingReplyText, type AppletReference } from '../src/shared/applets'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'
import { HandoffService, type HandoffTranscriptSource } from '../src/mms/run/handoff/HandoffService'

const source = {
  schemaVersion: 1,
  title: 'Calculator',
  description: 'Illustrative values',
  html: '<main>Costs</main>',
  css: '',
  js: 'document.body.dataset.ready="true"'
}
const fence = (value: unknown) => '```mousse-applet\n' + JSON.stringify(value) + '\n```'
const homes: string[] = []
const services: MousseMainService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
async function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-applets-orchestrator-'))
  homes.push(home)
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const main = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  services.push(main)
  await main.start()
  main.settings.set({ provider: { llmProvider: 'claude-subscription', model: 'opus' } })
  const thread = main.threads.createThread('Applet conversation')
  return { home, main, thread }
}
const request = (main: MousseMainService, method: string, params: unknown) =>
  dispatchMethod({ mms: main, globalSequence: () => 0 }, method, params)
function reference(main: MousseMainService, threadId: string): AppletReference {
  const part = main.threads
    .loadThreadData(threadId)
    .messages.flatMap((message) => message.presentationParts ?? [])
    .find((part) => part.type === 'applet')
  expect(part?.type).toBe('applet')
  if (part?.type !== 'applet') throw new Error('No published applet')
  return part.reference
}
it('publishes completed native fences in order and reloads source after daemon restart', async () => {
  const { main, home, thread } = await fixture()
  const content = 'Before\n' + fence(source) + '\nAfter'
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
    input.onText(content)
    return content
  })
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  const completed = main.threads
    .loadThreadData(thread.id)
    .messages.find((message) => message.presentationParts)
  expect(completed?.presentationParts?.map((part) => part.type)).toEqual(['text', 'applet', 'text'])
  const ref = reference(main, thread.id)
  expect(main.applets.load(thread.id, ref.appletId, ref.revisionId).source.html).toBe(source.html)
  await main.stop()
  services.splice(services.indexOf(main), 1)
  const restarted = await MousseMainService.create({
    homeDir: home,
    headless: true,
    ownerKind: 'test'
  })
  services.push(restarted)
  await restarted.start()
  expect(reference(restarted, thread.id)).toEqual(ref)
  expect(
    await request(restarted, 'applets.get', {
      threadId: thread.id,
      appletId: ref.appletId,
      revisionId: ref.revisionId
    })
  ).toEqual(expect.objectContaining({ source: expect.objectContaining(source) }))
})
it('keeps interrupted native responses inert even when the complete fence was streamed', async () => {
  const { main, thread } = await fixture()
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
    input.onText(fence(source))
    expect(main.orchestrator.abortActiveTurn(thread.id)).toBe(true)
    return fence(source)
  })
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  const messages = main.threads.loadThreadData(thread.id).messages
  expect(messages.some((message) => message.role === 'assistant' && message.incomplete)).toBe(true)
  expect(
    messages.every((message) => !message.presentationParts?.some((part) => part.type === 'applet'))
  ).toBe(true)
  expect(main.applets.list(thread.id)).toEqual([])
  // What a parent or `thread_wait` reads of the stopped run names the applet, not its source.
  expect(results.at(-1)).toBe('[Applet: Calculator]')
})
it('names a staged applet the cap refused, also when one of the reply\'s own applets has its title', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  // The reply's last applet has the staged one's title: the cap refuses the staged one, which takes nothing of it.
  const own = ['Table', 'Map', 'Calculator'].map((title) => fence({ ...source, title })).join('\n')
  const adapter = piAdapter(() => own + '\nDone.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!({ ...source, js: 'window.staged = true' })
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  expect(main.applets.list(thread.id)).toHaveLength(3)
  expect(results.at(-1)).toMatch(/^\[Applet: Table \(appletId [^)]+\)\]\n\[Applet: Map \(appletId [^)]+\)\]\n\[Applet: Calculator \(appletId [^)]+\)\]\nDone\.\n\n\[Applet: Calculator\]$/)
})

it('cuts a fence an earlier row opened from what a stopped run hands back', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const adapter = piAdapter(() => 'unused')
  adapter.startTurn = async (_input, sink) => {
    const first = 'Draft:\n~~~mousse-applet\n'
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: first, contentIndex: 0 })
    sink.text({ phase: 'complete', content: first, contentIndex: 0 })
    sink.tool({ phase: 'start', callId: 'read', kind: 'mcp_tool_call', title: 'Read', summary: '', details: [] })
    sink.tool({ phase: 'complete', callId: 'read', kind: 'mcp_tool_result', title: 'Read', summary: '', details: [] })
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: '{"js":"STOP_CANARY"}', contentIndex: 0 })
    expect(main.orchestrator.abortActiveTurn(thread.id)).toBe(true)
    throw new DOMException('Aborted', 'AbortError')
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })
  expect(results.at(-1)).toBe('[Applet]')
})
it('keeps malformed applets as inert source without failing the completed turn', async () => {
  const { main, thread } = await fixture()
  const content = '```mousse-applet\nnot JSON\n```'
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
    input.onText(content)
    return content
  })
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  const parts = main.threads
    .loadThreadData(thread.id)
    .messages.flatMap((message) => message.presentationParts ?? [])
  expect(parts).toEqual([
    expect.objectContaining({ type: 'text', text: expect.stringContaining('not JSON') })
  ])
  expect(main.applets.list(thread.id)).toEqual([])
})
it('admits visible assistant references and denies user-crafted, hidden, cross-thread and cross-profile references', async () => {
  const { main, thread } = await fixture()
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
    input.onText(fence(source))
    return fence(source)
  })
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  const ref = reference(main, thread.id)
  const params = { threadId: thread.id, appletId: ref.appletId, revisionId: ref.revisionId }
  expect(await request(main, 'applets.state.save', { ...params, state: { slider: 25 } })).toEqual({
    saved: true
  })
  expect(await request(main, 'applets.state.get', params)).toEqual({ state: { slider: 25 } })
  expect(await request(main, 'applets.export', { ...params, format: 'html' })).toEqual({
    content: expect.stringContaining('sandbox="allow-scripts"')
  })
  expect(await request(main, 'applets.export', { ...params, format: 'source' })).toEqual({
    content: expect.stringContaining('Calculator')
  })
  await expect(request(main, 'applets.get', { ...params, profileId: 'other' })).rejects.toThrow(
    'profile binding changed'
  )
  expect(await request(main, 'applets.get', { ...params, profileId: main.profileId })).toEqual(
    expect.objectContaining({ appletId: ref.appletId })
  )
  await expect(request(main, 'applets.get', { ...params, unexpected: true })).rejects.toThrow(
    'Unexpected'
  )
  const other = main.threads.createThread('Other conversation')
  await expect(request(main, 'applets.get', { ...params, threadId: other.id })).rejects.toThrow(
    'not available'
  )
  const host = main.getInstallationHost()!
  const profile = host.manager.create({ displayName: 'Other profile' })
  const personal = await main.getProfileServices(profile.id)
  await expect(
    dispatchMethod({ mms: personal, globalSequence: () => 0 }, 'applets.get', params)
  ).rejects.toThrow()
  main.threads.mutateThreadData(thread.id, (data) => ({
    messages: data.messages.map((message) =>
      message.presentationParts
        ? { ...message, hidden: true }
        : { ...message, presentationParts: [{ type: 'applet', reference: ref }] }
    )
  }))
  for (const method of [
    'applets.get',
    'applets.state.get',
    'applets.state.save',
    'applets.export'
  ]) {
    await expect(
      request(main, method, {
        ...params,
        ...(method === 'applets.state.save' ? { state: {} } : {}),
        ...(method === 'applets.export' ? { format: 'html' } : {})
      })
    ).rejects.toThrow('not available')
  }
})
it('stages structured tool submissions through the same final publication path and enforces three per turn', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  // The turn's tool host stages applets, as the `publish_applet` tool does.
  const adapter = piAdapter(() => 'Here are three charts.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    const onPublishApplet = host.tools.onPublishApplet
    expect(onPublishApplet).toBeTypeOf('function')
    for (let i = 0; i < 3; i++)
      expect(onPublishApplet!({ ...source, title: `Chart ${i}` })).toEqual({
        queued: true,
        title: `Chart ${i}`
      })
    expect(() => onPublishApplet!(source)).toThrow('three')
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  expect(main.applets.list(thread.id)).toHaveLength(3)
  const completed = main.threads
    .loadThreadData(thread.id)
    .messages.find((message) => message.presentationParts)
  expect(completed?.content).toContain('```mousse-applet')
  expect(completed?.presentationParts?.filter((part) => part.type === 'applet')).toHaveLength(3)
})

it('hands a published applet to other models as one line, while the stored reply keeps its source', async () => {
  let transcriptOf: HandoffTranscriptSource | null = null
  const install = HandoffService.prototype.setTranscriptSource
  vi.spyOn(HandoffService.prototype, 'setTranscriptSource').mockImplementation(function (this: HandoffService, source) {
    transcriptOf = source
    return install.call(this, source)
  })
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const adapter = piAdapter(() => 'Here is the chart.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(source)
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  const ref = reference(main, thread.id)
  const line = `[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]`
  const reply = main.threads.loadThreadData(thread.id).messages.find((message) => message.presentationParts)!
  // Stored for recovery and bots' chats: the fence with its source.
  expect(reply.content).toContain(JSON.stringify(source.js))
  // A parent's result, a handoff to another model, and an agent's thread_read: the line, not the source.
  expect(results.at(-1)).toBe(`Here is the chart.\n\n${line}`)
  const handedOver = transcriptOf!(thread.id).find((item) => item.role === 'assistant')
  expect(handedOver?.text).toBe(`Here is the chart.\n\n${line}`)
  const page = await request(main, 'thread.messages', { threadId: thread.id, index: 0 }) as { messages: Array<{ role: string; content: string }> }
  const read = page.messages.find((message) => message.role === 'assistant')
  expect(read?.content).toContain(line)
  expect(read?.content).not.toContain('mousse-applet')
})

it('gives a parent the line, not the source, of an applet the model wrote as a fence', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  main.orchestrator.setHarness(testHarness({ adapters: [piAdapter(() => 'Before\n' + fence(source) + '\nAfter')], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })
  const ref = reference(main, thread.id)
  expect(results.at(-1)).toBe(`Before\n[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]\nAfter`)
})

it('publishes a tool-staged applet after a reply that left a code block open, and passes on its line', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const adapter = piAdapter(() => 'Here is the chart.\n```js\nconst open = true')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(source)
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  const ref = reference(main, thread.id)
  expect(results.at(-1)).toContain(`[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]`)
  expect(results.at(-1)).not.toContain(source.js)
})

it('publishes a tool-staged applet on a last row that follows a row left with an open code block', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const first = 'Trying it:\n~~~js\nconst open = true\n'
  const adapter = piAdapter(() => 'Chart updated.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    // The first row ends at a tool call with a block still open; the turn's last row is a reply of its own.
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: first, contentIndex: 0 })
    sink.text({ phase: 'complete', content: first, contentIndex: 0 })
    sink.tool({ phase: 'start', callId: 'edit', kind: 'mcp_tool_call', title: 'publish_applet', summary: '', details: [] })
    host.tools.onPublishApplet!(source)
    sink.tool({ phase: 'complete', callId: 'edit', kind: 'mcp_tool_result', title: 'publish_applet', summary: '', details: [] })
    // The last row streams only its own text; the turn's text is both rows, as a runtime reports it.
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: 'Chart updated.', contentIndex: 0 })
    const result = await startTurn(input, sink, ctl, host)
    return { ...result, text: first + result.text }
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  const ref = reference(main, thread.id)
  const replies = main.threads.loadThreadData(thread.id).messages.filter((message) => message.role === 'assistant' && !message.kind)
  expect(replies.length).toBeGreaterThan(1)
  expect(results.at(-1)).toContain(`[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]`)
  expect(results.at(-1)).not.toContain(source.js)
})

it('closes a code block left open inside a closed applet fence before staging an applet, and still cuts the fence whole', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const adapter = piAdapter(() => 'Draft: ```mousse-applet\n~~~json\n{"html":"SOURCE_CANARY"}\n```')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(source)
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  const ref = reference(main, thread.id)
  const reply = main.threads.loadThreadData(thread.id).messages.find((message) => message.presentationParts)!
  for (const text of [results.at(-1), modelFacingReplyText(reply)]) {
    expect(text).toContain(`[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]`)
    expect(text).not.toContain('SOURCE_CANARY')
  }
})

it('cuts a fence a row opened and the last row went on with, also after a tool-staged applet publishes', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const first = 'Draft:\n~~~mousse-applet\n'
  const last = '{"js":"ROW_CANARY"}\n~~~\nDone.'
  const adapter = piAdapter(() => last)
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: first, contentIndex: 0 })
    sink.text({ phase: 'complete', content: first, contentIndex: 0 })
    sink.tool({ phase: 'start', callId: 'publish', kind: 'mcp_tool_call', title: 'publish_applet', summary: '', details: [] })
    host.tools.onPublishApplet!(source)
    sink.tool({ phase: 'complete', callId: 'publish', kind: 'mcp_tool_result', title: 'publish_applet', summary: '', details: [] })
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: last, contentIndex: 0 })
    const result = await startTurn(input, sink, ctl, host)
    return { ...result, text: first + result.text }
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  const ref = reference(main, thread.id)
  expect(results.at(-1)).toContain(`[Applet: Calculator (appletId ${ref.appletId}, revision ${ref.revisionId})]`)
  expect(results.at(-1)).not.toContain('ROW_CANARY')
  expect(results.at(-1)).not.toContain(source.js)
})

it('names an applet on an earlier reply row, also after a row that left a code block open', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const rows = ['Trying it:\n```js\nconst open = true\n', 'Here it is:\n' + fence(source) + '\n']
  const adapter = piAdapter(() => 'Done.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    // Two rows, each ended by a tool call, then the last row: the turn's text is all three, as a runtime reports it.
    rows.forEach((row, at) => {
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: row, contentIndex: 0 })
      sink.text({ phase: 'complete', content: row, contentIndex: 0 })
      sink.tool({ phase: 'start', callId: `call-${at}`, kind: 'mcp_tool_call', title: 'Read', summary: '', details: [] })
      sink.tool({ phase: 'complete', callId: `call-${at}`, kind: 'mcp_tool_result', title: 'Read', summary: '', details: [] })
    })
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    sink.text({ phase: 'delta', content: 'Done.', contentIndex: 0 })
    const result = await startTurn(input, sink, ctl, host)
    return { ...result, text: rows.join('') + result.text }
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  expect(results.at(-1)).toContain('Here it is:\n[Applet: Calculator]')
  expect(results.at(-1)).not.toContain(source.js)
})

it('publishes a tool-staged applet whose source holds a separator then backticks, and never an applet the reply left unfinished', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  const draft = { ...source, title: 'Draft', js: 'window.draft = "DRAFT_SOURCE"' }
  const adapter = piAdapter(() => 'Almost:\n~~~mousse-applet\n' + JSON.stringify(draft))
  const startTurn = adapter.startTurn.bind(adapter)
  // A separator then backticks in a string: the staged fence still holds the whole source.
  const ls = String.fromCharCode(0x2028)
  const staged = { ...source, html: '<pre>' + ls + '```' + ls + '</pre>' }
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(staged)
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: thread.id })

  // The staged fence follows the unfinished one, which publication reads as text to the end, as on master: neither publishes.
  expect(main.applets.list(thread.id)).toEqual([])
  // Both are one cut, to the end: named as one applet, never by its source.
  expect(results.at(-1)).toBe('Almost:\n[Applet]')

  // Without the unfinished fence, the staged one publishes whole.
  const second = await fixture()
  second.main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const plain = piAdapter(() => 'Here:')
  const startPlain = plain.startTurn.bind(plain)
  plain.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(staged)
    return startPlain(input, sink, ctl, host)
  }
  second.main.orchestrator.setHarness(testHarness({ adapters: [plain], profileHome: second.main.getProfileHomeDir() }))
  await second.main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, { threadId: second.thread.id })
  expect(second.main.applets.list(second.thread.id).map((applet) => applet.title)).toEqual(['Calculator'])
})

it('names an applet that failed to publish to other models, without its source', async () => {
  let transcriptOf: HandoffTranscriptSource | null = null
  const install = HandoffService.prototype.setTranscriptSource
  vi.spyOn(HandoffService.prototype, 'setTranscriptSource').mockImplementation(function (this: HandoffService, source) {
    transcriptOf = source
    return install.call(this, source)
  })
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  const results: Array<string | undefined> = []
  const markTerminal = main.runEngine.markTerminal.bind(main.runEngine)
  vi.spyOn(main.runEngine, 'markTerminal').mockImplementation((...args: Parameters<typeof markTerminal>) => {
    results.push(args[3]?.resultText)
    return markTerminal(...args)
  })
  // A valid applet that revises one this thread never published: publication fails when the reply completes.
  const stale = { ...source, appletId: 'applet_missing', expectedRevision: 'rev_missing' }
  main.orchestrator.setHarness(testHarness({ adapters: [piAdapter(() => 'Before\n' + fence(stale) + '\nAfter')], profileHome: main.getProfileHomeDir() }))
  // A person's message never publishes: a fence pasted there reaches the next model as written.
  const asked = 'Fix this:\n' + fence(source)
  await main.orchestrator.send({ content: asked, mode: 'agent' }, false, { threadId: thread.id })

  expect(main.applets.list(thread.id)).toEqual([])
  const reply = main.threads.loadThreadData(thread.id).messages.find((message) => message.role === 'assistant')!
  expect(reply.content).toContain(JSON.stringify(source.js))
  expect(results.at(-1)).toBe('Before\n[Applet: Calculator]\nAfter')
  const handedOver = transcriptOf!(thread.id).find((item) => item.role === 'assistant')
  expect(handedOver?.text).toBe('Before\n[Applet: Calculator]\nAfter')
  expect(transcriptOf!(thread.id).find((item) => item.role === 'user')?.text).toBe(asked)
  const page = await request(main, 'thread.messages', { threadId: thread.id, index: 0 }) as { messages: Array<{ role: string; content: string }> }
  const read = page.messages.find((message) => message.role === 'assistant')
  expect(read?.content).toContain('[Applet: Calculator]')
  expect(read?.content).not.toContain(source.html)
})

it('keeps one reply row when a tool-published applet follows a reply that already closed', async () => {
  const { main, thread } = await fixture()
  main.settings.set({ provider: { llmProvider: 'openai', model: 'test' } })
  // As Claude Code streams it: the applet is published by tool, then the reply opens and closes
  // before the turn ends.
  const adapter = piAdapter(() => 'I published a chart.')
  const startTurn = adapter.startTurn.bind(adapter)
  adapter.startTurn = async (input, sink, ctl, host) => {
    host.tools.onPublishApplet!(source)
    sink.text({ phase: 'start', content: '', contentIndex: 0 })
    return startTurn(input, sink, ctl, host)
  }
  main.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: main.getProfileHomeDir() }))
  await main.orchestrator.send({ content: 'Illustrate costs', mode: 'agent' }, false, {
    threadId: thread.id
  })
  const replies = main.threads
    .loadThreadData(thread.id)
    .messages.filter((message) => message.role === 'assistant' && !message.kind && !message.hidden)
  expect(replies).toHaveLength(1)
  expect(replies[0].content).toContain('I published a chart.')
  expect(replies[0].presentationParts?.filter((part) => part.type === 'applet')).toHaveLength(1)
})

it('recovers a completed turn publication after its transcript reference is lost', async () => {
  const { main, thread } = await fixture()
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async input => {
    const content = fence(source)
    input.onText(content)
    return content
  })
  await main.orchestrator.send({content:'Show a calculator',mode:'agent'},false,{threadId:thread.id})
  const ref = reference(main, thread.id)
  main.threads.mutateThreadData(thread.id, current => ({messages: current.messages.map(message => ({...message,presentationParts:undefined}))}))
  const durable = main.threads.loadThreadData(thread.id)
  main.orchestrator.markThreadRestored(thread.id)
  main.orchestrator.bindThread(thread.id,durable.messages,durable.llmContext,durable.messageQueue)
  expect(reference(main,thread.id)).toEqual(ref)
})


it('exports the validated current appearance and rejects appearance injection', async () => {
  const {main,thread}=await fixture()
  vi.spyOn(main.claudeSubscription,'chat').mockImplementation(async input => {
    const content=fence(source);input.onText(content);return content
  })
  await main.orchestrator.send({content:'Illustrate costs',mode:'agent'},false,{threadId:thread.id})
  const ref=reference(main,thread.id)
  const appearance={theme:'light',colorScheme:'light',fontFamily:'system-ui',fontSize:'14px',reducedMotion:true,tokens:{'--accent':'#6251aa','--bg-primary':'#fafafa'}}
  const result=await request(main,'applets.export',{threadId:thread.id,appletId:ref.appletId,revisionId:ref.revisionId,format:'html',appearance}) as {content:string}
  expect(result.content).toContain('sandbox="allow-scripts"')
  expect(result.content).toContain('#6251aa')
  expect(result.content).toContain('mousse-appearance-change')
  await expect(request(main,'applets.export',{threadId:thread.id,appletId:ref.appletId,revisionId:ref.revisionId,format:'html',appearance:{...appearance,tokens:{'--accent':'red; background:url(https://example.test/)'}}})).rejects.toThrow('Invalid applet appearance token')
})
