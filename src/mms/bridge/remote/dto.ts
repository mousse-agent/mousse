import { NetError, isId } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import type { BridgeRemoteMethod } from './capabilities'

/** Images per message, as for local sends (MMS_PROTOCOL_MAX_IMAGES). */
export const REMOTE_MAX_ATTACHMENTS = 16
/** Base64 characters in one staged chunk; keeps each request well inside one 64 KiB frame. */
export const REMOTE_ATTACHMENT_CHUNK_CHARS = 48 * 1024
/** Base64 characters in one staged image (MMS_PROTOCOL_MAX_IMAGE_BASE64_CHARS). */
export const REMOTE_ATTACHMENT_MAX_CHARS = 3 * 1024 * 1024
export const REMOTE_ATTACHMENT_MIME = /^image\/(png|jpeg|gif|webp|bmp)$/
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BUILT_IN_MODES = new Set(['agent', 'plan', 'build'])

export function validateRemoteParams(
  method: BridgeRemoteMethod,
  value: unknown
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(canonicalJson(value)) > 128 * 1024
  )
    throw new NetError('bad_request')
  const p = value as Record<string, unknown>
  const keys = (required: string[], optional: string[] = []): void => {
    if (
      required.some((key) => !Object.hasOwn(p, key)) ||
      Object.keys(p).some((key) => ![...required, ...optional].includes(key))
    )
      throw new NetError('bad_request')
  }
  const text = (key: string, max = 256, optional = false): void => {
    if (optional && !Object.hasOwn(p, key)) return
    if (typeof p[key] !== 'string' || !(p[key] as string).trim() || (p[key] as string).length > max)
      throw new NetError('bad_request')
  }
  const boolean = (key: string, optional = false): void => {
    if (optional && !Object.hasOwn(p, key)) return
    if (typeof p[key] !== 'boolean') throw new NetError('bad_request')
  }
  const integer = (key: string, min: number, max: number): void => {
    const value = p[key]
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
      throw new NetError('bad_request')
  }
  /** A built-in mode, or a skill mode `{ type: 'skill', skillId }`. */
  const mode = (): void => {
    if (!Object.hasOwn(p, 'mode')) return
    const value = p.mode
    if (typeof value === 'string' && BUILT_IN_MODES.has(value)) return
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'skillId,type' &&
      (value as Record<string, unknown>).type === 'skill' &&
      typeof (value as Record<string, unknown>).skillId === 'string' &&
      (value as Record<string, string>).skillId.trim() !== '' &&
      (value as Record<string, string>).skillId.length <= 256
    )
      return
    throw new NetError('bad_request')
  }
  /** Ids of images this caller staged with `attachments.stage`. */
  const attachments = (): void => {
    if (!Object.hasOwn(p, 'attachments')) return
    const value = p.attachments
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > REMOTE_MAX_ATTACHMENTS ||
      new Set(value).size !== value.length ||
      value.some((id) => typeof id !== 'string' || !UPLOAD_ID.test(id))
    )
      throw new NetError('bad_request')
  }
  switch (method) {
    case 'projects.list':
      keys([])
      break
    case 'threads.list':
      keys([], ['projectId'])
      text('projectId', 256, true)
      break
    case 'threads.get':
    case 'thread.snapshot':
    case 'orchestrator.isTurnActive':
    case 'orchestrator.contextUsage':
      keys(['threadId'])
      text('threadId')
      break
    case 'threads.search':
      keys(['query'], ['limit'])
      text('query', 512)
      if (
        p.limit !== undefined &&
        (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 200)
      )
        throw new NetError('bad_request')
      break
    case 'threads.create':
      keys(['name'], ['projectId', 'worktreeEnabled'])
      text('name', 512)
      text('projectId', 256, true)
      boolean('worktreeEnabled', true)
      break
    case 'threads.rename':
      keys(['threadId', 'name'])
      text('threadId')
      text('name', 512)
      break
    case 'threads.pin':
      keys(['threadId', 'pinned'])
      text('threadId')
      boolean('pinned')
      break
    case 'threads.settle':
      keys(['threadId', 'settled'])
      text('threadId')
      boolean('settled')
      break
    case 'orchestrator.send':
    case 'queue.enqueue':
      keys(['threadId', 'content'], ['mode', 'attachments'])
      text('threadId')
      text('content', 64 * 1024)
      mode()
      attachments()
      break
    case 'composer.options':
      keys([], ['threadId'])
      text('threadId', 256, true)
      break
    case 'queue.list':
      keys(['threadId'])
      text('threadId')
      break
    case 'queue.remove':
    case 'queue.promoteToSteer':
      keys(['threadId', 'itemId'])
      text('threadId')
      text('itemId')
      break
    case 'threads.setModel': {
      keys(['threadId', 'model'])
      text('threadId')
      const model = p.model
      if (!model || typeof model !== 'object' || Array.isArray(model))
        throw new NetError('bad_request')
      const m = model as Record<string, unknown>
      if (Object.keys(m).some((key) => !['instanceId', 'llmProvider', 'model'].includes(key)))
        throw new NetError('bad_request')
      for (const [key, max, required] of [
        ['instanceId', 256, false],
        ['llmProvider', 256, false],
        ['model', 512, true]
      ] as const) {
        if (!required && m[key] === undefined) continue
        if (
          typeof m[key] !== 'string' ||
          !(m[key] as string).trim() ||
          (m[key] as string).length > max
        )
          throw new NetError('bad_request')
      }
      if (m.instanceId === undefined && m.llmProvider === undefined)
        throw new NetError('bad_request')
      break
    }
    case 'attachments.stage':
      keys(['upload', 'index', 'total', 'name', 'mimeType', 'data'])
      if (typeof p.upload !== 'string' || !UPLOAD_ID.test(p.upload))
        throw new NetError('bad_request')
      integer('total', 1, Math.ceil(REMOTE_ATTACHMENT_MAX_CHARS / REMOTE_ATTACHMENT_CHUNK_CHARS))
      integer('index', 0, (p.total as number) - 1)
      text('name', 512)
      if (typeof p.mimeType !== 'string' || !REMOTE_ATTACHMENT_MIME.test(p.mimeType))
        throw new NetError('bad_request')
      if (
        typeof p.data !== 'string' ||
        !p.data ||
        p.data.length > REMOTE_ATTACHMENT_CHUNK_CHARS ||
        !BASE64.test(p.data)
      )
        throw new NetError('bad_request')
      break
    case 'orchestrator.steer':
      keys(['threadId', 'run', 'text'])
      text('threadId')
      text('text', 64 * 1024)
      if (!isId('rpc', p.run)) throw new NetError('bad_request')
      break
    case 'orchestrator.abort':
      keys(['threadId', 'run'])
      text('threadId')
      if (!isId('rpc', p.run)) throw new NetError('bad_request')
      break
  }
}
