import { CHAT_CAPABILITY } from '../../../shared/chats'
import { CHAT_NETWORK_METHODS, type ChatAsideCreateInput, type ChatAsideSendInput, type ChatBindInput, type ChatPublishInput, type ChatTaskDispatchInput, type ChatTaskGetInput, type ChatTaskListInput, type ChatWorkGetInput } from '../../../shared/chatsNetwork'
import { isId } from '../../../shared/net'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import type { ChatNetworkBindingService } from './ChatNetworkBindingService'
import { chatId } from '../ChatStore'
import { chatNetworkError } from './errors'
import { chatPrivateClientKey } from './ChatPrivateAsideService'

export function registerChatNetworkMethods(domains: DomainHandlerRegistry, forProfile: (id: string) => ChatNetworkBindingService | Promise<ChatNetworkBindingService>): void {
  for (const method of CHAT_NETWORK_METHODS) domains.register({ method, scope: 'profile', capability: CHAT_CAPABILITY,
    requiredCapabilities: [CHAT_CAPABILITY, 'net.v1'], validate(value) {
      const row = domainObject(value ?? {}, method === 'chats.publish' ? ['profileId', 'chatId', 'publicationId', 'name'] : method==='chats.bind'?['profileId','bindingId','space','channel']:method==='chats.work.get'||method==='chats.aside.get'?['profileId','chatId','stream','after','limit']:method==='chats.dispatch'?['profileId','chatId','taskId']:method==='chats.tasks'?['profileId','chatId','after','limit']:method==='chats.task.get'?['profileId','chatId','taskId','result']:method==='chats.aside.create'?['profileId','chatId','asideId','participants']:method==='chats.aside.send'?['profileId','chatId','stream','text','clientMessageId']:['profileId', 'chatId'])
      if (method==='chats.bind') {
        if (!isId('space',row.space) || !isId('stream',row.channel) || typeof row.bindingId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.bindingId) || ['__proto__','constructor','prototype'].includes(row.bindingId)) throw new DomainRpcError('invalid_params','Invalid joined channel binding')
      } else if (!chatId(row.chatId)) throw new DomainRpcError('invalid_params', 'Invalid Group identity')
      if((method==='chats.dispatch'||method==='chats.task.get')&&!isId('rpc',row.taskId))throw new DomainRpcError('invalid_params','Invalid Bridge task identity')
      if(method==='chats.task.get'&&row.result!==undefined&&typeof row.result!=='boolean')throw new DomainRpcError('invalid_params','Invalid task result query')
      if(method==='chats.tasks'&&(row.after!==undefined&&!isId('rpc',row.after)||row.limit!==undefined&&(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>128)))throw new DomainRpcError('invalid_params','Invalid task page')
      if(method==='chats.aside.create'&&(!chatPrivateClientKey(row.asideId)||!Array.isArray(row.participants)||!row.participants.length||row.participants.length>16||new Set(row.participants).size!==row.participants.length||row.participants.some(user=>!isId('user',user))))throw new DomainRpcError('invalid_params','Choose explicit private participants')
      if(method==='chats.aside.send'&&(!isId('stream',row.stream)||!chatPrivateClientKey(row.clientMessageId)||typeof row.text!=='string'||!row.text.trim()||Buffer.byteLength(row.text)>32*1024))throw new DomainRpcError('invalid_params','Invalid private message')
      if(method==='chats.work.get'||method==='chats.aside.get'){
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
        return method === 'chats.publish' ? service.publish(params as unknown as ChatPublishInput) : method==='chats.bind'?await service.bind(params as unknown as ChatBindInput):method==='chats.work.get'?await service.work(params as unknown as ChatWorkGetInput):method==='chats.dispatch'?await service.dispatch(params as unknown as ChatTaskDispatchInput):method==='chats.tasks'?service.listTasks(params as unknown as ChatTaskListInput):method==='chats.task.get'?await service.getTask(params as unknown as ChatTaskGetInput):method==='chats.aside.create'?await service.asideCreate(params as unknown as ChatAsideCreateInput):method==='chats.aside.send'?await service.asideSend(params as unknown as ChatAsideSendInput):method==='chats.aside.get'?await service.asideGet(params as unknown as ChatWorkGetInput):service.binding(params.chatId as string) ?? null
      } catch (error) { throw chatNetworkError(error) }
    } })
}
