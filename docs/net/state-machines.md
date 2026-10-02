# Mousse Net state machines

This is a P0 contract, not a claim that P1–P9 behavior exists. MUST, MUST NOT and MAY are normative. [protocol.md](protocol.md) defines encoding and transport limits; [PLAN.md](PLAN.md) defines scope. Service owners below refer to `src/mms/net/contracts.ts`. State names finer than a public union are internal substates, not additional public API values. Decisions filling an underspecified plan rule are marked **P0 decision**.

## Shared rules

A guard is evaluated immediately before its transition, against verified, durably applied state. Meta live append and historical replay are distinct modes: live checks current unrevoked identity; historical replay verifies embedded/historically retained root-signed delegation evidence at original event authorization time and roles in the historical pre-event state. Later key rotation, expiry, revocation or placement changes never retroactively remove a valid committed membership/bot event. Runtime qualification is enforced by bot setup/executor admission only; it is not signed meta state and cannot affect deterministic projection. Historical signature validity is not permission for new work. A host-provided timestamp is not independent proof of real-time ordering. A rejected operation MUST NOT partially change state. Unlisted transitions are forbidden. Repeating an already committed transition with identical identity and bytes returns its original outcome; reusing an identity with different bytes is `conflict`. Network success, a socket, or an advertised head does not prove durability or authorization.

Wall-clock timestamps are integer milliseconds; deadlines use `Clock.monotonic()`. Sequences, versions and epochs are safe nonnegative integers, epochs start at 1, and increments never wrap. Before exhaustion the authority stops writes with `conflict`; it cannot invent an epoch. Logs never contain tokens, proof keys, passphrases, private material, sealed plaintext or message text. Errors retain their code and sanitized cause chain.

On storage failure, the transaction rolls back; no success acknowledgment or runtime start follows. Disk full enters read-only recovery mode (`storage_full`). Integrity failure quarantines net data (`storage_corrupt`). **P0 decision:** a resynced event history cannot reconstruct whether external effects happened. Losing an execution ledger disables execution for its bot/RPC scopes until a trustworthy ledger backup is restored or an explicit owner recovery boundary is installed. Historical mentions are never treated as new work after this reset. The UI states that deduplication evidence was lost.

## Session and routes

Owner: `RouteManager`, `OpenSecureChannel`, `SyncSession`. Public states: `connecting`, `open`, `closing`, `closed`. Internal connecting phases: resolve, connect, TLS, authenticate/hello; `backoff` belongs to the connection supervisor.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| closed | connect; keys unlocked, peer pinned, roster not conflicted | Select verified routes by priority; begin resolve deadline 5 s | connecting/resolve |
| resolve | resolved route | Dial with 10 s deadline; stagger alternatives, cancel losing dials | connecting/connect |
| connect | byte stream obtained | TLS 1.3, mutual certificates, 10 s deadline | connecting/TLS |
| TLS | handshake complete; expected peer fingerprint known | Compare certificate SPKI fingerprint before application bytes; mismatch closes `peer_key_mismatch` | connecting/hello |
| TLS | normal peer delegation not yet available | Permit only bounded preauth hello to obtain delegation; expose no service, send no sensitive application data | connecting/hello |
| hello | major equal; valid pinned-root delegation/roster; node matches certificate transport key, current epoch, unrevoked, nonconflicted | Negotiate minor/capabilities, verify signed routes; complete both hello gates within 10 s | open |
| hello | enrollment connection | Only enrollment messages allowed; inviter pinned by invite, joiner keys bound to certificate and proof | open/enrollment-only |
| connecting | timeout, malformed preauth, wrong key/version, revoked or invalid delegation | Close stream; retain layer/code/cause, never publish authenticated session | closed |
| open | matching session-code pong | Reset missed count; measure offset; healthy route independent of subject presence | open |
| open | three unanswered 20 s ping intervals | Fail pending wire operations as uncertain where applicable; close | closing |
| open | verified revocation, conflict, expiry, goAway, shutdown | Stop admitting new work; cancel caller work/uploads/subscriptions; drain bounded cleanup | closing |
| closing | cleanup complete or deadline | Release lanes/listeners, call closed once | closed |
| any live phase | abort signal | Cancel phase and loser attempts, return `cancelled` | closed |

Only peer session code answers pings; WebSocket/tunnel pongs do not count. Preauth bounds are 32 total connections, 4 per address, 16 KiB and a 10 s authentication budget. Enrollment-only sessions cannot subscribe, append, fetch blobs or dispatch RPC. A normal session never inherits authority from its transport.

The supervisor retries reachability/timeouts with exponential jitter from 1 to 60 s. Identity, key mismatch, version and explicit revocation errors require a state change, not a reconnect loop. Reset backoff only after an authenticated session survives 30 s. Delegation renewal is scheduled independently of socket health. Crash from every phase discards connections/timers/credits and starts new TLS/hello; sessions and TLS tickets are never restored. Persist only verified identity/routes and diagnostic metadata. Property invariants: no application dispatch before all authentication gates; at most one winning session per connect attempt; timers/losers cleaned on every exit.

## Subscription, replay and snapshots

Owner: `SyncSession` subscriber plus `StreamStore`. States: stopped, subscribing, replaying, live, resnapshot, staging, blocked. Durable cursor is `(stream, epoch, seq)` of a complete stored prefix.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| stopped | subscribe and current read grant | Send durable cursor | subscribing |
| subscribing | subscribed for authorized current epoch, consistent head and replayThrough | Set immutable replayThrough for this attempt | replaying |
| replaying/live | next seq in cursor epoch, verified record | Store and move cursor in one transaction; notify after commit; drain next contiguous buffered records | same |
| replaying | live record ahead of cursor | Buffer by position; exact duplicates coalesce; conflicting bytes fail closed | replaying |
| replaying | caughtUp and cursor has reached replayThrough | Notify caught-up once; continue contiguous live delivery | live |
| replaying | caughtUp with gap | Do not advance/notify; request gap by a fresh subscribe | subscribing |
| replaying/live | overlap exceeds 1,000 records or 4 MiB | Discard ephemeral buffer, close attempt and resubscribe from durable cursor | subscribing |
| subscribing/replaying/live | snapshotRequired: cursorTooOld, cursorAhead, epochChanged, gapOverBudget | Abandon attempt; request snapshot under current read authority | resnapshot |
| resnapshot | first chunk, pinned current epoch/head | Stage outside active projection; check every chunk and cumulative bounds | staging |
| staging | final complete snapshot, still authorized, descriptors verified | Validate complete history/projection; atomically install snapshot and cursor | subscribing |
| staging | disconnect, error, checksum/signature failure, membership revoked | Discard staging; keep old cursor/state; never execute snapshot content | stopped or blocked |
| any active | removal/private exclusion or roster conflict | Stop unauthorized remote delivery/read, discard pending unauthorized bytes | blocked |
| member replica | unknown critical authorization | Continue bounded opaque durable replication, stop safe projection before event, execution and writes | blocked authorization |
| host authority | unknown critical authorization | Stop authorization-dependent reads, snapshots, blobs and fan-out as well as writes/execution | blocked |
| any active | transport closes | Drop overlap and incomplete staging; retain cursor | stopped |
| any | unsubscribe | Cancel attempt, discard ephemeral buffers | stopped |

