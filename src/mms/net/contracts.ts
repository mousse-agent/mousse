/**
 * Service interfaces for Mousse Net. These are the frozen seams between
 * workstreams: implement against them, do not widen them locally. Semantics
 * that matter for correctness (atomicity, idempotency, ordering) are stated on
 * each member and specified in docs/net/state-machines.md.
 */
import type { Duplex } from 'node:stream'
import type {
  Base64Url,
  BlobId,
  BotAudiencePolicy,
  BotDelegation,
  BotId,
  BotProfile,
  Cursor,
  Envelope,
  EventId,
  ExecutionId,
  KeystoreState,
  Lane,
  NetErrorCode,
  NodeCapability,
  NodeDelegation,
  NodeId,
  NodePublicKeys,
  Roster,
  RosterState,
  Route,
  RoutesRecord,
  RpcId,
  Signed,
  SnapshotReason,
  SpaceDescriptor,
  SpaceId,
  SpaceRole,
  StoredRecord,
  StreamDescriptor,
  StreamHead,
  StreamId,
  TransportId,
  UserId,
  WireMessage
} from '../../shared/net'

// ---------------------------------------------------------------- time

export interface Clock {
  /** Wall clock, ms. */
  now(): number
  /** Monotonic, ms. Use for timeouts and intervals. */
  monotonic(): number
  setTimeout(callback: () => void, ms: number): { cancel(): void }
}

// ---------------------------------------------------------------- identity

export interface TlsCredentials {
  /** PEM. Self-signed certificate for the node transport key. */
  cert: string
  /** PEM, PKCS#8. */
  key: string
}

/**
 * Holds private keys. Private key material never leaves this interface; callers
 * ask it to sign, unwrap or produce TLS credentials.
 */
export interface KeyStore {
  state(): KeystoreState
  unlock(passphrase: string): Promise<void>
  /** Create node keys (and, when `asAuthority`, the user root key). Fails if keys exist. */
  initialize(options: { asAuthority: boolean }): Promise<{ node: NodePublicKeys; rootKey?: Base64Url }>
  nodeKeys(): NodePublicKeys
  /** Present only on the authority node. */
  rootKey(): Base64Url | undefined
  signAsNode(bytes: Uint8Array): Uint8Array
  /** Throws `forbidden` when this node is not the authority. */
  signAsRoot(bytes: Uint8Array): Uint8Array
  createBotKey(bot: BotId): Base64Url
  signAsBot(bot: BotId, bytes: Uint8Array): Uint8Array
  /** X25519 with the node agreement key. */
  agree(peerEphemeral: Uint8Array): Uint8Array
  tlsCredentials(): TlsCredentials
  /** Symmetric secrets (invite proof keys, private-stream keys), encrypted at rest. */
  putSecret(name: string, value: Uint8Array): void
  getSecret(name: string): Uint8Array | undefined
  deleteSecret(name: string): void
  exportRecovery(passphrase: string): Promise<Uint8Array>
  /** Installs the root key on this node. Does not by itself change any roster. */
  importRecovery(file: Uint8Array, passphrase: string): Promise<void>
  /** Removes the root key from this node (after an authority transfer). */
  dropRootKey(): void
}

export type VerifiedAuthor =
  | { kind: 'node'; user: UserId; node: NodeId; delegation: NodeDelegation; verifyOnly: boolean }
  | { kind: 'bot'; user: UserId; bot: BotId; node: NodeId; delegation: BotDelegation; verifyOnly: boolean }

