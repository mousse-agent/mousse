/** Browser-safe executable JSON Schemas for protocol 1.0. Byte checks live in the codec. */
import Ajv, { type AnySchema, type ValidateFunction } from 'ajv'
import { BOT_PROFILES, NODE_CAPABILITIES, SPACE_ROLES } from './capabilities'
import { CONTENT_EVENT_TYPES, META_EVENT_TYPES, type Envelope, type KnownEventType } from './envelope'
import { NET_ERRORS } from './errors'
import type { WireMessage, WireMessageType } from './wire'
import { STREAM_KINDS, type StreamDescriptor } from './streams'
import { BLOB_CHUNK_BYTES, MAX_INLINE_ENVELOPE_BYTES, MAX_SEQ, REPLAY_BATCH_BYTES } from './limits'

type Schema = Record<string, unknown>
const integer = (minimum = 0, maximum = MAX_SEQ): Schema => ({ type: 'integer', minimum, maximum })
const text = (maxLength = 4096, minLength = 0): Schema => ({ type: 'string', minLength, maxLength })
const literal = (value: unknown): Schema => ({ const: value })
const enumeration = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] })
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const array = (items: Schema, maxItems = 256, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems })
const id = (prefix: string): Schema => ({ type: 'string', pattern: `^${prefix}_[0-9a-hjkmnp-tv-z]{26}$` })
const participant: Schema = { anyOf: [id('usr'), id('bot')] }
const subject: Schema = { anyOf: [id('nod'), id('bot')] }
const b64 = (maxLength: number, minLength = 1): Schema => ({ type: 'string', minLength, maxLength, pattern: '^[A-Za-z0-9_-]+$', format: 'base64url' })
const fixedB64 = (bytes: number): Schema => ({ ...b64(Math.ceil(bytes * 4 / 3)), minLength: Math.ceil(bytes * 4 / 3) })
const blobId: Schema = { type: 'string', pattern: '^blb_[0-9a-f]{64}$' }
const rpcArtifactRef = object({ stream: id('str'), event: id('evt'), blob: blobId })
const bool: Schema = { type: 'boolean' }
const json: Schema = {} // Bounded by the encoded header/envelope, depth and node limits in codec.
const signature = fixedB64(64)
const key = fixedB64(32)
const nonce = fixedB64(12)
const head = object({ epoch: integer(1), seq: integer() })
const signed = object({ payload: b64(Math.ceil(MAX_INLINE_ENVELOPE_BYTES * 4 / 3)), sig: signature })
const keys = object({ sign: key, agree: key, transport: b64(512) })
const route = object({ transport: text(64, 1), address: text(2048, 1), priority: integer() })
const steer: Schema = { oneOf: [object({ kind: literal('owner') }), object({ kind: literal('everyone') }), object({ kind: literal('roles'), roles: { ...array(enumeration(SPACE_ROLES), 3, 1), uniqueItems: true } })] }
const policy = object({ steer, visibility: enumeration(['public', 'private']) })
const member = object({ user: id('usr'), rootKey: key, role: enumeration(SPACE_ROLES), displayName: text(256, 1) })
const bot = object({ bot: id('bot'), owner: id('usr'), delegation: signed, displayName: text(256, 1), profile: enumeration(BOT_PROFILES), policy })
const settingsProperties = { name: text(256, 1), membersMayAddBots: bool, maxBlobBytes: integer(1), minProtoMinor: integer() }
const permissionBinding = object({ stream: id('str'), compartment: text(512, 1), visibilityEpoch: integer(1) }, ['stream', 'compartment'])
const permissionRequestBase = { requester: id('usr'), bot: id('bot'), trigger: id('evt'), summary: text(4096), expiresAt: integer(), binding: permissionBinding }
const permissionGrantBase = { request: id('evt'), requestHash: key, expiresAt: integer() }
const settings = object(settingsProperties)
const record = object({ seq: integer(1), epoch: integer(1), recvTs: integer() })
const wireErrorBase = object({ code: enumeration(Object.keys(NET_ERRORS)), message: text(4096), retryable: bool, cause: array(object({ code: text(128, 1), message: text(4096) }, ['message']), 8) }, ['code', 'message', 'retryable'])
const wireError: Schema = { ...wireErrorBase, allOf: Object.entries(NET_ERRORS).map(([code, error]) => ({ if: { properties: { code: literal(code) }, required: ['code'] }, then: { properties: { retryable: literal(error.retryable) } } })) }
const parts = array(integer(1, MAX_INLINE_ENVELOPE_BYTES), 1000)
const pairedParts: Schema = { type: 'array', items: [integer(1, MAX_INLINE_ENVELOPE_BYTES), literal(64)], minItems: 2, maxItems: 2, additionalItems: false }
const baseDelegation = { v: literal(1), owner: id('usr'), name: text(256, 1), keyEpoch: integer(1), issuedAt: integer(), expiresAt: integer() }