A wrong-epoch record is never stored into the current prefix. A changed owner-signed descriptor triggers new-epoch snapshot; old records remain local as abandoned history, not current executable state. Duplicate old positions must match stored bytes/signature; otherwise `conflict` and host misbehavior. **P0 decision:** malformed or unauthorized stored records may be retained as evidence but cannot advance an authorization projection until their position is explicitly accounted for; validly signed but semantically invalid meta records advance the scanned position with a violation, leaving semantic state unchanged (§Meta). Unknown critical records stop the applied authorization head before that record.

Meta snapshots contain full signed history and epoch descriptor links; there is no trusted projected member list. **P0 decision:** original meta records preserve their original `(epoch,seq)` across old and current epochs. Snapshot header epoch/throughSeq identifies the active epoch tail, not a rewrite of all historical record positions. Rebuild validates dense prefixes within each epoch and each first-record owner descriptor transition, then publishes the current projection/cursor atomically. `space.meta` validation must not reject prior epochs solely because they differ from the snapshot header. Non-meta snapshots contain only the active epoch projection; abandoned history stays outside executable state. Other snapshots are display-only; admission is prohibited from all snapshot records. Large snapshots use bounded staging and yielding transactions, not one unbounded in-memory array or one transaction. The final pointer/cursor commit is atomic; a crash before it leaves old state, after it leaves new state. Replay transactions are at most 500 rows or 1 MiB. Cursor never skips a gap, decreases in the same epoch, or reflects uncommitted data; snapshot completion is required before visibility switches. `onRecord` is once per newly committed record in this subscription attempt; after process restart callers rebuild projection from stored state rather than treating callback delivery as durable work admission.

## Outbox message

Owner: `Outbox`, sender through `SyncSession`. Durable states: pending, unknown, sent, failed.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| absent | local send; signed bytes complete | Commit id, stream, exact bytes and signature before any network send | pending |
| pending/unknown | attempt with current authority/read-write grant | Increment attempts and durably record ambiguity before sending same id/bytes | unknown |
| unknown/pending | successful appendResult or verified replay matches id, bytes and signature | Store original authority epoch/seq | sent |
| unknown | disconnect, lost result or deadline | Preserve uncertainty; reconcile by replay/getById or same-id resend | unknown |
| pending/unknown | retryable rejection conclusively before storage | Preserve bytes; schedule bounded retry | pending |
| pending/unknown | explicit terminal rejection | Store terminal code; present failed result | failed |
| sent/failed | duplicate matching receipt/rejection | Return committed result, do not recreate a send | same |

**P0 decision:** timeout or `retryable` alone does not prove rejection; only a correlated authority rejection establishes that attempt did not commit. An unknown entry must not get a new id automatically. Epoch move with uncertain append requires reconciliation of abandoned history and explicit user choice; never automatically author old commands into a replacement epoch. Editing a failed message creates a new event id. Crash restores pending/unknown/sent/failed exactly; uncertain in-flight attempts remain unknown. `markAttempt` must perform pending→unknown durably. Property invariants: journal precedes send; one id never changes bytes; sent requires evidence, not a successful write to a socket.

## Node enrollment and invite lifecycle

Owner: `KeyStore`, `IdentityService`, enrollment authority (P2). Authority invite states: active, consumed, expired/revoked; joiner: uninitialized, prepared, connecting, awaitingResult, enrolled, failed.

| Side/current | Trigger and guard | Action | Next |
|---|---|---|---|
| authority/absent | invite; unlocked current authority, nonconflicted | Generate 256-bit T; protect derived proofKey; persist invite id, tokenId, policy/expiry and state; print mj1 string | active |
| joiner/uninitialized | join string parsed, unexpired with inviter pin/routes | Generate and durably store one node identity/keyset and join attempt before dialing | prepared |
| joiner/prepared | connect | Pin inviter TLS; derive proof; bind exact proof-free request and 32-byte exporter | awaitingResult |
| authority/active | request; valid exporter-bound proof, certificate matches requested transport key, unexpired | One transaction consumes invite bound to node id/keys/request, issues delegation, advances signed roster and stores exact result | consumed |
| authority/consumed | retry same bound request/keyset with fresh session proof | Return original delegation/roster; never issue a second delegation | consumed |
| authority/active or consumed | wrong proof, changed request/node/keys, invalid pin | `invite_invalid`; no roster/key mutation | same |
| authority/active | expiry/revoke | Remove active acceptance ability, retain tombstone as needed | expired/revoked |
| joiner/awaitingResult | verified result tied to request and pinned root | Persist root pin, delegation and roster together | enrolled |
| joiner/awaitingResult | disconnect/lost result | Keep keys/request; retry with new exporter proof | prepared |
| joiner/any pre-enrolled | invalid terminal response | Preserve keys for diagnostics/retry; reveal no secrets | failed |

HKDF/proof byte construction is in protocol. Authority never stores T in plaintext; a token hash is not an HMAC verification key. **P0 decision:** a consumed token's identical retry may retrieve its committed result after expiry, but must provide fresh bound proof; expiry prohibits new admissions, not lost-response retrieval. Retain consumed proof/result at least until issued delegation expiry; later returns `invite_invalid` and requires authority inspection/new invite, never silent re-enrollment. Concurrent requests serialize consumption; only one keyset wins. Crash before authority commit leaves active, after commit leaves consumed. Joiner crash from prepared/awaitingResult retries identical identity; after enrolled it uses normal hello. Invite output and proofs are secret, no-echo input is the safe default.

Space invites use the same protected token/proof and atomic consumption principle. Different-user space joining MUST use an explicit quarantined space-join exchange, not same-user Bridge RPC and not authority node enrollment. Before establishing space membership, verify the inviter descriptor/transport pin, invitation proof bound to TLS exporter and full join request, and joiner delegated transport-key possession/delegation/roster/transport-key equality. No normal space reads or writes precede this gate. A valid invite authorizes pinning the joiner root for the new membership, not replacing a pinned existing root. A successful join commits invite-use receipt and member.joined as one transaction; owner approval pending requests consume no use until approval. Replicas verify authorization evidence described below, never bearer tokens. No new root pin is accepted as a rotation of an existing member identity merely because a host says so.

## Roster, authority, keystore and historical keys

