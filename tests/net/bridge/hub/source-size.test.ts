import { afterEach, expect, it, vi } from 'vitest'
import { fixture, cleanup } from './fixture'
afterEach(cleanup)
it('delivers the previously failing5MiB actual MMS source snapshot over TLS after bounded document parsing', async () => {
  const f = await fixture(),
    thread = f.mms.threads.createThread('Large parser reproduction'),
    message = {
      id: 'large',
      role: 'assistant' as const,
      content: 'x'.repeat(5 * 1024 * 1024),
      timestamp: new Date().toISOString()
    }
  f.mms.threads.mutateThreadData(thread.id, () => ({ messages: [message] }))
  f.mms.orchestrator.getOrCreateSession(thread.id).messages = [message]
  const adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const updates: unknown[] = [],
    errors: string[] = []
  await f.hub().attach(
    { nodeId: f.targetNode, entityId: thread.id },
    (value) => updates.push(value),
    (code) => errors.push(code)
  )
  await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 5000 })
  expect(updates[0]).toMatchObject({
    kind: 'snapshot',
    value: { messages: [{ content: message.content }] }
  })
  expect(errors).toEqual([])
})
