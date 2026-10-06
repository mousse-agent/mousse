import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { AppletReference } from '../src/shared/applets'

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
  const llm = (
    main.orchestrator as unknown as {
      llm: {
        getSelectedModelContextLimit: () => unknown
        getContextInputs: () => Promise<unknown>
        chat: (...args: unknown[]) => Promise<unknown>
      }
    }
  ).llm
  const contextInputs = {
    systemPromptText: '',
    mcpToolsText: '',
    otherToolsText: '',
    signature: 'applets-test'
  }
  vi.spyOn(llm, 'getSelectedModelContextLimit').mockReturnValue({ limit: 100_000 })
  vi.spyOn(llm, 'getContextInputs').mockResolvedValue(contextInputs)
  vi.spyOn(llm, 'chat').mockImplementation(async (...args) => {
    const options = args[2] as { onPublishApplet: (value: unknown) => unknown }
    expect(options.onPublishApplet).toBeTypeOf('function')
    for (let i = 0; i < 3; i++)
      expect(options.onPublishApplet({ ...source, title: `Chart ${i}` })).toEqual({
        queued: true,
        title: `Chart ${i}`
      })
    expect(() => options.onPublishApplet(source)).toThrow('three')
    return {
      text: 'Here are three charts.',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      modelName: 'test',
      totalResponseTimeMs: 1,
      totalTokensUsed: 2,
      tokensPerSecond: 1,
      contextInputs,
      toolEvents: [],
      nativeMessages: []
    }
  })
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

it('publishes native plan-mode applets once while retaining the plan message', async () => {
  const { main, thread } = await fixture()
  const content = 'Plan explanation\n' + fence(source)
  vi.spyOn(main.claudeSubscription, 'chat').mockImplementation(async (input) => {
    expect(input.mode).toBe('plan')
    input.onText(content)
    return content
  })
  await main.orchestrator.send({ content: 'Illustrate a plan', mode: 'plan' }, false, {
    threadId: thread.id
  })
  const messages = main.threads.loadThreadData(thread.id).messages
  const published = messages.filter((message) =>
    message.presentationParts?.some((part) => part.type === 'applet')
  )
  expect(published).toHaveLength(1)
  expect(published[0].kind).toBe('plan_card')
  expect(published[0].content).toContain('Plan explanation')
  expect(main.applets.list(thread.id)).toHaveLength(1)
  const ref = reference(main, thread.id)
  expect(
    await request(main, 'applets.get', {
      profileId: main.profileId,
      threadId: thread.id,
      appletId: ref.appletId,
      revisionId: ref.revisionId
    })
  ).toEqual(expect.objectContaining({ title: source.title }))
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
