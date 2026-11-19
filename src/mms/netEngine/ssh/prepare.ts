import { NetError } from '../../../shared/net/errors'
import { engineControl } from '../limits'
import type { SshRequest, SshRequestStore } from './requests'

/** What A sends in session 2 (1b §3.4 step 4). */
export interface PrepareRequest {
  requestId: string
  issuedAt: number
  selector?: string
  newLabel?: string
  joiner: string
  joinerName: string
}

/** B's reply (step 6). */
export interface PrepareReply {
  identity: string
  name: string
  selector: string
  grant_id: string
  existing: boolean
  already: boolean
  starts_at_login: boolean
}

/** B's row for A in the chosen profile, as step 4 reads it. */
export interface PrepareRow {
  key: string
  state: string
  /** The request that wrote it (an SSH row of this or another request). */
  requestId?: string
  grant?: string
}

/** One profile's engine as the steps use it. */
export interface PrepareEngine {
  identity: string
  name: string
  rowFor(joiner: string): PrepareRow | undefined
  /** Step 4: `{state: ssh_granting, source: ssh, request_id}`; answers its key. */
  writeOwnRow(request: PrepareRequest): string
  /** Step 5: `grant.add {identity, name, receipt: request_id}` (idempotent by identity). */
  grantAdd(request: PrepareRequest): Promise<string>
  setRowGrant(key: string, grant: string): void
  /** Step 6: an own row moves to `ssh_granted`. */
  granted(key: string): void
  /** Whether the helper still holds the grant `grantId` live. */
  grantLive(grantId: string): Promise<boolean>
  /** The grant id on a serving row, if the row still serves. */
  rowGrant(key: string): string | undefined
}

export interface PreparePort {
  requests: SshRequestStore
  /** Seconds since 1970, B's clock. */
  now(): number
  maxAgeSecs: number
  /** The profile with this selector, if any. */
  hasProfile(selector: string): boolean
  /** The profile a crash may have left made for this request (its tag), if any. */
  profileTagged(requestId: string): string | undefined
  /** Step 2: a new profile with `label`, tagged with the request; answers its selector. */
  createProfile(label: string, requestId: string): Promise<string>
  /** Step 3: the profile's networking, on with nothing advertised, its helper running. */
  engine(selector: string): Promise<PrepareEngine>
  /** Runs `work` under the per-device lock 1a's removal takes for `joiner` on `selector`. */
  locked<T>(selector: string, joiner: string, work: () => Promise<T>): Promise<T>
  startsAtLogin(): boolean
}

const removed = () =>
  new NetError('forbidden', 'This computer removed that access.', { details: { reason: 'removed' } })

const same = (a: SshRequest, b: PrepareRequest): boolean =>
  a.issuedAt === b.issuedAt &&
  a.joiner === b.joiner &&
  a.joinerName === b.joinerName &&
  (a.selector ?? '') === (b.selector ?? '') &&
  (a.newLabel ?? '') === (b.newLabel ?? '')

/**
 * B's side of `prepare` (1b §3.4 step 4): each step records its result before the next, so a repeat with the same
 * `request_id` resumes at the first unrecorded step, and a request already done answers its stored reply only while
 * its grant still serves. Runs under the removal lock of A on the profile.
 */
