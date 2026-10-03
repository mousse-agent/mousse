import { chmodSync, constants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { X509Certificate, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto'
import type { BotId, KeystoreState, NodePublicKeys } from '../../../shared/net'
import { isId } from '../../../shared/net/ids'
import { NetError } from '../../../shared/net/errors'
import type { KeyStore, TlsCredentials } from '../contracts'
import { createSecretCodec, type SecretCodec } from '../../providers/secretCodec'
import { generateSelfSignedCert } from '../link/selfSignedCert'
import { decodeBase64, generateSigningKey, publicKeyFromRaw, rawPublicKey, signBytes } from './crypto'
import { parseProtocolJson } from '../sync/codec'

interface KeyMaterial {
  v: 1
  nodeSign: string
  nodeAgree: string
  transport: TlsCredentials
  root?: string
  bots: Record<string, string>
  secrets: Record<string, string>
}
type StoredKeys = { v: 1; mode: 'plain'; data: KeyMaterial } | { v: 1; mode: 'vault'; data: string } | { v: 1; mode: 'passphrase'; data: Encrypted }
interface Encrypted { v: 1; salt: string; nonce: string; ct: string }

export interface FileKeyStoreOptions {
  codec?: SecretCodec
  /** Fresh non-vault stores can be passphrase encrypted; supplied again after restart. */
  passphrase?: string
  /** Fault injection at actual durable boundaries; never called with secret bytes. */
  fault?(point: 'keys.lockPublished' | 'keys.beforeRename'): void
}

const AAD_KEYS = Buffer.from('mousse-net/keystore/v1\0')
const AAD_RECOVERY = Buffer.from('mousse-net/recovery/v1\0')
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function encrypted(plain: string, passphrase: string, aad: Uint8Array): Encrypted {
  if (!passphrase) throw new NetError('bad_request', 'A nonempty passphrase is required.')
  const salt = randomBytes(32), nonce = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return { v: 1, salt: salt.toString('base64url'), nonce: nonce.toString('base64url'), ct: ct.toString('base64url') }
  } finally { key.fill(0) }
}

function decrypted(value: Encrypted, passphrase: string, aad: Uint8Array): string {
  if (!value || value.v !== 1 || Object.keys(value).sort().join(',') !== 'ct,nonce,salt,v') throw new NetError('storage_corrupt', 'Invalid encrypted key file.')
  const salt = decodeBase64(value.salt, 32), nonce = decodeBase64(value.nonce, 12), ct = decodeBase64(value.ct)
  if (ct.length < 16 || ct.length > 1024 * 1024) throw new NetError('storage_corrupt')
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    cipher.setAuthTag(ct.subarray(-16))
    return Buffer.concat([cipher.update(ct.subarray(0, -16)), cipher.final()]).toString('utf8')
  } catch (cause) { throw new NetError('keystore_locked', 'Passphrase or authenticated key data is invalid.', { cause }) }
  finally { key.fill(0) }
}

function parse(bytes: Uint8Array): unknown {
  try { return parseProtocolJson(bytes) } catch (cause) { throw new NetError('storage_corrupt', 'Invalid key file.', { cause }) }
}

function material(value: unknown): KeyMaterial {
  const candidate = value as KeyMaterial
  try {
    if (!candidate || candidate.v !== 1 || typeof candidate.nodeSign !== 'string' || typeof candidate.nodeAgree !== 'string' || !candidate.bots || !candidate.secrets) throw new Error('Missing fields.')
    if (createPrivateKey(candidate.nodeSign).asymmetricKeyType !== 'ed25519' || createPrivateKey(candidate.nodeAgree).asymmetricKeyType !== 'x25519') throw new Error('Wrong key type.')
    if (candidate.root && createPrivateKey(candidate.root).asymmetricKeyType !== 'ed25519') throw new Error('Wrong root key type.')
    const transport = createPrivateKey(candidate.transport.key)
    if (transport.asymmetricKeyType !== 'ec' || transport.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !new X509Certificate(candidate.transport.cert).checkPrivateKey(transport)) throw new Error('Wrong transport type.')
    for (const [bot, key] of Object.entries(candidate.bots)) if (!isId('bot', bot) || createPrivateKey(key).asymmetricKeyType !== 'ed25519') throw new Error('Wrong bot key.')
    for (const secret of Object.values(candidate.secrets)) decodeBase64(secret)
    return candidate
  } catch (cause) { throw new NetError('storage_corrupt', 'Invalid private key material.', { cause }) }
}

/** Profile-owned keys. Encryption mode is pinned in the file and never silently downgraded. */
export class FileKeyStore implements KeyStore {
  private readonly file: string
  private readonly codec: SecretCodec
  private readonly configuredPassphrase?: string
  private keys?: KeyMaterial
  private stored?: StoredKeys
  private passphrase?: string
  private readonly fault?: FileKeyStoreOptions['fault']

