import { CHAT_CAPABILITY } from '../../../shared/chats'
import { CHAT_NETWORK_METHODS, type ChatPublishInput } from '../../../shared/chatsNetwork'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import type { ChatNetworkBindingService } from './ChatNetworkBindingService'
import { chatId } from '../ChatStore'
import { chatNetworkError } from './errors'

export function registerChatNetworkMethods(domains: DomainHandlerRegistry, forProfile: (id: string) => ChatNetworkBindingService | Promise<ChatNetworkBindingService>): void {
  for (const method of CHAT_NETWORK_METHODS) domains.register({ method, scope: 'profile', capability: CHAT_CAPABILITY,
    requiredCapabilities: [CHAT_CAPABILITY, 'net.v1'], validate(value) {
      const row = domainObject(value ?? {}, method === 'chats.publish' ? ['profileId', 'chatId', 'publicationId', 'name'] : ['profileId', 'chatId'])
      if (!chatId(row.chatId)) throw new DomainRpcError('invalid_params', 'Invalid Group identity')
      if (method === 'chats.publish' && (typeof row.publicationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.publicationId) || ['__proto__', 'constructor', 'prototype'].includes(row.publicationId))) throw new DomainRpcError('invalid_params', 'A publication retry key is required')
      if (row.name !== undefined && (typeof row.name !== 'string' || !row.name.trim() || row.name !== row.name.trim() || Array.from(row.name).length > 120 || /[\x00-\x1f\x7f]/.test(row.name))) throw new DomainRpcError('invalid_params', 'Invalid publication name')
      return row
    }, async handle(_context, params, binding) {
      try {
        const service = await forProfile(binding!.profileId)
        if (service.options.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Publication belongs to another profile')
        return method === 'chats.publish' ? service.publish(params as unknown as ChatPublishInput) : service.binding(params.chatId as string) ?? null
      } catch (error) { throw chatNetworkError(error) }
    } })
}