export const signedDocumentSchemas = {
  signed,
  nodeDelegation: object({ ...baseDelegation, kind: literal('node'), subject: id('nod'), keys, caps: { ...array(enumeration(NODE_CAPABILITIES), 5), uniqueItems: true } }),
  botDelegation: object({ ...baseDelegation, kind: literal('bot'), subject: id('bot'), keys: object({ sign: key }), hostNode: id('nod') }),
  roster: object({ v: literal(1), owner: id('usr'), rootKey: key, recoveryEpoch: integer(), lineage: text(128, 1), version: integer(1), authorityNode: id('nod'), nodes: array(signed, 256), bots: array(signed, 256), revoked: array(object({ subject, throughKeyEpoch: integer(1), revokedAt: integer() }), 512), issuedAt: integer() }),
  routes: object({ v: literal(1), node: id('nod'), routes: array(route, 32), version: integer(1), issuedAt: integer() }),
  inviteAuthorization: object({ v: literal(1), invite: id('inv'), space: id('spc'), epoch: integer(1), issuer: object({ user: id('usr'), node: id('nod'), delegation: signed }), auth: object({ metaEpoch: integer(1), metaSeq: integer() }), role: enumeration(['member', 'admin']), issuedAt: integer(), expiresAt: integer(), uses: integer(1, 256), joiner: id('usr') }, ['v', 'invite', 'space', 'epoch', 'issuer', 'auth', 'role', 'issuedAt', 'expiresAt', 'uses']),
  spaceDescriptor: object({ v: literal(1), space: id('spc'), owner: id('usr'), hostNode: id('nod'), hostTransportKey: b64(512), routes: signed, epoch: integer(1), issuedAt: integer() })
} as const
export type SignedDocumentKind = keyof typeof signedDocumentSchemas

