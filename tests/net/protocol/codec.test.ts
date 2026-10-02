import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash, createHmac, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJson, encodeEnvelope, decodeEnvelope, decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, parseProtocolJson } from '../../../src/mms/net/sync/codec'
import { classifyWireMessage, eventBodySchemas, protocolRegistry, validateEnvelope, validateEventBody, validateStreamDescriptor, validateSignedDocument, validateWireMessage, wireMessageSchemas } from '../../../src/shared/net/schemas'
import { META_EVENT_TYPES, CONTENT_EVENT_TYPES, isCritical } from '../../../src/shared/net/envelope'
import { NET_ERRORS, NetError } from '../../../src/shared/net/errors'
import { laneFor, type WireMessage } from '../../../src/shared/net/wire'

const vectors = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/catalogue.json', import.meta.url), 'utf8'))
const signedVectors = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/signed-envelopes.json', import.meta.url), 'utf8'))
const proofVector = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/enrollment-proof.json', import.meta.url), 'utf8'))
const spaceProofVector = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/space-join-proof.json', import.meta.url), 'utf8'))
const spaceJoinReceipt = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/space-join-receipt.json', import.meta.url), 'utf8'))
const snapshotVector = JSON.parse(readFileSync(new URL('../../../test-vectors/net/protocol/multi-epoch-snapshot.json', import.meta.url), 'utf8'))
const str = 'str_00000000000000000000000000' as const
const rawMessage = (header: string, trailing = new Uint8Array()): Uint8Array => {
  const json = new TextEncoder().encode(header), bytes = new Uint8Array(4 + json.length + trailing.length)
  new DataView(bytes.buffer).setUint32(0, json.length, false); bytes.set(json, 4); bytes.set(trailing, 4 + json.length)
  return bytes
}
const code = (fn: () => unknown, expected = 'bad_request'): void => {
  try { fn(); throw new Error('Expected rejection') } catch (error) { expect(error).toBeInstanceOf(NetError); expect((error as NetError).code).toBe(expected) }
}

describe('P0 protocol catalogue', () => {
  it('covers and validates every wire type and event body, including all result variants', () => {
    expect(new Set(vectors.messages.map((m: WireMessage) => m.t))).toEqual(new Set(Object.keys(wireMessageSchemas)))
    expect(new Set(vectors.events.map((e: { type: string }) => e.type))).toEqual(new Set([...META_EVENT_TYPES, ...CONTENT_EVENT_TYPES]))
    expect(Object.keys(eventBodySchemas).sort()).toEqual([...protocolRegistry.eventTypes].sort())
    for (const header of vectors.messages as WireMessage[]) {
      expect(validateWireMessage(header), JSON.stringify(validateWireMessage.errors)).toBe(true)
      const parts = 'parts' in header ? header.parts.map((size) => new Uint8Array(size)) : []
      expect(decodeMessage(encodeMessage(header, parts), laneFor(header)).header).toEqual(header)
      expect(validateWireMessage({ ...header, surprise: true })).toBe(false)
    }
    for (const envelope of vectors.events) {
      expect(validateEnvelope(envelope), JSON.stringify(validateEnvelope.errors)).toBe(true)
      expect(validateEnvelope({ ...envelope, body: { ...envelope.body, surprise: true } })).toBe(false)
    }
  })
  it('validates each signed document and rejects confused delegation kinds and unsafe counters', () => {
    for (const [kind, document] of Object.entries(vectors.documents)) {
      expect(validateSignedDocument(kind as keyof typeof vectors.documents, document)).toBe(true)
      expect(validateSignedDocument(kind as keyof typeof vectors.documents, { ...(document as object), surprise: true })).toBe(false)
    }
    expect(validateWireMessage({ t: 'ping', n: Number.MAX_SAFE_INTEGER + 1, now: 0 })).toBe(false)
    expect(validateWireMessage({ t: 'ping', n: -1, now: 0 })).toBe(false)
    expect(validateWireMessage({ ...vectors.messages[0], caps: ['streams.v1', 'streams.v1'] })).toBe(false)
  })
  it('keeps unknown event bytes and registry criticality, distinguishes unknown wire messages', () => {
    const value = { ...vectors.events[0], type: 'future.render', body: { future: 123 }, extension: true }
    expect(decodeEnvelope(new TextEncoder().encode(JSON.stringify(value))).envelope).toEqual(value)
    expect(isCritical(value, false)).toBe(true)
    expect(isCritical({ ...value, crit: false }, false)).toBe(false)
    expect(isCritical({ ...value, crit: false }, true)).toBe(true)
    expect(isCritical({ type: 'participants.changed', crit: false }, false)).toBe(true)
    expect(isCritical({ type: 'message.posted', crit: true }, false)).toBe(true)
    expect(isCritical({ type: 'message.posted', crit: false }, false)).toBe(false)
    expect(classifyWireMessage({ t: 'future.wire' })).toBe('unknown')
    code(() => decodeMessage(rawMessage('{"t":"future.wire"}')), 'unsupported_version')
    expect(classifyWireMessage({ t: 'ping' })).toBe('invalid')
  })
  it('accepts future minor structural content for fail-closed critical handling downstream', () => {
    const future = { ...vectors.events[0], type: 'message.posted', minor: 1, crit: true, body: { future: true } }
    expect(validateEnvelope(future)).toBe(true)
    expect(isCritical(future, false)).toBe(true)
    expect(validateEnvelope({ ...vectors.events[0], minor: 0, body: { future: true } })).toBe(false)
  })
})