Owner: `IdentityService`, `KeyStore`. Keystore missing→unlocked on explicit initialization; locked→unlocked only after successful vault/passphrase unlock; unlock failure changes nothing. Locked/missing may read public stored history but cannot sign, seal, accept invitations or execute; encrypted data remains inaccessible. Runtime vault failure does not downgrade an existing encrypted store.

Roster states are ok and conflict; local authority substates: follower, authority, transferring, retired, recoveryPrepared. Persist verified rosters, pins, all historical verify keys, revocation maxima and conflict evidence.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| unpinned | explicit init/join trust decision | Pin user root fingerprint; verify initial roster | ok |
| ok | same signed roster bytes | No-op | ok |
| ok | lower position, same lineage; no new equivocation | Retain historical verification evidence, never roll back | ok |
| ok | higher version in same recovery epoch/lineage or higher recovery epoch | Verify root, owner, delegations and revocation nonregression; atomically adopt | ok |
| ok/conflict | different roster at same `(recoveryEpoch,version)` or different lineages in same recovery epoch | Retain conflict evidence, freeze user's writes/execution/new sessions/enrollment; existing pinned sessions read-only | conflict |
| conflict | higher version in conflicted epoch | Do not clear conflict | conflict |
| conflict | explicitly selected valid higher recovery epoch | Adopt new lineage/authority and preserve old evidence/verify keys | ok |
| authority | renew current delegation before expiry | Atomic roster version bump and signed renewed delegation; preserve epoch keys | authority |
| authority | rotate keys | Issue higher keyEpoch; old keys verify-only, never session/new-event authority | authority |
| authority | revoke node/bot | Atomic revocation+roster bump; tear down matching sessions/cancel caller executions at receiving peers | authority |
| authority | transfer to verified enrolled node | Freeze root-writing; durably prepare and securely deliver root/transfer evidence to chosen node | transferring |
| transferring | target durably acknowledges root and successor roster | Publish successor; irrevocably retire old writer and delete old root copy | retired |
| follower | explicit encrypted recovery import | Install root in locked/prepared storage; do not become writer implicitly | recoveryPrepared |
| recoveryPrepared | explicit become-authority; chosen successor; maximum observed recovery epoch known | Sign `(maxKnownEpoch+1,1)` fresh lineage, retire replaced authority operationally | authority |

**P0 decision:** authority transfer is a recoverable local operation journal, not an invented `authority.transfer` sync message. Before acknowledgment the old writer remains frozen; after acknowledgment it remains retired even if key deletion failed. Restart of transferring/retired state cannot resume signing automatically. The recipient activates only from committed successor evidence; no public transfer exchange is frozen by current wire.ts. Root-key copying cannot be cryptographically fenced: operational deletion and recovery are required.

Revocations and verify-only history are distinct. Verify a stored record at its original authorization time and retain cryptographic keys; do not execute it at an obsolete/revoked epoch. A revoked node cannot regain old epochs through a newer roster; only a newly authorized higher epoch can represent reenrollment. Connected peers enforce upon verified roster propagation; disconnected peers may trust a delegation until its seven-day expiry. Revocation cannot erase already received plaintext/keys. In conflict, private reads requiring fresh identity grants also stop; already possessed local history may remain readable.

**P0 decision:** recovery restores the same root key. v1 has no general root-rekey chain, so a changed pinned root requires a new invitation/trust decision, not a host assertion. Importing recovery twice or returning an old authority may conflict; no partition-wide uniqueness promise is made. Crash restores durable conflict and authority journal states; normal sockets are recreated. Invariants: accepted ordering never decreases; one lineage per trusted epoch; conflict cannot clear on a same-epoch higher version; only current unrevoked keys author new work.

## Bot placement transfer

Owner: `IdentityService`, `ExecutionLedger`, bot registry/runtime. States: activeOld, draining, handedOff, acknowledged, pendingActivation, activeNew, blocked, forced. Persist move id, old/new node, old expiry, activation boundary and payload-bound ledger handoff.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| activeOld | owner move | Stop new admissions; cancel/finish runs; settle/retain reservations; retain uncertain effects | draining |
| draining | no executing runtime/approval callbacks remain | Export complete dedup rows through stopped boundary; authenticate handoff to new node | handedOff |
| handedOff | new node validates and atomically imports full ledger | Commit import digest; return durable acknowledgment | acknowledged |
| acknowledged | authority verifies stop+import acknowledgment | Issue higher placement keyEpoch; commit activation time/boundary | pendingActivation |
| pendingActivation | new placement current and local ledger complete | Activate new node; refuse mentions with host recvTs before activation | activeNew |
| activeOld/draining | old node unreachable, no safe handoff | Freeze new execution; obtain trustworthy ledger or install explicit loss boundary | blocked |
| blocked | old delegation expired, ledger recovered/recovery boundary chosen | Issue current placement, disable historical mentions | pendingActivation |
| blocked | explicit owner force with duplicate-effect warning | Record forced takeover/activation; preserve same exclusion boundary | forced then activeNew |

Crash before acknowledgment resumes draining/import; partial imports never count as handed-off. After old stop commit it cannot restart admissions under its old placement. After activation only new placement may execute. Ledger imports include expired/uncertain/terminal keys and hashes; exportFor/importFor retain full ExecutionRecord identity/results; imported rows are never permission to reexecute. A same-trigger different hash is `conflict`. Force or ledger loss has duplicate-effect risk; waiting for delegation expiry only fences compliant old runtimes, not stolen keys or malicious executors. Activation times require the clock checks in admission. Transfer timeout never silently becomes force.

## Space meta projection and role authorization

Owner: `MetaProjection`, `StreamAuthority`, space host. State: absent, active, frozen, upgradeRequired; authorization data is owner, pinned descriptor, members, bots, channels/settings, applied head, invitation uses and violations. Signature checks precede semantic checks. Every event in space.meta is reader-critical regardless of `crit`; host authors do not get implicit admin rights. For live append the envelope author must be a current delegated human node except the narrow host join receipt; history uses retained historical delegation evidence, not present-day expiry/placement checks. Bot authors cannot mutate meta.

**P0 decision:** exactly one owner exists for the life of the space, the descriptor owner. Owner is also the permanent administrative authority; there need not be another admin. Owner cannot leave, be removed or be demoted. Admins may remove/demote members but cannot add, remove or demote owners/admins; only owner changes admin status. An admin may demote/leave themself because the owner remains. Role `owner` cannot be assigned by join or roleChanged. Role check uses state immediately before the event, not an author's obsolete auth reference.

