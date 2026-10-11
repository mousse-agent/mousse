import { describe, expect, it } from 'vitest'
import { CHAT_CAPABILITY } from '../src/shared/chats'
import type { ChatResourceContext } from '../src/shared/chatResources'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import { registerChatResourceMethods } from '../src/mms/chats/resources/registerMethods'
import type { ChatResourceService } from '../src/mms/chats/resources/ChatResourceService'

function fixture() {
  const calls: ChatResourceContext[] = [], disconnected: string[] = []
  const service = { profileId: 'profile-a', snapshot(context: ChatResourceContext) { calls.push(context); return { viewerClientId: context.clientId } },
    disconnect(clientId: string) { disconnected.push(clientId) }, dispose() {} } as unknown as ChatResourceService
  const domains = new DomainHandlerRegistry()
  registerChatResourceMethods(domains, () => service)
  const context = { connection: { id: 'trusted-client', clientType: 'gui', binding: { profileId: 'profile-a', epoch: 1 }, capabilities: new Set([CHAT_CAPABILITY]) }, globalSequence: () => 0 } as HandlerContext
  return { domains, context, calls, disconnected }
}

describe('group resource RPC admission', () => {
  it('derives the viewer and person identity from the authenticated connection', async () => {
    const { domains, context, calls, disconnected } = fixture()
    expect(await domains.dispatch(context, 'chatResources.snapshot', { groupId: 'group-a' })).toEqual({ viewerClientId: 'trusted-client' })
    expect(calls).toEqual([{ profileId: 'profile-a', groupId: 'group-a', clientId: 'trusted-client', participantId: 'self' }])
    domains.notifyConnectionClosed('trusted-client')
    expect(disconnected).toEqual(['trusted-client'])
  })

  it('rejects spoofed participant/client claims, cross-profile requests, and CLI admission', async () => {
    const { domains, context, calls } = fixture()
    for (const field of ['participantId', 'clientId', 'threadId', 'workspaceRoot']) await expect(domains.dispatch(context, 'chatResources.snapshot', { groupId: 'group-a', [field]: 'forged' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(domains.dispatch(context, 'chatResources.snapshot', { groupId: 'group-a', profileId: 'other-profile' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(domains.dispatch({ ...context, connection: { ...context.connection!, clientType: 'cli' } }, 'chatResources.snapshot', { groupId: 'group-a' })).rejects.toMatchObject({ code: 'gui_required' })
    await expect(domains.dispatch({ ...context, connection: { ...context.connection!, capabilities: new Set() } }, 'chatResources.snapshot', { groupId: 'group-a' })).rejects.toMatchObject({ code: 'capability_required' })
    expect(calls).toHaveLength(0)
  })

  it('validates cursor/action/document bounds before invoking the resource service', async () => {
    const { domains, context } = fixture()
    const request = (method: string, params: Record<string, unknown>) => domains.dispatch(context, method, { groupId: 'group-a', ...params })
    await expect(request('chatResources.presence.update', { target: { kind: 'browser', id: 'session' }, cursor: { kind: 'file', line: 1, column: 1, revision: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(request('chatResources.presence.update', { target: { kind: 'browser', id: 'session' }, cursor: { kind: 'browser', tabId: 'tab', generation: 1, x: -1, y: 1 } })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(request('chatResources.presence.update', { target: { kind: 'terminal', id: 'pty', extra: true } })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(request('chatResources.browser.action', { sessionId: 'session', tabId: 'tab', generation: 1, observationId: 'observation', action: { type: 'upload', target: { kind: 'ref', ref: 'ref' }, artifactIds: [] } })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(request('chatResources.terminal.resize', { terminalId: 'pty', columns: 2000, rows: 20 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(request('chatResources.file.write', { path: 'source.txt', content: 'draft', expectedRevision: 'bad' })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