  constructor(profileDir: string, options: FileKeyStoreOptions = {}) {
    this.fault = options.fault
    const profile = realpathSync(profileDir)
    const directory = join(profile, 'net')
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new NetError('forbidden', 'Net key directory is not a real directory.')
    this.file = join(directory, 'keys.json')
    this.codec = options.codec ?? createSecretCodec()
    this.configuredPassphrase = options.passphrase
    if (existsSync(this.file)) {
      const stat = lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new NetError('forbidden', 'Key file permissions or type are unsafe.')
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { this.stored = parse(readFileSync(fd)) as StoredKeys } finally { closeSync(fd) }
      if (!this.stored || this.stored.v !== 1 || !['plain', 'vault', 'passphrase'].includes(this.stored.mode)) throw new NetError('storage_corrupt')
      if (this.stored.mode === 'plain') {
        if (this.codec.encryptionRequired) throw new NetError('keystore_locked', 'An Electron vault must explicitly migrate the plaintext key store.')
        this.keys = material(this.stored.data)
      } else if (this.stored.mode === 'vault') this.tryVault()
    }
  }

  state(): KeystoreState { return this.keys ? 'unlocked' : this.stored ? 'locked' : 'missing' }

  /** Reports the persisted protection, rather than assuming a headless vault exists. */
  encryptedAtRest(): boolean { return this.stored?.mode === 'vault' || this.stored?.mode === 'passphrase' }

  /** Explicitly protects an unlocked existing profile; a failed write retains its previous mode. */
  protect(passphrase?: string): void {
    const keys = structuredClone(this.required())
    if (passphrase !== undefined && !passphrase) throw new NetError('bad_request')
    if (passphrase === undefined && !this.codec.canEncrypt()) throw new NetError('keystore_locked', 'No encrypted key-store backend is available.')
    const prior = this.passphrase
    this.passphrase = passphrase
    try { this.persist(keys, false, passphrase === undefined ? 'vault' : 'passphrase') }
    catch (error) { this.passphrase = prior; throw error }
  }

  async unlock(passphrase: string): Promise<void> {
    if (!this.stored) throw new NetError('keystore_missing')
    if (this.keys) return
    if (this.stored.mode === 'vault') {
      this.tryVault()
      if (!this.keys) throw new NetError('keystore_locked')
    } else if (this.stored.mode === 'passphrase') {
      this.keys = material(parse(Buffer.from(decrypted(this.stored.data, passphrase, AAD_KEYS))))
      this.passphrase = passphrase
    } else throw new NetError('keystore_locked')
  }

