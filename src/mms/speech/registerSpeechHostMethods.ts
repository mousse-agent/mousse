import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import {
  PHONE_SPEECH_KINDS,
  SPEECH_HOST_MAX_MESSAGE_BYTES,
  SPEECH_HOST_METHODS,
  type SpeechHostMethod
} from '../../shared/speechRelay'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { SpeechRelay } from './SpeechRelay'

const JOB_ID = /^sj_[A-Za-z0-9_-]{8,64}$/
const REFUSAL_CODES = new Set(['no_host', 'no_model', 'unavailable', 'invalid', 'busy', 'failed'])

const KEYS: Record<SpeechHostMethod, readonly string[]> = {
  'speech.host.wait': [],
  'speech.host.take': ['id'],
  'speech.host.progress': ['id', 'data'],
  'speech.host.finish': ['id', 'result']
}

function boundedJson(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainRpcError('invalid_params', `${field} must be an object`)
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new DomainRpcError('invalid_params', `${field} must be JSON`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > SPEECH_HOST_MAX_MESSAGE_BYTES)
    throw new DomainRpcError('invalid_params', `${field} is too large`)
}

export function validateSpeechHostParams(method: SpeechHostMethod, value: unknown): Record<string, unknown> {
  const params = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  if (method !== 'speech.host.wait' && (typeof params.id !== 'string' || !JOB_ID.test(params.id)))
    throw new DomainRpcError('invalid_params', 'A speech job id is required')
  if (method === 'speech.host.progress') boundedJson(params.data, 'data')
  if (method === 'speech.host.finish') {
    boundedJson(params.result, 'result')
    const result = params.result as Record<string, unknown>
    if (result.ok !== true && result.ok !== false) throw new DomainRpcError('invalid_params', 'result.ok must be boolean')
    if (
      result.ok === false &&
      (!REFUSAL_CODES.has(result.code as string) || typeof result.error !== 'string' || result.error.length > 1000)
    )
      throw new DomainRpcError('invalid_params', 'A refusal needs a known code and a short message')
    if (result.kind !== undefined && !(PHONE_SPEECH_KINDS as readonly unknown[]).includes(result.kind))
      throw new DomainRpcError('invalid_params', 'Unknown speech kind')
  }
  return params
}

/**
 * Local window methods that serve phone speech requests. Only Mousse windows may take them: a
 * job carries the phone's recording or text, and the answer goes back to the phone.
 */
export function registerSpeechHostMethods(
  registry: DomainHandlerRegistry,
  forProfile: (profileId: string) => SpeechRelay | Promise<SpeechRelay>
): () => void {
  const relays = new Set<SpeechRelay>()
  const unsubscribe = registry.onConnectionClosed((connection) => {
    for (const relay of relays) relay.connectionClosed(connection)
  })
  for (const method of SPEECH_HOST_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (value) => validateSpeechHostParams(method, value),
      handle: async (context, params, binding) => {
        const connection = context.connection
        if (!connection || connection.clientType !== 'gui' || !binding)
          throw new DomainRpcError('forbidden', 'Only a Mousse window serves phone speech requests')
        const relay = await forProfile(binding.profileId)
        relays.add(relay)
        const id = params.id as string
        switch (method) {
          case 'speech.host.wait':
            return relay.wait(connection.id)
          case 'speech.host.take':
            return { job: relay.take(connection.id, id) }
          case 'speech.host.progress':
            return relay.progress(connection.id, id, params.data)
          case 'speech.host.finish':
            relay.finish(connection.id, id, params.result)
            return { ok: true }
        }
      }
    })
  return unsubscribe
}
