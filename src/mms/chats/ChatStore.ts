import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalChatConversation as ChatConversation } from '../../shared/chats'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertOwnedPath } from '../profiles/pathSafety'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import { DomainRpcError } from '../protocol/domainRegistry'

export const CHAT_RECORD_MAX_BYTES = 8 * 1024 * 1024
export interface ChatRecord {
  version: 1
  profileId: string
  conversation: ChatConversation
  workspaceRoot: string
  /** Server-generated ids admitted with clientMessageId, never renderer-selected message identities. */
  acceptedMessages: Record<string, { text: string; messageId: string }>
  integrity?: string
}
export function chatId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** All chats live in the admitted profile root. No client filesystem paths are accepted. */
export class ChatStore {
  readonly root: string
  private readonly canonicalRoot: string
  constructor(private readonly profileRoot: string, private readonly profileId: string) {
    this.root = join(profileRoot, 'chats')
    assertOwnedPath(profileRoot, this.root)
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new Error('Chat storage cannot be a symlink')
    mkdirSync(this.root, { recursive: true })
    this.canonicalRoot = realpathSync(this.root)
  }
  assertRoot(): void {
    assertOwnedPath(this.profileRoot, this.root)
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.canonicalRoot) throw new Error('Chat storage changed')
  }
  private file(id: string): string {
    if (!chatId(id)) throw new DomainRpcError('invalid_params', 'Invalid chat identity')
    this.assertRoot()
    return join(this.root, `${id}.json`)
  }
  list(): ChatRecord[] {
    this.assertRoot()
    const entries = readdirSync(this.root)
    if (entries.length > 10_000) throw new Error('Chat inventory exceeds its bound')
    return entries.filter((name) => name.endsWith('.json') && chatId(name.slice(0, -5))).map((name) => this.read(name.slice(0, -5)))
  }
  read(id: string): ChatRecord {
    const path = this.file(id)
    if (!existsSync(path)) throw new DomainRpcError('chat_not_found', 'Chat was not found in this profile')
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > CHAT_RECORD_MAX_BYTES) throw new Error('Chat record is not a bounded regular file')
    const fd = openSync(path, 'r')
    let text: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > CHAT_RECORD_MAX_BYTES) throw new Error('Chat record changed')
      const bytes = Buffer.alloc(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0)
      if (count > stat.size) throw new Error('Chat record grew while reading')
      text = bytes.subarray(0, count).toString('utf8')
    } finally { closeSync(fd) }
    const record = JSON.parse(text) as ChatRecord
    this.validate(record, id)
    return record
  }
  write(record: ChatRecord): void {
    const { integrity: _previous, ...body } = record
    const stored = { ...body, integrity: sha256Hex(canonicalJson(body)) }
    this.validate(stored, record.conversation.id)
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > CHAT_RECORD_MAX_BYTES) throw new DomainRpcError('chat_full', 'Chat history exceeds its storage bound')
    const path = this.file(record.conversation.id)
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error('Chat record path changed')
    atomicWriteJsonSync(path, stored)
    record.integrity = stored.integrity
  }
  private validate(record: ChatRecord, id: string): void {
    const { integrity, ...body } = record
    const conversation = record.conversation
    const timestamps = conversation && [conversation.createdAt, conversation.updatedAt]
    if (record.version !== 1 || record.profileId !== this.profileId || !conversation || conversation.id !== id || !chatId(conversation.threadId)
      || !['direct', 'group'].includes(conversation.kind) || typeof conversation.name !== 'string' || !conversation.name.trim()
      || typeof record.workspaceRoot !== 'string' || !record.workspaceRoot
      || !timestamps?.every((at) => typeof at === 'string' && Number.isFinite(Date.parse(at)))
      || !Array.isArray(conversation.participants) || conversation.participants.length < 2 || conversation.participants.length > 17
      || !Array.isArray(conversation.messages) || conversation.messages.length > 2000
      || !record.acceptedMessages || typeof record.acceptedMessages !== 'object' || Array.isArray(record.acceptedMessages)
      || Object.keys(record.acceptedMessages).length > 2000
      || typeof integrity !== 'string' || integrity !== sha256Hex(canonicalJson(body))) throw new Error('Chat record ownership or integrity is invalid')
    const ids = new Set<string>()
    for (const participant of conversation.participants) {
      if (!participant || typeof participant.id !== 'string' || ids.has(participant.id) || typeof participant.name !== 'string'
        || !['person', 'agent'].includes(participant.kind)
        || (participant.kind === 'person' && participant.id !== 'self')
        || (participant.kind === 'agent' && (participant.definitionId !== participant.id || typeof participant.slug !== 'string'
          || !/^[a-f0-9]{64}$/.test(participant.definitionRevision ?? '') || typeof participant.deviceId !== 'string'))) throw new Error('Chat participant identity is invalid')
      ids.add(participant.id)
    }
    for (const message of conversation.messages) {
      if (!message || !chatId(message.id) || !ids.has(message.participantId) || typeof message.text !== 'string'
        || Buffer.byteLength(message.text, 'utf8') > 256 * 1024 || !Number.isFinite(Date.parse(message.createdAt))
        || !['completed', 'failed', 'cancelled', 'interrupted'].includes(message.status)) throw new Error('Chat message is invalid')
    }
    const run = conversation.run
    if (run && (!chatId(run.id) || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)
      || !Number.isFinite(Date.parse(run.startedAt)))) throw new Error('Chat run is invalid')
  }
}
