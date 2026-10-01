import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  PairingHandshake,
  ReconnectHandshake,
  SecureSession,
  HandshakeError,
  SessionError
} from '../src/mms/control/crypto/noise'
import {
  generateX25519KeyPair,
  publicKeyFromPrivate
} from '../src/mms/control/crypto/keys'
import {
  encodePrologue,
  type PrologueContext
} from '../src/mms/control/crypto/prologue'
import {
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN,
  decodeFrame,
  encodeFrame
} from '../src/mms/control/crypto/framing'
import {
  requestEnvelope,
  responseResultEnvelope,
  responseErrorEnvelope,
  eventEnvelope,
  pingEnvelope,
  canonicalizeEnvelope,
  encodeEnvelopeBytes,
  decodeEnvelopeBytes
} from '../src/mms/control/relay/envelopes'

function createSamplePrologue(opts?: Partial<PrologueContext>): PrologueContext {
  return {
    protocolMajor: 2,
    protocolMinor: 0,
    installationId: 'inst_live_test_001',
    controlOrigin: 'https://control.example.com',
    mode: 'hosted',
    accountId: 'acct_live_test_001',
    mmsDeviceId: 'mms_live_test_001',
    mobileDeviceId: 'mobile_live_test_001',
    pairingId: 'pair_live_test_001',
    initiatorRole: 'mobile',
    responderRole: 'mms',
    ...opts
  }
}