describe('P0 exact bytes and hostile inputs', () => {
  it('verifies frozen Ed25519 signatures over exact bytes and rejects tampering/reserialization', () => {
    const publicKey = createPublicKey({ key: Buffer.from(signedVectors.publicKeySpki, 'base64url'), format: 'der', type: 'spki' })
    for (const vector of signedVectors.cases) {
      const bytes = Buffer.from(vector.envelope, 'base64url'), sig = Buffer.from(vector.signature, 'base64url')
      expect(verify(null, bytes, publicKey, sig)).toBe(vector.valid)
      if (vector.valid) {
        expect(decodeEnvelope(bytes).bytes).toBe(bytes)
        expect(verify(null, canonicalJson(decodeEnvelope(bytes).envelope), publicKey, sig)).toBe(false)
      }
    }
  })
  it('rejects duplicate escaped keys, malformed UTF8, BOM, trailing JSON, unsafe numbers and nesting', () => {
    for (const json of ['{"t":"ping","t":"pong","n":1,"now":0}', '{"x":1,"\\u0078":2}', '{"n":9007199254740993}', '{"n":1e999}', '{"x":"\\ud800"}', '[1,]', '{}{}', '\ufeff{}', '['.repeat(40) + '0' + ']'.repeat(40)]) {
      expect(() => parseProtocolJson(new TextEncoder().encode(json))).toThrow(NetError)
    }
    code(() => parseProtocolJson(new Uint8Array([0xc3, 0x28])))
  })
  it('rejects ambiguous result variants, noncanonical base64url and author confusion', () => {
    expect(validateWireMessage({ t: 'rpc.result', id: 'rpc_00000000000000000000000000', result: null, error: vectors.error })).toBe(false)
    expect(validateEnvelope({ ...vectors.events[0], author: { ...vectors.events[0].author, bot: 'bot_00000000000000000000000000' } })).toBe(false)
    expect(validateSignedDocument('signed', { payload: 'Zh', sig: 'A'.repeat(86) })).toBe(false)
    expect(validateSignedDocument('signed', { payload: 'Zg==', sig: 'A'.repeat(86) })).toBe(false)
    expect(validateEnvelope({ ...vectors.events[0], sealed: { keyEpoch: 1, nonce: 'A'.repeat(16), ct: 'A'.repeat(24) } })).toBe(false)
  })
  it('rejects header/parts mismatches, trailing bytes, wrong lane and oversized messages', () => {
    const append = { t: 'append', stream: str, id: 'evt_00000000000000000000000000', parts: [1, 64] } as WireMessage
    code(() => encodeMessage(append, [new Uint8Array(1)]))
    code(() => encodeMessage(append, [new Uint8Array(2), new Uint8Array(64)]))
    code(() => decodeMessage(rawMessage(JSON.stringify(append), new Uint8Array(64))))
    code(() => decodeMessage(rawMessage('{"t":"ping","n":1,"now":0}', new Uint8Array(1))))
    code(() => decodeMessage(encodeMessage({ t: 'ping', n: 1, now: 0 }), 'bulk'))
    code(() => decodeMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1)), 'too_large')
    code(() => decodeEnvelope(new Uint8Array(65537)), 'too_large')
  })
  it('rejects mispaired record signatures, sequence holes and snapshot epochs', () => {
    const record = { seq: 1, epoch: 1, recvTs: 0 }
    code(() => encodeMessage({ t: 'events', stream: str, records: [record], replay: true, parts: [1, 63] }, [new Uint8Array(1), new Uint8Array(63)]))
    code(() => encodeMessage({ t: 'events', stream: str, records: [record, { ...record, seq: 3 }], replay: true, parts: [1, 64, 1, 64] }, [new Uint8Array(1), new Uint8Array(64), new Uint8Array(1), new Uint8Array(64)]))
    code(() => encodeMessage({ t: 'snapshot.chunk', stream: str, records: [{ ...record, epoch: 3 }], epoch: 2, throughSeq: 1, done: true, parts: [1, 64] }, [new Uint8Array(1), new Uint8Array(64)]))
  })
  it('defines stable canonical proof inputs and catches non-JSON values before signing', () => {
    expect(new TextDecoder().decode(canonicalJson({ z: [true, null], a: { b: 2, a: 'é' } }))).toBe('{"a":{"a":"é","b":2},"z":[true,null]}')
    expect(() => canonicalJson({ x: undefined })).toThrow(NetError)
    expect(() => canonicalJson({ x: NaN })).toThrow(NetError)
    expect(() => canonicalJson(new Array(1))).toThrow(NetError)
  })
  it('binds frozen enrollment proof to exact canonical request and exporter', () => {
    const proofKey = Buffer.from(hkdfSync('sha256', Buffer.from(proofVector.token, 'base64url'), Buffer.alloc(0), Buffer.from('mousse-net/enroll/v1'), 32))
    expect(proofKey.toString('base64url')).toBe(proofVector.proofKey)
    const canonical = canonicalJson(proofVector.requestWithoutProof)
    expect(Buffer.from(canonical).toString()).toBe(proofVector.canonicalRequest)
    const hash = createHash('sha256').update(canonical).digest()
    expect(hash.toString('base64url')).toBe(proofVector.requestHash)
    const proof = (exporter: Buffer, requestHash: Buffer): string => createHmac('sha256', proofKey).update(Buffer.concat([exporter, Buffer.from(proofVector.requestWithoutProof.invite), requestHash])).digest('base64url')
    expect(proof(Buffer.from(proofVector.exporter, 'base64url'), hash)).toBe(proofVector.proof)
    expect(proof(Buffer.alloc(32), hash)).not.toBe(proofVector.proof)
    const changed = createHash('sha256').update(canonicalJson({ ...proofVector.requestWithoutProof, name: 'altered' })).digest()
    expect(proof(Buffer.from(proofVector.exporter, 'base64url'), changed)).not.toBe(proofVector.proof)
  })
  it('bounds UTF8 envelope bytes and validates opened private bodies and approval variants', () => {
    const sample = vectors.events.find((event: { type: string }) => event.type === 'message.posted')
    const baseline = encodeEnvelope(sample).length - Buffer.byteLength(sample.body.text)
    const exactly = { ...sample, body: { text: 'x'.repeat(65536 - baseline) } }
    expect(encodeEnvelope(exactly).length).toBe(65536)
    code(() => encodeEnvelope({ ...exactly, body: { text: exactly.body.text + 'é' } }), 'too_large')
    expect(validateEventBody('message.posted', { text: 'opened' })).toBe(true)
    expect(validateEventBody('message.posted', { text: 'opened', extension: true })).toBe(false)
    expect(validateEventBody('future.render', {})).toBe(false)
    for (const event of vectors.events.filter((event: { type: string }) => event.type.startsWith('bot.permission.'))) {
      expect(validateEventBody(event.type, event.body)).toBe(true)
    }
    const requested = vectors.events.find((event: { type: string; body: { kind?: string } }) => event.type === 'bot.permission.requested' && event.body.kind === 'runtimeAction')
    const { actionHash: _omitted, ...missingHash } = requested.body
    expect(validateEventBody(requested.type, missingHash)).toBe(false)
    expect(validateWireMessage({ t: 'error', error: { ...vectors.error, retryable: true } })).toBe(false)
    code(() => decodeMessage(rawMessage(JSON.stringify({ t: 'subscribed', stream: str, head: { epoch: 1, seq: 2 }, replayThrough: 3 }))))
    const edited = vectors.events.find((event: { type: string }) => event.type === 'message.edited')
    const { refs: _refs, ...withoutRefs } = edited
    expect(validateEnvelope(withoutRefs)).toBe(false)
  })
  it('preserves original snapshot epochs across a fixed final target and retains strict replay batches', () => {
    for (const chunk of snapshotVector.chunks as WireMessage[]) {
      const parts = 'parts' in chunk ? chunk.parts.map((size) => new Uint8Array(size)) : []
      expect(decodeMessage(encodeMessage(chunk, parts), 'bulk').header).toEqual(chunk)
    }
    const historic = snapshotVector.chunks[0]
    expect(historic.records[1].seq).toBeGreaterThan(historic.throughSeq)
    for (const records of [
      [{ epoch: 3, seq: 1, recvTs: 0 }],
      [{ epoch: 2, seq: 2, recvTs: 0 }],
      [{ epoch: 1, seq: 1, recvTs: 0 }, { epoch: 2, seq: 2, recvTs: 0 }],
      [{ epoch: 1, seq: 1, recvTs: 0 }, { epoch: 1, seq: 3, recvTs: 0 }]
    ]) {
      const lengths = records.flatMap(() => [1, 64]), parts = lengths.map((size) => new Uint8Array(size))
      code(() => encodeMessage({ ...historic, records, parts: lengths }, parts))
    }
    code(() => encodeMessage({ t: 'events', stream: str, replay: true, records: [{ epoch: 1, seq: 1, recvTs: 0 }, { epoch: 2, seq: 2, recvTs: 0 }], parts: [1, 64, 1, 64] }, [new Uint8Array(1), new Uint8Array(64), new Uint8Array(1), new Uint8Array(64)]))
  })
  it('rejects unsupported envelope major separately from malformed versions', () => {
    const sample = vectors.events.find((event: { type: string }) => event.type === 'message.posted')
    code(() => decodeEnvelope(new TextEncoder().encode(JSON.stringify({ ...sample, v: 2 }))), 'unsupported_version')
    for (const v of ['2', 1.5, 0, -1, null]) code(() => decodeEnvelope(new TextEncoder().encode(JSON.stringify({ ...sample, v }))))
    const { v: _version, ...noVersion } = sample
    code(() => decodeEnvelope(new TextEncoder().encode(JSON.stringify(noVersion))))
  })
  it('defines bounded space admission and exact host-signed member receipt bytes', () => {
    const request = vectors.messages.find((message: WireMessage) => message.t === 'space.join.request')
    expect(encodeMessage(request).length).toBeLessThanOrEqual(16384)
    const oversized = { ...request, roster: { ...request.roster, payload: 'A'.repeat(18000) } }
    expect(validateWireMessage(oversized)).toBe(true)
    code(() => encodeMessage(oversized), 'too_large')
    code(() => decodeMessage(rawMessage(JSON.stringify(oversized))), 'too_large')
    expect(validateWireMessage({ ...request, node: undefined })).toBe(false)
    expect(validateWireMessage({ ...spaceJoinReceipt.header, error: vectors.error })).toBe(false)
    const envelopeBytes = Buffer.from(spaceJoinReceipt.envelope, 'base64url'), signatureBytes = Buffer.from(spaceJoinReceipt.signature, 'base64url')
    const publicKey = createPublicKey({ key: Buffer.from(spaceJoinReceipt.publicKeySpki, 'base64url'), format: 'der', type: 'spki' })
    const decoded = decodeMessage(encodeMessage(spaceJoinReceipt.header, [envelopeBytes, signatureBytes]), 'control')
    expect(verify(null, decoded.parts[0], publicKey, decoded.parts[1])).toBe(true)
    expect(Buffer.from(decoded.parts[0]).equals(envelopeBytes)).toBe(true)
    expect(decodeEnvelope(decoded.parts[0]).envelope.type).toBe('member.joined')
  })
  it('domain-separates space-join proof and binds user, root, space, credentials and TLS exporter', () => {
    const proofKey = Buffer.from(hkdfSync('sha256', Buffer.from(spaceProofVector.token, 'base64url'), Buffer.alloc(0), Buffer.from('mousse-net/space-join/v1'), 32))
    expect(proofKey.toString('base64url')).toBe(spaceProofVector.proofKey)
    expect(proofKey.toString('base64url')).not.toBe(proofVector.proofKey)
    const request = spaceProofVector.requestWithoutProof, canonical = canonicalJson(request)
    expect(Buffer.from(canonical).toString()).toBe(spaceProofVector.canonicalRequest)
    const hash = createHash('sha256').update(canonical).digest()
    expect(hash.toString('base64url')).toBe(spaceProofVector.requestHash)
    const proof = (input: unknown, exporter = Buffer.from(spaceProofVector.exporter, 'base64url')): string => createHmac('sha256', proofKey).update(Buffer.concat([exporter, Buffer.from(request.invite), createHash('sha256').update(canonicalJson(input)).digest()])).digest('base64url')
    expect(proof(request)).toBe(spaceProofVector.proof)
    expect(proof(request, Buffer.alloc(32))).not.toBe(spaceProofVector.proof)
    for (const change of [{ space: 'spc_00000000000000000000000001' }, { user: 'usr_00000000000000000000000001' }, { rootKey: 'B'.repeat(42) + 'A' }, { node: 'nod_00000000000000000000000001' }, { delegation: { ...request.delegation, payload: 'e3' } }]) expect(proof({ ...request, ...change })).not.toBe(spaceProofVector.proof)
  })
  it('binds Bridge artifact refs to stream/event/blob and requires scoped publication', () => {
    const result = vectors.messages.find((message: { t: string; blob?: unknown }) => message.t === 'rpc.result' && message.blob)
    expect(validateWireMessage(result)).toBe(true)
    expect(validateWireMessage({ ...result, blob: result.blob.blob })).toBe(false)
    for (const missing of ['stream', 'event', 'blob']) {
      const incomplete = { ...result.blob }; delete incomplete[missing]
      expect(validateWireMessage({ ...result, blob: incomplete })).toBe(false)
    }
    const descriptor = vectors.streamDescriptors[0]
    expect(validateStreamDescriptor(descriptor)).toBe(true)
    const { artifact: _artifact, ...unbound } = descriptor
    expect(validateStreamDescriptor(unbound)).toBe(false)
    expect(validateStreamDescriptor({ ...descriptor, space: 'spc_00000000000000000000000000' })).toBe(false)
    expect(validateStreamDescriptor({ ...descriptor, kind: 'node.thread' })).toBe(false)
    expect(validateStreamDescriptor({ ...descriptor, artifact: { ...descriptor.artifact, caller: 'usr_00000000000000000000000000' } })).toBe(false)
    for (const event of vectors.events.filter((event: { type: string }) => event.type === 'artifact.published')) {
      expect(validateEnvelope(event)).toBe(true)
      expect(validateEnvelope({ ...event, blobs: [] })).toBe(false)
      const { blobs: _blobs, ...withoutReferences } = event
      expect(validateEnvelope(withoutReferences)).toBe(false)
      expect(validateEnvelope({ ...event, body: { ...event.body, purpose: 'unbound' } })).toBe(false)
    }
  })
  it('has a bounded decoder that returns a value or structured protocol error for arbitrary bytes', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 10000 }), (bytes) => {
      try { decodeMessage(bytes) } catch (error) { expect(error).toBeInstanceOf(NetError); expect(Object.hasOwn(NET_ERRORS, (error as NetError).code)).toBe(true) }
    }), { numRuns: 250, seed: 44 })
  })
})
