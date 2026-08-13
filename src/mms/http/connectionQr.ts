import type { MmsConfigSection } from '../config/types'

export const MOUSSE_CONNECTION_QR_VERSION = '1'

export interface ConnectionQrInfo {
  enabled: boolean
  baseUrl?: string
  payload?: string
  reason?: string
}

export interface ConnectionQrView extends ConnectionQrInfo {
  qrDataUrl?: string
}

export interface MobileConnectionConfig {
  enabled: boolean
  host: string
  port: number
  serverName: string
  publicBaseUrl?: string
  tlsCertPath?: string
  tlsKeyPath?: string
}

export function canonicalClientBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/'
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

/** The QR is configuration only. OAuth tokens and approval codes are never embedded. */
export function buildConnectionQrPayload(baseUrl: string): string {
  const canonical = canonicalClientBaseUrl(baseUrl)
  if (!canonical) throw new Error('Connection QR requires a canonical HTTP(S) server origin')
  const payload = new URL('mousse://connect')
  payload.searchParams.set('v', MOUSSE_CONNECTION_QR_VERSION)
  payload.searchParams.set('base', canonical)
  return payload.toString()
}

export function connectionQrInfo(section: MmsConfigSection): ConnectionQrInfo {
  const http = section.http
  if (!http?.enabled) {
    return {
      enabled: false,
      reason: 'Mobile connections are disabled in mms.http.'
    }
  }
  if (!http.publicBaseUrl) {
    return {
      enabled: true,
      reason: 'Set mms.http.publicBaseUrl to the HTTPS origin reachable by your phone.'
    }
  }
  const baseUrl = canonicalClientBaseUrl(http.publicBaseUrl)
  if (!baseUrl) {
    return { enabled: true, reason: 'mms.http.publicBaseUrl is not a canonical HTTP(S) origin.' }
  }
  if (!baseUrl.startsWith('https://')) {
    return {
      enabled: true,
      baseUrl,
      reason: 'A mobile connection QR requires an HTTPS publicBaseUrl.'
    }
  }
  return { enabled: true, baseUrl, payload: buildConnectionQrPayload(baseUrl) }
}