| Meta type | Required author/evidence and guards | Effect / rejection |
|---|---|---|
| space.created | First event, seq 1 epoch 1; owner node signature; root-signed descriptor with matching space/owner/host key/routes; owner MemberRecord matches pinned root, role owner; valid settings | Create unique owner/state. Existing space, mismatched evidence or invalid settings: conflict/bad_request/forbidden |
| space.descriptor | Owner node signature plus owner-root-signed descriptor; same space/owner, valid host delegation/routes; epoch strictly greater than pinned epoch; first meta event at seq 1 of that epoch | Adopt descriptor, clear freeze; other new-epoch records wait for full prior signed history/descriptor evidence. Same identical descriptor is no-op; changed same/lower epoch conflict |
| space.frozen | Current owner; active, no unknown critical state | Persist freeze before rejecting subsequent writes/admissions; repeated identical freeze no-op |
| settings.changed | Owner/admin; partial settings valid, minProtoMinor does not decrease without explicit supported policy | Merge settings. No negative/over-limit quotas; invalid settings bad_request |
| member.joined | Owner direct add may assign member/admin; admin direct add only member; OR current host node with independently signed valid invite authorization and consumed-use evidence | Pin new root/user, add member. Owner role, existing conflicting root/role, invalid/expired/reused invite, issuer no longer authorized: forbidden/invite_invalid/conflict |
| member.left | Human author is target current non-owner member/admin | Remove target; current private-key distribution updates and cancellation follow. Owner leave forbidden |
| member.removed | Owner for any non-owner; admin only for ordinary member (including self) | Remove target and bot registrations owned by removed member; revoke steering and subscriptions. Removing owner/admin by admin forbidden; absent target bad_request |
| member.roleChanged | Owner may member↔admin; admin may admin(self)→member only; target exists, never owner | Update role, revalidate active grants; same permitted role is idempotent. Any owner assignment/removal or admin escalation forbidden |
| bot.added | Human bot owner is member; root-signed BotDelegation (current for live append, historically valid for replay) matches bot/owner/placement; owner/admin may add own bot, member only if membersMayAddBots; profile is a known protocol profile, isAllowedBotPolicy true | Add bot; bot id conflict rejected; members cannot add someone else's bot; operator non-owner steer forbidden |
| bot.removed | Bot owner or space owner/admin; bot exists | Remove registry and cancel new/running executions; terminal ledger retained |
| bot.policyChanged | Bot owner only; bot exists, root-signed delegation (current for live, historical for replay), known effective profile and allowed audience policy | Update policy/profile atomically; cancel runs made unauthorized; admin cannot widen another owner's bot grant |
| channel.created | Owner/admin; unique stream id, valid nonempty name, matching space host authority descriptor | Add channel; cross-space/id collision conflict |
| channel.renamed | Owner/admin; existing unarchived channel, valid name | Rename; absent/archived bad_request |
| channel.archived | Owner/admin; channel exists | Mark archived; deny new channel writes and thread starts; retain readable history |

**P0 decision: invitation evidence.** A host receipt requires a `Signed` issuer-node-signed `SpaceInviteAuthorization`: `{ v: 1, invite, space, epoch, issuer: { user, node, delegation: Signed }, auth: { metaEpoch, metaSeq }, role, issuedAt, expiresAt, uses, joiner? }`. Role is member/admin, uses is 1–256, and optional joiner binds a user. Token is absent. Live admission verifies the issuer delegation against the pinned root and independently adopted current `IdentityService` roster. Historical replicas verify the embedded root-signed delegation at original issuance/use time without rejecting it for later rotation/expiry/removal. Both verify the invite node signature and check issuer role at its signed auth position and the historical pre-join state: admin may invite member, owner may invite member/admin. Missing roster/history is meta_stale, never permission to skip verification. Validate space/epoch/time, role bounds and optional joiner. The member.joined body carries invite and inviteUse; its full signature binds the invite, one-based use index and exact joined MemberRecord/root key. Host author must match the current descriptor. Persist unique `(invite,inviteUse)` and user association during apply; reusing a slot for another user is invite_invalid. Direct admin add has no host trust shortcut. Use count proves ordered host receipts, not token secrecy: a malicious host holding its protected proof database can manufacture redemption, so issuer-signed grants are bearer membership authorization, not proof of joiner intent. The joiner must separately prove key possession before a compliant host consumes a token.

Invites never assign owner and cannot outlive issuer authorization; administrative direct add remains supported. Invite revocation is enforced by host issuance state; independent retroactive signed invite revocation is not a v1 event, so do not claim it defeats a malicious host. Invite validity at replica replay uses signed event/receipt time bounds; adversarial host recvTs is not a trusted clock.

Frozen state rejects all new writes with `space_frozen`, except owner-authorized higher-epoch descriptor activation in the controlled import/restore path. Unknown critical meta event sets upgradeRequired and stops before it: host MUST stop writes, execution and authorization-dependent remote reads/fan-out/snapshot/blob serving, not merely message appends. A member stops execution/writes and cannot project later rights; it may display already verified local history. Upgrade and full signed replay clears this state; skipping the unknown event cannot.

A cryptographically valid but semantically invalid stored event is ignored for semantic changes, its scanned position recorded with a violation, and host misbehavior surfaced. This permits deterministic reconstruction of the same prefix while not granting invalid rights. Host check MUST reject it before append. Invalid signature/unknown critical prevents safe authorization progress and requires correction/upgrade rather than optimistic scanning. Projection commit and applied position/violation bookkeeping share a transaction. Crash restores the last durable semantic state, scanned position and critical block. Invariants: one immutable owner; no unproved role increase; unauthorized record has no semantic effects; all replicas yield the same state/violations for identical signed history.

## Stream read/write checks

The first space.descriptor record of a new epoch is the bootstrap exception: its auth names the previous epoch and last verified frozen meta head, while its record/embedded descriptor name the strictly higher new epoch. Full prior signed history establishes owner authority; ordinary events cannot use this exception. Both the host and consumers verify stream kind, current descriptor epoch, signed author/delegation, author placement/current key, envelope stream/id, auth epoch and `auth.metaSeq <= applied.seq`. Every space stream requires auth, including meta (epoch-1 space.created uses metaSeq 0; later descriptor activation uses the prior frozen head). Current applied state controls access, never former membership. Low-minor clients can read understood permitted data but cannot write below minProtoMinor. A frozen/critical/conflicted space forbids authorizing new work.

| Kind | Read | Write and consumer checks |
|---|---|---|
| node.thread | Same pinned user node with read capability, scoped to profile | Only authority node adapts thread data; Bridge methods independently require mapped capability |
| node.artifact | Exact same-user caller/request/method/capability scope, including persisted request aliases | Caller publishes input only in authorized upload scope; authority publishes results; signed event/blob refs required (Bridge artifact section) |
| space.meta | Current members, unless authorization projection blocked | Only events passing exact meta table; complete signed replay |
| space.channel | Current members | Human member posts; bot status/output only for registered bot and owned execution; edits/deletes require original human author or owner/admin moderation; refs cannot redirect audience |
| space.thread | Current members for public thread | Target bot for owned run status/output; human steering only if bot policy allows; parent/subject/execution must match. Private work uses space.private, never an ACL-filtered public sequence |
| space.private | Explicit current participant user or placed bot, plus valid membership/delegation where applicable | Participants only; sealed content, authenticated participants control exception; bot output stays private, permission grant/deny only bot owner |

