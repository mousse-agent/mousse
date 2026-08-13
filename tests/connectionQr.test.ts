import { describe, expect, it } from 'vitest'
import { buildConnectionQrPayload, connectionQrInfo } from '../src/mms/http/connectionQr'

describe('connection QR payload', () => {
  it('contains only the protocol version and canonical server origin', () => {
    const payload = new URL(buildConnectionQrPayload('https://mousse.example.test:28478'))
    expect(payload.protocol).toBe('mousse:')
    expect(payload.hostname).toBe('connect')
    expect(Object.fromEntries(payload.searchParams)).toEqual({ v: '1', base: 'https://mousse.example.test:28478' })
  })

  it('does not offer a mobile QR without an HTTPS public URL', () => {
    expect(connectionQrInfo({ autostart: false, logLevel: 'info' }).payload).toBeUndefined()
    expect(connectionQrInfo({ autostart: false, logLevel: 'info', http: { enabled: true, host: '127.0.0.1', port: 28478, serverName: 'Mousse', publicBaseUrl: 'http://127.0.0.1:28478' } }).payload).toBeUndefined()
  })
})
