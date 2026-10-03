import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Envelope, EventId, NodeId, SpaceId, StreamId, UserId } from '../../../shared/net'
import { NetError } from '../../../shared/net/errors'
import { validateEventBody } from '../../../shared/net/schemas'
import type { KeyStore, PrivateStreamKeys } from '../contracts'
import { canonicalJson, decodeEnvelope, parseProtocolJson } from '../sync/codec'
import { decodeBase64, publicKeyFromRaw, rawPublicKey,verifyBytes } from './crypto'

type Control = NonNullable<Envelope<'participants.changed'>['body']>
export interface PrivateStreamKeysOptions {
  database: DatabaseSync
  keys: KeyStore
  node: NodeId
  user: UserId
  spaceForStream(stream: StreamId): SpaceId
  /** Shared store coordinator when adoption participates in event+cursor commit. */
  transaction?: <T>(operation: () => T) => T
  /** Actual archive preparation writes share the profile's bounded SQL coordinator. */
  charge?(rows:number,bytes?:number):void
  checkpoint?(point:string):void
}
const CONTENT_DOMAIN = Buffer.from('mousse-net/private-content/v1\0')
const WRAP_DOMAIN = Buffer.from('mousse-net/private-wrap/v1\0')
const WRAP_SALT = createHash('sha256').update('mousse-net/private-wrap/v1').digest()
const BLOB_DOMAIN = Buffer.from('mousse-net/private-blob/v1\0')
const same = (a: unknown, b: unknown): boolean => Buffer.from(canonicalJson(a)).equals(Buffer.from(canonicalJson(b)))
const MAX_COUNTER = (1n << 64n) - 1n

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}
function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Buffer {
  if (ciphertext.length < 16) throw new NetError('bad_request')
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad); cipher.setAuthTag(ciphertext.subarray(-16))
    return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()])
  } catch (cause) { throw new NetError('forbidden', 'Private ciphertext authentication failed.', { cause }) }
}

/** Crypto/storage seam. Domain caller MUST validate the enclosing signed controller event first. */
export class SqlPrivateStreamKeys implements PrivateStreamKeys {
  private readonly options: PrivateStreamKeysOptions
  constructor(options: PrivateStreamKeysOptions) {
    this.options = options
    options.database.exec('CREATE TABLE IF NOT EXISTS net_private_control (stream TEXT NOT NULL, epoch INTEGER NOT NULL, body TEXT NOT NULL, adopted INTEGER NOT NULL CHECK(adopted IN (0,1)), PRIMARY KEY(stream,epoch)); CREATE TABLE IF NOT EXISTS net_private_nonce (stream TEXT NOT NULL, epoch INTEGER NOT NULL, node TEXT NOT NULL, prefix TEXT NOT NULL, counter TEXT NOT NULL, PRIMARY KEY(stream,epoch,node))')
  }

  rotate(stream: StreamId, recipients: Array<{ node: NodeId; agree: string }>, context: { controller: UserId; participants: Array<UserId | import('../../../shared/net').BotId>; visibilityEpoch: number }): Control {
    if (context.controller !== this.options.user || !context.participants.includes(context.controller)) throw new NetError('forbidden', 'Only the current human controller rotates private keys.')
    const pending = this.pending(stream)
    if (pending) throw new NetError('meta_stale', 'A rotation is awaiting signed control adoption.')
    const before = this.current(stream)
    const participants = [...new Set(context.participants)].sort()
    if (participants.length !== context.participants.length || new Set(recipients.map(row => row.node)).size !== recipients.length) throw new NetError('bad_request')
    const changed = before && JSON.stringify(before.participants) !== JSON.stringify(participants)
    const visibility = before ? before.visibilityEpoch + (changed ? 1 : 0) : 1
    if (context.visibilityEpoch !== visibility || (before && before.controller !== context.controller)) throw new NetError('conflict', 'Invalid visibility epoch or controller.')
    const keyEpoch = (before?.keyEpoch ?? 0) + 1
    if (!Number.isSafeInteger(keyEpoch)) throw new NetError('conflict')
    const contentKey = randomBytes(32)
    const seen = new Set<string>()
    const writers = recipients.map(row => {
      let noncePrefix: string
      do { noncePrefix = randomBytes(4).toString('base64url') } while (seen.has(noncePrefix))
      seen.add(noncePrefix)
      return { node: row.node, noncePrefix }
    }).sort((a, b) => a.node.localeCompare(b.node))
    const body: Control = { participants, keyEpoch, visibilityEpoch: visibility, controller: context.controller, writers, wrapped: recipients.map(row => this.wrap(stream, keyEpoch, visibility, contentKey, row)).sort((a, b) => a.node.localeCompare(b.node)) }
    this.validate(body)
    // Key file is durable first; an orphan key cannot become active without a committed control.
    this.options.keys.putSecret(this.keyName(stream, keyEpoch), contentKey)
    this.transaction(() => {
      if (this.pending(stream) || (this.current(stream)?.keyEpoch ?? 0) !== keyEpoch - 1) throw new NetError('conflict')
      this.options.database.prepare('INSERT INTO net_private_control(stream,epoch,body,adopted) VALUES(?,?,?,0)').run(stream, keyEpoch, JSON.stringify(body))
    })
    contentKey.fill(0)
    return body
  }

