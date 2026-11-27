import { NetError, isId } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import type { BridgeRemoteMethod } from './capabilities'
import { USAGE_AGENT_LABELS, USAGE_HISTORY_RANGES, type UsageHistoryRange } from '../../../shared/usageHistory'
import {
  REMOTE_MAX_ATTACHMENTS,
  REMOTE_ATTACHMENT_CHUNK_CHARS,
  REMOTE_ATTACHMENT_MAX_CHARS,
  REMOTE_ATTACHMENT_MIME
} from '../../../shared/bridge'

export {
  REMOTE_MAX_ATTACHMENTS,
  REMOTE_ATTACHMENT_CHUNK_CHARS,
  REMOTE_ATTACHMENT_MAX_CHARS,
  REMOTE_ATTACHMENT_MIME
}

/** A Git commit id: SHA-1 or SHA-256 in hex. */
const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BUILT_IN_MODES = new Set(['agent', 'build'])
/** Most messages a phone may ask for in one page of older messages. */
export const PHONE_MESSAGES_PAGE_MAX = 500

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
    // No `refresh`: scanning another computer's disk is not something a remote caller may ask for.
    case 'storage.usage':
      keys([])
      break
    case 'usage.history':
      keys(['range'], ['timeZone', 'agent'])
      if (!USAGE_HISTORY_RANGES.includes(p.range as UsageHistoryRange)) throw new NetError('bad_request')
      text('timeZone', 64, true)
      if (Object.hasOwn(p, 'agent') && !Object.hasOwn(USAGE_AGENT_LABELS, p.agent as string)) throw new NetError('bad_request')
      break
    case 'projects.match': {
      keys(['roots'], ['remotes'])
      const roots = p.roots
      if (
        !Array.isArray(roots) ||
        roots.length < 1 ||
        roots.length > 256 ||
        new Set(roots).size !== roots.length ||
        roots.some((root) => typeof root !== 'string' || !COMMIT_HASH.test(root))
      )
        throw new NetError('bad_request')
      const remotes = p.remotes ?? []
      if (
        !Array.isArray(remotes) ||
        remotes.length > 64 ||
        remotes.some(
          (remote) =>
            typeof remote !== 'string' || !remote || remote.length > 512 || /[\x00-\x20\x7f]/.test(remote)
        )
      )
        throw new NetError('bad_request')
      break
    }
    case 'projects.open':
      keys(['path'])
      text('path', 4096)
      // The receiving machine decides whether the path is acceptable; a NUL never is.
      if ((p.path as string).includes('\0')) throw new NetError('bad_request')
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
    case 'thread.messages':
      keys(['threadId', 'before'], ['limit'])
      text('threadId')
      // A cursor is a message id, with which copy of it when the id repeats (`pageCursor`).
      text('before', 320)
      if (Object.hasOwn(p, 'limit')) integer('limit', 1, PHONE_MESSAGES_PAGE_MAX)
      break
    case 'reply.page':
      keys(['id', 'index'])
      text('id', 64)
      integer('index', 0, 4096)
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
      keys(['name'], ['projectId', 'worktreeEnabled', 'startedFromProjectId'])
      text('name', 512)
      text('projectId', 256, true)
      boolean('worktreeEnabled', true)
      text('startedFromProjectId', 256, true)
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
    case 'threads.archive':
      keys(['threadId', 'archived'])
      text('threadId')
      boolean('archived')
      break
    // Legacy name of `threads.archive`, from a phone that runs an older Mousse.
    case 'threads.settle':
      keys(['threadId', 'settled'])
      text('threadId')
      boolean('settled')
      break
    case 'threads.regenerateTitle':
      keys(['threadId'])
      text('threadId')
      break
    case 'threads.setExpiry':
      // An ISO time, or null to keep the thread; the handler checks the time is a minute to a year away.
      keys(['threadId', 'expiresAt'], ['stopsRun'])
      text('threadId')
      if (p.expiresAt !== null) text('expiresAt', 64)
      boolean('stopsRun', true)
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
    case 'queue.reorder': {
      keys(['threadId', 'orderedIds'])
      text('threadId')
      const ids = p.orderedIds
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 200 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)
      )
        throw new NetError('bad_request')
      break
    }
    case 'threads.setModel': {
      keys(['threadId', 'model'])
      text('threadId')
      const model = p.model
      if (!model || typeof model !== 'object' || Array.isArray(model))
        throw new NetError('bad_request')
      const m = model as Record<string, unknown>
      if (Object.keys(m).some((key) => !['instanceId', 'llmProvider', 'model', 'effort'].includes(key)))
        throw new NetError('bad_request')
      for (const [key, max, required] of [
        ['instanceId', 256, false],
        ['llmProvider', 256, false],
        ['model', 512, true],
        ['effort', 64, false]
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
    case 'orchestrator.pendingQuestions':
      keys(['threadId'])
      text('threadId')
      break
    case 'orchestrator.dismissQuestions':
      keys(['threadId', 'requestId'])
      text('threadId')
      text('requestId')
      break
    case 'orchestrator.answerQuestions': {
      keys(['threadId', 'requestId', 'answers'], ['attachments'])
      // Images staged with `attachments.stage`, by the id of the question each answers; as many as one message takes.
      if (Object.hasOwn(p, 'attachments')) {
        const byQuestion = p.attachments
        if (!byQuestion || typeof byQuestion !== 'object' || Array.isArray(byQuestion)) throw new NetError('bad_request')
        const groups = Object.entries(byQuestion)
        const ids = groups.flatMap(([, value]) => (Array.isArray(value) ? value : [null]))
        if (
          groups.length < 1 ||
          groups.length > 32 ||
          groups.some(([key, value]) => !key || key.length > 256 || !Array.isArray(value) || value.length < 1) ||
          ids.length > REMOTE_MAX_ATTACHMENTS ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== 'string' || !UPLOAD_ID.test(id))
        )
          throw new NetError('bad_request')
      }
      text('threadId')
      text('requestId')
      const answers = p.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers))
        throw new NetError('bad_request')
      const entries = Object.entries(answers)
      const answer = (value: unknown, max = 8 * 1024): boolean =>
        typeof value === 'string' && value.length <= max
      if (
        entries.length > 32 ||
        entries.some(
          ([key, value]) =>
            !key ||
            key.length > 256 ||
            !(
              answer(value) ||
              (Array.isArray(value) &&
                value.length <= 32 &&
                value.every((item) => answer(item, 1024)))
            )
        )
      )
        throw new NetError('bad_request')
      break
    }
    case 'orchestrator.abort':
      keys(['threadId', 'run'])
      text('threadId')
      if (!isId('rpc', p.run)) throw new NetError('bad_request')
      break
  }
}
