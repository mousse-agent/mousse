import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  encodePrologue,
  type PrologueContext
} from '../src/mms/control/crypto/prologue'
import {
  publicKeyFromPrivate
} from '../src/mms/control/crypto/keys'
import {
  PairingHandshake,
  ReconnectHandshake,
  runPairingHandshake,
  runReconnectHandshake
} from '../src/mms/control/crypto/noise'
import {
  encodeRelayFrame,
  decodeRelayFrame,
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN
} from '../src/mms/control/crypto/framing'
import {
  encodeQrUri,
  parseQrUri,
  canonicalizeQrPayload
} from '../src/mms/control/pairing/pairingQr'
import {
  buildRelayAuthMessage
} from '../src/mms/control/relay/relayClient'
import {
  requestEnvelope,
  responseResultEnvelope,
  eventEnvelope,
  canonicalizeEnvelope,
  encodeEnvelopeBytes
} from '../src/mms/control/relay/envelopes'
import {
  wireModeFromStorage,
  storageModeFromWire
} from '../src/shared/controlTypes'

const frozen = JSON.parse(
  readFileSync(join(__dirname, '..', 'test-vectors', 'control-protocol-2.0.json'), 'utf8')
) as {
  name: string
  protocolMajor: number
  protocolMinor: number
  keys: {
    initiatorStaticPrivate: string
    initiatorStaticPublic: string
    responderStaticPrivate: string
    responderStaticPublic: string
    initiatorEphemeralPrivate: string
    initiatorEphemeralPublic: string
    responderEphemeralPrivate: string
    responderEphemeralPublic: string
    pairingSecret: string
  }
  qr: {
    hosted: { input: any; canonicalJson: string; canonicalJsonHex: string; uri: string }
    selfHosted: { input: any; canonicalJson: string; uri: string }
  }
  prologue: {
    input: PrologueContext
    bytesHex: string
    bytesBase64url: string
  }
  pairingHandshake: {
    pattern: string
    initiatorPayloadHex: string
    responderPayloadHex: string
    message1FrameHex: string
    message2FrameHex: string
    message3FrameHex: string
    handshakeHashHex: string
    transport: {
      plaintextHex: string
      ciphertextFrameHex: string
      decryptedPlaintextHex: string
    }
  }
  reconnectHandshake: {
    pattern: string
    initiatorPayloadHex: string
    responderPayloadHex: string
    message1FrameHex: string
    message2FrameHex: string
    handshakeHashHex: string
    transport: {
      plaintextHex: string
      ciphertextFrameHex: string
    }
  }
  relay: {
    frame: {
      samplePayloadHex: string
      controlFrameHex: string
      dataFrameHex: string
    }
    authMobile: { message: any; json: string }
    authMms: { message: any; json: string }
  }
  envelopes: {
    request: { object: any; canonicalJson: string; bytesHex: string }
    response: { object: any; canonicalJson: string; bytesHex: string }
    event: { object: any; canonicalJson: string; bytesHex: string }
  }
}

function hex(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('hex')
}

function hexToBytes(h: string): Uint8Array {
  return new Uint8Array(Buffer.from(h, 'hex'))
}

