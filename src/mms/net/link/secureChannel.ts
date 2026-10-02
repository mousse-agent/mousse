import { constants, timingSafeEqual } from 'node:crypto'
import { connect, TLSSocket } from 'node:tls'
import { NetError } from '../../../shared/net'
import type { OpenSecureChannel } from '../contracts'
import { fingerprint, transportKeyFromCertificate } from './selfSignedCert'

/**
 * Chain validation is intentionally replaced with SPKI pinning. An unpinned
 * channel is quarantined by SyncSession: only bounded hello/enrollment traffic
 * is allowed until the delegation and this certificate's key match.
 */
export const openSecureChannel: OpenSecureChannel = async (raw, options) => {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    raw.destroy()
    throw new NetError('deadline_exceeded')
  }
  if (options.signal?.aborted) {
    raw.destroy()
    throw new NetError('cancelled', undefined, { cause: options.signal.reason })
  }
  return new Promise((resolve, reject) => {
    let socket: TLSSocket
    try {
      const tlsOptions = {
        cert: options.credentials.cert,
        key: options.credentials.key,
        minVersion: 'TLSv1.3' as const,
        maxVersion: 'TLSv1.3' as const,
        rejectUnauthorized: false,
        secureOptions: constants.SSL_OP_NO_TICKET
      }
      socket = options.role === 'client'
        ? connect({ ...tlsOptions, socket: raw })
        : new TLSSocket(raw, { ...tlsOptions, isServer: true, requestCert: true })
      socket.disableRenegotiation()
    } catch (cause) {
      raw.destroy()
      reject(new NetError('bad_request', 'TLS channel setup failed.', { cause }))
      return
    }
    let settled = false
    const readyEvent = options.role === 'client' ? 'secureConnect' : 'secure'
    const clean = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      socket.removeListener(readyEvent, ready)
      socket.removeListener('close', closed)
    }
    const fail = (error: NetError) => {
      if (settled) return
      settled = true
      clean()
      socket.destroy()
      raw.destroy()
      reject(error)
    }
    const closed = () => fail(new NetError('route_unreachable', 'Peer closed during the TLS handshake.'))
    const abort = () => fail(new NetError('cancelled', undefined, { cause: options.signal?.reason }))
    const timer = setTimeout(() => fail(new NetError('deadline_exceeded')), options.deadlineMs)
    const ready = () => {
      if (settled) return
      try {
        if (socket.getProtocol() !== 'TLSv1.3' || socket.isSessionReused()) {
          throw new NetError('bad_request', 'A fresh TLS 1.3 handshake is required.')
        }
        const cert = socket.getPeerCertificate(true).raw
        if (!cert?.length) throw new NetError('peer_key_mismatch', 'Peer did not present a certificate.')
        const key = transportKeyFromCertificate(cert)
        if (options.expectedPeerFingerprint !== undefined) {
          const expected = Buffer.from(options.expectedPeerFingerprint, 'utf8')
          const actual = Buffer.from(fingerprint(key), 'utf8')
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new NetError('peer_key_mismatch')
          }
        }
        settled = true
        clean()
        resolve({
          stream: socket,
          peerTransportKey: Buffer.from(key).toString('base64url'),
          exporter: (label, length) => socket.exportKeyingMaterial(length, label, Buffer.alloc(0)),
          close: () => { socket.destroy(); raw.destroy() }
        })
      } catch (cause) {
        fail(cause instanceof NetError ? cause : new NetError('peer_key_mismatch', undefined, { cause }))
      }
    }
    socket.once(readyEvent, ready)
    socket.once('close', closed)
    // Keep the listener after opening; callers still receive the stream's error
    // event, while close-before-subscribe cannot create an uncaught exception.
    socket.on('error', cause => fail(new NetError('bad_request', 'TLS handshake failed.', { cause })))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}
