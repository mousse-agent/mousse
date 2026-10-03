import { CHAT_CAPABILITY, CHAT_METHODS, type ChatMethod, type ChatCreateInput, type ChatSendInput, type ChatAssignDeviceInput, type ChatCancelInput } from '../../shared/chats'
import { isAgentDefinitionId } from '../../shared/agents/schema'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { AgentChatService } from './AgentChatService'
import { chatId } from './ChatStore'
import { isId } from '../../shared/net'
import type { ChatNetworkBindingService } from './network/ChatNetworkBindingService'
import { chatNetworkError } from './network/errors'

type Params = Record<string, unknown>
const keys: Record<ChatMethod, string[]> = {
  'chats.snapshot': [], 'chats.create': ['kind', 'agentIds', 'name', 'projectId'], 'chats.get': ['chatId'],
  'chats.send': ['chatId', 'text', 'clientMessageId', 'mentions'], 'chats.cancel': ['chatId', 'runId'], 'chats.assignDevice': ['agentId', 'deviceId']
}
export function validateChatParams(method: ChatMethod, value: unknown): Params {
  const params = domainObject(value ?? {}, ['profileId', ...keys[method]])
  if (['chats.get', 'chats.send', 'chats.cancel'].includes(method) && !chatId(params.chatId)) throw new DomainRpcError('invalid_params', 'A valid chat identity is required')
  if (method === 'chats.cancel' && !chatId(params.runId)) throw new DomainRpcError('invalid_params', 'A valid run identity is required')
  if (method === 'chats.create') {
    if (params.kind !== 'direct' && params.kind !== 'group') throw new DomainRpcError('invalid_params', 'Choose a direct or group chat')
    if (!Array.isArray(params.agentIds) || params.agentIds.length < 1 || params.agentIds.length > 16
      || params.agentIds.some((id) => !isAgentDefinitionId(id)) || new Set(params.agentIds).size !== params.agentIds.length
      || (params.kind === 'direct' && params.agentIds.length !== 1)) throw new DomainRpcError('invalid_params', 'Choose distinct published agent identities')
    if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim() || params.name.trim().length > 120)) throw new DomainRpcError('invalid_params', 'Invalid chat name')
    if (params.kind === 'group' && params.name === undefined) throw new DomainRpcError('invalid_params', 'A group name is required')
    if (params.kind === 'direct' && params.projectId !== undefined) throw new DomainRpcError('invalid_params', 'Only groups can be associated with a project')
    if (params.projectId !== undefined && !chatId(params.projectId)) throw new DomainRpcError('invalid_params', 'Invalid project identity')
  }
  if (method === 'chats.send') {
    if (params.mentions !== undefined && (!Array.isArray(params.mentions) || params.mentions.length > 16 || new Set(params.mentions).size !== params.mentions.length || params.mentions.some(bot => !isId('bot', bot)))) throw new DomainRpcError('invalid_params', 'Invalid bot mentions')
    if (typeof params.text !== 'string' || !params.text.trim() || Buffer.byteLength(params.text, 'utf8') > 256 * 1024) throw new DomainRpcError('invalid_params', 'Invalid chat message')
    if (params.clientMessageId !== undefined && (typeof params.clientMessageId !== 'string' || (!/^[A-Za-z0-9_-]{1,128}$/.test(params.clientMessageId) || ['__proto__', 'constructor', 'prototype'].includes(params.clientMessageId)))) throw new DomainRpcError('invalid_params', 'Invalid message idempotency key')
  }
  if (method === 'chats.assignDevice' && (!isAgentDefinitionId(params.agentId) || typeof params.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.deviceId))) throw new DomainRpcError('invalid_params', 'Invalid agent or device identity')
  return params
}
/** Resolve only the daemon's admitted profile. Clients never choose a profile root or run host. */
export function registerChatMethods(domains: DomainHandlerRegistry, serviceForProfile: (profileId: string) => AgentChatService | Promise<AgentChatService>, networkForProfile?: (profileId: string) => ChatNetworkBindingService | Promise<ChatNetworkBindingService>): void {
  for (const method of CHAT_METHODS) domains.register({
    method, scope: 'profile', capability: CHAT_CAPABILITY, requiredCapabilities: [CHAT_CAPABILITY],
    validate: (params) => validateChatParams(method, params),
    async handle(context, params, binding) {
      const service = await serviceForProfile(binding!.profileId)
      if (service.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Chat service does not belong to the admitted profile')
      if (networkForProfile && ['chats.get', 'chats.send'].includes(method)) {
        try {
          const network = await networkForProfile(binding!.profileId)
          if (network.options.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Network Chats belong to another profile')
          if (network.blocksLocal(params.chatId as string)) {
            if (!context.connection?.capabilities.has('net.v1')) throw new DomainRpcError('capability_required', 'Published Groups require the network capability')
            return method === 'chats.get' ? network.get(params.chatId as string) : await network.send(params as unknown as import('../../shared/chatsNetwork').ChatNetworkSendInput)
          }
        } catch (error) { throw chatNetworkError(error) }
      }
      if (method === 'chats.send' && params.mentions !== undefined) throw new DomainRpcError('invalid_params', 'Local Groups use their local agent mention routing')
      switch (method) {
        case 'chats.snapshot': return service.snapshot()
        case 'chats.create': return service.create(params as unknown as ChatCreateInput)
        case 'chats.get': return service.get(params.chatId as string)
        case 'chats.send': return service.send(params as unknown as ChatSendInput)
        case 'chats.cancel': return service.cancel(params as unknown as ChatCancelInput)
        case 'chats.assignDevice': return service.assignDevice(params as unknown as ChatAssignDeviceInput)
      }
    }
  })
}