export const eventBodySchemas = {
  'artifact.published': object({ rpc: id('rpc'), purpose: enumeration(['input', 'result']) }),
  'space.created': object({ descriptor: signed, settings, owner: member }),
  'space.descriptor': object({ descriptor: signed }),
  'space.frozen': object({ reason: text(4096) }),
  'settings.changed': object({ settings: { ...object(settingsProperties, []), minProperties: 1 } }),
  'member.joined': { ...object({ member, invite: signed, inviteUse: integer(1, 256) }, ['member']), dependencies: { invite: ['inviteUse'], inviteUse: ['invite'] } },
  'member.left': object({ user: id('usr') }),
  'member.removed': object({ user: id('usr') }),
  'member.roleChanged': object({ user: id('usr'), role: enumeration(SPACE_ROLES) }),
  'bot.added': object({ record: bot }),
  'bot.removed': object({ bot: id('bot') }),
  'bot.policyChanged': { ...object({ bot: id('bot'), profile: enumeration(BOT_PROFILES), policy }, ['bot']), anyOf: [{ required: ['profile'] }, { required: ['policy'] }] },
  'channel.created': object({ stream: id('str'), name: text(256, 1) }),
  'channel.renamed': object({ stream: id('str'), name: text(256, 1) }),
  'channel.archived': object({ stream: id('str') }),
  'message.posted': object({ text: text(MAX_INLINE_ENVELOPE_BYTES) }),
  'message.edited': object({ text: text(MAX_INLINE_ENVELOPE_BYTES) }),
  'message.deleted': object({}),
  'thread.opened': object({ stream: id('str'), title: text(256, 1), private: bool }),
  'thread.closed': object({ stream: id('str') }),
  'participants.changed': object({ controller: id('usr'), visibilityEpoch: integer(1), writers: array(object({ node: id('nod'), noncePrefix: fixedB64(4) }), 256, 1), participants: { ...array(participant, 256, 1), uniqueItems: true }, keyEpoch: integer(1), wrapped: array(object({ node: id('nod'), recipientAgreementKey: key, ephemeral: key, nonce, ct: fixedB64(48) }), 256, 1) }),
  'bot.run.accepted': object({ title: text(256, 1) }),
  'bot.run.progress': object({ text: text(MAX_INLINE_ENVELOPE_BYTES) }),
  'bot.run.toolSummary': object({ tool: text(128, 1), summary: text(4096) }),
  'bot.run.waitingApproval': object({ summary: text(4096) }),
  'bot.run.completed': object({ text: text(MAX_INLINE_ENVELOPE_BYTES) }),
  'bot.run.failed': object({ code: text(128, 1), message: text(4096) }),
  'bot.run.cancelled': object({ by: id('usr') }),
  'bot.run.uncertain': object({ summary: text(4096) }),
  'bot.run.expired': object({}),
  'bot.permission.requested': { oneOf: [object({ ...permissionRequestBase, kind: literal('steerPolicyChange'), proposedPolicy: policy }), object({ ...permissionRequestBase, kind: literal('runtimeAction'), execution: id('exe'), actionHash: key, profileDigest: key })] },
  'bot.permission.granted': { oneOf: [object({ ...permissionGrantBase, kind: literal('steerPolicyChange') }), object({ ...permissionGrantBase, kind: literal('runtimeAction'), execution: id('exe'), actionHash: key, profileDigest: key, binding: permissionBinding })] },
  'bot.permission.denied': object({ request: id('evt') })
} satisfies Record<KnownEventType, Schema>

const envelopeProperties = {
  v: literal(1), minor: integer(), id: id('evt'), stream: id('str'), type: text(128, 1), crit: bool,
  author: { ...object({ user: id('usr'), bot: id('bot'), node: id('nod'), keyEpoch: integer(1) }, ['node', 'keyEpoch']), oneOf: [{ required: ['user'], not: { required: ['bot'] } }, { required: ['bot'], not: { required: ['user'] } }] },
  ts: integer(), auth: object({ metaSeq: integer(), metaEpoch: integer(1) }),
  refs: object({ replyTo: id('evt'), thread: id('str'), mentions: { ...array(id('bot'), 32), uniqueItems: true }, execution: id('exe'), subject: id('evt') }, []),
  body: json, sealed: object({ keyEpoch: integer(1), nonce, ct: b64(Math.ceil(MAX_INLINE_ENVELOPE_BYTES * 4 / 3), 22) }),
  blobs: array(object({ id: blobId, bytes: integer(), mime: text(256, 1), sealed: bool }, ['id', 'bytes', 'mime']), 32),
  origin: json
}
export const envelopeSchema: Schema = {
  ...object(envelopeProperties, ['v', 'minor', 'id', 'stream', 'type', 'crit', 'author', 'ts']),
  additionalProperties: true,
  oneOf: [{ required: ['body'], not: { required: ['sealed'] } }, { required: ['sealed'], not: { required: ['body'] } }],
  allOf: [
    { if: { properties: { type: literal('artifact.published'), minor: literal(0) }, required: ['type', 'minor'] }, then: { required: ['body', 'blobs'], properties: { blobs: { type: 'array', minItems: 1 } } } },
    ...Object.entries(eventBodySchemas).map(([type, schema]) => ({ if: { properties: { type: literal(type), minor: literal(0) }, required: ['type', 'body', 'minor'] }, then: { properties: { body: schema } } })),
    { if: { properties: { type: enumeration(['message.edited', 'message.deleted']), minor: literal(0) }, required: ['type', 'minor'] }, then: { required: ['refs'], properties: { refs: { type: 'object', required: ['subject'] } } } },
    { if: { properties: { type: enumeration(CONTENT_EVENT_TYPES.filter((type) => type.startsWith('bot.run.'))), minor: literal(0) }, required: ['type', 'minor'] }, then: { required: ['refs'], properties: { refs: { type: 'object', required: ['execution', 'subject'] } } } }
  ]
}