  async initialize(options: { asAuthority: boolean }): Promise<{ node: NodePublicKeys; rootKey?: string }> {
    if (this.stored || this.keys) throw new NetError('conflict', 'Keys already exist.')
    const signing = generateSigningKey()
    const agreement = generateKeyPairSync('x25519')
    const transport = generateSelfSignedCert('Mousse Net')
    const keys: KeyMaterial = { v: 1, nodeSign: signing.privateKey, nodeAgree: agreement.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), transport: { cert: transport.cert, key: transport.key }, bots: {}, secrets: {} }
    if (options.asAuthority) keys.root = generateSigningKey().privateKey
    this.passphrase = this.configuredPassphrase
    this.persist(keys, true)
    return { node: this.nodeKeys(), ...(keys.root ? { rootKey: this.rootKey() } : {}) }
  }

  nodeKeys(): NodePublicKeys {
    const keys = this.required()
    return { sign: rawPublicKey(createPrivateKey(keys.nodeSign)), agree: rawPublicKey(createPrivateKey(keys.nodeAgree)), transport: createPublicKey(keys.transport.key).export({ type: 'spki', format: 'der' }).toString('base64url') }
  }
  rootKey(): string | undefined { const root = this.required().root; return root ? rawPublicKey(createPrivateKey(root)) : undefined }
  signAsNode(bytes: Uint8Array): Uint8Array { return signBytes(bytes, this.required().nodeSign) }
  signAsRoot(bytes: Uint8Array): Uint8Array { const root = this.required().root; if (!root) throw new NetError('forbidden', 'This key store holds no root key.'); return signBytes(bytes, root) }
  createBotKey(bot: BotId): string {
    if (!isId('bot', bot)) throw new NetError('bad_request')
    const keys = this.required()
    if (keys.bots[bot]) throw new NetError('conflict', 'Bot key already exists.')
    const pair = generateSigningKey()
    this.mutate(next => { next.bots[bot] = pair.privateKey })
    return pair.publicKey
  }
  ensureBotKey(bot: BotId): string {
    if(!isId('bot',bot))throw new NetError('bad_request')
    const keys=this.required()
    const key=keys.bots[bot]
    if(!key)return this.createBotKey(bot)
    // Returning an in-memory key must not bypass the normal writer's stale
    // checkpoint fence after another process changes/replaces this profile file.
    const release=this.acquireWriteLock(this.file+'.lock')
    try{
      const stat=lstatSync(this.file)
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw new NetError('forbidden')
      const fd=openSync(this.file,constants.O_RDONLY|constants.O_NOFOLLOW)
      try{if(JSON.stringify(parse(readFileSync(fd)))!==JSON.stringify(this.stored))throw new NetError('conflict')}finally{closeSync(fd)}
      try{const material=createPrivateKey(key);if(material.asymmetricKeyType!=='ed25519')throw new Error('Wrong key type');return rawPublicKey(material)}catch{throw new NetError('storage_corrupt')}
    }finally{release()}
  }
  signAsBot(bot: BotId, bytes: Uint8Array): Uint8Array { const key = this.required().bots[bot]; if (!key) throw new NetError('forbidden'); return signBytes(bytes, key) }
  agree(peerEphemeral: Uint8Array): Uint8Array {
    if (peerEphemeral.length !== 32) throw new NetError('bad_request')
    try {
      const result = diffieHellman({ privateKey: createPrivateKey(this.required().nodeAgree), publicKey: publicKeyFromRaw(Buffer.from(peerEphemeral).toString('base64url'), 'x25519') })
      if (result.every(byte => byte === 0)) throw new Error('Invalid agreement key.')
      return result
    } catch (cause) { if (cause instanceof NetError) throw cause; throw new NetError('bad_delegation', 'Invalid agreement key.', { cause }) }
  }
  tlsCredentials(): TlsCredentials { return { ...this.required().transport } }
  putSecret(name: string, value: Uint8Array): void { this.secretName(name); if (value.length === 0) throw new NetError('bad_request'); this.mutate(next => { Object.defineProperty(next.secrets, name, { value: Buffer.from(value).toString('base64url'), writable: true, configurable: true, enumerable: true }) }) }
  getSecret(name: string): Uint8Array | undefined { this.secretName(name); const secrets = this.required().secrets; const value = Object.hasOwn(secrets, name) ? secrets[name] : undefined; return value === undefined ? undefined : decodeBase64(value) }
  deleteSecret(name: string): void { this.secretName(name); this.mutate(next => { delete next.secrets[name] }) }
  async exportRecovery(passphrase: string): Promise<Uint8Array> {
    const root = this.required().root
    if (!root) throw new NetError('forbidden')
    return Buffer.from(JSON.stringify(encrypted(JSON.stringify({ v: 1, root, rootKey: this.rootKey() }), passphrase, AAD_RECOVERY)))
  }
  async importRecovery(file: Uint8Array, passphrase: string): Promise<void> {
    this.required()
    const restored = this.recoveryMaterial(file, passphrase)
    const existing = this.rootKey()
    if (existing && existing !== restored.rootKey) throw new NetError('conflict', 'Recovery cannot replace a different root identity.')
    this.mutate(next => { next.root = restored.root })
  }
  /** Authenticates and validates the root before an enrollment/recovery operation mutates keys. */
  inspectRecoveryRoot(file: Uint8Array, passphrase: string): string { return this.recoveryMaterial(file, passphrase).rootKey }
  private recoveryMaterial(file: Uint8Array, passphrase: string): { v: number; root: string; rootKey: string } {
    const restored = parse(Buffer.from(decrypted(parse(file) as Encrypted, passphrase, AAD_RECOVERY))) as { v: number; root: string; rootKey: string }
    if (restored.v !== 1 || Object.keys(restored).sort().join(',') !== 'root,rootKey,v' || createPrivateKey(restored.root).asymmetricKeyType !== 'ed25519' || rawPublicKey(createPrivateKey(restored.root)) !== restored.rootKey) throw new NetError('storage_corrupt')
    return restored
  }
  dropRootKey(): void { this.mutate(next => { delete next.root }) }

  private secretName(name: string): void { if (!name || name.length > 512 || /[\u0000-\u001f]/.test(name)) throw new NetError('bad_request') }
  private required(): KeyMaterial { if (!this.keys) throw new NetError(this.stored ? 'keystore_locked' : 'keystore_missing'); return this.keys }
  private tryVault(): void {
    if (this.stored?.mode !== 'vault') return
    const plain = this.codec.decrypt(decodeBase64(this.stored.data))
    if (plain !== null) this.keys = material(parse(Buffer.from(plain)))
  }
  private mutate(change: (next: KeyMaterial) => void): void {
    const next = structuredClone(this.required())
    change(next)
    this.persist(next)
  }
  /** SQLite's OS lock serializes marker reclamation and is released even by SIGKILL. */
  private acquireWriteLock(lock: string): () => void {
    const mutex = this.file + '.mutex.db'
    if (existsSync(mutex) && (!lstatSync(mutex).isFile() || lstatSync(mutex).isSymbolicLink())) throw new NetError('forbidden', 'Key mutex is not an owned regular file.')
    const database = new DatabaseSync(mutex)
    let owned = false, token = '', ownerFile: string | undefined
    try {
      chmodSync(mutex, 0o600)
      database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS key_mutex_version (v INTEGER)')
      if (existsSync(lock)) {
        const stat = lstatSync(lock)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new NetError('forbidden')
        const fd = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW)
        let owner: { pid?: number; token?: string }
        try { owner = parse(readFileSync(fd)) as typeof owner } finally { closeSync(fd) }
        if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.token !== 'string' || !/^[0-9a-f]{32}$/.test(owner.token)) throw new NetError('conflict', 'Unowned/corrupt key lock requires explicit inspection.')
        let alive = true
        try { process.kill(owner.pid!, 0) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
        if (alive) throw new NetError('conflict', 'A live process owns the key write lock.')
        // No other compliant writer can change this path while the SQLite mutex is held.
        unlinkSync(lock)
      }
      token = randomBytes(16).toString('hex'); ownerFile = lock + '.' + token + '.owner'
      const fd = openSync(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, JSON.stringify({ v: 1, pid: process.pid, token })); fsyncSync(fd) } finally { closeSync(fd) }
      // Atomic publication has no empty-marker crash window.
      linkSync(ownerFile, lock); owned = true; unlinkSync(ownerFile); ownerFile = undefined
      return () => {
        try { if (owned) unlinkSync(lock) }
        finally { try { if (database.isTransaction) database.exec('COMMIT') } finally { database.close() } }
      }
    } catch (cause) {
      if (ownerFile && existsSync(ownerFile)) unlinkSync(ownerFile)
      if (owned && existsSync(lock)) unlinkSync(lock)
      try { if (database.isTransaction) database.exec('ROLLBACK') } finally { database.close() }
      if (cause instanceof NetError) throw cause
      const code = cause as { errcode?: number; code?: string }
      throw new NetError(code.errcode === 5 || code.code === 'EEXIST' ? 'conflict' : code.errcode === 13 || code.code === 'ENOSPC' ? 'storage_full' : 'internal', 'Key mutex acquisition failed.', { cause })
    }
  }

  private persist(keys: KeyMaterial, initial = false, protection?: 'vault' | 'passphrase'): void {
    const plain = JSON.stringify(keys)
    let stored: StoredKeys
    const mode = protection ?? this.stored?.mode
    if (mode === 'vault' || (!mode && this.codec.canEncrypt())) {
      const value = this.codec.encrypt(plain)
      if (!value) throw new NetError('keystore_locked', 'OS vault encryption is unavailable.')
      stored = { v: 1, mode: 'vault', data: value.toString('base64url') }
    } else if (mode === 'passphrase' || (!mode && this.passphrase)) {
      if (!this.passphrase) throw new NetError('keystore_locked')
      stored = { v: 1, mode: 'passphrase', data: encrypted(plain, this.passphrase, AAD_KEYS) }
    } else {
      if (this.codec.encryptionRequired) throw new NetError('keystore_locked', 'OS vault encryption is required.')
      stored = { v: 1, mode: 'plain', data: keys }
    }
    const lock = this.file + '.lock', temp = this.file + '.' + randomBytes(12).toString('hex') + '.tmp'
    let release: (() => void) | undefined, fd: number | undefined
    try {
      release = this.acquireWriteLock(lock)
      this.fault?.('keys.lockPublished')
      if (initial && existsSync(this.file)) throw new NetError('conflict', 'Keys already exist.')
      if (!initial && this.stored && JSON.stringify(parse(readFileSync(this.file))) !== JSON.stringify(this.stored)) throw new NetError('conflict', 'Key file changed in another process; reopen it.')
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const bytes = Buffer.from(JSON.stringify(stored))
      if (bytes.length > 1024 * 1024) throw new NetError('too_large', 'Key file exceeds the bounded storage format.')
      parseProtocolJson(bytes)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      this.fault?.('keys.beforeRename')
      renameSync(temp, this.file)
      const parentFd = openSync(dirname(this.file), constants.O_RDONLY)
      try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
      this.stored = stored; this.keys = keys
    } catch (cause) {
      if (cause instanceof NetError) throw cause
      const code = (cause as NodeJS.ErrnoException).code
      throw new NetError(code === 'ENOSPC' ? 'storage_full' : code === 'EEXIST' ? 'conflict' : 'internal', 'Key storage write failed.', { cause })
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temp)) unlinkSync(temp)
      release?.()
    }
  }
}