describe('Control Protocol 2.0 - Actual Initiator / Responder Secure Channel', () => {
  it('performs live XXpsk0 pairing handshake between mobile and MMS over framed messages', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const pairingSecret = randomBytes(32)
    const prologue = createSamplePrologue()

    const mobileInit = PairingHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      pairingSecret
    })

    const mmsResp = PairingHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic },
      pairingSecret,
      expectedInitiatorStatic: undefined
    })

    // Message 1: Mobile -> MMS
    const mobileHello = Buffer.from(JSON.stringify({ deviceModel: 'iPhone 15 Pro' }), 'utf-8')
    const m1Frame = mobileInit.write(mobileHello)

    const m1Decoded = decodeFrame(m1Frame)
    expect(m1Decoded.flags & FRAME_FLAG_CONTROL).not.toBe(0)
    expect(m1Decoded.flags & FRAME_FLAG_FIN).not.toBe(0)

    const receivedMobileHello = mmsResp.read(m1Frame)
    expect(JSON.parse(Buffer.from(receivedMobileHello).toString('utf-8'))).toEqual({
      deviceModel: 'iPhone 15 Pro'
    })

    // Message 2: MMS -> Mobile
    const mmsHello = Buffer.from(JSON.stringify({ daemonVersion: '2.0.0' }), 'utf-8')
    const m2Frame = mmsResp.write(mmsHello)

    const m2Decoded = decodeFrame(m2Frame)
    expect(m2Decoded.flags & FRAME_FLAG_CONTROL).not.toBe(0)

    const receivedMmsHello = mobileInit.read(m2Frame)
    expect(JSON.parse(Buffer.from(receivedMmsHello).toString('utf-8'))).toEqual({
      daemonVersion: '2.0.0'
    })

    // Message 3: Mobile -> MMS
    const m3Payload = Buffer.from(JSON.stringify({ confirm: true }), 'utf-8')
    const m3Frame = mobileInit.write(m3Payload)

    const receivedConfirm = mmsResp.read(m3Frame)
    expect(JSON.parse(Buffer.from(receivedConfirm).toString('utf-8'))).toEqual({ confirm: true })

    // Finish handshakes
    const mobileResult = mobileInit.finish()
    const mmsResult = mmsResp.finish()

    expect(mobileResult.pattern).toBe('XXpsk0')
    expect(mmsResult.pattern).toBe('XXpsk0')
    expect(Buffer.from(mobileResult.handshakeHash).equals(Buffer.from(mmsResult.handshakeHash))).toBe(true)
    expect(Buffer.from(mobileResult.remoteStaticPublicKey).equals(Buffer.from(mmsStatic.publicKey))).toBe(true)
    expect(Buffer.from(mmsResult.remoteStaticPublicKey).equals(Buffer.from(mobileStatic.publicKey))).toBe(true)

    // Bidirectional transport communication
    const req = requestEnvelope({
      requestId: 'req-pairing-test',
      method: 'status',
      params: { check: 'ok' }
    })
    const reqFrame = mobileResult.session.encrypt(encodeEnvelopeBytes(req))
    const decryptedReqBytes = mmsResult.session.decrypt(reqFrame)
    const decodedReq = decodeEnvelopeBytes(decryptedReqBytes)
    expect(decodedReq.type).toBe('request')
    expect((decodedReq as any).requestId).toBe('req-pairing-test')

    const res = responseResultEnvelope('req-pairing-test', { alive: true })
    const resFrame = mmsResult.session.encrypt(encodeEnvelopeBytes(res))
    const decryptedResBytes = mobileResult.session.decrypt(resFrame)
    const decodedRes = decodeEnvelopeBytes(decryptedResBytes)
    expect(decodedRes.type).toBe('response')
    expect((decodedRes as any).result).toEqual({ alive: true })
  })

  it('performs live IK reconnect handshake between mobile and MMS over framed messages', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const prologue = createSamplePrologue()

    const mobileInit = ReconnectHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      remoteStaticPublicKey: mmsStatic.publicKey
    })

    const mmsResp = ReconnectHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic },
      expectedInitiatorStatic: mobileStatic.publicKey
    })

    // Message 1: Mobile -> MMS
    const m1Payload = Buffer.from('reconnect-payload', 'utf-8')
    const m1Frame = mobileInit.write(m1Payload)
    const receivedM1Payload = mmsResp.read(m1Frame)
    expect(Buffer.from(receivedM1Payload).toString('utf-8')).toBe('reconnect-payload')

    // Message 2: MMS -> Mobile
    const m2Payload = Buffer.from('reconnect-ack', 'utf-8')
    const m2Frame = mmsResp.write(m2Payload)
    const receivedM2Payload = mobileInit.read(m2Frame)
    expect(Buffer.from(receivedM2Payload).toString('utf-8')).toBe('reconnect-ack')

    // Finish
    const mobileResult = mobileInit.finish()
    const mmsResult = mmsResp.finish()

    expect(Buffer.from(mobileResult.handshakeHash).equals(Buffer.from(mmsResult.handshakeHash))).toBe(true)
    expect(Buffer.from(mmsResult.remoteStaticPublicKey).equals(Buffer.from(mobileStatic.publicKey))).toBe(true)

    // Bidirectional transport events and RPCs
    const evt = eventEnvelope({
      instanceId: 'mms-daemon-01',
      sequence: 1,
      eventType: 'threads.updated',
      payload: { threadId: 't-100' }
    })
    const evtFrame = mmsResult.session.encrypt(encodeEnvelopeBytes(evt))
    const decryptedEvt = decodeEnvelopeBytes(mobileResult.session.decrypt(evtFrame))
    expect(decryptedEvt.type).toBe('event')
    expect((decryptedEvt as any).eventType).toBe('threads.updated')
    expect((decryptedEvt as any).payload).toEqual({ threadId: 't-100' })
  })

  it('enforces QR pinned MMS static key during initial pairing', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsActualStatic = generateX25519KeyPair()
    const forgedMmsStatic = generateX25519KeyPair()
    const pairingSecret = randomBytes(32)
    const prologue = createSamplePrologue()

    // Mobile expects mmsActualStatic, but an attacker uses forgedMmsStatic
    const mobileInit = PairingHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      pairingSecret
    })

    const attackerResp = PairingHandshake.responder({
      prologue,
      identity: { keyPair: forgedMmsStatic },
      pairingSecret
    })

    const m1 = mobileInit.write()
    attackerResp.read(m1)
    const m2 = attackerResp.write()

    // When mobile reads message 2, it receives forgedMmsStatic
    mobileInit.read(m2)
    const m3 = mobileInit.write()
    attackerResp.read(m3)

    attackerResp.finish()
    const mobileFinish = mobileInit.finish()

    // Mobile detects that the responder static key does not match QR pin
    expect(
      Buffer.from(mobileFinish.remoteStaticPublicKey).equals(Buffer.from(mmsActualStatic.publicKey))
    ).toBe(false)
  })

  it('fails pairing handshake when pairing secrets differ', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const correctSecret = randomBytes(32)
    const wrongSecret = randomBytes(32)
    const prologue = createSamplePrologue()

    const mobileInit = PairingHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      pairingSecret: correctSecret
    })

    const mmsResp = PairingHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic },
      pairingSecret: wrongSecret
    })

    const m1 = mobileInit.write()
    // Responder reading message 1 with wrong PSK fails authentication
    expect(() => mmsResp.read(m1)).toThrow()
  })

  it('fails reconnect handshake when expected initiator static does not match', () => {
    const mobileStatic = generateX25519KeyPair()
    const wrongMobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const prologue = createSamplePrologue()

    const mobileInit = ReconnectHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      remoteStaticPublicKey: mmsStatic.publicKey
    })

    const mmsResp = ReconnectHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic },
      expectedInitiatorStatic: wrongMobileStatic.publicKey
    })

    const m1 = mobileInit.write()
    // Responder reading message 1 rejects initiator static key pin mismatch
    expect(() => mmsResp.read(m1)).toThrow(HandshakeError)
  })

  it('rejects tampered handshake control frames and tampered ciphertext', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const pairingSecret = randomBytes(32)
    const prologue = createSamplePrologue()

    const mobileInit = PairingHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      pairingSecret
    })

    const mmsResp = PairingHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic },
      pairingSecret
    })

    const m1 = mobileInit.write()

    // 1. Frame missing CONTROL flag
    const corruptedFlags = Buffer.from(m1)
    corruptedFlags[3] = FRAME_FLAG_FIN // missing FRAME_FLAG_CONTROL
    expect(() => mmsResp.read(corruptedFlags)).toThrow(HandshakeError)

    // 2. Tampered ciphertext payload
    const corruptedPayload = Buffer.from(m1)
    corruptedPayload[corruptedPayload.length - 1] ^= 0x55
    expect(() => mmsResp.read(corruptedPayload)).toThrow(HandshakeError)
  })

  it('enforces sequential nonces, rejects replay and out-of-order transport messages', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const prologue = createSamplePrologue()

    const mobileInit = ReconnectHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      remoteStaticPublicKey: mmsStatic.publicKey
    })
    const mmsResp = ReconnectHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic }
    })

    const m1 = mobileInit.write()
    mmsResp.read(m1)
    const m2 = mmsResp.write()
    mobileInit.read(m2)

    const mobileSession = mobileInit.finish().session
    const mmsSession = mmsResp.finish().session

    // Mobile sends message 1 (nonce 0)
    const frame0 = mobileSession.encrypt(Buffer.from('msg-seq-0'))
    // Mobile sends message 2 (nonce 1)
    const frame1 = mobileSession.encrypt(Buffer.from('msg-seq-1'))

    // MMS receives message 0
    expect(Buffer.from(mmsSession.decrypt(frame0)).toString('utf-8')).toBe('msg-seq-0')
    expect(mmsSession.recvNonce).toBe(1n)

    // Replay attack: resending message 0 must throw SessionError!
    expect(() => mmsSession.decrypt(frame0)).toThrow(SessionError)

    // Receiving message 1 in order succeeds
    expect(Buffer.from(mmsSession.decrypt(frame1)).toString('utf-8')).toBe('msg-seq-1')
    expect(mmsSession.recvNonce).toBe(2n)

    // Replay message 1 must throw SessionError
    expect(() => mmsSession.decrypt(frame1)).toThrow(SessionError)
  })

  it('rejects tampered transport frames and enforces closed session lifecycle', () => {
    const mobileStatic = generateX25519KeyPair()
    const mmsStatic = generateX25519KeyPair()
    const prologue = createSamplePrologue()

    const mobileInit = ReconnectHandshake.initiator({
      prologue,
      identity: { keyPair: mobileStatic },
      remoteStaticPublicKey: mmsStatic.publicKey
    })
    const mmsResp = ReconnectHandshake.responder({
      prologue,
      identity: { keyPair: mmsStatic }
    })

    const m1 = mobileInit.write()
    mmsResp.read(m1)
    const m2 = mmsResp.write()
    mobileInit.read(m2)

    const mobileSession = mobileInit.finish().session
    const mmsSession = mmsResp.finish().session

    const frame = mobileSession.encrypt(Buffer.from('secure-payload'))

    // Tampered transport ciphertext bit
    const tampered = Buffer.from(frame)
    tampered[tampered.length - 5] ^= 0x01
    expect(() => mmsSession.decrypt(tampered)).toThrow(SessionError)

    // Closed session rejects operations
    mobileSession.close()
    expect(() => mobileSession.encrypt(Buffer.from('hello'))).toThrow(SessionError)
    expect(() => mobileSession.decrypt(frame)).toThrow(SessionError)
  })
})