**P0 decision:** thread descriptors bind the target bot, triggering event and execution in authoritative domain state before first bot receipt; refs alone are not authority. Message edit cannot silently create a new mention execution; only fresh message.posted human events trigger. Removing a member removes their active space bots, suspends their private-stream write/key distribution and prompts rotation; already held old keys/history cannot be revoked.

On each subscribe, snapshot, blob fetch, fan-out, append and permission action recheck access; removing a member closes existing subscriptions immediately after the removal applies. Blob authorization is `(stream,blob)` and a readable event reference, never global hash possession. Private rewrap requires current identity participant evidence. `node.artifact` uses the exact caller/request/method/capability rules in the Bridge artifact section; it is not readable by Space membership or writable as an ordinary node.thread. Consumers repeat author/current-state checks before any side effect; no host-supplied plaintext member list grants authority.

## Bot admission, permissions and execution

A relayed member envelope does not need to name the delivering host as its author. At original append, bind the author to the sending session; at subscriber/executor admission, bind the delivering session to the pinned host and independently verify the original member author.

Owner: bot registry, `MetaProjection`, `ExecutionLedger`, `BudgetLedger`, `Outbox`, `BotRuntimeAdapter`. The ordered gate table below applies independently for each mentioned bot. Do not run from a snapshot, bot output, edit, unknown type, delta or mere notification.

| Order | Guard | Failure / durable outcome |
|---|---|---|
| 0 | Verified non-snapshot message.posted; scope ledger intact | Snapshot ignored; lost ledger blocks execution pending recovery |
| 1 | Current bot delegation places bot here; node identity valid; recvTs not before activation | Wrong placement/revoked/verify-only: no execution; stale placement marker forbidden |
| 2 | Fresh host metaHead response within 30 s; same current descriptor/meta epoch; local applied state through confirmed head; auth not ahead; not critical/frozen/conflicted | meta_stale, upgrade_required, space_frozen or roster_conflict; no accepted row/model |
| 2a | Author kind is human node, no bot or origin handoff | Bot-authored mention is non-triggering; no model even same owner/node |
| 3 | Exact envelope signature, pinned root, current author key/delegation, author/delegation binding and placement valid; delivering session matches current pinned authority | bad_signature, bad_delegation or revoked; no execution |
| 4 | Current member and current effective bot steer/profile/grant permit author | not_member/forbidden/profile_unsupported; no execution |
| 5 | refs.mentions contains this bot, audience/stream/readability match target | Non-target ignored; cross-audience target forbidden |
| 6 | `(space,bot,event)` absent or payload hash identical | Same hash returns existing result before timing, no reservation/thread/model; different hash conflict |
| 7 | For an absent ledger key: valid clock and bounded delivery below | clock_skew disables execution; out-of-window becomes expired row+bot.run.expired in one transaction, no model/budget |
| 8 | Capacity/rate/quota sufficient; runtime spend ceiling honestly enforceable; budget reserve succeeds | rate_limited/quota_exceeded/budget_exhausted; rollback entire admission |
| 9 | Admission, reservation and signed accepted outbox receipt commit together | storage_full rolls all back; never start runtime before commit |
| 10 | Revalidate current authority/placement/grant/profile/compartment after queue/approval wait and before runtime/tool effect; delivery is initial admission only; exact private/public compartment and separate work thread ready | Changed authority cancels; start failure yields failed with reservation settled; never downgrade profile |

**P0 decision: clocks.** `offset = hostClock - localClock`; `hostNow = localNow + offset`. Require `abs(offset) <= 60000`, `0 <= hostNow - recvTs <= 30000`, and `0 <= recvTs - envelope.ts <= 120000`. Future host receipt/author timestamps are rejected as clock_skew (no clamping); too-old delivery or author age is expired. Exact upper bounds pass. A delayed meta reply that is more than 30 s old must be refreshed; receiving it now does not make it fresh. Request/reply round-trip must be at most 5 s; freshness age uses the request start and monotonic elapsed time, not the receive callback alone. A malicious host controls recvTs, reply freshness and offset claims; these are bounded-delivery policy for honest hosts, not an authenticated anti-delay clock oracle.

A briefly disconnected bot returning inside 30 s may execute; an author's outbox delayed at most 120 s may execute; older mentions never automatically run. Expired receipts set refs.subject to trigger and refs.execution to the expiry ledger id. **P0 decision:** expiry dedup insertion/outbox commit is atomic; duplicate expired delivery creates no second marker. Admission rejection does not queue an unbounded future run; a new mention is the explicit retry. Payload hash covers original exact signed envelope bytes, not a reconstructed body.

| Execution current | Trigger and guard | Transaction/action | Next |
|---|---|---|---|
| absent | successful admission | Insert record, reserve spend ceiling, enqueue accepted receipt together | accepted |
| accepted | runtime start after revalidation | Commit running before first provider/tool action | running |
| accepted | start fails or process restarts | Failure `not started`; release reservation and enqueue failed receipt atomically | failed |
| running | approval needed | Persist request/deadline; no awaiting tool effect; enqueue private waiting/request receipt | waitingApproval |
| waitingApproval | valid unexpired owner approval, same request/execution, gates revalidated | Record decision once and resume without widening profile | running |
| waitingApproval | denial, expiry or owner stop | Abort runtime; settle known spend, durable terminal receipt | cancelled |
| running/waitingApproval/accepted | grant revoked, member removed, freeze, emergency stop, cancel | Abort signal; reject later tool actions; terminalize only after runtime cleanup proves stopped | cancelled, or uncertain if stop/effects unprovable |
| running | result and spend recorded | Commit terminal record, settlement and result outbox together | completed |
| running | definite failure after cleanup | Commit error, actual spend settlement and failed outbox | failed |
| running/waitingApproval | restart, ambiguous adapter exit or unrecorded external effect | Persist uncertain, retain conservative reservation; publish uncertain receipt | uncertain |
| absent | expired delivery | Atomic expiry ledger+outbox, no reservation | expired |
| completed/failed/cancelled/expired/uncertain | duplicate trigger | Return state; never reexecute | same |

