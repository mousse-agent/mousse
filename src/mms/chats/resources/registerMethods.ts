import { CHAT_RESOURCE_METHODS, type ChatResourceCursor, type ChatResourceMethod, type ChatResourceTarget, type ChatSharedBrowserAction } from '../../../shared/chatResources'
import { CHAT_CAPABILITY } from '../../../shared/chats'
import { validateBrowserAction } from '../../../shared/browser/validation'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import { ChatResourceError, ChatResourceService } from './ChatResourceService'

const fields: Record<ChatResourceMethod, readonly string[]> = {
  'chatResources.snapshot': [],
  'chatResources.presence.update': ['target', 'cursor'],
  'chatResources.presence.leave': [],
  'chatResources.browser.open': ['url'],
  'chatResources.browser.observe': ['sessionId', 'tabId'],
  'chatResources.browser.control': ['sessionId', 'acquire'],
  'chatResources.browser.action': ['sessionId', 'tabId', 'generation', 'observationId', 'action'],
  'chatResources.browser.close': ['sessionId'],
  'chatResources.terminal.create': ['columns', 'rows'],
  'chatResources.terminal.output': ['terminalId', 'afterSequence'],
  'chatResources.terminal.control': ['terminalId', 'acquire'],
  'chatResources.terminal.write': ['terminalId', 'data'],
  'chatResources.terminal.resize': ['terminalId', 'columns', 'rows'],
  'chatResources.terminal.close': ['terminalId'],
  'chatResources.file.read': ['path'],
  'chatResources.file.write': ['path', 'content', 'expectedRevision']
}

function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new DomainRpcError('invalid_params', 'Invalid ' + name)
  return value
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new DomainRpcError('invalid_params', 'Invalid ' + name)
  return value
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new DomainRpcError('invalid_params', 'Invalid ' + name)
  return value
}
function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DomainRpcError('invalid_params', 'Invalid ' + name)
  return value
}

function validate(method: ChatResourceMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', 'groupId', ...fields[method]])
  string(p.groupId, 'groupId')
  for (const key of ['sessionId', 'tabId', 'observationId', 'terminalId']) if (p[key] !== undefined) string(p[key], key)
  for (const key of ['generation', 'afterSequence']) if (p[key] !== undefined) integer(p[key], key, key === 'generation' ? 1 : 0)
  for (const key of ['columns', 'rows']) if (p[key] !== undefined) integer(p[key], key, 2, key === 'columns' ? 500 : 300)
  if (method.includes('.browser.') && !method.endsWith('.open')) string(p.sessionId, 'sessionId')
  if (method.includes('.terminal.') && !method.endsWith('.create')) string(p.terminalId, 'terminalId')
  if (method.endsWith('.control')) boolean(p.acquire, 'acquire')
  if (method === 'chatResources.terminal.resize') { integer(p.columns, 'columns', 2, 500); integer(p.rows, 'rows', 2, 300) }
  if (method === 'chatResources.terminal.write' && (typeof p.data !== 'string' || p.data.length > 256_000)) throw new DomainRpcError('invalid_params', 'Invalid terminal input')
  if (method === 'chatResources.browser.open') string(p.url, 'url', 4096)
  if (method.includes('.file.')) string(p.path, 'path', 4096)
  if (method === 'chatResources.file.write') {
    if (typeof p.content !== 'string' || Buffer.byteLength(p.content, 'utf8') > 512 * 1024 || p.content.includes('\0')) throw new DomainRpcError('invalid_params', 'Invalid file content')
    if (typeof p.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedRevision)) throw new DomainRpcError('invalid_params', 'Invalid file revision')
  }
  if (method === 'chatResources.browser.action') {
    string(p.tabId, 'tabId'); string(p.observationId, 'observationId'); integer(p.generation, 'generation', 1)
    try {
      const action = validateBrowserAction(p.action)
      if (action.type === 'upload' || action.type === 'dialog') throw new Error('Unsupported shared browser action')
      p.action = action
    } catch (error) { throw new DomainRpcError('invalid_params', error instanceof Error ? error.message : 'Invalid browser action') }
  }
  if (method === 'chatResources.presence.update') {
    const target = domainObject(p.target, ['kind', 'id'])
    if (!['browser', 'terminal', 'file'].includes(target.kind as string)) throw new DomainRpcError('invalid_params', 'Invalid presence resource')
    string(target.id, 'id', target.kind === 'file' ? 4096 : 256)
    if (p.cursor !== undefined) {
      const kind = (p.cursor as { kind?: unknown })?.kind
      if (kind !== target.kind) throw new DomainRpcError('invalid_params', 'Cursor does not match its resource')
      const cursor = domainObject(p.cursor, kind === 'browser' ? ['kind', 'tabId', 'generation', 'x', 'y'] : kind === 'terminal' ? ['kind', 'row', 'column'] : ['kind', 'revision', 'line', 'column', 'endLine', 'endColumn'])
      if (kind === 'browser') { string(cursor.tabId, 'tabId'); integer(cursor.generation, 'generation', 1); finite(cursor.x, 'x'); finite(cursor.y, 'y') }
      else if (kind === 'terminal') { integer(cursor.row, 'row', 0, 300); integer(cursor.column, 'column', 0, 500) }
      else {
        if (typeof cursor.revision !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.revision)) throw new DomainRpcError('invalid_params', 'Invalid cursor file revision')
        integer(cursor.line, 'line', 1); integer(cursor.column, 'column', 1)
        for (const key of ['endLine', 'endColumn']) if (cursor[key] !== undefined) integer(cursor[key], key, 1)
      }
    }
  }
  return p
}

