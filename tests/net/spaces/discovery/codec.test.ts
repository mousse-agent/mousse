import { expect, it } from 'vitest'
import { decodeMessage, encodeMessage } from '../../../../src/mms/net/sync/codec'
import {
  newId,
  SPACE_DISCOVERY_MAX_CONTROL_BYTES,
  type SpaceDiscoveryResultMessage
} from '../../../../src/shared/net'

function proof(count: number, bytes = 128) {
  const stream = newId('stream'),
    space = newId('space'),
    parent = newId('stream'),
    head = { epoch: 1, seq: count },
    parts = [
      new Uint8Array(128),
      new Uint8Array(64),
      ...Array.from({ length: count }, () => [new Uint8Array(bytes), new Uint8Array(64)]).flat()
    ]
  const header: SpaceDiscoveryResultMessage = {
    t: 'space.discovery.result',
    n: 1,
    space,
    stream,
    metaHead: { epoch: 1, seq: 2 },
    descriptor: {
      id: stream,
      space,
      kind: 'space.private',
      parent,
      authority: newId('node'),
      participants: [newId('user')],
      createdAt: 1
    },
    head,
    parent: { epoch: 1, seq: 1, recvTs: 1 },
    controls: Array.from({ length: count }, (_, index) => ({
      epoch: 1,
      seq: index + 1,
      recvTs: 1
    })),
    parts: parts.map((part) => part.length)
  }
  return { header, parts }
}
it('enforces exact cumulative control bounds, signature parts and response descriptor scope in the actual wire codec', () => {
  const valid = proof(64)
  expect(decodeMessage(encodeMessage(valid.header, valid.parts)).header).toEqual(valid.header)
  const excessive = proof(65)
  expect(() => encodeMessage(excessive.header, excessive.parts)).toThrow()
  const boundary = proof(1, SPACE_DISCOVERY_MAX_CONTROL_BYTES - 64)
  expect(() => encodeMessage(boundary.header, boundary.parts)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  ) // Individual envelopes remain bounded to 64 KiB.
  const total = proof(3, 44000)
  expect(() => encodeMessage(total.header, total.parts)).toThrow(
    expect.objectContaining({ code: 'too_large' })
  )
  const badSignature = proof(1)
  badSignature.parts[3] = new Uint8Array(63)
  badSignature.header.parts[3] = 63
  expect(() => encodeMessage(badSignature.header, badSignature.parts)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
  const scope = proof(1)
  scope.header.stream = newId('stream')
  expect(() => encodeMessage(scope.header, scope.parts)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
  const unordered = proof(2)
  unordered.header.controls[1].seq = 1
  expect(() => encodeMessage(unordered.header, unordered.parts)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
})
