import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  generateDeviceKeyBundle,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  computeFingerprint,
  computeSharedSecret,
  signEd25519,
  verifyEd25519
} from '../src/mms/control/crypto/keys'
import {
  encryptChaCha20Poly1305,
  decryptChaCha20Poly1305,
  formatNoiseNonce,
  deriveKeysHkdf,
  hmacSha256
} from '../src/mms/control/crypto/aead'
import {
  NoiseXxPsk0Initiator,
  NoiseXxPsk0Responder,
  NoiseIkInitiator,
  NoiseIkResponder
} from '../src/mms/control/crypto/noise'
import {
  chunkMessage,
  parseChunk,
  MessageReassembler,
  MAX_CHUNK_PAYLOAD_BYTES
} from '../src/mms/control/crypto/framing'
import { CHUNK_MAX_BYTES } from '../src/mms/control/constants'

describe('Control Protocol 2.0 - Cryptographic Primitives', () => {
  it('generates valid X25519 keypairs and agrees on common secret via ECDH', () => {
    const alice = generateX25519KeyPair()
    const bob = generateX25519KeyPair()

    expect(alice.publicKey.length).toBe(32)
    expect(alice.privateKey.length).toBe(32)
    expect(bob.publicKey.length).toBe(32)
    expect(bob.privateKey.length).toBe(32)

    const secretA = computeSharedSecret(alice.privateKey, bob.publicKey)
    const secretB = computeSharedSecret(bob.privateKey, alice.publicKey)

    expect(secretA.length).toBe(32)
    expect(secretA.equals(secretB)).toBe(true)
  })

  it('generates valid Ed25519 keypairs, signs messages, and verifies signatures', () => {
    const keys = generateEd25519KeyPair()
    const message = Buffer.from('mousse:test-pairing-receipt:12345')

    const signature = signEd25519(message, keys.privateKey)
    expect(signature.length).toBe(64)

    const valid = verifyEd25519(message, signature, keys.publicKey)
    expect(valid).toBe(true)

    // Tampered message fails verification
    const tampered = Buffer.from('mousse:test-pairing-receipt:99999')
    const invalid = verifyEd25519(tampered, signature, keys.publicKey)
    expect(invalid).toBe(false)
  })

  it('computes friendly 19-character formatted fingerprints from public keys', () => {
    const keys = generateEd25519KeyPair()
    const fp = computeFingerprint(keys.publicKey)
    expect(fp.length).toBe(19)
    expect(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(fp)).toBe(true)
  })

  it('generates full device key bundles with transport and signing keys', () => {
    const bundle = generateDeviceKeyBundle()
    expect(bundle.transport.publicKey.length).toBe(32)
    expect(bundle.transport.privateKey.length).toBe(32)
    expect(bundle.signing.publicKey.length).toBe(32)
    expect(bundle.signing.privateKey.length).toBe(32)

    const fp = computeFingerprint(bundle.signing.publicKey)
    expect(fp.length).toBe(19)
  })

  it('encrypts and decrypts with ChaCha20-Poly1305 and authenticates AAD', () => {
    const key = randomBytes(32)
    const nonce = formatNoiseNonce(42n)
    const plaintext = Buffer.from('Hello Mousse Plus End-to-End Encryption!')
    const aad = Buffer.from('protocol-v2-header')

    const ciphertext = encryptChaCha20Poly1305(key, nonce, plaintext, aad)
    // Poly1305 tag is 16 bytes appended
    expect(ciphertext.length).toBe(plaintext.length + 16)

    const decrypted = decryptChaCha20Poly1305(key, nonce, ciphertext, aad)
    expect(decrypted.toString('utf-8')).toBe(plaintext.toString('utf-8'))

    // Mismatched AAD fails authentication
    const badAad = Buffer.from('tampered-aad')
    expect(() => decryptChaCha20Poly1305(key, nonce, ciphertext, badAad)).toThrow()

    // Tampered ciphertext fails authentication
    const tamperedCipher = Buffer.from(ciphertext)
    tamperedCipher[0] ^= 0xff
    expect(() => decryptChaCha20Poly1305(key, nonce, tamperedCipher, aad)).toThrow()
  })

  it('derives symmetric keys using HKDF-SHA256 and HMAC-SHA256', () => {
    const ikm = Buffer.from('initial-keying-material')
    const salt = Buffer.from('noise-salt')
    const info = Buffer.from('mousse-session-keys')

    const okm = deriveKeysHkdf(ikm, salt, info, 64)
    expect(okm.length).toBe(64)

    const mac = hmacSha256(salt, ikm)
    expect(mac.length).toBe(32)
  })
})

