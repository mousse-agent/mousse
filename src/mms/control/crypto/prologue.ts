/**
 * Canonical Noise Prologue encoding for Control Protocol 2.0.
 * Aligned with docs/WIRE_PROTOCOL.md §3.
 *
 * Prologue encoding: consecutive uint16 BE length-prefixed UTF-8 fields in order:
 * 1. protocolMajor ("2")
 * 2. protocolMinor ("0")
 * 3. installationId
 * 4. controlOrigin
 * 5. mode ("hosted" | "self-hosted")
 * 6. accountId (empty string when absent / self-hosted)
 * 7. mmsDeviceId
 * 8. mobileDeviceId
 * 9. pairingId
 * 10. initiatorRole ("mobile" | "mms")
 * 11. responderRole ("mms" | "mobile", must differ)
 */

import { ID_MAX_LENGTH, PROTOCOL_MAJOR, PROTOCOL_MINOR } from '../constants'

export type ChannelMode = 'hosted' | 'self-hosted'
export type ChannelRole = 'mms' | 'mobile'

export interface PrologueContext {
  protocolMajor: number
  protocolMinor: number
  installationId: string
  controlOrigin: string
  mode: ChannelMode
  accountId?: string
  mmsDeviceId: string
  mobileDeviceId: string
  pairingId: string
  initiatorRole: ChannelRole
  responderRole: ChannelRole
}

const TEXT = new TextEncoder()

function assertId(value: string, label: string): void {
  if (value.length === 0 || value.length > ID_MAX_LENGTH) {
    throw new Error(`${label} length out of range`)
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL`)
  }
}

function assertOrigin(origin: string): void {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error('controlOrigin must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('controlOrigin must be http(s)')
  }
  if (url.username || url.password) {
    throw new Error('controlOrigin must not include userinfo')
  }
  if (url.origin !== origin) {
    throw new Error('controlOrigin must be a canonical origin (no path/query/fragment)')
  }
}

/**
 * Encode prologue as length-prefixed UTF-8 fields (uint16 BE lengths).
 * Absent accountId is encoded as length 0.
 */
export function encodePrologue(ctx: PrologueContext): Uint8Array {
  if (ctx.protocolMajor !== PROTOCOL_MAJOR) {
    throw new Error(`unsupported protocol major ${ctx.protocolMajor}`)
  }
  if (ctx.initiatorRole === ctx.responderRole) {
    throw new Error('initiator and responder roles must differ')
  }
  if (ctx.mode !== 'hosted' && ctx.mode !== 'self-hosted') {
    throw new Error('invalid mode')
  }
  if (ctx.mode === 'hosted' && !ctx.accountId) {
    throw new Error('hosted mode requires accountId')
  }
  if (ctx.mode === 'self-hosted' && ctx.accountId) {
    throw new Error('self-hosted mode must not bind accountId')
  }

  assertId(ctx.installationId, 'installationId')
  assertOrigin(ctx.controlOrigin)
  assertId(ctx.mmsDeviceId, 'mmsDeviceId')
  assertId(ctx.mobileDeviceId, 'mobileDeviceId')
  assertId(ctx.pairingId, 'pairingId')
  if (ctx.accountId !== undefined && ctx.accountId !== '') {
    assertId(ctx.accountId, 'accountId')
  }

  const fields = [
    String(ctx.protocolMajor),
    String(ctx.protocolMinor),
    ctx.installationId,
    ctx.controlOrigin,
    ctx.mode,
    ctx.accountId ?? '',
    ctx.mmsDeviceId,
    ctx.mobileDeviceId,
    ctx.pairingId,
    ctx.initiatorRole,
    ctx.responderRole
  ]

  const encoded = fields.map((f) => TEXT.encode(f))
  let total = 0
  for (const part of encoded) {
    if (part.byteLength > 0xffff) {
      throw new Error('prologue field too large')
    }
    total += 2 + part.byteLength
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const part of encoded) {
    out[offset] = (part.byteLength >> 8) & 0xff
    out[offset + 1] = part.byteLength & 0xff
    offset += 2
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function defaultPrologueVersions(
  partial: Omit<PrologueContext, 'protocolMajor' | 'protocolMinor'> &
    Partial<Pick<PrologueContext, 'protocolMajor' | 'protocolMinor'>>
): PrologueContext {
  return {
    protocolMajor: partial.protocolMajor ?? PROTOCOL_MAJOR,
    protocolMinor: partial.protocolMinor ?? PROTOCOL_MINOR,
    installationId: partial.installationId,
    controlOrigin: partial.controlOrigin,
    mode: partial.mode,
    accountId: partial.accountId,
    mmsDeviceId: partial.mmsDeviceId,
    mobileDeviceId: partial.mobileDeviceId,
    pairingId: partial.pairingId,
    initiatorRole: partial.initiatorRole,
    responderRole: partial.responderRole
  }
}
