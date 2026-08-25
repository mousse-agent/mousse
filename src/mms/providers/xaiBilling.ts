import type { ProviderUsageWindow } from '../../shared/providerAuth'

/** First-party Grok CLI identity headers required by cli-chat-proxy / grok.com billing. */
export function grokCliBillingHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-xai-token-auth': 'xai-grok-cli',
    'user-agent': 'xai-grok-cli'
  }
}

/**
 * Weekly SuperGrok credits via grok.com gRPC-web.
 * REST `?format=credits` can 500 with "Failed to serialize billing response" for some
 * accounts; this endpoint still returns credit_usage_percent over OAuth bearer.
 */
export async function fetchGrokCreditsViaGrpc(
  token: string,
  signal?: AbortSignal
): Promise<ProviderUsageWindow[]> {
  const response = await fetch('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', {
    method: 'POST',
    headers: {
      ...grokCliBillingHeaders(token),
      accept: 'application/grpc-web+proto',
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      origin: 'https://grok.com',
      referer: 'https://grok.com/?_s=usage'
    },
    // Empty protobuf request message, gRPC-web framed.
    body: new Uint8Array([0, 0, 0, 0, 0]),
    signal
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error('Grok session expired. Reconnect Grok (xAI) in Settings.')
  }
  if (!response.ok) return []

  const grpcStatus = response.headers.get('grpc-status')
  if (grpcStatus && grpcStatus !== '0') return []

  return parseGrokCreditsGrpcWeb(await response.arrayBuffer())
}

/** Parse gRPC-web GetGrokCreditsConfig response into a weekly usage window. */
export function parseGrokCreditsGrpcWeb(body: ArrayBuffer | Uint8Array): ProviderUsageWindow[] {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  const message = firstGrpcWebDataMessage(bytes)
  if (!message) return []

  // Response { CreditsConfig config = 1; } — config carries credit_usage_percent + period.
  const config = readLengthDelimitedField(message, 1) ?? message
  const periodEnd = readTimestampField(config, 5) ?? readTimestampField(config, 4)
  const encodedUsedPercent = readFloatField(config, 1)
  // credit_usage_percent is a proto3 scalar. Grok omits field 1 when its value is
  // the default 0, so a valid period-bearing config without the field means 0% used,
  // not an unexpected response. Still reject payloads with neither usage nor period.
  if (encodedUsedPercent === undefined && !periodEnd) return []
  const usedPercent = encodedUsedPercent ?? 0
  if (!Number.isFinite(usedPercent)) return []

  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))

  return [
    {
      id: 'weekly',
      label: 'Weekly',
      remainingPercent,
      resetsAt: periodEnd
    }
  ]
}

function firstGrpcWebDataMessage(bytes: Uint8Array): Uint8Array | undefined {
  let offset = 0
  while (offset + 5 <= bytes.length) {
    const compressed = bytes[offset]
    const length = (bytes[offset + 1]! << 24) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 8) | bytes[offset + 4]!
    offset += 5
    if (length < 0 || offset + length > bytes.length) return undefined
    const frame = bytes.subarray(offset, offset + length)
    offset += length
    // Trailer frames start with "grpc-status:" ASCII after a compressed flag of 0x80.
    if (compressed === 0x80) continue
    if (compressed !== 0) continue
    if (frame.length >= 11 && frame.subarray(0, 11).toString() === 'grpc-status') continue
    return frame
  }
  return undefined
}

function readLengthDelimitedField(message: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = message[offset++]
    if (tag === undefined) return undefined
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2) {
      const length = readVarint(message, offset)
      if (!length) return undefined
      offset = length.next
      const value = message.subarray(offset, offset + length.value)
      offset += length.value
      if (field === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

function readFloatField(message: Uint8Array, fieldNumber: number): number | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = message[offset++]
    if (tag === undefined) return undefined
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 5) {
      if (offset + 4 > message.length) return undefined
      const value = new DataView(message.buffer, message.byteOffset + offset, 4).getFloat32(0, true)
      offset += 4
      if (field === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

function readTimestampField(message: Uint8Array, fieldNumber: number): string | undefined {
  const nested = readLengthDelimitedField(message, fieldNumber)
  if (!nested) return undefined
  // google.protobuf.Timestamp { int64 seconds = 1; int32 nanos = 2; }
  let offset = 0
  let seconds: number | undefined
  while (offset < nested.length) {
    const tag = nested[offset++]
    if (tag === undefined) break
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      const value = readVarint(nested, offset)
      if (!value) break
      offset = value.next
      if (field === 1) seconds = value.value
      continue
    }
    const skipped = skipField(nested, offset, wire)
    if (skipped === undefined) break
    offset = skipped
  }
  if (seconds === undefined) return undefined
  return new Date(seconds * 1000).toISOString()
}

function readVarint(
  message: Uint8Array,
  offset: number
): { value: number; next: number } | undefined {
  let result = 0
  let shift = 0
  let next = offset
  while (next < message.length && shift <= 35) {
    const byte = message[next++]!
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result >>> 0, next }
    shift += 7
  }
  return undefined
}

function skipField(message: Uint8Array, offset: number, wire: number): number | undefined {
  if (wire === 0) {
    const value = readVarint(message, offset)
    return value?.next
  }
  if (wire === 1) return offset + 8 <= message.length ? offset + 8 : undefined
  if (wire === 2) {
    const length = readVarint(message, offset)
    if (!length) return undefined
    const next = length.next + length.value
    return next <= message.length ? next : undefined
  }
  if (wire === 5) return offset + 4 <= message.length ? offset + 4 : undefined
  return undefined
}