export interface IdentityService {
  self(): { user: UserId; node: NodeId; isAuthority: boolean } | undefined
  rosterState(user: UserId): RosterState
  /** Own latest roster, signed. */
  roster(): Signed | undefined
  /**
   * Verify and adopt a roster for a pinned user. Higher `(recoveryEpoch, version)`
   * wins. Two different rosters at one position, or two lineages at one recovery
   * epoch, set `conflict` and adopt neither. Returns whether state changed.
   */
  acceptRoster(signed: Signed, pinnedRootKey: Base64Url): { changed: boolean; state: RosterState }
  /** Pin a user's root key (trust on first use). Throws `conflict` on a different key. */
  pinUser(user: UserId, rootKey: Base64Url): void
  pinnedRootKey(user: UserId): Base64Url | undefined
  /**
   * Check a detached signature over `bytes` for the claimed author at `keyEpoch`.
   * Throws `bad_signature`, `bad_delegation` or `revoked`. `verifyOnly` is true
   * when the epoch is valid for history but may not author new work.
   */
  verifyAuthor(
    author: Envelope['author'],
    bytes: Uint8Array,
    sig: Uint8Array,
    at: number
  ): VerifiedAuthor
  verifySigned<T>(signed: Signed, publicKey: Base64Url): T
  signAsNode<T>(document: T): Signed
  // Authority-only operations. Each bumps the roster version atomically.
  issueNodeDelegation(input: { node: NodeId; keys: NodePublicKeys; name: string; caps: NodeCapability[] }): Signed
  issueBotDelegation(input: { bot: BotId; key: Base64Url; name: string; hostNode: NodeId }): Signed
  revoke(subject: NodeId | BotId): Signed
  renewExpiring(now: number): Signed | undefined
  transferAuthority(to: NodeId): Signed
  becomeAuthorityFromRecovery(): Signed
  onRosterChanged(listener: (user: UserId) => void): () => void
}

/** Sealing for `space.private` streams. Keys are per stream and per key epoch. */
export interface PrivateStreamKeys {
  /** Create a new content key epoch wrapped to the given nodes. */
  rotate(stream: StreamId, recipients: Array<{ node: NodeId; agree: Base64Url }>): Envelope<'participants.changed'>['body']
  /** Adopt a wrapped key addressed to this node. No-op if not addressed to us. */
  accept(stream: StreamId, body: NonNullable<Envelope<'participants.changed'>['body']>): void
  /** Re-wrap an existing epoch for another node of the same participant. */
  rewrap(stream: StreamId, keyEpoch: number, recipient: { node: NodeId; agree: Base64Url }): NonNullable<Envelope<'participants.changed'>['body']>['wrapped'][number]
  seal(stream: StreamId, plaintext: Uint8Array, aad: Uint8Array): NonNullable<Envelope['sealed']>
  /** Throws `forbidden` when this node holds no key for that epoch. */
  open(stream: StreamId, sealed: NonNullable<Envelope['sealed']>, aad: Uint8Array): Uint8Array
  sealBlob(stream: StreamId, plaintext: Uint8Array): { keyEpoch: number; bytes: Uint8Array }
  openBlob(stream: StreamId, keyEpoch: number, bytes: Uint8Array): Uint8Array
}

// ---------------------------------------------------------------- storage

export interface AppendInput {
  id: EventId
  envelope: Uint8Array
  sig: Uint8Array
  recvTs: number
}

export type AppendOutcome =
  | { kind: 'stored'; epoch: number; seq: number; recvTs: number }
  /** Same id and same bytes seen before: the original position. */
  | { kind: 'duplicate'; epoch: number; seq: number; recvTs: number }

export interface ReplayPage {
  records: StoredRecord[]
  /** True when the page reaches `through`. */
  done: boolean
}