const message = (t: string, properties: Record<string, Schema> = {}, required = Object.keys(properties)): Schema => object({ t: literal(t), ...properties }, ['t', ...required])
const stream = { stream: id('str') }
const rpc = { id: id('rpc') }
const blob = { blob: blobId }
export const wireMessageSchemas = {
  hello: message('hello', { protoMajor: integer(1), protoMinor: integer(), caps: { ...array(text(64, 1), 32), uniqueItems: true }, node: id('nod'), delegation: signed, roster: signed, routes: signed, now: integer() }, ['protoMajor', 'protoMinor', 'caps', 'node', 'now']),
  helloAck: message('helloAck', { protoMinor: integer(), caps: { ...array(text(64, 1), 32), uniqueItems: true }, now: integer() }),
  ping: message('ping', { n: integer(), now: integer() }),
  pong: message('pong', { n: integer(), now: integer() }),
  goAway: message('goAway', { error: wireError }),
  error: message('error', { re: text(128, 1), error: wireError }, ['error']),
  subscribe: message('subscribe', { ...stream, after: head }),
  subscribed: message('subscribed', { ...stream, head, replayThrough: integer() }),
  events: message('events', { ...stream, records: array(record, 500, 1), replay: bool, parts }),
  caughtUp: message('caughtUp', stream),
  snapshotRequired: message('snapshotRequired', { ...stream, reason: enumeration(['cursorTooOld', 'cursorAhead', 'epochChanged', 'gapOverBudget']), head }),
  'snapshot.get': message('snapshot.get', stream),
  'snapshot.chunk': message('snapshot.chunk', { ...stream, epoch: integer(1), throughSeq: integer(), records: array(record, 500), done: bool, parts }),
  unsubscribe: message('unsubscribe', stream),
  'metaHead.get': message('metaHead.get', { ...stream, n: integer() }),
  metaHead: message('metaHead', { ...stream, n: integer(), head, now: integer() }),
  append: message('append', { ...stream, id: id('evt'), parts: pairedParts }),
  appendResult: { oneOf: [message('appendResult', { ...stream, id: id('evt'), epoch: integer(1), seq: integer(1), recvTs: integer() }), message('appendResult', { ...stream, id: id('evt'), error: wireError })] },
  'blob.put.begin': message('blob.put.begin', { ...stream, ...blob, bytes: integer(), sealed: bool }),
  'blob.chunk': message('blob.chunk', { ...blob, offset: integer(), parts: { type: 'array', items: integer(1, BLOB_CHUNK_BYTES), minItems: 1, maxItems: 1 } }),
  'blob.put.end': message('blob.put.end', blob),
  'blob.put.result': message('blob.put.result', { ...blob, error: wireError }, ['blob']),
  'blob.get': message('blob.get', { ...stream, ...blob, offset: integer() }),
  'blob.end': message('blob.end', { ...blob, error: wireError }, ['blob']),
  'rpc.request': message('rpc.request', { ...rpc, method: text(128, 1), params: json, idem: text(256, 1), deadlineMs: integer(1, 86_400_000) }, ['id', 'method', 'params', 'deadlineMs']),
  'rpc.progress': message('rpc.progress', { ...rpc, data: json }),
  'rpc.result': { oneOf: [message('rpc.result', { ...rpc, result: json, blob: rpcArtifactRef }, ['id', 'result']), message('rpc.result', { ...rpc, error: wireError })] },
  'rpc.cancel': message('rpc.cancel', rpc),
  'rpc.result.get': message('rpc.result.get', rpc),
  presence: message('presence', { ...stream, subject, counter: integer(1), ts: integer(), state: enumeration(['idle', 'working', 'workingPrivate']), activity: text(256, 1), sig: signature }, ['stream', 'subject', 'counter', 'ts', 'state', 'sig']),
  ephemeral: message('ephemeral', { ...stream, kind: enumeration(['typing', 'delta']), data: json }),
  revoked: message('revoked', { subject }),
  rosterUpdate: message('rosterUpdate', { roster: signed }),
  'enroll.request': message('enroll.request', { invite: id('inv'), node: id('nod'), keys, name: text(256, 1), proof: fixedB64(32) }),
  'enroll.result': { oneOf: [message('enroll.result', { delegation: signed, roster: signed }), message('enroll.result', { error: wireError })] },
  'space.join.request': message('space.join.request', { invite: id('inv'), space: id('spc'), user: id('usr'), rootKey: key, node: id('nod'), delegation: signed, roster: signed, name: text(256, 1), proof: fixedB64(32) }),
  'space.join.result': { oneOf: [message('space.join.result', { space: id('spc'), descriptor: signed, member: record, parts: pairedParts }), message('space.join.result', { space: id('spc'), error: wireError })] }
} satisfies Record<WireMessageType, Schema>

