/**
 * Runtime validators for protocol envelopes and method params.
 * Untrusted frame fields must not drive file/tool access before validation.
 */

import type { ChatImageAttachment, ChatMode } from '../../shared/types'
import type { ProviderLoginResponse } from '../../shared/providerAuth'
import {
  MMS_PROTOCOL_MAX_ID_LENGTH,
  MMS_PROTOCOL_MAX_IMAGE_DATA_CHARS,
  MMS_PROTOCOL_MAX_IMAGES,
  MMS_PROTOCOL_MAX_METHOD_LENGTH,
  MMS_PROTOCOL_MAX_ORDERED_IDS,
  MMS_PROTOCOL_MAX_OWNER_TOKEN_LENGTH,
  MMS_PROTOCOL_MAX_TEXT_LENGTH,
  MMS_PROTOCOL_VERSION,
  PROTOCOL_METHODS,
  type ProtocolClientType,
  type ProtocolEnvelope,
  type ProtocolEvent,
  type ProtocolHello,
  type ProtocolHelloOk,
  type ProtocolMethod,
  type ProtocolRequest,
  type ProtocolResponse
} from './types'

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isFiniteNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function isBoundedString(
  v: unknown,
  maxLen: number,
  opts?: { nonEmpty?: boolean }
): v is string {
  if (typeof v !== 'string') return false
  if (opts?.nonEmpty && !v.trim()) return false
  return v.length <= maxLen
}

function isClientType(v: unknown): v is ProtocolClientType {
  return v === 'cli' || v === 'gui' || v === 'test' || v === 'unknown'
}

/** Parse and shape-check an untrusted envelope. Returns null if invalid. */
export function parseEnvelope(raw: unknown): ProtocolEnvelope | null {
  if (!isObject(raw) || typeof raw.kind !== 'string') return null
  switch (raw.kind) {
    case 'hello': {
      if (
        typeof raw.protocolVersion !== 'number' ||
        !Number.isFinite(raw.protocolVersion) ||
        !isBoundedString(raw.ownerToken, MMS_PROTOCOL_MAX_OWNER_TOKEN_LENGTH, {
          nonEmpty: true
        }) ||
        !isClientType(raw.clientType)
      ) {
        return null
      }
      if (raw.clientBuild !== undefined && typeof raw.clientBuild !== 'string') return null
      const hello: ProtocolHello = {
        kind: 'hello',
        protocolVersion: raw.protocolVersion,
        ownerToken: raw.ownerToken,
        clientType: raw.clientType,
        ...(typeof raw.clientBuild === 'string' ? { clientBuild: raw.clientBuild } : {})
      }
      return hello
    }
    case 'hello_ok': {
      if (
        typeof raw.protocolVersion !== 'number' ||
        !Number.isFinite(raw.protocolVersion) ||
        typeof raw.instanceId !== 'string' ||
        !raw.instanceId ||
        !Array.isArray(raw.capabilities) ||
        !raw.capabilities.every((c) => typeof c === 'string') ||
        !isFiniteNonNegativeNumber(raw.globalSequence)
      ) {
        return null
      }
      const ok: ProtocolHelloOk = {
        kind: 'hello_ok',
        protocolVersion: raw.protocolVersion,
        instanceId: raw.instanceId,
        capabilities: raw.capabilities as string[],
        globalSequence: raw.globalSequence,
        ...(typeof raw.serverVersion === 'string' ? { serverVersion: raw.serverVersion } : {}),
        ...(typeof raw.serverBuild === 'string' ? { serverBuild: raw.serverBuild } : {})
      }
      return ok
    }
    case 'hello_err': {
      if (typeof raw.code !== 'string' || typeof raw.message !== 'string') return null
      return { kind: 'hello_err', code: raw.code, message: raw.message }
    }
    case 'req': {
      if (
        !isBoundedString(raw.id, MMS_PROTOCOL_MAX_ID_LENGTH, { nonEmpty: true }) ||
        !isBoundedString(raw.method, MMS_PROTOCOL_MAX_METHOD_LENGTH, { nonEmpty: true })
      ) {
        return null
      }
      const req: ProtocolRequest = {
        kind: 'req',
        id: raw.id,
        method: raw.method,
        ...(raw.params !== undefined ? { params: raw.params } : {})
      }
      return req
    }
    case 'res': {
      if (!isBoundedString(raw.id, MMS_PROTOCOL_MAX_ID_LENGTH, { nonEmpty: true })) return null
      if (typeof raw.ok !== 'boolean') return null
      if (raw.ok === false) {
        if (
          raw.error !== undefined &&
          (!isObject(raw.error) ||
            typeof raw.error.code !== 'string' ||
            typeof raw.error.message !== 'string')
        ) {
          return null
        }
      }
      const res: ProtocolResponse = {
        kind: 'res',
        id: raw.id,
        ok: raw.ok,
        ...(raw.result !== undefined ? { result: raw.result } : {}),
        ...(isObject(raw.error) &&
        typeof raw.error.code === 'string' &&
        typeof raw.error.message === 'string'
          ? {
              error: {
                code: raw.error.code,
                message: raw.error.message,
                ...(raw.error.details !== undefined ? { details: raw.error.details } : {})
              }
            }
          : {})
      }
      return res
    }
    case 'event': {
      if (
        !isFiniteNonNegativeNumber(raw.sequence) ||
        typeof raw.type !== 'string' ||
        !raw.type ||
        typeof raw.ts !== 'string' ||
        !raw.ts
      ) {
        return null
      }
      if (raw.threadId !== undefined && typeof raw.threadId !== 'string') return null
      const event: ProtocolEvent = {
        kind: 'event',
        sequence: raw.sequence,
        type: raw.type,
        data: raw.data,
        ts: raw.ts,
        ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {})
      }
      return event
    }
    case 'error': {
      if (typeof raw.code !== 'string' || typeof raw.message !== 'string') return null
      return { kind: 'error', code: raw.code, message: raw.message }
    }
    default:
      return null
  }
}