There is no uncertain→running automatic transition. Owner retry is a new mention/id after inspection. **P0 decision:** unknown spend keeps its reservation until owner reconciliation; restart cannot give that budget back speculatively. Spend is integer micro-USD. Reserve the entire run ceiling in the admission transaction and a conservatively verified worst-case provider-call maximum before each call through BotSpendPort; unknown pricing is profile_unsupported. Settlement is idempotent per execution/call; actual spend cannot erase other reservations. Permission events distinguish steerPolicyChange (proposed policy, no runtime unlock) from runtimeAction (exact execution, actionHash, profileDigest and immutable stream/compartment/visibility binding). A steerPolicyChange grant updates the owner-authored bot policy through the meta state machine; it never executes or revives the refused mention. The requester authors a fresh message.posted after the policy applies and passes every initial delivery gate. Grant requestHash must match the exact signed request bytes; grant expiry cannot exceed request expiry. BotApprovalPort.consume is atomic and single-use immediately before the bound action; changed action/profile/audience or repeated consumption is forbidden. No tool may execute after approval expiry or revocation. Maximum 20 pending permission requests per bot; each expires in 24 h, duplicate grants/denials are idempotent and mismatched/replayed decisions are forbidden. Owner grant can only enable supported profile/audience, never turn a member into operator steer. Provider credentials stay executor-local; operator disclosure remains owner responsibility.

Execution states, receipt identity and budget changes are durable; provider/tool in-flight state is not reconstructed by replay. Store restart maps accepted→failed, running/waitingApproval→uncertain, preserves terminal/uncertain/expired. Cancel races with completion serialize terminal commit: completed proof already committed wins; otherwise a pending abort does not falsely claim cancelled before effects stop. Invariants: one ledger row per scoped trigger/hash; model starts only after atomic acceptance; no second reservation on duplicate; terminal receipt cannot precede durable outcome.

## Private keys and authenticated visibility changes

Owner: `PrivateStreamKeys`, `KeyStore`, private-stream domain controller and compartment store. States: noKey, ready(keyEpoch,visibilityEpoch,participants), rotating, excluded, blocked. Participant control is plaintext signed `participants.changed`; private message bodies and blobs are sealed. It reveals participants/wrapped keys, not content keys. **P0 decision:** the stream creator is the key controller and an explicit human participant; only that current controller may change participant sets or authorize rewrap. Losing controller requires an explicitly new stream, not host takeover.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| noKey | authorized stream creation | Controller generates random 32-byte content key epoch 1, visibility epoch 1; wraps to all authorized participant nodes | ready |
| ready | participant set changes | Block new seal/run; increment key epoch and visibility epoch, generate fresh key; sign authenticated control; reset bot context for new set | rotating |
| ready | participant node revoked/removed or key rotated, participant set unchanged | Block future writes; increment key epoch; fresh key excluding revoked node; keep visibility epoch | rotating |
| rotating | current authenticated control committed/applied | Atomically install new key/control/participant state, resume eligible seals; old keys verify/decrypt history only | ready or excluded |
| noKey/ready | control addressed to this current authorized node | Verify controller, monotonic epochs, recipients, AAD, wrap auth; atomically adopt | ready |
| ready | new enrolled node of same participant | Controller authorizes rewrap of current key; authenticated signed control, same epochs/set | ready |
| ready | this node/user excluded | Stop seal/run; rotate future epoch on controller; retain previously possessed old history | excluded |
| any | forged control, incompatible epochs, roster conflict, missing new key | No partial adoption; forbid new private effects | blocked |

Same-epoch rewrap controls contain the complete cumulative recipient/writer lists, never an implicit replacement or delta. Existing wraps, agreement-key bindings and nonce-prefix assignments MUST remain byte-identical; additions require controller signature and current same-participant node evidence. The controller allocates a unique never-before-used prefix for each newly writable node before signing; recipients do not allocate their own prefixes. `rewrap` produces one wrap; the controller composes/signs the full control after allocation. Removing or changing an existing recipient/writer/assignment requires a new key epoch; same-epoch rewrap cannot change the content key or visibility epoch. Prefix assignments already used in the epoch cannot be recycled.

Rewrap of old epochs to newly added participants is forbidden. A participant's new node may obtain old epochs only through one of that participant's previously authorized nodes and explicit same-user proof; rewrap cannot introduce a new user into an old audience. All bot context resets on participant-set change; cryptographic rotation alone preserves compartment identity. See [compartments.md](compartments.md).

**P0 decision: key-wrap construction.** For each recipient node and key epoch, generate fresh ephemeral X25519 keypair. Derive `shared = X25519(ephemeralPrivate, recipientAgreementPublic)` and reject invalid/all-zero output. Use HKDF-SHA256 with salt `SHA256(UTF8("mousse-net/private-wrap/v1"))`, IKM shared and info equal to deterministic JSON bytes `{space,stream,keyEpoch,visibilityEpoch,node,ephemeral,recipientAgreementKey}`. Output is 32 bytes. Wrap the 32-byte content key using AES-256-GCM, fresh 12-byte nonce, 16-byte tag appended to ciphertext. AAD is the same info bytes prefixed by UTF8 `mousse-net/private-wrap/v1\0`. Controller signature covers entire participants.changed envelope/wrap contexts. Ephemeral key, recipient agreement key, epochs and stream are authenticated; a host cannot swap a wrap across streams/recipients/epochs. Wrapped ciphertext is 48 bytes; base64url unpadded encodings follow protocol.

**P0 decision: seal construction and nonce safety.** Content encryption uses the epoch content key directly with per-writer allocated nonce prefixes: controller allocates unique 4-byte writer prefix in signed control, each node durably reserves a monotonically increasing 64-bit counter before encryption; nonce=`prefix || uint64be(counter)`. Never share one prefix across writers; a replaced writer loses its prefix; counter rollback or uncertain backup state forces a new key epoch/prefix before sealing. A wrapping key is unique per fresh ephemeral key, used once with its 12-byte random nonce. Blob data and envelopes use the same persisted counter namespace. Prefix exhaustion/unknown ownership blocks writes. No silent probabilistic reuse of an epoch key across cloned writers is permitted.

AAD passed to seal/open MUST be deterministic JSON bytes of envelope metadata excluding body/sealed (include v, minor, id, stream, type, crit, author, ts, auth, refs and blobs where present), prefixed with UTF8 `mousse-net/private-content/v1\0`. The envelope signature verifies before decryption; authenticated metadata prevents redirecting ciphertext. Blob bytes are `version(1 byte=1) || keyEpoch(uint64be) || nonce(12) || ciphertext || tag(16)` with AAD domain `mousse-net/private-blob/v1\0` plus deterministic `{space,stream,keyEpoch}`. Hash ciphertext stored bytes, never plaintext. Encrypted blob header's epoch must equal its authorized event key epoch. Nonce prefixes/counters and key epochs are durable in one allocation transaction; crash after reserve wastes a counter but never reuses it. Old key decrypt is allowed only for historical local entitlement, never new sealing.