export interface StreamStore {
  createStream(descriptor: StreamDescriptor, epoch: number): void
  getStream(id: StreamId): StreamDescriptor | undefined
  listStreams(filter?: { space?: SpaceId; kind?: StreamDescriptor['kind'] }): StreamDescriptor[]
  head(stream: StreamId): StreamHead
  /**
   * Authority side. Assigns the next dense sequence in the current epoch, in one
   * transaction. Idempotent on `(stream, id)`; the same id with different bytes
   * throws `conflict`. Throws `too_large`, `storage_full`.
   */
  appendAsAuthority(stream: StreamId, input: AppendInput): AppendOutcome
  /**
   * Subscriber side. Stores records received from the authority and advances the
   * contiguous cursor in the same transaction. Records ahead of `cursor.seq + 1`
   * are not accepted here (the caller buffers them); returns the new cursor.
   */
  applyFromAuthority(stream: StreamId, records: StoredRecord[]): Cursor
  cursor(stream: StreamId): Cursor
  /**
   * Records with `after < seq <= through`, at most `budgetBytes` (always at
   * least one). Throws `snapshot_required` when the range is not fully retained
   * or the epoch differs.
   */
  read(stream: StreamId, after: StreamHead, through: number, budgetBytes: number): ReplayPage
  /** Why a subscriber at `after` cannot be served by replay, if so. */
  snapshotReason(stream: StreamId, after: StreamHead): SnapshotReason | undefined
  /** Replace local state for a stream with a snapshot and set the cursor, atomically. */
  installSnapshot(stream: StreamId, epoch: number, throughSeq: number, records: StoredRecord[]): Cursor
  /** Start a new authority epoch for all streams of a space (restore or move). */
  beginEpoch(space: SpaceId, epoch: number): void
  /** Drop records up to `throughSeq`. Never allowed on `space.meta`. */
  truncate(stream: StreamId, throughSeq: number): void
  getById(stream: StreamId, id: EventId): StoredRecord | undefined
}

export interface BlobStore {
  /** Streaming upload into a pending slot; becomes visible only on `commit`. */
  begin(blob: BlobId, expectedBytes: number, sealed: boolean): BlobUpload
  has(blob: BlobId): boolean
  size(blob: BlobId): number | undefined
  read(blob: BlobId, offset: number, length: number): Uint8Array
  addRef(blob: BlobId, stream: StreamId, event: EventId): void
  isReferenced(blob: BlobId, stream: StreamId): boolean
  /** Remove expired pending uploads and unreferenced blobs past the grace period. */
  collectGarbage(now: number): { removed: number; bytes: number }
}

export interface BlobUpload {
  write(offset: number, chunk: Uint8Array): void
  /** Verifies length and SHA-256 against the id; throws `conflict` on mismatch. */
  commit(): void
  abort(): void
}

export type OutboxState = 'pending' | 'unknown' | 'sent' | 'failed'

export interface OutboxEntry {
  id: EventId
  stream: StreamId
  envelope: Uint8Array
  sig: Uint8Array
  state: OutboxState
  attempts: number
  createdAt: number
  error?: NetErrorCode
  position?: { epoch: number; seq: number }
}

/** Journal first, then send. Entries are resent under the same event id. */
export interface Outbox {
  enqueue(entry: Pick<OutboxEntry, 'id' | 'stream' | 'envelope' | 'sig'>): void
  /** Entries to (re)send for a stream, oldest first. */
  due(stream: StreamId): OutboxEntry[]
  markAttempt(id: EventId): void
  markSent(id: EventId, position: { epoch: number; seq: number }): void
  markFailed(id: EventId, error: NetErrorCode): void
  get(id: EventId): OutboxEntry | undefined
  list(stream: StreamId): OutboxEntry[]
  onChanged(listener: (entry: OutboxEntry) => void): () => void
}

export type ExecutionState =
  | 'accepted'
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  | 'expired'

export interface ExecutionKey {
  /** Space for bot runs; the calling node for Bridge RPC and dispatch. */
  scope: SpaceId | NodeId
  /** Bot for bot runs; the method for RPC. */
  target: BotId | string
  /** Triggering event id, or the RPC idempotency key. */
  trigger: string
}

export interface ExecutionRecord extends ExecutionKey {
  id: ExecutionId
  payloadHash: string
  state: ExecutionState
  startedAt: number
  updatedAt: number
  result?: unknown
  error?: { code: string; message: string }
}