describe('Control Protocol 2.0 - Frozen Wire Vector Conformance', () => {
  it('matches naming and mode storage boundary mappings', () => {
    expect(wireModeFromStorage('self_hosted')).toBe('self-hosted')
    expect(wireModeFromStorage('hosted')).toBe('hosted')
    expect(storageModeFromWire('self-hosted')).toBe('self_hosted')
    expect(storageModeFromWire('hosted')).toBe('hosted')
  })

  it('matches deterministic key material vectors', () => {
    const initPriv = hexToBytes(frozen.keys.initiatorStaticPrivate)
    const initPub = publicKeyFromPrivate(initPriv)
    expect(hex(initPub)).toBe(frozen.keys.initiatorStaticPublic)

    const respPriv = hexToBytes(frozen.keys.responderStaticPrivate)
    const respPub = publicKeyFromPrivate(respPriv)
    expect(hex(respPub)).toBe(frozen.keys.responderStaticPublic)

    const initEphPriv = hexToBytes(frozen.keys.initiatorEphemeralPrivate)
    const initEphPub = publicKeyFromPrivate(initEphPriv)
    expect(hex(initEphPub)).toBe(frozen.keys.initiatorEphemeralPublic)

    const respEphPriv = hexToBytes(frozen.keys.responderEphemeralPrivate)
    const respEphPub = publicKeyFromPrivate(respEphPriv)
    expect(hex(respEphPub)).toBe(frozen.keys.responderEphemeralPublic)
  })

  it('encodes exact prologue bytes and base64url', () => {
    const bytes = encodePrologue(frozen.prologue.input)
    expect(hex(bytes)).toBe(frozen.prologue.bytesHex)
    expect(Buffer.from(bytes).toString('base64url')).toBe(frozen.prologue.bytesBase64url)
  })

  it('reproduces hosted and self-hosted QR canonical JSON and URIs', () => {
    // Hosted QR
    expect(canonicalizeQrPayload(frozen.qr.hosted.input)).toBe(frozen.qr.hosted.canonicalJson)
    expect(Buffer.from(canonicalizeQrPayload(frozen.qr.hosted.input), 'utf-8').toString('hex')).toBe(
      frozen.qr.hosted.canonicalJsonHex
    )
    expect(encodeQrUri(frozen.qr.hosted.input)).toBe(frozen.qr.hosted.uri)
    const parsedHosted = parseQrUri(frozen.qr.hosted.uri, { rejectExpired: false })
    expect(parsedHosted).toEqual(frozen.qr.hosted.input)

    // Self-hosted QR
    expect(canonicalizeQrPayload(frozen.qr.selfHosted.input)).toBe(frozen.qr.selfHosted.canonicalJson)
    expect(encodeQrUri(frozen.qr.selfHosted.input)).toBe(frozen.qr.selfHosted.uri)
    const parsedSelfHosted = parseQrUri(frozen.qr.selfHosted.uri, { rejectExpired: false })
    expect(parsedSelfHosted).toEqual(frozen.qr.selfHosted.input)
  })

  it('reproduces Noise_XXpsk0 pairing handshake frames and transport ciphertext byte-for-byte', () => {
    const initIdentity = {
      keyPair: {
        privateKey: hexToBytes(frozen.keys.initiatorStaticPrivate),
        publicKey: hexToBytes(frozen.keys.initiatorStaticPublic)
      }
    }
    const respIdentity = {
      keyPair: {
        privateKey: hexToBytes(frozen.keys.responderStaticPrivate),
        publicKey: hexToBytes(frozen.keys.responderStaticPublic)
      }
    }
    const initEphemeral = {
      privateKey: hexToBytes(frozen.keys.initiatorEphemeralPrivate),
      publicKey: hexToBytes(frozen.keys.initiatorEphemeralPublic)
    }
    const respEphemeral = {
      privateKey: hexToBytes(frozen.keys.responderEphemeralPrivate),
      publicKey: hexToBytes(frozen.keys.responderEphemeralPublic)
    }
    const pairingSecret = hexToBytes(frozen.keys.pairingSecret)
    const initPayload = hexToBytes(frozen.pairingHandshake.initiatorPayloadHex)
    const respPayload = hexToBytes(frozen.pairingHandshake.responderPayloadHex)

    // Step-by-step handshake execution
    const init = PairingHandshake.initiator({
      prologue: frozen.prologue.input,
      identity: initIdentity,
      pairingSecret,
      ephemeral: initEphemeral
    })

    const resp = PairingHandshake.responder({
      prologue: frozen.prologue.input,
      identity: respIdentity,
      pairingSecret,
      ephemeral: respEphemeral
    })

    // Message 1
    const m1 = init.write(initPayload)
    expect(hex(m1)).toBe(frozen.pairingHandshake.message1FrameHex)
    const receivedInitPayload = resp.read(m1)
    expect(hex(receivedInitPayload)).toBe(frozen.pairingHandshake.initiatorPayloadHex)

    // Message 2
    const m2 = resp.write(respPayload)
    expect(hex(m2)).toBe(frozen.pairingHandshake.message2FrameHex)
    const receivedRespPayload = init.read(m2)
    expect(hex(receivedRespPayload)).toBe(frozen.pairingHandshake.responderPayloadHex)

    // Message 3
    const m3 = init.write()
    expect(hex(m3)).toBe(frozen.pairingHandshake.message3FrameHex)
    resp.read(m3)

    // Completion & hash
    const initRes = init.finish()
    const respRes = resp.finish()
    expect(hex(initRes.handshakeHash)).toBe(frozen.pairingHandshake.handshakeHashHex)
    expect(hex(respRes.handshakeHash)).toBe(frozen.pairingHandshake.handshakeHashHex)

    // Transport encryption
    const plaintext = hexToBytes(frozen.pairingHandshake.transport.plaintextHex)
    const cipherFrame = initRes.session.encrypt(plaintext)
    expect(hex(cipherFrame)).toBe(frozen.pairingHandshake.transport.ciphertextFrameHex)

    // Transport decryption (increments recv nonce to 1)
    const decrypted = respRes.session.decrypt(cipherFrame)
    expect(hex(decrypted)).toBe(frozen.pairingHandshake.transport.decryptedPlaintextHex)

    // Sanity: a fresh handshake session decrypts the frozen ciphertext vector
    const fresh = runPairingHandshake({
      prologue: frozen.prologue.input,
      initiatorIdentity: initIdentity,
      responderIdentity: respIdentity,
      pairingSecret,
      initiatorPayload: initPayload,
      responderPayload: respPayload,
      initiatorEphemeral: initEphemeral,
      responderEphemeral: respEphemeral
    })
    const frozenFrame = hexToBytes(frozen.pairingHandshake.transport.ciphertextFrameHex)
    expect(hex(fresh.responder.session.decrypt(frozenFrame))).toBe(
      frozen.pairingHandshake.transport.plaintextHex
    )
  })

  it('reproduces Noise_IK reconnect handshake frames and transport ciphertext byte-for-byte', () => {
    const initIdentity = {
      keyPair: {
        privateKey: hexToBytes(frozen.keys.initiatorStaticPrivate),
        publicKey: hexToBytes(frozen.keys.initiatorStaticPublic)
      }
    }
    const respIdentity = {
      keyPair: {
        privateKey: hexToBytes(frozen.keys.responderStaticPrivate),
        publicKey: hexToBytes(frozen.keys.responderStaticPublic)
      }
    }
    const initEphemeral = {
      privateKey: hexToBytes(frozen.keys.initiatorEphemeralPrivate),
      publicKey: hexToBytes(frozen.keys.initiatorEphemeralPublic)
    }
    const respEphemeral = {
      privateKey: hexToBytes(frozen.keys.responderEphemeralPrivate),
      publicKey: hexToBytes(frozen.keys.responderEphemeralPublic)
    }
    const initPayload = hexToBytes(frozen.reconnectHandshake.initiatorPayloadHex)
    const respPayload = hexToBytes(frozen.reconnectHandshake.responderPayloadHex)

    const init = ReconnectHandshake.initiator({
      prologue: frozen.prologue.input,
      identity: initIdentity,
      remoteStaticPublicKey: respIdentity.keyPair.publicKey,
      ephemeral: initEphemeral
    })

    const resp = ReconnectHandshake.responder({
      prologue: frozen.prologue.input,
      identity: respIdentity,
      expectedInitiatorStatic: initIdentity.keyPair.publicKey,
      ephemeral: respEphemeral
    })

    // Message 1
    const m1 = init.write(initPayload)
    expect(hex(m1)).toBe(frozen.reconnectHandshake.message1FrameHex)
    const receivedInitPayload = resp.read(m1)
    expect(hex(receivedInitPayload)).toBe(frozen.reconnectHandshake.initiatorPayloadHex)

    // Message 2
    const m2 = resp.write(respPayload)
    expect(hex(m2)).toBe(frozen.reconnectHandshake.message2FrameHex)
    const receivedRespPayload = init.read(m2)
    expect(hex(receivedRespPayload)).toBe(frozen.reconnectHandshake.responderPayloadHex)

    // Completion & hash
    const initRes = init.finish()
    const respRes = resp.finish()
    expect(hex(initRes.handshakeHash)).toBe(frozen.reconnectHandshake.handshakeHashHex)
    expect(hex(respRes.handshakeHash)).toBe(frozen.reconnectHandshake.handshakeHashHex)

    // Transport encryption
    const plaintext = hexToBytes(frozen.reconnectHandshake.transport.plaintextHex)
    const cipherFrame = initRes.session.encrypt(plaintext)
    expect(hex(cipherFrame)).toBe(frozen.reconnectHandshake.transport.ciphertextFrameHex)

    // Fresh responder session decrypts the frozen ciphertext vector
    const again = runReconnectHandshake({
      prologue: frozen.prologue.input,
      initiatorIdentity: initIdentity,
      responderIdentity: respIdentity,
      initiatorEphemeral: initEphemeral,
      responderEphemeral: respEphemeral
    })
    const frozenFrame = hexToBytes(frozen.reconnectHandshake.transport.ciphertextFrameHex)
    const decryptedFrozen = again.responder.session.decrypt(frozenFrame)
    expect(hex(decryptedFrozen)).toBe(frozen.reconnectHandshake.transport.plaintextHex)
  })

  it('reproduces relay binary frames and authentication JSON', () => {
    const samplePayload = hexToBytes(frozen.relay.frame.samplePayloadHex)

    // Control frame: flags = 0x03 (CONTROL | FIN)
    const controlFrame = encodeRelayFrame(samplePayload, FRAME_FLAG_CONTROL | FRAME_FLAG_FIN)
    expect(hex(controlFrame)).toBe(frozen.relay.frame.controlFrameHex)

    // Data frame: flags = 0x01 (FIN)
    const dataFrame = encodeRelayFrame(samplePayload, FRAME_FLAG_FIN)
    expect(hex(dataFrame)).toBe(frozen.relay.frame.dataFrameHex)

    // Frame decoding
    const decoded = decodeRelayFrame(dataFrame)
    expect(decoded.flags).toBe(FRAME_FLAG_FIN)
    expect(hex(decoded.payload)).toBe(frozen.relay.frame.samplePayloadHex)

    // Mobile auth JSON
    expect(JSON.stringify(frozen.relay.authMobile.message)).toBe(frozen.relay.authMobile.json)
    const mobileAuthMsg = buildRelayAuthMessage({
      admission: frozen.relay.authMobile.message.admission
    })
    expect(JSON.stringify(mobileAuthMsg)).toBe(frozen.relay.authMobile.json)

    // MMS auth JSON with connectorEpoch
    expect(JSON.stringify(frozen.relay.authMms.message)).toBe(frozen.relay.authMms.json)
    const mmsAuthMsg = buildRelayAuthMessage({
      admission: frozen.relay.authMms.message.admission,
      connectorEpoch: frozen.relay.authMms.message.connectorEpoch
    })
    expect(JSON.stringify(mmsAuthMsg)).toBe(frozen.relay.authMms.json)
  })

  it('reproduces canonical application envelopes byte-for-byte', () => {
    // Request envelope
    const req = requestEnvelope({
      requestId: 'req_test_001',
      method: 'agent.status',
      params: { projectId: 'proj_01' },
      idempotencyKey: 'idem_test_001'
    })
    expect(canonicalizeEnvelope(req)).toBe(frozen.envelopes.request.canonicalJson)
    expect(hex(encodeEnvelopeBytes(req))).toBe(frozen.envelopes.request.bytesHex)

    // Response envelope
    const resp = responseResultEnvelope('req_test_001', { status: 'idle' })
    expect(canonicalizeEnvelope(resp)).toBe(frozen.envelopes.response.canonicalJson)
    expect(hex(encodeEnvelopeBytes(resp))).toBe(frozen.envelopes.response.bytesHex)

    // Event envelope
    const evt = eventEnvelope({
      instanceId: 'daemon_test_001',
      sequence: 1,
      eventType: 'thread.updated',
      payload: { id: 'thread_01' }
    })
    expect(canonicalizeEnvelope(evt)).toBe(frozen.envelopes.event.canonicalJson)
    expect(hex(encodeEnvelopeBytes(evt))).toBe(frozen.envelopes.event.bytesHex)
  })
})