This direct encryption format requires signed per-writer prefix evidence in control; the current SealedBody shape remains keyEpoch/nonce/ct with tag appended. No per-object-key alternative is a v1 wire option. No implementation may silently choose a different format. Counter cloning and malicious authorized writers remain explicit trust limits; rotate before restore/recovery reuses a writer state.

## Bridge RPC and dispatch

Owner: `RpcDispatcher`, `ExecutionLedger`, Bridge adapter and dispatch service. RPC states reuse execution states; progress is ephemeral, result/error durable. Only same-user current pinned nodes pass Bridge admission; methods absent from capability map are forbidden.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| absent | request; capability, profile scope and deadline valid | For mutation require idem; durably bind `(callerNode,method,idem)` to exact params hash before handler | accepted |
| accepted | authorized handler begins | Commit running before any effect; propagate AbortSignal/deadline | running |
| running | progress | Deliver bounded sanitized update; no completion promise | running |
| accepted/running | rpc.cancel/deadline | Abort; suppress subsequent tool admission; commit cancelled only with definite stop | cancelled or uncertain |
| running | result durably known | Commit result and terminal state; oversized result referenced as authorized blob | completed/failed |
| any recorded | duplicate idem, same hash | Return existing accepted/running/terminal state, never execute twice | same |
| any recorded | duplicate idem, different hash | conflict | same |
| terminal/uncertain | rpc.result.get by same authorized caller | Return retained result/error/outcome_uncertain; no handler execution | same |
| accepted | restart | failed(not started) | failed |
| running/waitingApproval | restart, effect/result gap | Reconcile with durable thread-store effect evidence; if unprovable, outcome_uncertain | uncertain |

`SyncSession.rpc` requires a caller-journalled `id`; `rpcResult` issues read-only lookup and `rpcCancel` cancels by that same id. The server persists `(callerNode,rpcId)` mapped to the ledger key/payload hash before admission; a new request id using an existing idem attaches to the same execution, never another handler. Query of missing/running work cannot invoke or resubmit it. QualifiedClockEstimate carries monotonic sample time, RTT and wall-delta evidence; stale/missing/unqualified estimates fail bot admission rather than treating an old zero offset as fresh.

**P0 decision:** request id is response correlation; mutation dedup key is caller node+method+idem. A reconnect's result lookup must remain bound to caller identity, not merely possession of rpc id. Cancellation is best-effort for external effects and terminal commit is serialized with completion. Read-only RPC may retry only if classified side-effect free by its registered method. An abort never erases completed effects or frees uncertain spend. Result retention matches dedup retention; pruning an idem tombstone while a guarded command can recur is forbidden.

**P0 decision: Bridge artifact scope.** A `node.artifact` stream is created by the target authority for one `(user, caller node, journalled rpc id, registered method/capability)`. Its descriptor stores this immutable artifact context. It is never a Space stream or a public content stream. Oversized RPC results include `RpcArtifactRef {stream,event,blob}`; the authority signs an `artifact.published {rpc,purpose:"result"}` envelope with the blob in `blobs`. The event and stored RPC result commit together before the terminal response; caller verifies the stream context, publication signature, referenced blob/hash and original RPC identity before decoding the result. `getBlob(stream,blob)` remains the existing fetch seam.

Bundle upload first calls same-user registered `bridge.artifacts.open` with `{forRpcId,forMethod}` under the dispatch method's required capability and a durable idem. The authority checks the registered upload-enabled method and caller, creates/reuses its request-scoped artifact stream, and returns its descriptor/id. Artifact context uses the canonical original request id; a persisted same-caller/same-method/same-payload idem alias may reference/retrieve that original artifact without changing its params or widening capability. A retry id never requires republishing input or result under a different scope. The caller uploads via `putBlob`, then signs `artifact.published {rpc,purpose:"input"}` in that stream with a blob reference. Dispatch params reference `{stream,event,blob}`; the target verifies ownership/caller/rpc/method/capability, signature, committed ref and bundle integrity before effects. An artifact upload is not permission to execute the planned RPC. Normal node.thread remains authority-write-only.

Artifact reads and input appends require current same-user delegation, exact original caller node and the bound method's current capability; only the target authority can publish result events. No cross-user Space member or unrelated caller gets access by knowing an id/hash. Blob begin is allowed only in an authorized upload scope; pending uploads are invisible until commit/publication and subject to upload limits/GC. Retain publication/ref and durable RPC binding at least as long as the result/idempotency tombstone; unreferenced abandoned uploads expire normally. These are P1/P3 authorization requirements, not a generic blob bypass. Method registry and stream creation are P3 domain implementation, while the event/ref/scope codec is frozen here.

Dispatch uses the same ledger. Substates: preparing, transferring, verifying, running, publishing, cleanup; these map to accepted until effects begin and running afterwards. Explicit repository binding by normalized remote identity precedes any fetch. Missing binding is repo_not_bound; missing base commit requires owner-authorized fetch or validated bundle, never guessing another branch. Verify bundle size/hash/commit reachability in a quarantine repository; reject unexpected refs/path traversal/hooks and object integrity failures. Create an isolated worktree only after verification, bind exact base commit/task/execution and runtime profile, and never apply dirty caller files unless explicitly included in the authenticated task. A result is signed by the target current node and binds execution, repo identity, base commit, result commit/branch, bundle hash and errors. Verify it before presenting or applying; a signature does not prove review quality. No implicit push or merge is authorized by dispatch.

Cleanup runs after terminal result/ledger commit and only removes task-owned worktrees/artifacts; failure remains recorded for owner recovery. Crash preparing/transferring/verifying causes failed with cleanup; running/publishing becomes uncertain unless recorded result proves completion; cleanup resumes without repeating task effects. Dispatch contracts are domain documents for P3, not new P0 RPC handlers.

## Space freeze, export, retire, restore and move

Owner: space host service, `MetaProjection`, `StreamStore`, archive service. States: active, frozen, exporting, exported, retired, importedFrozen, activating, activeNew, failedFrozen. Persist operation journal and signed descriptor chains. The owner must be available for activation.

| Current | Trigger and guard | Action | Next |
|---|---|---|---|
| active | owner space.frozen durably applied | Refuse subsequent writes/admissions; cancel/drain runs and uploads; preserve readable verified history | frozen |
| frozen | export; runtime drained, consistent store/blob boundary | Build allowlisted space-scoped archive and blob manifest with hashes; no destination activation | exporting |
| exporting | archive and all referenced blobs fsynced, manifest verified | Commit archive digest/completion evidence | exported |
| exporting | error/crash/incomplete manifest | Discard staging; retain frozen source | failedFrozen |
| exported | owner retire; verify complete export digest | Delete only source space authority data; retain signed move/retirement evidence outside active authority store | retired |
| retired | owner import on destination; archive validates | Merge one space into destination; refuse collisions, keep unrelated profile rows; no serving yet | importedFrozen |
| importedFrozen | owner signs strictly higher descriptor for destination key/host/epoch | Begin new epoch and append descriptor as first meta record in same activation commit | activating |
| activating | activation commit durable and full signed authorization replay valid | Publish descriptor via authorized join string; serve new authority | activeNew |
| active/retired/any | restore backup on same host | Start quarantined frozen; never serve old backup as live authority | importedFrozen |
| importedFrozen | restore owner signs higher descriptor | Same activation/snapshot rules, retain locally held abandoned-epoch events | activeNew |