  /** Recover the exact prepared control after a crash so the domain outbox can sign/adopt it. */
  preparedRotation(stream: StreamId): Control | undefined {
    const row = this.options.database.prepare('SELECT body FROM net_private_control WHERE stream=? AND adopted=0 ORDER BY epoch LIMIT 1').get(stream) as { body: string } | undefined
    if (!row) return undefined
    const body = parseProtocolJson(Buffer.from(row.body)) as Control
    this.validate(body)
    return body
  }

  /** Trusted archive controller only. The domain must supply the last control
   * from verified original history; this primitive never unwraps an old key.
   * A protected bundle publishes the fresh key and exact control together before
   * either SQL or the ordinary content-key slot, so retries keep both originals. */
  prepareArchiveRotation(stream:StreamId,before:Control,recipients:Array<{node:NodeId;agree:string}>,context:{operation:string;sourceHash:string;binding:string;forbiddenPrefixes:readonly string[];sign?:(body:Control)=>{envelope:Uint8Array;sig:Uint8Array}}):Control{
    if(!this.options.charge||!/^[a-f0-9-]{36}$/.test(context.operation)||!/^[a-f0-9]{64}$/.test(context.sourceHash)||!/^[a-f0-9]{64}$/.test(context.binding))throw new NetError('forbidden')
    this.validate(before)
    if(before.controller!==this.options.user||!before.participants.includes(this.options.user)||new Set(recipients.map(r=>r.node)).size!==recipients.length||!recipients.length)throw new NetError('forbidden')
    const epoch=before.keyEpoch+1;if(!Number.isSafeInteger(epoch))throw new NetError('conflict')
    const request=Buffer.from(canonicalJson({stream,before,node:this.options.node,user:this.options.user,recipients:[...recipients].sort((a,b)=>a.node.localeCompare(b.node)),operation:context.operation,sourceHash:context.sourceHash,binding:context.binding,signed:!!context.sign,forbiddenPrefixes:[...new Set(context.forbiddenPrefixes)].sort()})).toString()
    const name=`archive/rotation/${context.operation}/${stream}/${epoch}`,saved=this.options.keys.getSecret(name)
    let prepared:{v:1;request:string;key:string;body:Control;original?:{envelope:string;sig:string}}
    if(saved){prepared=parseProtocolJson(saved) as typeof prepared;if(prepared.v!==1||prepared.request!==request)throw new NetError('conflict')}
    else{
      // A later local epoch can never be overwritten by a restored backup.
      if(this.options.keys.getSecret(this.keyName(stream,epoch)))throw new NetError('conflict')
      const key=randomBytes(32),seen=new Set(context.forbiddenPrefixes)
      try{
        const writers=recipients.map(row=>{let prefix:string;do{prefix=randomBytes(4).toString('base64url')}while(seen.has(prefix));seen.add(prefix);return{node:row.node,noncePrefix:prefix}}).sort((a,b)=>a.node.localeCompare(b.node))
        const body:Control={participants:before.participants,keyEpoch:epoch,visibilityEpoch:before.visibilityEpoch,controller:before.controller,writers,wrapped:recipients.map(row=>this.wrap(stream,epoch,before.visibilityEpoch,key,row)).sort((a,b)=>a.node.localeCompare(b.node))}
        this.validate(body);const original=context.sign?.(structuredClone(body));if(original)this.verifyArchiveOriginal(stream,body,original)
        prepared={v:1,request,key:key.toString('base64url'),body,...(original?{original:{envelope:Buffer.from(original.envelope).toString('base64url'),sig:Buffer.from(original.sig).toString('base64url')}}:{})}
        this.options.keys.putSecret(name,canonicalJson(prepared))
      }finally{key.fill(0)}
    }
    this.validate(prepared.body)
    const body=prepared.body
    if(body.controller!==before.controller||body.keyEpoch!==epoch||body.visibilityEpoch!==before.visibilityEpoch||!same(body.participants,before.participants)||body.writers.some(w=>context.forbiddenPrefixes.includes(w.noncePrefix))||body.wrapped.length!==recipients.length||body.wrapped.some(w=>!recipients.some(r=>r.node===w.node&&r.agree===w.recipientAgreementKey)))throw new NetError('conflict')
    const key=decodeBase64(prepared.key,32)
    if(context.sign){if(!prepared.original)throw new NetError('conflict');this.verifyArchiveOriginal(stream,body,{envelope:decodeBase64(prepared.original.envelope),sig:decodeBase64(prepared.original.sig,64)})}
    try{
      this.options.checkpoint?.('spaces.archive.private.bundleDurable')
      const held=this.options.keys.getSecret(this.keyName(stream,epoch))
      if(held&&!Buffer.from(held).equals(key))throw new NetError('conflict')
      if(!held)this.options.keys.putSecret(this.keyName(stream,epoch),key)
      this.transaction(()=>{
        const current=this.current(stream),pending=this.preparedRotation(stream)
        if(current&&!same(current,before)&&!same(current,body)||pending&&!same(pending,body))throw new NetError('conflict')
        if(!current){this.options.charge!(1,Buffer.byteLength(JSON.stringify(before)));this.options.database.prepare('INSERT INTO net_private_control VALUES(?,?,?,1)').run(stream,before.keyEpoch,JSON.stringify(before))}
        const known=this.control(stream,epoch)
        if(known&&!same(known,body))throw new NetError('conflict')
        if(!known){this.options.charge!(1,Buffer.byteLength(JSON.stringify(body)));this.options.database.prepare('INSERT INTO net_private_control VALUES(?,?,?,0)').run(stream,epoch,JSON.stringify(body))}
        this.options.checkpoint?.('spaces.archive.private.prepared.beforeCommit')
      })
      return structuredClone(body)
    }finally{key.fill(0)}
  }
  /** Public signed original only; the prepared content key never leaves this primitive. */
  archiveRotationOriginal(stream:StreamId,operation:string,epoch:number):{stream:StreamId;id:EventId;envelope:Uint8Array;sig:Uint8Array}{
    if(!/^[a-f0-9-]{36}$/.test(operation)||!Number.isSafeInteger(epoch)||epoch<2)throw new NetError('bad_request')
    const saved=this.options.keys.getSecret(`archive/rotation/${operation}/${stream}/${epoch}`)
    if(!saved)throw new NetError('forbidden')
    const bundle=parseProtocolJson(saved) as {body:Control;original?:{envelope:string;sig:string}}
    if(!bundle.original)throw new NetError('forbidden')
    const original={envelope:decodeBase64(bundle.original.envelope),sig:decodeBase64(bundle.original.sig,64)}
    this.verifyArchiveOriginal(stream,bundle.body,original)
    return{stream,id:decodeEnvelope(original.envelope).envelope.id,...original}
  }
  private verifyArchiveOriginal(stream:StreamId,body:Control,original:{envelope:Uint8Array;sig:Uint8Array}):void{
    const envelope=decodeEnvelope(original.envelope).envelope
    if(envelope.stream!==stream||envelope.type!=='participants.changed'||envelope.author.bot||envelope.author.node!==this.options.node||envelope.author.user!==this.options.user||!same(envelope.body,body)||envelope.auth?.metaSeq!==1||envelope.auth.metaEpoch<2)throw new NetError('forbidden')
    verifyBytes(original.envelope,original.sig,this.options.keys.nodeKeys().sign)
  }