export function isAllowlistedMethod(method: string): method is ProtocolMethod {
  return (PROTOCOL_METHODS as readonly string[]).includes(method)
}

export function validateHello(raw: unknown): {
  ok: true
  hello: ProtocolHello
} | { ok: false; code: string; message: string } {
  const env = parseEnvelope(raw)
  if (!env || env.kind !== 'hello') {
    return { ok: false, code: 'invalid_hello', message: 'First frame must be hello' }
  }
  if (env.protocolVersion !== MMS_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'protocol_version',
      message: `Unsupported protocol version ${env.protocolVersion}; server is ${MMS_PROTOCOL_VERSION}`
    }
  }
  if (!env.ownerToken.trim()) {
    return { ok: false, code: 'auth', message: 'ownerToken required' }
  }
  return { ok: true, hello: env }
}

export function validateRequest(raw: unknown): {
  ok: true
  req: ProtocolRequest
} | { ok: false; code: string; message: string } {
  const env = parseEnvelope(raw)
  if (!env || env.kind !== 'req') {
    return { ok: false, code: 'invalid_request', message: 'Expected kind=req' }
  }
  if (!isAllowlistedMethod(env.method)) {
    return { ok: false, code: 'method_not_allowed', message: `Method not allowed: ${env.method}` }
  }
  return { ok: true, req: env }
}

export function asString(v: unknown, name: string, maxLen = MMS_PROTOCOL_MAX_TEXT_LENGTH): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty string`)
  if (v.length > maxLen) throw new Error(`${name} exceeds max length ${maxLen}`)
  return v
}

export function asOptionalString(v: unknown, maxLen = MMS_PROTOCOL_MAX_TEXT_LENGTH): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error('expected string')
  if (v.length > maxLen) throw new Error(`string exceeds max length ${maxLen}`)
  return v
}

export function asBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${name} must be a boolean`)
  return v
}

export function asOptionalBoolean(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined
  return asBoolean(v, name)
}

export function asFiniteNonNegative(v: unknown, name: string): number {
  if (!isFiniteNonNegativeNumber(v)) {
    throw new Error(`${name} must be a finite nonnegative number`)
  }
  return v
}

export function asStringArray(
  v: unknown,
  name: string,
  opts?: { unique?: boolean; maxItems?: number; maxItemLen?: number }
): string[] {
  const maxItems = opts?.maxItems ?? MMS_PROTOCOL_MAX_ORDERED_IDS
  const maxItemLen = opts?.maxItemLen ?? MMS_PROTOCOL_MAX_ID_LENGTH
  if (!Array.isArray(v)) throw new Error(`${name} must be string[]`)
  if (v.length > maxItems) throw new Error(`${name} exceeds max items ${maxItems}`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) {
      throw new Error(`${name} must be non-empty strings`)
    }
    if (x.length > maxItemLen) throw new Error(`${name} item exceeds max length`)
    if (opts?.unique) {
      if (seen.has(x)) throw new Error(`${name} must not contain duplicates`)
      seen.add(x)
    }
    out.push(x)
  }
  return out
}

