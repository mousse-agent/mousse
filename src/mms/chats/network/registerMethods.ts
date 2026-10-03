import { CHAT_CAPABILITY } from '../../../shared/chats'
import { CHAT_NETWORK_METHODS, type ChatBindInput, type ChatPublishInput, type ChatTaskDispatchInput, type ChatWorkGetInput } from '../../../shared/chatsNetwork'
import { isId } from '../../../shared/net'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import type { ChatNetworkBindingService } from './ChatNetworkBindingService'
import { chatId } from '../ChatStore'
import { chatNetworkError } from './errors'

export function registerChatNetworkMethods(domains: DomainHandlerRegistry, forProfile: (id: string) => ChatNetworkBindingService | Promise<ChatNetworkBindingService>): void {
  for (const method of CHAT_NETWORK_METHODS) domains.register({ method, scope: 'profile', capability: CHAT_CAPABILITY,
    requiredCapabilities: [CHAT_CAPABILITY, 'net.v1'], validate(value) {
      const row = domainObject(value ?? {}, method === 'chats.publish' ? ['profileId', 'chatId', 'publicationId', 'name'] : method==='chats.bind'?['profileId','bindingId','space','channel']:method==='chats.work.get'?['profileId','chatId','stream','after','limit']:method==='chats.dispatch'?['profileId','chatId','taskId']:['profileId', 'chatId'])
      if (method==='chats.bind') {
        if (!isId('space',row.space) || !isId('stream',row.channel) || typeof row.bindingId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.bindingId) || ['__proto__','constructor','prototype'].includes(row.bindingId)) throw new DomainRpcError('invalid_params','Invalid joined channel binding')
      } else if (!chatId(row.chatId)) throw new DomainRpcError('invalid_params', 'Invalid Group identity')
      if(method==='chats.dispatch'&&!isId('rpc',row.taskId))throw new DomainRpcError('invalid_params','Invalid Bridge task identity')
      if(method==='chats.work.get'){
        if(!isId('stream',row.stream)||row.limit!==undefined&&(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>128))throw new DomainRpcError('invalid_params','Invalid work stream page')
        if(row.after!==undefined){const after=domainObject(row.after,['epoch','seq']);if(!Number.isSafeInteger(after.epoch)||Number(after.epoch)<1||!Number.isSafeInteger(after.seq)||Number(after.seq)<0)throw new DomainRpcError('invalid_params','Invalid work stream cursor')}
      }
      if (method === 'chats.publish' && (typeof row.publicationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.publicationId) || ['__proto__', 'constructor', 'prototype'].includes(row.publicationId))) throw new DomainRpcError('invalid_params', 'A publication retry key is required')
      if (row.name !== undefined && (typeof row.name !== 'string' || !row.name.trim() || row.name !== row.name.trim() || Array.from(row.name).length > 120 || /[\x00-\x1f\x7f]/.test(row.name))) throw new DomainRpcError('invalid_params', 'Invalid publication name')
      return row
    }, async handle(_context, params, binding) {
      try {
        const service = await forProfile(binding!.profileId)
        if (service.options.profileId !== binding!.profileId) throw new DomainRpcError('profile_mismatch', 'Publication belongs to another profile')
        return method === 'chats.publish' ? service.publish(params as unknown as ChatPublishInput) : method==='chats.bind'?await service.bind(params as unknown as ChatBindInput):method==='chats.work.get'?await service.work(params as unknown as ChatWorkGetInput):method==='chats.dispatch'?await service.dispatch(params as unknown as ChatTaskDispatchInput):service.binding(params.chatId as string) ?? null
      } catch (error) { throw chatNetworkError(error) }
    } })
}