export const streamDescriptorSchema: Schema = {
  ...object({ id: id('str'), kind: enumeration(STREAM_KINDS), authority: id('nod'), space: id('spc'), parent: id('str'), participants: { ...array(participant, 256, 1), uniqueItems: true }, artifact: object({ user: id('usr'), caller: id('nod'), rpc: id('rpc'), method: text(128, 1), capability: enumeration(NODE_CAPABILITIES) }), createdAt: integer() }, ['id', 'kind', 'authority', 'createdAt']),
  allOf: [
    { if: { properties: { kind: literal('node.artifact') }, required: ['kind'] }, then: { required: ['artifact'], not: { anyOf: [{ required: ['space'] }, { required: ['parent'] }, { required: ['participants'] }] } }, else: { not: { required: ['artifact'] } } },
    { if: { properties: { kind: enumeration(STREAM_KINDS.filter((kind) => kind.startsWith('space.'))) }, required: ['kind'] }, then: { required: ['space'] }, else: { not: { required: ['space'] } } },
    { if: { properties: { kind: enumeration(['space.thread', 'space.private']) }, required: ['kind'] }, then: { required: ['parent'] } },
    { if: { properties: { kind: literal('space.private') }, required: ['kind'] }, then: { required: ['participants'] } }
  ]
}

export const wireMessageSchema: Schema = { oneOf: Object.values(wireMessageSchemas) }
const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: false, strictRequired: false })
ajv.addFormat('base64url', (value: string) => {
  if (value.length % 4 === 1) return false
  try { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value } catch { return false }
})
export const validateStreamDescriptor: ValidateFunction<StreamDescriptor> = ajv.compile<StreamDescriptor>(streamDescriptorSchema as AnySchema)
export const validateEnvelope: ValidateFunction<Envelope> = ajv.compile<Envelope>(envelopeSchema as AnySchema)
export const validateWireMessage: ValidateFunction<WireMessage> = ajv.compile<WireMessage>(wireMessageSchema as AnySchema)
const documents = Object.fromEntries(Object.entries(signedDocumentSchemas).map(([kind, schema]) => [kind, ajv.compile(schema as AnySchema)])) as Record<SignedDocumentKind, ValidateFunction>
export function validateSignedDocument(kind: SignedDocumentKind, value: unknown): boolean {
  return documents[kind](value)
}
export function classifyWireMessage(value: unknown): 'valid' | 'unknown' | 'invalid' {
  if (typeof value === 'object' && value !== null && 't' in value && typeof value.t === 'string' && !Object.hasOwn(wireMessageSchemas, value.t)) return 'unknown'
  return validateWireMessage(value) ? 'valid' : 'invalid'
}

/** Assertions expose schema coverage to conformance consumers without maintaining another registry. */
export const protocolRegistry = { eventTypes: [...META_EVENT_TYPES, ...CONTENT_EVENT_TYPES], messageTypes: Object.keys(wireMessageSchemas), replayBudget: REPLAY_BATCH_BYTES } as const

const bodyValidators = Object.fromEntries(Object.entries(eventBodySchemas).map(([type, schema]) => [type, ajv.compile(schema as AnySchema)])) as Record<KnownEventType, ValidateFunction>
/** Validate opened private content against its known type; unknown types are not executable. */
export function validateEventBody(type: string, value: unknown): boolean {
  return Object.hasOwn(bodyValidators, type) && bodyValidators[type as KnownEventType](value)
}