/** GUI participant and client identities come exclusively from daemon admission. */
export function registerChatResourceMethods(domains: DomainHandlerRegistry, serviceForProfile: (profileId: string) => ChatResourceService | Promise<ChatResourceService>): { dispose(): void } {
  const known = new Map<string, ChatResourceService>()
  const closed = domains.onConnectionClosed((clientId) => { for (const service of known.values()) service.disconnect(clientId) })
  const disposed = domains.onProfileDisposed((profileId) => { void known.get(profileId)?.dispose().catch(() => undefined); known.delete(profileId) })
  for (const method of CHAT_RESOURCE_METHODS) domains.register({
    method, scope: 'profile', capability: CHAT_CAPABILITY, requiredCapabilities: [CHAT_CAPABILITY], validate: (value) => validate(method, value),
    async handle(handler, p, binding) {
      if (!binding || !handler.connection?.id || handler.connection.clientType !== 'gui') throw new DomainRpcError('gui_required', 'Shared group resources require an authenticated GUI client')
      const service = await serviceForProfile(binding.profileId)
      if (service.profileId !== binding.profileId) throw new DomainRpcError('profile_mismatch', 'Resource service belongs to another profile')
      known.set(binding.profileId, service)
      const context = { profileId: binding.profileId, groupId: p.groupId as string, clientId: handler.connection.id, participantId: 'self' }
      try {
        switch (method) {
          case 'chatResources.snapshot': return service.snapshot(context)
          case 'chatResources.presence.update': return service.presenceUpdate(context, p.target as ChatResourceTarget, p.cursor as ChatResourceCursor | undefined)
          case 'chatResources.presence.leave': await service.presenceLeave(context); return { ok: true }
          case 'chatResources.browser.open': return service.browserOpen(context, p.url as string)
          case 'chatResources.browser.observe': return service.browserObserve(context, p.sessionId as string, p.tabId as string | undefined)
          case 'chatResources.browser.control': return service.browserControl(context, p.sessionId as string, p.acquire as boolean)
          case 'chatResources.browser.action': return service.browserAction(context, p as unknown as ChatSharedBrowserAction)
          case 'chatResources.browser.close': await service.browserClose(context, p.sessionId as string); return { ok: true }
          case 'chatResources.terminal.create': return service.terminalCreate(context, p.columns as number | undefined, p.rows as number | undefined)
          case 'chatResources.terminal.output': return service.terminalOutput(context, p.terminalId as string, p.afterSequence as number | undefined)
          case 'chatResources.terminal.control': return service.terminalControl(context, p.terminalId as string, p.acquire as boolean)
          case 'chatResources.terminal.write': await service.terminalWrite(context, p.terminalId as string, p.data as string); return { ok: true }
          case 'chatResources.terminal.resize': await service.terminalResize(context, p.terminalId as string, p.columns as number, p.rows as number); return { ok: true }
          case 'chatResources.terminal.close': await service.terminalClose(context, p.terminalId as string); return { ok: true }
          case 'chatResources.file.read': return service.fileRead(context, p.path as string)
          case 'chatResources.file.write': return service.fileWrite(context, p.path as string, p.content as string, p.expectedRevision as string)
        }
      } catch (error) { if (error instanceof ChatResourceError) throw new DomainRpcError(error.code, error.message); throw error }
    }
  })
  return { dispose() { closed(); disposed(); known.clear() } }
}