export type AdmitOutcome =
  | { kind: 'admitted'; record: ExecutionRecord }
  | { kind: 'duplicate'; record: ExecutionRecord }

export interface ExecutionLedger {
  /**
   * Insert a new execution or report the existing one. The same key with a
   * different `payloadHash` throws `conflict`. `sideEffects` runs in the same
   * transaction (budget reservation, outbox enqueue of the acceptance event).
   */
  admit(key: ExecutionKey, payloadHash: string, now: number, sideEffects?: () => void): AdmitOutcome
  transition(id: ExecutionId, to: ExecutionState, now: number, patch?: Pick<ExecutionRecord, 'result' | 'error'>): ExecutionRecord
  get(id: ExecutionId): ExecutionRecord | undefined
  find(key: ExecutionKey): ExecutionRecord | undefined
  /**
   * After a process restart: `accepted` becomes `failed`, `running` and
   * `waitingApproval` become `uncertain`. Returns the changed records.
   */
  recoverAfterRestart(now: number): ExecutionRecord[]
  /** Dedup state for a bot placement move. */
  exportFor(target: BotId): Array<Pick<ExecutionRecord, 'scope' | 'target' | 'trigger' | 'payloadHash' | 'state'>>
  importFor(target: BotId, rows: ReturnType<ExecutionLedger['exportFor']>): void
}

export interface BudgetLedger {
  setDailyBudget(bot: BotId, space: SpaceId, units: number): void
  /** Atomically reserve `units` for an execution; throws `budget_exhausted`. */
  reserve(bot: BotId, space: SpaceId, execution: ExecutionId, units: number, now: number): void
  /** Replace the reservation with actual spend. Idempotent per execution. */
  settle(execution: ExecutionId, spentUnits: number): void
  remaining(bot: BotId, space: SpaceId, now: number): number
}

// ---------------------------------------------------------------- space meta

export interface MetaState {
  space: SpaceId
  owner: UserId
  descriptor: SpaceDescriptor
  frozen: boolean
  settings: Envelope<'space.created'>['body'] extends infer B ? (B extends { settings: infer S } ? S : never) : never
  members: Map<UserId, { rootKey: Base64Url; role: SpaceRole; displayName: string }>
  bots: Map<BotId, { owner: UserId; delegation: BotDelegation; profile: BotProfile; policy: BotAudiencePolicy; displayName: string }>
  channels: Map<StreamId, { name: string; archived: boolean }>
  /** Position this state reflects. */
  applied: StreamHead
  /** Set when an unknown critical event was met; execution and writes stop. */
  upgradeRequired: boolean
}

export type MetaDecision = { ok: true } | { ok: false; code: NetErrorCode; reason: string }

/** Deterministic replay of `space.meta`. The same events give the same state everywhere. */
export interface MetaProjection {
  state(space: SpaceId): MetaState | undefined
  /** Would this meta event be valid as the next event? Used by the host before storing. */
  check(space: SpaceId, envelope: Envelope, author: VerifiedAuthor): MetaDecision
  /** Apply the next stored meta record. Invalid events are ignored and reported. */
  apply(space: SpaceId, record: StoredRecord): { applied: boolean; violation?: string }
  canRead(space: SpaceId, stream: StreamDescriptor, user: UserId): boolean
  canWrite(space: SpaceId, stream: StreamDescriptor, envelope: Envelope, author: VerifiedAuthor): MetaDecision
  canSteer(space: SpaceId, bot: BotId, user: UserId): boolean
}

// ---------------------------------------------------------------- link

export interface TransportTraits {
  canListen: boolean
  canDial: boolean
  /** True when an intermediary terminates outer encryption (informational only). */
  readsPlaintext: boolean
  needsAccount: boolean
}

export type TransportState = 'disabled' | 'provisioning' | 'ready' | 'degraded' | 'failed'

