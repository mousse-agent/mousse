import { afterEach, expect, it, vi } from 'vitest'
import { newId } from '../../../../src/shared/net'
import { BRIDGE_HUB_LOCAL_METHODS } from '../../../../src/shared/bridge'
import { executeBridgeHubLocal, validateBridgeHubLocal } from '../../../../src/mms/bridge/hub'
import { fixture, cleanup } from './fixture'
afterEach(cleanup)

const png = Buffer.from('not really a png').toString('base64')
const chunk = (target: string, upload: string, extra: Record<string, unknown> = {}) => ({
  target,
  upload,
  index: 0,
  total: 1,
  name: 'shot.png',
  mimeType: 'image/png',
  data: png,
  ...extra
})

it('accepts exact DTOs for the composer calls a remote thread view makes and nothing else', async () => {
  const f = await fixture(),
    ref = { nodeId: f.targetNode, entityId: 'thread-1' }
  for (const method of ['composerOptions', 'setModel', 'stageAttachment'])
    expect(BRIDGE_HUB_LOCAL_METHODS).toContain(`bridge.hub.${method}`)
  validateBridgeHubLocal('bridge.hub.composerOptions', { target: f.targetNode })
  validateBridgeHubLocal('bridge.hub.composerOptions', { target: f.targetNode, threadId: 'thread-1' })
  validateBridgeHubLocal('bridge.hub.setModel', { ref, model: { instanceId: 'codex', model: 'gpt' } })
  validateBridgeHubLocal('bridge.hub.stageAttachment', chunk(f.targetNode, 'upload-0001'))
  validateBridgeHubLocal('bridge.hub.send', {
    ref,
    content: 'hi',
    mode: 'plan',
    attachments: ['upload-0001']
  })
  validateBridgeHubLocal('bridge.hub.send', {
    ref,
    content: 'hi',
    mode: { type: 'skill', skillId: 'review' }
  })
  const refused: Array<[Parameters<typeof validateBridgeHubLocal>[0], unknown]> = [
    ['bridge.hub.composerOptions', { target: f.targetNode, extra: true }],
    ['bridge.hub.setModel', { ref, model: { model: 'gpt' } }],
    ['bridge.hub.stageAttachment', chunk(f.targetNode, 'short')],
    ['bridge.hub.stageAttachment', chunk(f.targetNode, 'upload-0001', { mimeType: 'text/html' })],
    ['bridge.hub.stageAttachment', chunk(f.targetNode, 'upload-0001', { index: 1 })],
    ['bridge.hub.send', { ref, content: 'hi', attachments: 'upload-0001' }],
    ['bridge.hub.send', { ref, content: 'hi', mode: 'root' }],
    ['bridge.hub.send', { ref, content: 'hi', images: [] }]
  ]
  for (const [method, value] of refused)
    expect(() => validateBridgeHubLocal(method, value), method).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
})

it('reads the target composer options and refuses a model the target does not offer', async () => {
  const f = await fixture()
  await f.connect()
  const created = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
    target: f.targetNode,
    name: 'Composer'
  })) as { thread: { id: string } }
  const options = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.composerOptions', {
    target: f.targetNode,
    threadId: created.thread.id
  })) as { providers: unknown[]; modes: unknown[]; commands: unknown[] }
  expect(Array.isArray(options.providers)).toBe(true)
  expect(options.modes.length).toBeGreaterThan(0)
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.setModel', {
      ref: { nodeId: f.targetNode, entityId: created.thread.id },
      model: { instanceId: 'not-an-instance', model: 'nothing' },
      options: { id: newId('rpc') }
    })
  ).toMatchObject({ ok: false })
})

it('stages an image and sends it with the message, which the target stores with the user message', async () => {
  const f = await fixture()
  ;(f.mms.orchestrator as unknown as { llm: unknown }).llm = {
    getSelectedModelContextLimit: () => ({ limit: 128000, modelName: 'fixture' }),
    getContextInputs: async () => ({
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'fixture'
    }),
    generateTitle: async () => 'Image turn',
    chat: async (
      _messages: unknown,
      _tools: unknown,
      _options: unknown,
      _thinking: unknown,
      onText: (event: unknown) => void
    ) => {
      onText({ phase: 'start', content: '', contentIndex: 0 })
      onText({ phase: 'delta', content: 'seen', contentIndex: 0 })
      return {
        text: 'seen',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        modelName: 'fixture',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        contextInputs: { signature: 'fixture' },
        toolEvents: [],
        nativeMessages: []
      }
    }
  }
  await f.connect()
  const created = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
      target: f.targetNode,
      name: 'Images'
    })) as { thread: { id: string } },
    ref = { nodeId: f.targetNode, entityId: created.thread.id }
  expect(
    await executeBridgeHubLocal(
      f.hub(),
      'bridge.hub.stageAttachment',
      chunk(f.targetNode, 'upload-image-0001')
    )
  ).toMatchObject({ ok: true, received: 1, total: 1 })
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.send', {
    ref,
    content: 'What is in this picture?',
    attachments: ['upload-image-0001'],
    options: { id: newId('rpc') }
  })
  await vi.waitFor(() => {
    const user = f.mms.orchestrator
      .getMessages(created.thread.id)
      .find((message) => message.role === 'user')
    expect(user?.content).toContain('What is in this picture?')
    expect(user?.images?.length).toBe(1)
  })
})
