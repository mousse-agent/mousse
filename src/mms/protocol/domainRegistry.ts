import type { HandlerContext } from './handlers'
import { MMS_PROTOCOL_MAX_TEXT_LENGTH, PROTOCOL_METHODS } from './types'

export interface TrustedProfileBinding {
  readonly profileId: string
  readonly epoch: number
}

export interface DomainConnectionContext {
  readonly id: string
  /** Assigned by daemon admission, never deserialized from request params. */
  readonly binding?: TrustedProfileBinding
  readonly capabilities: ReadonlySet<string>
}

export class DomainRpcError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'DomainRpcError'
  }
}

export interface DomainMethod<T = unknown> {
  readonly method: string
  readonly scope: 'installation' | 'profile'
  readonly capability?: string
  readonly requiredCapabilities?: readonly string[]
  validate: (params: unknown) => T
  handle: (context: HandlerContext, params: T, binding?: TrustedProfileBinding) => unknown | Promise<unknown>
}

/** Per-daemon registration. Legacy handlers keep their existing dispatch behavior. */
export class DomainHandlerRegistry {
  private readonly entries = new Map<string, DomainMethod>()
  private sealed = false

  register<T>(entry: DomainMethod<T>): void {
    if (this.sealed) throw new Error('Domain registrations are sealed')
    if (!/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(entry.method) || entry.method.length > 96) throw new Error('Invalid domain method')
    if ((PROTOCOL_METHODS as readonly string[]).includes(entry.method) || this.entries.has(entry.method)) throw new Error('Duplicate domain method: ' + entry.method)
    this.entries.set(entry.method, Object.freeze({ ...entry, requiredCapabilities: Object.freeze([...(entry.requiredCapabilities ?? [])]) }) as DomainMethod)
  }

  seal(): void { this.sealed = true }
  has(method: string): boolean { return this.entries.has(method) }
  methods(): ReadonlySet<string> { return new Set(this.entries.keys()) }
  capabilities(): string[] {
    return [...new Set([...this.entries.values()].flatMap((entry) => entry.capability ? [entry.capability] : []))].sort()
  }

  async dispatch(context: HandlerContext, method: string, params: unknown): Promise<unknown> {
    const entry = this.entries.get(method)
    if (!entry) throw new DomainRpcError('method_not_available', 'Domain method is unavailable')
    const binding = context.connection?.binding
    if (entry.scope === 'profile' && !binding) throw new DomainRpcError('profile_binding_required', 'Bind this connection to a profile first')
    if (binding && (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1 || !binding.profileId)) throw new DomainRpcError('invalid_profile_binding', 'Invalid daemon profile binding')
    for (const capability of entry.requiredCapabilities ?? []) {
      if (!context.connection?.capabilities.has(capability)) throw new DomainRpcError('capability_required', 'This connection cannot use ' + method, { capability })
    }
    let encoded: string | undefined
    try { encoded = JSON.stringify(params) }
    catch { throw new DomainRpcError('invalid_params', 'Request parameters must be JSON') }
    if (encoded && Buffer.byteLength(encoded, 'utf8') > MMS_PROTOCOL_MAX_TEXT_LENGTH) throw new DomainRpcError('params_too_large', 'Domain request exceeds its size limit')
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const claimed = (params as Record<string, unknown>).profileId
      if (claimed !== undefined && (entry.scope !== 'profile' || claimed !== binding?.profileId)) {
        throw new DomainRpcError('profile_mismatch', 'Request profile does not match the connection')
      }
    }
    const validated = entry.validate(params)
    return entry.handle(context, validated, binding ? Object.freeze({ ...binding }) : undefined)
  }
}

/** New DTO validators opt in to exact keys; legacy permissive DTOs are unchanged. */
export function domainObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new DomainRpcError('invalid_params', 'Expected a JSON object')
  }
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!keys.has(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new DomainRpcError('unknown_field', 'Unexpected field: ' + key)
  }
  return value as Record<string, unknown>
}