  accept(stream: StreamId, body: Control): void {
    this.validate(body)
    const before = this.current(stream)
    const known = this.control(stream, body.keyEpoch)
    if (known && !same(known, body)) {
      const allowedRewrap = known.controller === body.controller && known.visibilityEpoch === body.visibilityEpoch && same(known.participants, body.participants) && known.wrapped.every(entry => body.wrapped.some(next => same(entry, next))) && known.writers.every(entry => body.writers.some(next => same(entry, next)))
      if (!allowedRewrap) throw new NetError('conflict', 'Key epoch control differs.')
    }
    if (!known) {
      const sameSet = before && JSON.stringify(before.participants) === JSON.stringify(body.participants)
      if (body.keyEpoch !== (before?.keyEpoch ?? 0) + 1 || body.visibilityEpoch !== (before ? before.visibilityEpoch + (sameSet ? 0 : 1) : 1) || (before && before.controller !== body.controller)) throw new NetError('conflict', 'Private key epoch or audience transition is invalid.')
    }
    const own = body.wrapped.find(row => row.node === this.options.node)
    if (own) {
      if (own.recipientAgreementKey !== this.options.keys.nodeKeys().agree) throw new NetError('bad_delegation', 'Wrap targets a different agreement key.')
      const context = this.wrapContext(stream, body.keyEpoch, body.visibilityEpoch, own)
      const info = canonicalJson(context), aad = Buffer.concat([WRAP_DOMAIN, info])
      const shared = this.options.keys.agree(decodeBase64(own.ephemeral, 32))
      const wrapping = Buffer.from(hkdfSync('sha256', shared, WRAP_SALT, info, 32))
      try {
        const key = open(wrapping, decodeBase64(own.nonce, 12), decodeBase64(own.ct, 48), aad)
        const held = this.options.keys.getSecret(this.keyName(stream, body.keyEpoch))
        if (held && !Buffer.from(held).equals(key)) throw new NetError('conflict', 'Existing content key differs from its authenticated wrap.')
        if (!held) this.options.keys.putSecret(this.keyName(stream, body.keyEpoch), key)
        key.fill(0)
      } finally { wrapping.fill(0); shared.fill(0) }
    }
    this.transaction(() => {
      const present = this.control(stream, body.keyEpoch), committed = this.current(stream)
      if (!present) {
        const sameSet = committed && same(committed.participants, body.participants)
        if (body.keyEpoch !== (committed?.keyEpoch ?? 0) + 1 || body.visibilityEpoch !== (committed ? committed.visibilityEpoch + (sameSet ? 0 : 1) : 1) || (committed && committed.controller !== body.controller)) throw new NetError('conflict', 'Private control advanced before this adoption transaction.')
      }
      if (present && !same(present, body) && !(present.controller === body.controller && present.visibilityEpoch === body.visibilityEpoch && same(present.participants, body.participants) && present.wrapped.every(entry => body.wrapped.some(next => same(entry, next))) && present.writers.every(entry => body.writers.some(next => same(entry, next))))) throw new NetError('conflict')
      this.options.database.prepare('INSERT INTO net_private_control(stream,epoch,body,adopted) VALUES(?,?,?,1) ON CONFLICT(stream,epoch) DO UPDATE SET body=excluded.body,adopted=1').run(stream, body.keyEpoch, JSON.stringify(body))
      const writer = body.writers.find(row => row.node === this.options.node)
      if (writer && own) {
        const nonce = this.options.database.prepare('SELECT prefix FROM net_private_nonce WHERE stream=? AND epoch=? AND node=?').get(stream, body.keyEpoch, this.options.node) as { prefix: string } | undefined
        if (nonce && nonce.prefix !== writer.noncePrefix) throw new NetError('conflict', 'Writer namespace cannot change in an existing key epoch.')
        this.options.database.prepare('INSERT OR IGNORE INTO net_private_nonce(stream,epoch,node,prefix,counter) VALUES(?,?,?,?,?)').run(stream, body.keyEpoch, this.options.node, writer.noncePrefix, '0')
      }
    })
  }