export async function prepare(port: PreparePort, request: PrepareRequest): Promise<PrepareReply> {
  if (!/^[0-9a-f]{32}$/.test(request.requestId))
    throw new NetError('bad_request', 'Bad request id.', { details: { reason: 'bad_request' } })
  if (!request.selector === !request.newLabel)
    throw new NetError('bad_request', 'Name one profile.', { details: { reason: 'bad_request' } })

  // The control makes the profile before the request is journaled: a crash between them leaves a profile no
  // repeat finds, so the repeat makes a second one.
  if (engineControl('profile-before-journal') && request.newLabel && !port.requests.get(request.requestId))
    await port.createProfile(request.newLabel, request.requestId)

  // 1. Journal the request.
  let record = port.requests.get(request.requestId)
  if (!record) {
    if (request.issuedAt < port.now() - port.maxAgeSecs)
      throw new NetError('clock_skew', 'That request expired.', { details: { reason: 'expired' } })
    record = port.requests.add(request, port.now())
  } else if (!same(record, request))
    throw new NetError('bad_request', 'That request id was used for something else.', {
      details: { reason: 'bad_request' }
    })
  if (record.state === 'removed') throw removed()

  // 2. Profile.
  let profile = record.profile
  if (!profile) {
    if (request.selector) {
      if (!port.hasProfile(request.selector))
        throw new NetError('bad_request', 'That profile is gone.', {
          details: { reason: 'remote_no_endpoint' }
        })
      profile = request.selector
    } else
      profile =
        port.profileTagged(request.requestId) ??
        (await port.createProfile(request.newLabel!, request.requestId))
    record = port.requests.update(request.requestId, { profile })
  }
  const selector = profile

  return port.locked(selector, request.joiner, async () => {
    record = port.requests.get(request.requestId)!
    if (record.state === 'removed') throw removed()
    // 3. Networking.
    const engine = await port.engine(selector)

    if (record.state === 'done') {
      const stored = record.reply as PrepareReply | undefined
      const key = record.rowKey
      const live =
        !!record.grantId &&
        !!key &&
        (engineControl('grant-id-not-checked') ||
          ((await engine.grantLive(record.grantId)) && engine.rowGrant(key) === record.grantId))
      if (!stored || !live) {
        port.requests.update(request.requestId, { state: 'removed' })
        throw removed()
      }
      return { ...stored, already: true }
    }

    // 4. Row.
    let key = record.rowKey
    if (!record.row) {
      const row = engine.rowFor(request.joiner)
      if (row?.state === 'removing')
        throw new NetError('conflict', 'Busy; try again.', { details: { reason: 'busy' } })
      if (row && row.requestId !== request.requestId && !engineControl('overwrite-1a-row')) {
        // Any other live row is never overwritten: it is kept, with its grant.
        record = port.requests.update(request.requestId, {
          row: 'existing',
          rowKey: row.key,
          ...(row.grant ? { grantId: row.grant } : {})
        })
        return done(port, engine, record, selector, true)
      }
      if (row && row.requestId === request.requestId && !engineControl('own-row-not-resumed'))
        key = row.key
      else key = engine.writeOwnRow(request)
      record = port.requests.update(request.requestId, { row: 'own', rowKey: key })
    }
    if (record.row === 'existing') return done(port, engine, record, selector, true)

    // 5. Grant: stored on the request, then on the row.
    let grant = record.grantId
    if (!grant) {
      grant = await engine.grantAdd(request)
      record = port.requests.update(request.requestId, { grantId: grant })
    }
    if (engine.rowGrant(key!) !== grant) engine.setRowGrant(key!, grant)

    // 6. Done.
    engine.granted(key!)
    return done(port, engine, record, selector, false)
  })
}

function done(
  port: PreparePort,
  engine: PrepareEngine,
  record: SshRequest,
  selector: string,
  existing: boolean
): PrepareReply {
  const reply: PrepareReply = {
    identity: engine.identity,
    name: engine.name,
    selector,
    grant_id: record.grantId ?? '',
    existing,
    already: false,
    starts_at_login: port.startsAtLogin()
  }
  // The control keeps no reply for an existing row: a repeat after a lost reply then has nothing to answer.
  if (!(existing && engineControl('existing-reply-not-kept')))
    port.requests.update(record.requestId, { state: 'done', reply: { ...reply } })
  return reply
}

/**
 * A removal of A on B (under the removal lock): every open or done request of A for that profile is `removed`, and
 * a grant a request saved before its id was stored is found by identity and receipt and removed first (§3.6).
 */
export async function removeRequestsOf(
  requests: SshRequestStore,
  joiner: string,
  selector: string,
  grants: {
    list(): Promise<Array<{ grant: string; identity: string; receipt?: string }>>
    remove(grant: string): Promise<void>
  }
): Promise<void> {
  const open = requests.live(joiner, selector)
  if (!open.length) return
  if (open.some((request) => !request.grantId) && !engineControl('removal-skips-unsaved-grant')) {
    const ids = new Set(open.map((request) => request.requestId))
    for (const grant of await grants.list())
      if (grant.identity === joiner && grant.receipt && ids.has(grant.receipt))
        await grants.remove(grant.grant)
  }
  for (const request of open) requests.update(request.requestId, { state: 'removed' })
}