/** Validate ChatMode from untrusted input — modes are file-defined, any non-empty string is allowed. */
export function asChatMode(v: unknown, name = 'mode'): ChatMode {
  if (typeof v === 'string') {
    if (!v.trim()) throw new Error(`${name} must be a non-empty mode id`)
    if (v.length > 64) throw new Error(`${name} exceeds max length`)
    if (!/^[a-zA-Z0-9_-]+$/.test(v)) throw new Error(`${name} must be alphanumeric with -_`)
    return v
  }
  if (isObject(v) && v.type === 'skill' && typeof v.skillId === 'string' && v.skillId.trim()) {
    if (v.skillId.length > MMS_PROTOCOL_MAX_ID_LENGTH) {
      throw new Error(`${name}.skillId exceeds max length`)
    }
    return { type: 'skill', skillId: v.skillId }
  }
  throw new Error(`${name} must be agent|plan|build or { type: 'skill', skillId }`)
}

export function asOptionalChatMode(v: unknown, name = 'mode'): ChatMode | undefined {
  if (v === undefined || v === null) return undefined
  return asChatMode(v, name)
}

/** Validate images array shape and data size within frame constraints. */
export function asChatImages(v: unknown, name = 'images'): ChatImageAttachment[] {
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`)
  if (v.length > MMS_PROTOCOL_MAX_IMAGES) {
    throw new Error(`${name} exceeds max ${MMS_PROTOCOL_MAX_IMAGES} images`)
  }
  const out: ChatImageAttachment[] = []
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (!isObject(item)) throw new Error(`${name}[${i}] must be an object`)
    if (typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error(`${name}[${i}].name must be a non-empty string`)
    }
    if (item.name.length > 512) throw new Error(`${name}[${i}].name too long`)
    if (typeof item.mimeType !== 'string' || !item.mimeType.trim()) {
      throw new Error(`${name}[${i}].mimeType must be a non-empty string`)
    }
    if (item.mimeType.length > 128) throw new Error(`${name}[${i}].mimeType too long`)
    if (typeof item.data !== 'string' || !item.data) {
      throw new Error(`${name}[${i}].data must be a non-empty string`)
    }
    if (item.data.length > MMS_PROTOCOL_MAX_IMAGE_DATA_CHARS) {
      throw new Error(`${name}[${i}].data exceeds max size`)
    }
    out.push({ name: item.name, mimeType: item.mimeType, data: item.data })
  }
  return out
}

export function asOptionalChatImages(
  v: unknown,
  name = 'images'
): ChatImageAttachment[] | undefined {
  if (v === undefined || v === null) return undefined
  return asChatImages(v, name)
}

export function asAfterSequence(v: unknown): number {
  if (v === undefined || v === null) return 0
  return asFiniteNonNegative(v, 'afterSequence')
}

// ── Nested payload validators (no `as never` into services) ─────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Reject prototype-pollution keys and force plain objects. */
export function asPlainObject(v: unknown, name: string): Record<string, unknown> {
  if (!isObject(v)) throw new Error(`${name} must be an object`)
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
    // Allow plain JSON objects only.
    const proto = Object.getPrototypeOf(v)
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(`${name} must be a plain object`)
    }
  }
  for (const key of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${name} contains forbidden key`)
  }
  return v
}

export function asChannelPlatform(v: unknown, name = 'platform'): 'telegram' | 'discord' | 'webhook' {
  if (v !== 'telegram' && v !== 'discord' && v !== 'webhook') {
    throw new Error(`${name} must be telegram|discord|webhook`)
  }
  return v
}

export function asOptionalChannelPlatform(
  v: unknown,
  name = 'platform'
): 'telegram' | 'discord' | 'webhook' | undefined {
  if (v === undefined || v === null) return undefined
  return asChannelPlatform(v, name)
}

export function asScope(v: unknown, name = 'scope'): 'global' | 'project' {
  if (v !== 'global' && v !== 'project') throw new Error(`${name} must be global|project`)
  return v
}