  rewrap(stream: StreamId, keyEpoch: number, recipient: { node: NodeId; agree: string }): Control['wrapped'][number] {
    const body = this.control(stream, keyEpoch, true)
    if (!body || body.controller !== this.options.user || !body.participants.includes(this.options.user)) throw new NetError('forbidden')
    // The domain caller validates same-user current-node eligibility before this primitive.
    return this.wrap(stream, keyEpoch, body.visibilityEpoch, this.key(stream, keyEpoch), recipient)
  }
  seal(stream: StreamId, plaintext: Uint8Array, aad: Uint8Array): NonNullable<Envelope['sealed']> {
    const authorNode = this.contentAuthor(stream, aad)
    if (authorNode !== this.options.node) throw new NetError('forbidden', 'Content AAD author differs from the sealing node.')
    const current = this.sealable(stream), nonce = this.reserveNonce(stream, current)
    return { keyEpoch: current.keyEpoch, nonce: nonce.toString('base64url'), ct: seal(this.key(stream, current.keyEpoch), nonce, plaintext, aad).toString('base64url') }
  }
  open(stream: StreamId, sealed: NonNullable<Envelope['sealed']>, aad: Uint8Array): Uint8Array {
    const authorNode = this.contentAuthor(stream, aad)
    const body = this.control(stream, sealed.keyEpoch, true)
    if (!body) throw new NetError('forbidden')
    const nonce = decodeBase64(sealed.nonce, 12)
    if (!body.writers.some(row => row.node === authorNode && decodeBase64(row.noncePrefix, 4).equals(nonce.subarray(0, 4)))) throw new NetError('forbidden', 'Nonce uses a different author writer namespace.')
    return open(this.key(stream, sealed.keyEpoch), nonce, decodeBase64(sealed.ct), aad)
  }
  sealBlob(stream: StreamId, plaintext: Uint8Array): { keyEpoch: number; bytes: Uint8Array } {
    const current = this.sealable(stream), nonce = this.reserveNonce(stream, current), epoch = Buffer.alloc(8)
    epoch.writeBigUInt64BE(BigInt(current.keyEpoch))
    return { keyEpoch: current.keyEpoch, bytes: Buffer.concat([Buffer.from([1]), epoch, nonce, seal(this.key(stream, current.keyEpoch), nonce, plaintext, this.blobAAD(stream, current.keyEpoch))]) }
  }
  openBlob(stream: StreamId, keyEpoch: number, bytes: Uint8Array): Uint8Array {
    const raw = Buffer.from(bytes), body = this.control(stream, keyEpoch, true)
    if (!body || raw.length < 37 || raw[0] !== 1 || raw.readBigUInt64BE(1) !== BigInt(keyEpoch)) throw new NetError('forbidden')
    const nonce = raw.subarray(9, 21)
    if (!body.writers.some(row => decodeBase64(row.noncePrefix, 4).equals(nonce.subarray(0, 4)))) throw new NetError('forbidden')
    return open(this.key(stream, keyEpoch), nonce, raw.subarray(21), this.blobAAD(stream, keyEpoch))
  }

