/**
 * A person who writes in an archived thread gets it back: the thread leaves Archived and the message runs. That holds for
 * a message or a steer from a Mousse window, their phone or the CLI. A thread whose expiry passed stays archived and
 * refuses it.
 * Agents' and bots' messages to an archived thread stay refused (`thread_archived`, tests/run/threadActionsTools.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'

let home: string
let mms: MousseMainService
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'mousse-archived-send-'))
  process.env.MOUSSE_HOME = home
  mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await mms.start()
  const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length)!
  const model = mms.providerAuth.models.getModels(provider.id)[0]
  vi.spyOn(mms.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(mms.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'synthetic' } as never)
  const settings = mms.settings.get()
  mms.settings.set({ provider: { llmProvider: provider.id, model: model.id }, integrations: {
    ...settings.integrations, tools: { enabled: false, enabledTools: [] },
    skills: { ...settings.integrations.skills, enabled: false }, mcp: { ...settings.integrations.mcp, enabled: false }
  } })
  mms.orchestrator.setHarness(testHarness({ adapters: [piAdapter(() => 'reply')], profileHome: mms.getProfileHomeDir() }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await mms.stop()
  rmSync(home, { recursive: true, force: true })
  delete process.env.MOUSSE_HOME
})

const from = (clientType: 'gui' | 'cli') => (method: string, params: Record<string, unknown>) =>
  dispatchMethod({ mms, globalSequence: () => 0, connection: { id: `${clientType}-1`, clientType, capabilities: new Set() } } as unknown as HandlerContext, method, params)
const window = from('gui')
const cli = from('cli')

/** A started thread the person archived with the app's own Archive. */
async function archivedThread(options: { expiresAt?: string } = {}): Promise<string> {
  const thread = mms.threads.createThread('Old work', undefined, undefined, { started: true, ...options })
  await window('threads.settle', { threadId: thread.id, settled: true })
  expect(mms.threads.getThread(thread.id)?.settledAt).toBeTruthy()
  return thread.id
}

const replies = (threadId: string) => mms.orchestrator.getMessages(threadId).filter((message) => message.role === 'assistant').map((message) => message.content)

it('unarchives a thread when the person sends a message from a window, and the message runs', async () => {
  const threadId = await archivedThread()
  await window('orchestrator.send', { threadId, content: 'one more thing', mode: 'agent' })
  expect(mms.threads.getThread(threadId)?.settledAt).toBeUndefined()
  expect(replies(threadId)).toContain('reply')
}, 60_000)

it('unarchives a thread when the person sends a message from their phone, and the message runs', async () => {
  const threadId = await archivedThread()
  const result = await mms.orchestrator.runRemoteTurn(threadId, 'one more thing', mms.threads)
  expect(result.error).toBeUndefined()
  expect(mms.threads.getThread(threadId)?.settledAt).toBeUndefined()
  expect(replies(threadId)).toContain('reply')
}, 60_000)

it('unarchives a thread when the person sends a message from the CLI, and the message runs', async () => {
  const threadId = await archivedThread()
  await cli('orchestrator.send', { threadId, content: 'one more thing', mode: 'agent' })
  expect(mms.threads.getThread(threadId)?.settledAt).toBeUndefined()
  expect(replies(threadId)).toContain('reply')
}, 60_000)

it.each([['a window', window], ['the CLI', cli]] as const)('unarchives a thread when the person steers it from %s', async (_label, caller) => {
  const threadId = await archivedThread()
  await caller('orchestrator.steer', { threadId, text: 'also this' })
  expect(mms.threads.getThread(threadId)?.settledAt).toBeUndefined()
}, 60_000)

it('keeps an expired thread archived and refuses the message', async () => {
  const threadId = await archivedThread({ expiresAt: new Date(Date.now() - 1000).toISOString() })
  await expect(window('orchestrator.send', { threadId, content: 'one more thing', mode: 'agent' })).rejects.toMatchObject({ code: 'thread_expired' })
  expect((await mms.orchestrator.runRemoteTurn(threadId, 'one more thing', mms.threads)).error).toMatch(/expired/)
  await window('orchestrator.steer', { threadId, text: 'also this' }).catch(() => undefined)
  expect(mms.threads.getThread(threadId)?.settledAt).toBeTruthy()
  expect(replies(threadId)).toEqual([])
}, 60_000)