export function asProviderLoginResponse(v: unknown): ProviderLoginResponse {
  const response = asPlainObject(v, 'response')
  const allowed = new Set(['sessionId', 'kind', 'value'])
  for (const key of Object.keys(response)) {
    if (!allowed.has(key)) throw new Error(`response contains unknown field: ${key}`)
  }
  const sessionId = asString(response.sessionId, 'response.sessionId', 256)
  const kind = response.kind
  if (kind !== 'prompt' && kind !== 'select' && kind !== 'manual_code' && kind !== 'cancel') {
    throw new Error('response.kind must be prompt|select|manual_code|cancel')
  }
  const value = asOptionalString(response.value, MMS_PROTOCOL_MAX_TEXT_LENGTH)
  return value === undefined ? { sessionId, kind } : { sessionId, kind, value }
}

export function asTaskStatus(
  v: unknown,
  name = 'status'
): 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  const allowed = new Set([
    'pending',
    'in_progress',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ])
  if (typeof v !== 'string' || !allowed.has(v)) {
    throw new Error(`${name} must be a valid task status`)
  }
  return v as
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
}

export function asOptionalTaskStatus(
  v: unknown,
  name = 'status'
): ReturnType<typeof asTaskStatus> | undefined {
  if (v === undefined || v === null) return undefined
  return asTaskStatus(v, name)
}