  private contentAuthor(stream: StreamId, aad: Uint8Array): NodeId {
    const bytes = Buffer.from(aad)
    if (!bytes.subarray(0, CONTENT_DOMAIN.length).equals(CONTENT_DOMAIN)) throw new NetError('bad_request', 'Content AAD domain is missing.')
    const raw = bytes.subarray(CONTENT_DOMAIN.length), metadata = parseProtocolJson(raw) as { stream?: StreamId; author?: { node?: NodeId }; body?: unknown; sealed?: unknown }
    if (metadata.stream !== stream || !metadata.author?.node || Object.hasOwn(metadata, 'body') || Object.hasOwn(metadata, 'sealed') || !Buffer.from(canonicalJson(metadata)).equals(raw)) throw new NetError('bad_request', 'Invalid canonical content metadata binding.')
    return metadata.author.node
  }
  private wrap(stream: StreamId, keyEpoch: number, visibilityEpoch: number, key: Uint8Array, recipient: { node: NodeId; agree: string }): Control['wrapped'][number] {
    const ephemeral = generateKeyPairSync('x25519'), entry = { node: recipient.node, recipientAgreementKey: recipient.agree, ephemeral: rawPublicKey(ephemeral.publicKey) }
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyFromRaw(recipient.agree, 'x25519') })
    if (shared.every(byte => byte === 0)) throw new NetError('bad_delegation')
    const info = canonicalJson(this.wrapContext(stream, keyEpoch, visibilityEpoch, entry))
    const wrapping = Buffer.from(hkdfSync('sha256', shared, WRAP_SALT, info, 32)), nonce = randomBytes(12)
    try { return { ...entry, nonce: nonce.toString('base64url'), ct: seal(wrapping, nonce, key, Buffer.concat([WRAP_DOMAIN, info])).toString('base64url') } }
    finally { shared.fill(0); wrapping.fill(0) }
  }
  private wrapContext(stream: StreamId, keyEpoch: number, visibilityEpoch: number, entry: Pick<Control['wrapped'][number], 'node' | 'ephemeral' | 'recipientAgreementKey'>) {
    return { space: this.options.spaceForStream(stream), stream, keyEpoch, visibilityEpoch, node: entry.node, ephemeral: entry.ephemeral, recipientAgreementKey: entry.recipientAgreementKey }
  }
  private blobAAD(stream: StreamId, keyEpoch: number): Uint8Array { return Buffer.concat([BLOB_DOMAIN, canonicalJson({ space: this.options.spaceForStream(stream), stream, keyEpoch })]) }
  private keyName(stream: StreamId, epoch: number): string { return `private/${stream}/${epoch}` }
  private key(stream: StreamId, epoch: number): Uint8Array {
    const body = this.control(stream, epoch, true), key = this.options.keys.getSecret(this.keyName(stream, epoch))
    if (!body?.wrapped.some(row => row.node === this.options.node) || !key || key.length !== 32) throw new NetError('forbidden', 'No adopted key addressed to this node.')
    return key
  }
  private current(stream: StreamId): Control | undefined {
    const row = this.options.database.prepare('SELECT body FROM net_private_control WHERE stream=? AND adopted=1 ORDER BY epoch DESC LIMIT 1').get(stream) as { body: string } | undefined
    return row ? JSON.parse(row.body) as Control : undefined
  }
  private pending(stream: StreamId): boolean { return !!this.options.database.prepare('SELECT 1 FROM net_private_control WHERE stream=? AND adopted=0 LIMIT 1').get(stream) }
  private control(stream: StreamId, epoch: number, adopted = false): Control | undefined {
    const row = this.options.database.prepare(`SELECT body FROM net_private_control WHERE stream=? AND epoch=?${adopted ? ' AND adopted=1' : ''}`).get(stream, epoch) as { body: string } | undefined
    return row ? JSON.parse(row.body) as Control : undefined
  }
  private sealable(stream: StreamId): Control {
    if (this.pending(stream)) throw new NetError('meta_stale', 'Rotation is not yet adopted.')
    const body = this.current(stream)
    if (!body || !body.writers.some(row => row.node === this.options.node)) throw new NetError('forbidden')
    this.key(stream, body.keyEpoch)
    return body
  }
  private reserveNonce(stream: StreamId, body: Control): Buffer {
    let result!: Buffer
    this.transaction(() => {
      const row = this.options.database.prepare('SELECT prefix,counter FROM net_private_nonce WHERE stream=? AND epoch=? AND node=?').get(stream, body.keyEpoch, this.options.node) as { prefix: string; counter: string } | undefined
      if (!row || !/^(0|[1-9]\d*)$/.test(row.counter)) throw new NetError('storage_corrupt')
      const counter = BigInt(row.counter), anchorName = `nonce/${stream}/${body.keyEpoch}/${this.options.node}`, rawAnchor = this.options.keys.getSecret(anchorName)
      const anchorText = rawAnchor ? Buffer.from(rawAnchor).toString() : '0'
      if (!/^(0|[1-9]\d*)$/.test(anchorText)) throw new NetError('storage_corrupt', 'Nonce anchor is malformed.')
      const anchor = BigInt(anchorText)
      if (counter < anchor || counter >= MAX_COUNTER) throw new NetError('conflict', 'Nonce state rolled back or exhausted; rotate the key epoch.')
      const next = counter + 1n
      this.options.keys.putSecret(anchorName, Buffer.from(next.toString()))
      this.options.database.prepare('UPDATE net_private_nonce SET counter=? WHERE stream=? AND epoch=? AND node=?').run(next.toString(), stream, body.keyEpoch, this.options.node)
      result = Buffer.alloc(12); decodeBase64(row.prefix, 4).copy(result); result.writeBigUInt64BE(next, 4)
    })
    return result
  }
  private validate(body: Control): void {
    if (!validateEventBody('participants.changed', body) || !body.participants.includes(body.controller) || JSON.stringify(body.participants) !== JSON.stringify([...new Set(body.participants)].sort()) || new Set(body.writers.map(row => row.node)).size !== body.writers.length || new Set(body.writers.map(row => row.noncePrefix)).size !== body.writers.length || new Set(body.wrapped.map(row => row.node)).size !== body.wrapped.length || body.writers.some(writer => !body.wrapped.some(wrap => wrap.node === writer.node))) throw new NetError('bad_request', 'Invalid private key control.')
  }
  private transaction<T>(operation: () => T): T {
    if (this.options.transaction) return this.options.transaction(operation)
    this.options.database.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.options.database.exec('COMMIT'); return value }
    catch (cause) { try { this.options.database.exec('ROLLBACK') } catch { /* SQLite may have already rolled back. */ } throw cause }
  }
}