describe('Control Protocol 2.0 - Noise Handshakes', () => {
  it('executes Noise_XXpsk0 handshake between mobile initiator and desktop responder', () => {
    const mobileStatic = generateX25519KeyPair()
    const desktopStatic = generateX25519KeyPair()
    const pairingPsk = randomBytes(32)
    const prologue = Buffer.from('mousse:v2:pairing:test-pairing-123')

    const initiator = new NoiseXxPsk0Initiator(mobileStatic, pairingPsk, prologue)
    const responder = new NoiseXxPsk0Responder(desktopStatic, pairingPsk, prologue)

    // Msg 1: -> e
    const msg1 = initiator.createMessage1()
    responder.processMessage1(msg1)

    // Msg 2: <- e, ee, s, es
    const msg2 = responder.createMessage2(Buffer.from('Hello from desktop responder!'))
    const { payload: resPayload } = initiator.processMessage2(msg2)
    expect(resPayload.toString('utf-8')).toBe('Hello from desktop responder!')

    // Msg 3: -> s, se
    const msg3 = initiator.createMessage3(Buffer.from('Hello from mobile initiator!'))
    const { payload: initPayload, result: responderResult } = responder.processMessage3(msg3.message)
    expect(initPayload.toString('utf-8')).toBe('Hello from mobile initiator!')

    const initiatorResult = msg3.result

    // Verify authenticated peer static keys
    expect(responderResult.remoteStaticKey).toEqual(mobileStatic.publicKey)
    expect(initiatorResult.remoteStaticKey).toEqual(desktopStatic.publicKey)

    // Test bidirectional transport encryption
    const ping = Buffer.from('Ping from mobile!')
    const cipherPing = initiatorResult.sendCipher.encryptWithAd(Buffer.alloc(0), ping)
    const plainPing = responderResult.recvCipher.decryptWithAd(Buffer.alloc(0), cipherPing)
    expect(plainPing.toString('utf-8')).toBe('Ping from mobile!')

    const pong = Buffer.from('Pong from desktop!')
    const cipherPong = responderResult.sendCipher.encryptWithAd(Buffer.alloc(0), pong)
    const plainPong = initiatorResult.recvCipher.decryptWithAd(Buffer.alloc(0), cipherPong)
    expect(plainPong.toString('utf-8')).toBe('Pong from desktop!')
  })

  it('executes Noise_IK handshake (reconnect) using stored static keys', () => {
    const mobileStatic = generateX25519KeyPair()
    const desktopStatic = generateX25519KeyPair()
    const prologue = Buffer.from('mousse:v2:reconnect:session-456')

    const initiator = new NoiseIkInitiator(mobileStatic, desktopStatic.publicKey, prologue)
    const responder = new NoiseIkResponder(desktopStatic, mobileStatic.publicKey, prologue)

    // Msg 1: -> e, es, s, ss
    const msg1 = initiator.createMessage1(Buffer.from('Reconnect mobile hello'))
    const { payload: reqPayload } = responder.processMessage1(msg1)
    expect(reqPayload.toString('utf-8')).toBe('Reconnect mobile hello')

    // Msg 2: <- e, ee, se
    const msg2 = responder.createMessage2(Buffer.from('Reconnect desktop ack'))
    const { payload: ackPayload, result: initiatorResult } = initiator.processMessage2(msg2.message)
    expect(ackPayload.toString('utf-8')).toBe('Reconnect desktop ack')

    const responderResult = msg2.result

    const msg = Buffer.from('Reconnected message')
    const encrypted = initiatorResult.sendCipher.encryptWithAd(Buffer.alloc(0), msg)
    const decrypted = responderResult.recvCipher.decryptWithAd(Buffer.alloc(0), encrypted)
    expect(decrypted.toString('utf-8')).toBe('Reconnected message')
  })
})

describe('Control Protocol 2.0 - Framing and Chunking', () => {
  it('frames small messages into a single <=64KB chunk with 8-byte header', () => {
    const payload = Buffer.from('Small control request')
    const streamId = 101
    const chunks = chunkMessage(payload, streamId)

    expect(chunks.length).toBe(1)
    const parsed = parseChunk(chunks[0])
    expect(parsed.msgId).toBe(streamId)
    expect(parsed.chunkIndex).toBe(0)
    expect(parsed.totalChunks).toBe(1)
    expect(parsed.payload.toString('utf-8')).toBe('Small control request')
  })

  it('chunks messages larger than 64KB and reassembles them accurately', () => {
    const largeMessage = randomBytes(MAX_CHUNK_PAYLOAD_BYTES * 2 + 1024) // Spans 3 chunks
    const streamId = 202

    const chunks = chunkMessage(largeMessage, streamId)
    expect(chunks.length).toBe(3)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
    }

    const reassembler = new MessageReassembler()
    let assembled: Buffer | null = null

    for (let i = 0; i < chunks.length; i++) {
      const parsed = parseChunk(chunks[i])
      const res = reassembler.push(parsed)
      if (i < chunks.length - 1) {
        expect(res).toBeNull()
      } else {
        assembled = res
      }
    }

    expect(assembled).not.toBeNull()
    expect(assembled!.length).toBe(largeMessage.length)
    expect(assembled!.equals(largeMessage)).toBe(true)
  })
})