export function asBoundedInt(
  v: unknown,
  name: string,
  opts: { min: number; max: number }
): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${name} must be an integer`)
  }
  if (v < opts.min || v > opts.max) {
    throw new Error(`${name} must be between ${opts.min} and ${opts.max}`)
  }
  return v
}

export function asOptionalBoundedInt(
  v: unknown,
  name: string,
  opts: { min: number; max: number }
): number | undefined {
  if (v === undefined || v === null) return undefined
  return asBoundedInt(v, name, opts)
}

export function asIsoDateString(v: unknown, name: string): string {
  const s = asString(v, name, 64)
  const t = Date.parse(s)
  if (!Number.isFinite(t)) throw new Error(`${name} must be a valid ISO date string`)
  return s
}

export function asJobSchedule(v: unknown, name = 'schedule'): {
  kind: 'once' | 'interval' | 'cron'
  runAt?: string
  minutes?: number
  expr?: string
} {
  const o = asPlainObject(v, name)
  const kind = o.kind
  if (kind !== 'once' && kind !== 'interval' && kind !== 'cron') {
    throw new Error(`${name}.kind must be once|interval|cron`)
  }
  if (kind === 'once') {
    const runAt = asIsoDateString(o.runAt, `${name}.runAt`)
    return { kind, runAt }
  }
  if (kind === 'interval') {
    const minutes = asBoundedInt(o.minutes, `${name}.minutes`, { min: 1, max: 60 * 24 * 365 })
    return { kind, minutes }
  }
  const expr = asString(o.expr, `${name}.expr`, 256)
  // Lightweight cron shape: 5 fields
  if (expr.split(/\s+/).filter(Boolean).length < 5) {
    throw new Error(`${name}.expr must be a cron expression with at least 5 fields`)
  }
  return { kind, expr }
}

export type CreateScheduledJobInputValidated = {
  name: string
  prompt: string
  schedule: ReturnType<typeof asJobSchedule>
  threadId?: string
  projectId?: string
  createThread?: boolean
  repeat?: { times?: number }
}

export function asCreateScheduledJobInput(v: unknown): CreateScheduledJobInputValidated {
  const o = asPlainObject(v, 'input')
  const input: CreateScheduledJobInputValidated = {
    name: asString(o.name, 'name', 256),
    prompt: asString(o.prompt, 'prompt'),
    schedule: asJobSchedule(o.schedule, 'schedule')
  }
  const threadId = asOptionalString(o.threadId, 256)
  if (threadId) input.threadId = threadId
  const projectId = asOptionalString(o.projectId, 256)
  if (projectId) input.projectId = projectId
  if (o.createThread !== undefined) input.createThread = asBoolean(o.createThread, 'createThread')
  if (o.repeat !== undefined) {
    const r = asPlainObject(o.repeat, 'repeat')
    const times = asOptionalBoundedInt(r.times, 'repeat.times', { min: 1, max: 10_000 })
    input.repeat = times !== undefined ? { times } : {}
  }
  // Reject unknown top-level keys beyond allowlist
  const allowed = new Set([
    'name',
    'prompt',
    'schedule',
    'threadId',
    'projectId',
    'createThread',
    'repeat'
  ])
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new Error(`input.${key} is not allowed`)
  }
  return input
}

export function asScheduledJobPatch(v: unknown): {
  name?: string
  prompt?: string
  schedule?: ReturnType<typeof asJobSchedule>
  enabled?: boolean
  threadId?: string | null
  projectId?: string | null
  createThread?: boolean
  repeat?: { times?: number } | null
} {
  const o = asPlainObject(v, 'patch')
  const allowed = new Set([
    'name',
    'prompt',
    'schedule',
    'enabled',
    'threadId',
    'projectId',
    'createThread',
    'repeat'
  ])
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new Error(`patch.${key} is not allowed`)
  }
  const patch: ReturnType<typeof asScheduledJobPatch> = {}
  if (o.name !== undefined) patch.name = asString(o.name, 'name', 256)
  if (o.prompt !== undefined) patch.prompt = asString(o.prompt, 'prompt')
  if (o.schedule !== undefined) patch.schedule = asJobSchedule(o.schedule, 'schedule')
  if (o.enabled !== undefined) patch.enabled = asBoolean(o.enabled, 'enabled')
  if (o.threadId === null) patch.threadId = null
  else if (o.threadId !== undefined) patch.threadId = asString(o.threadId, 'threadId', 256)
  if (o.projectId === null) patch.projectId = null
  else if (o.projectId !== undefined) patch.projectId = asString(o.projectId, 'projectId', 256)
  if (o.createThread !== undefined) patch.createThread = asBoolean(o.createThread, 'createThread')
  if (o.repeat === null) patch.repeat = null
  else if (o.repeat !== undefined) {
    const r = asPlainObject(o.repeat, 'repeat')
    const times = asOptionalBoundedInt(r.times, 'repeat.times', { min: 1, max: 10_000 })
    patch.repeat = times !== undefined ? { times } : {}
  }
  return patch
}

function asChannelPlatformConfig(
  v: unknown,
  name: string
): {
  enabled: boolean
  token?: string
  allowedUserIds?: string[]
  allowAllUsers?: boolean
  homeChatId?: string
  webhookPort?: number
  webhookSecret?: string
} {
  const o = asPlainObject(v, name)
  const allowed = new Set([
    'enabled',
    'token',
    'allowedUserIds',
    'allowAllUsers',
    'homeChatId',
    'webhookPort',
    'webhookSecret'
  ])
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new Error(`${name}.${key} is not allowed`)
  }
  const cfg: ReturnType<typeof asChannelPlatformConfig> = {
    enabled: asBoolean(o.enabled ?? false, `${name}.enabled`)
  }
  if (o.token !== undefined) cfg.token = asString(o.token, `${name}.token`, 4096)
  if (o.allowedUserIds !== undefined) {
    cfg.allowedUserIds = asStringArray(o.allowedUserIds, `${name}.allowedUserIds`, {
      maxItems: 500,
      maxItemLen: 256
    })
  }
  if (o.allowAllUsers !== undefined) {
    cfg.allowAllUsers = asBoolean(o.allowAllUsers, `${name}.allowAllUsers`)
  }
  if (o.homeChatId !== undefined) {
    cfg.homeChatId = asString(o.homeChatId, `${name}.homeChatId`, 256)
  }
  if (o.webhookPort !== undefined) {
    cfg.webhookPort = asBoundedInt(o.webhookPort, `${name}.webhookPort`, {
      min: 1,
      max: 65535
    })
  }
  if (o.webhookSecret !== undefined) {
    cfg.webhookSecret = asString(o.webhookSecret, `${name}.webhookSecret`, 1024)
  }
  return cfg
}

export function asChannelConfigPatch(v: unknown): {
  platforms?: Partial<
    Record<'telegram' | 'discord' | 'webhook', Partial<ReturnType<typeof asChannelPlatformConfig>>>
  >
  filterSilenceNarration?: boolean
  unauthorizedDmBehavior?: 'pair' | 'ignore'
} {
  const o = asPlainObject(v, 'patch')
  const allowed = new Set(['platforms', 'filterSilenceNarration', 'unauthorizedDmBehavior'])
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new Error(`patch.${key} is not allowed`)
  }
  const patch: ReturnType<typeof asChannelConfigPatch> = {}
  if (o.filterSilenceNarration !== undefined) {
    patch.filterSilenceNarration = asBoolean(o.filterSilenceNarration, 'filterSilenceNarration')
  }
  if (o.unauthorizedDmBehavior !== undefined) {
    if (o.unauthorizedDmBehavior !== 'pair' && o.unauthorizedDmBehavior !== 'ignore') {
      throw new Error('unauthorizedDmBehavior must be pair|ignore')
    }
    patch.unauthorizedDmBehavior = o.unauthorizedDmBehavior
  }
  if (o.platforms !== undefined) {
    const platforms = asPlainObject(o.platforms, 'platforms')
    const out: NonNullable<ReturnType<typeof asChannelConfigPatch>['platforms']> = {}
    for (const key of Object.keys(platforms)) {
      const platform = asChannelPlatform(key, 'platforms key')
      out[platform] = asChannelPlatformConfig(platforms[key], `platforms.${platform}`)
    }
    patch.platforms = out
  }
  return patch
}

/** Settings patch: only known top-level sections; reject pollution; bound strings. */
export function asSettingsPartial(v: unknown): Record<string, unknown> {
  const o = asPlainObject(v, 'partial')
  const allowed = new Set(['profile', 'appearance', 'provider', 'title', 'agents', 'integrations'])
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new Error(`partial.${key} is not allowed`)
  }
  // Deep walk for forbidden keys + string length bounds
  const walk = (node: unknown, path: string, depth: number): unknown => {
    if (depth > 8) throw new Error(`${path} exceeds max depth`)
    if (typeof node === 'string') {
      if (node.length > MMS_PROTOCOL_MAX_TEXT_LENGTH) {
        throw new Error(`${path} exceeds max length`)
      }
      return node
    }
    if (typeof node === 'number' || typeof node === 'boolean' || node === null) return node
    if (Array.isArray(node)) {
      if (node.length > 200) throw new Error(`${path} array too large`)
      return node.map((item, i) => walk(item, `${path}[${i}]`, depth + 1))
    }
    if (isObject(node)) {
      const plain = asPlainObject(node, path)
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(plain)) {
        out[k] = walk(val, `${path}.${k}`, depth + 1)
      }
      return out
    }
    throw new Error(`${path} has unsupported type`)
  }
  return walk(o, 'partial', 0) as Record<string, unknown>
}

export function asStringEnvMap(v: unknown, name = 'env'): Record<string, string> {
  const o = asPlainObject(v, name)
  const out: Record<string, string> = {}
  const keys = Object.keys(o)
  if (keys.length > 64) throw new Error(`${name} has too many keys`)
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) {
      throw new Error(`${name} key invalid`)
    }
    if (typeof o[key] !== 'string' || (o[key] as string).length > 4096) {
      throw new Error(`${name}.${key} must be a string ≤4096`)
    }
    out[key] = o[key] as string
  }
  return out
}

export function asOptionalStringEnvMap(
  v: unknown,
  name = 'env'
): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  return asStringEnvMap(v, name)
}

export function asAnswersMap(v: unknown): Record<string, string | string[]> {
  const o = asPlainObject(v, 'answers')
  const out: Record<string, string | string[]> = {}
  const keys = Object.keys(o)
  if (keys.length > 64) throw new Error('answers has too many keys')
  for (const key of keys) {
    if (key.length > 256) throw new Error('answers key too long')
    const val = o[key]
    if (typeof val === 'string') {
      if (val.length > MMS_PROTOCOL_MAX_TEXT_LENGTH) throw new Error('answer too long')
      out[key] = val
    } else if (Array.isArray(val)) {
      out[key] = asStringArray(val, `answers.${key}`, { maxItems: 32, maxItemLen: 1024 })
    } else {
      throw new Error(`answers.${key} must be string or string[]`)
    }
  }
  return out
}

export function asCursorMcpConfigPatch(v: unknown): Record<string, unknown> {
  const o = asPlainObject(v, 'patch')
  // Bound size of serialized patch
  const json = JSON.stringify(o)
  if (json.length > 200_000) throw new Error('patch exceeds max size')
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12) throw new Error('patch nesting too deep')
    if (Array.isArray(node)) {
      if (node.length > 200) throw new Error('patch array too large')
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (isObject(node)) {
      asPlainObject(node, 'patch')
      for (const val of Object.values(node)) walk(val, depth + 1)
    }
  }
  walk(o, 0)
  return o
}