Archive manifest records version, space id, descriptor chain, frozen source epoch/head per stream, allowlisted table counts, blob ids/bytes/hashes and completion digest. Tables are filtered by space_id and refs; only streams/events/meta/members/bots/blob refs and private ciphertext/wrapped key controls are exported. Exclude other spaces, Bridge, outbox, invitations/tokens, grants, budgets, execution/provider private keys and decrypted local private cache. Never copy a whole profile backup for space export. Archive validation precedes import; merge never overwrites an existing unrelated stream/id. Export authentication/hash verification is independent of signature checking each event. Secret-free does not mean nonsensitive: public content and private metadata remain in archive.

**P0 decision:** source freeze and destination activation are separate commits; failed move stays frozen and recoverable. A user cannot unfreeze by an ordinary settings event or lower/same epoch descriptor. Crash active restores active; frozen/exported/failedFrozen remains frozen; exporting resumes or discards incomplete staging; retired never starts hosting; importedFrozen/activating serves nothing until atomic higher-epoch activation completes. No timeout activates an incomplete move. Restore requires new nonce prefix/key state before any private sealing and ledger recovery before bot execution.

A member who missed freeze can still use an unretired old host until learning the higher descriptor. A restored pre-freeze copy can reproduce this. The protocol does not fence an isolated root/host or provide live migration consensus. Retirement and keeping old authorities shut down are operational requirements, not consequences of seeing a higher epoch elsewhere. Once a member pins higher epoch it rejects lower descriptors/session authority and snapshots; already received local history is not erased.

## Presence derivation

Owner: signed subject publisher and member receiver (`SyncSession`). A host relays presence; it cannot manufacture an independent member's heartbeat. A compromised host retains the privileges of its own delegated owner-node key. Per subject/current key epoch retain highest valid counter and last accepted heartbeat's monotonic receipt time. **P0 decision:** timestamp must be within ±60 s of offset-corrected subject time; reject non-current/revoked keys, wrong stream/placement, repeated or decreasing counter and invalid signature before refreshing receipt time. Counter must persist across restart for a key or rotate keyEpoch; replayed old heartbeat never extends liveness.

| Current | Trigger | Action | Next |
|---|---|---|---|
| offline | fresh verified heartbeat | Record counter/receipt; display idle/working/workingPrivate | online |
| online | no heartbeat for 45 s | Keep last activity private-safe; show route separately | reconnecting |
| reconnecting | fresh heartbeat | Refresh receipt/counter | online |
| online/reconnecting | no heartbeat for 90 s, or verified revocation | Remove active activity | offline |
| any | forged/replayed/host/tunnel pong | Ignore for presence freshness | same |

Private presence is only workingPrivate and carries no private task text. Never infer permission/executor ownership from online. Counter/fingerprint baseline persists; receipt time does not survive restart as a live proof, so receiver starts offline until a fresh heartbeat. Exact 45/90 s thresholds enter reconnecting/offline. Host withholding heartbeats causes conservative false offline; host replay within freshness window can delay disappearance by the accepted clock tolerance, so no stronger death/fencing claim follows. Invariants: only subject-signed fresh increments refresh; heartbeat routing and session liveness are independent.

## Open contradictions and interface closure

I found these concrete P0 seam gaps in the interrupted baseline. The integration owner must make shared types/schema/docs agree before P0 exits; none is proof of implemented behavior. Shared type updates now settle minor, compact invite/use, controller/visibility/writer/wrap fields, full execution export/import and spend/approval bindings. The remaining domain journals and shipping gates below are intentionally phase-owned contracts:

- The original member.joined free-form invite string carried no independently verifiable authorization. P0 uses a node-signed SpaceInviteAuthorization plus inviteUse; administrative role and nested delegated identity must both verify.
- Envelope.minor is now required. Known events from a newer minor are critical when crit:true; known security families are critical regardless of flag; all fixtures and schemas use the updated type.
- PrivateStreamKeys.rotate now takes controller/participants/visibility input and outputs authenticated agreement-key/writer-prefix fields. Its body-only accept/rewrap APIs do not verify the enclosing author signature: the domain caller MUST validate the signed controller event and current roster before invoking them; P5 must qualify this gate.
- MetaState now documents blocked remote reads. P1/P5 must persist scanned-invalid violations and the safe authorization head as specified above; the original single applied head alone is not evidence of correctness.
- The placement journal persists immutable activationHostTs for each placement epoch; normal delegation renewal preserves it and never treats a new issuedAt as a new activation. Qualified clock evidence translates the acknowledged activation to the relevant host clock; a higher-epoch delegation is not issued before acknowledged stop/import or expiry/explicit force. Placement journal must expose this evidence for admission; full ExecutionRecord export/import now preserves identity/results. Imported records still suppress execution.
- Different-user space.join request/result message tags and schema are a concrete gap in the original wire.ts; protocol/schema integration must freeze their quarantine/proof/credential and atomic receipt semantics before P0 exits. Bridge RPC remains same-user and cannot be a join shortcut.
- Mixed-epoch meta snapshot source/staging must support original per-record positions and atomic active-generation publish; the original installSnapshot single-array API is insufficient evidence that large full history is safely handled.
- Roster transfer is mentioned as authority.transfer but wire.ts has no transfer message. The journal semantics above do not define an interoperable transfer RPC; P2 must use authenticated same-user transfer and freeze a concrete exchange before shipping it.
- Private-stream controller/invite-use fields and immutable run bindings are now explicit shared types. Target-bot thread mapping, retirement journals and archive manifests remain P3/P5/P9 domain requirements specified above; they are not implicit permission in a generic refs field.
- Recovery is same-root restoration. A claimed general root rekey chain is unimplemented and unspecified; v1 changes root through explicit re-invitation/trust instead.

These are contract decisions and limitations, not unresolved alternatives that permit implementers to choose divergent wire formats. The P0 integration review must update this list to reflect which shared seams are settled. Current closure adds explicit space.join request/result, SnapshotReader/SnapshotStage, history/newWork author verification, live/history projection checks, adopted roster lookup by user, qualified clock estimates, caller-journalled RPC id/query/cancel, and atomic terminal/restart callbacks. Required real module/daemon behavior remains P1 onward; these signatures alone do not prove it.