export interface TransportStatus {
  state: TransportState
  detail?: string
  /** Preserved cause of the last failure. */
  lastError?: { code: NetErrorCode; message: string; cause?: unknown }
  /** Routes this transport currently offers for the local node. */
  routes: Route[]
}

export interface Listener {
  close(): Promise<void>
}

export interface InboundInfo {
  remoteAddress?: string
  transport: TransportId
}

/**
 * A transport yields plain byte streams. It provides no security: TLS with key
 * pinning always runs on top.
 */
export interface Transport {
  readonly id: TransportId
  readonly traits: TransportTraits
  /** Idempotent. May spawn or configure external tools. */
  provision(): Promise<void>
  listen(onConnection: (stream: Duplex, info: InboundInfo) => void): Promise<Listener>
  dial(route: Route, signal: AbortSignal): Promise<Duplex>
  status(): TransportStatus
  onStatus(listener: (status: TransportStatus) => void): () => void
  /** Idempotent. */
  teardown(): Promise<void>
}

export interface TransportManifest {
  id: TransportId
  kind: 'transport'
  displayName: string
  traits: TransportTraits
  /** JSON Schema for this add-on's settings. */
  settingsSchema: Record<string, unknown>
  setupSteps: Array<{ title: string; detail: string; command?: string }>
}

export interface TransportAddon {
  manifest: TransportManifest
  create(settings: unknown, context: { clock: Clock; profileDir: string }): Transport
}

export interface SecureChannelOptions {
  role: 'client' | 'server'
  credentials: TlsCredentials
  /** SHA-256 fingerprint (base64url) of the expected peer transport key, when known up front. */
  expectedPeerFingerprint?: Base64Url
  deadlineMs: number
  signal?: AbortSignal
}

export interface SecureChannel {
  /** Encrypted byte stream. */
  readonly stream: Duplex
  /** Peer transport public key, SPKI DER base64url, taken from the peer certificate. */
  readonly peerTransportKey: Base64Url
  /** TLS exporter value for channel binding. */
  exporter(label: string, length: number): Uint8Array
  close(): void
}

/** Runs TLS 1.3 over `raw`. Rejects with `peer_key_mismatch` before any application byte. */
export type OpenSecureChannel = (raw: Duplex, options: SecureChannelOptions) => Promise<SecureChannel>

export interface MuxMessage {
  header: WireMessage
  parts: Uint8Array[]
}

/** Two lanes with independent credit windows; control is always scheduled first. */
export interface Mux {
  send(lane: Lane, message: MuxMessage, signal?: AbortSignal): Promise<void>
  onMessage(listener: (lane: Lane, message: MuxMessage) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  /** Bytes queued and not yet written, per lane. */
  queued(lane: Lane): number
  close(error?: Error): void
}

export interface PeerRef {
  node: NodeId
  user: UserId
  routes: Route[]
  transportKey: Base64Url
}

export type RouteHealth = { route: Route; state: 'unknown' | 'ok' | 'failing'; lastError?: NetErrorCode; lastOkAt?: number }

export interface RouteManager {
  /** Dial by priority with stagger, per-phase deadlines and backoff. */
  connect(peer: PeerRef, signal: AbortSignal): Promise<{ channel: SecureChannel; route: Route }>
  health(peer: NodeId): RouteHealth[]
  localRoutes(): RoutesRecord
}

// ---------------------------------------------------------------- sync

export type SessionState = 'connecting' | 'open' | 'closing' | 'closed'

export interface SubscriptionHandlers {
  /** Called in order, each record exactly once, after it is durably stored. */
  onRecord(record: StoredRecord): void
  onCaughtUp(): void
  onSnapshotInstalled(cursor: Cursor): void
  onError(code: NetErrorCode): void
}

export interface SyncSession {
  readonly peer: { node: NodeId; user: UserId; delegation: NodeDelegation }
  state(): SessionState
  /** Measured `peer clock − local clock`, ms. */
  clockOffsetMs(): number
  /** Subscribe from the local contiguous cursor; resumes automatically. */
  subscribe(stream: StreamId, handlers: SubscriptionHandlers): { close(): void }
  /** Resolves with the authority's position. Idempotent on the event id. */
  append(stream: StreamId, id: EventId, envelope: Uint8Array, sig: Uint8Array): Promise<{ epoch: number; seq: number; recvTs: number }>
  metaHead(stream: StreamId): Promise<StreamHead>
  putBlob(stream: StreamId, blob: BlobId, bytes: Uint8Array, sealed: boolean): Promise<void>
  getBlob(stream: StreamId, blob: BlobId): Promise<Uint8Array>
  rpc(method: string, params: unknown, options: { idem?: string; deadlineMs: number; signal?: AbortSignal; onProgress?: (data: unknown) => void }): Promise<unknown>
  sendEphemeral(message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>): void
  onEphemeral(listener: (message: Extract<WireMessage, { t: 'presence' | 'ephemeral' }>) => void): () => void
  onClosed(listener: (error?: Error) => void): () => void
  close(code?: NetErrorCode): void
}

/** What an authority node plugs into a session to serve streams. */
export interface StreamAuthority {
  canRead(stream: StreamId, peer: SyncSession['peer']): boolean
  /** Validate and store. Throws a NetError to reject. */
  append(stream: StreamId, id: EventId, envelope: Uint8Array, sig: Uint8Array, peer: SyncSession['peer']): AppendOutcome
  canFetchBlob(stream: StreamId, blob: BlobId, peer: SyncSession['peer']): boolean
  acceptBlob(stream: StreamId, blob: BlobId, bytes: number, sealed: boolean, peer: SyncSession['peer']): void
}

export interface RpcContext {
  id: RpcId
  caller: SyncSession['peer']
  signal: AbortSignal
  deadlineAt: number
  progress(data: unknown): void
}

export interface RpcMethod {
  method: string
  capability: NodeCapability
  mutating: boolean
  handle(params: unknown, context: RpcContext): Promise<unknown>
}

/** Deny by default: a method that is not registered is `forbidden`. */
export interface RpcDispatcher {
  register(method: RpcMethod): void
  methods(): string[]
  dispatch(method: string, params: unknown, idem: string | undefined, context: RpcContext): Promise<unknown>
}

// ---------------------------------------------------------------- bots

export interface BotRunRequest {
  execution: ExecutionId
  bot: BotId
  space: SpaceId
  profile: BotProfile
  /** Compartment whose history this run may read and extend. */
  compartment: string
  prompt: string
  /** Project root for `reader`; absent for `chat`. */
  projectRoot?: string
  spendCeilingUnits: number
  signal: AbortSignal
}

export interface BotRunEvents {
  onProgress(text: string): void
  onToolSummary(tool: string, summary: string): void
  onWaitingApproval(summary: string): void
}

export interface BotRunResult {
  text: string
  spentUnits: number
}

/**
 * Adapter over the existing agent runtime. `supports` must be honest: a profile
 * is offered only when this adapter can enforce it. See docs/net/bot-runtime.md.
 */
export interface BotRuntimeAdapter {
  readonly id: string
  supports(profile: BotProfile): boolean
  run(request: BotRunRequest, events: BotRunEvents): Promise<BotRunResult>
}

/** Per-bot conversation state, separated by audience. See docs/net/compartments.md. */
export interface CompartmentStore {
  /** Public compartment of a bot in a space. */
  publicId(bot: BotId, space: SpaceId): string
  /** Private compartment for one participant set (visibility epoch) of a private stream. */
  privateId(bot: BotId, stream: StreamId, keyEpoch: number): string
  appendTurn(compartment: string, turn: { role: 'user' | 'assistant'; author?: UserId | BotId; text: string; ts: number }): void
  history(compartment: string, limit: number): Array<{ role: 'user' | 'assistant'; author?: UserId | BotId; text: string; ts: number }>
  drop(compartment: string): void
}
