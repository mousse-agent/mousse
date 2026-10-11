# Mousse Net protocol 1.0

Status: P0 contract for review; implementation of sessions, authorization, persistence and mux is P1 or later. `PLAN.md` describes intent; this document, `state-machines.md`, browser-safe `src/shared/net/schemas.ts`, `src/shared/net/{wire,envelope,identity,limits}.ts` and frozen `test-vectors/net/protocol/` define the interoperable contract. MUST, MUST NOT, SHOULD and MAY are normative. The codec's structural validation does not establish signature validity, membership, execution admission or durability.

## 1. Scalar encodings and signatures

All JSON MUST be UTF-8 with no BOM, duplicate object keys (including differently escaped spellings), unpaired Unicode surrogates, non-finite numbers, unsafe integral numbers, or trailing bytes. Depth is at most 32 and a document contains at most 16,384 JSON values/keys. JSON field names and type tags are case sensitive. Times are nonnegative JSON-safe integer Unix milliseconds; intervals are integer milliseconds. Sequence, epoch, counter and version values are JSON-safe integers; stream/key epochs and stored sequence numbers start at 1, cursor sequence 0 denotes an empty prefix. Monotonic clocks MUST measure intervals and deadlines.

IDs are a registered three-letter prefix, underscore and 26 lowercase Crockford base32 characters (`0123456789abcdefghjkmnpqrstvwxyz`), representing 128 random bits. Prefixes: `usr`, `nod`, `bot`, `spc`, `str`, `evt`, `exe`, `rpc`, `inv`, `dsp`. IDs MUST NOT derive from paths or keys and MUST remain stable across key rotations. `blb_` followed by 64 lowercase hexadecimal characters is SHA-256 of the stored blob bytes; sealed blobs are hashed after encryption.

Base64url means the URL alphabet with no `=` padding, whitespace or noncanonical unused trailing bits. Ed25519 and X25519 public keys are raw 32 bytes (43 characters). Ed25519 signatures are 64 bytes (86 characters). AES-GCM nonces are 12 bytes (16 characters); `ct` appends the 16-byte authentication tag to the ciphertext. P-256 transport public keys are SPKI DER, not raw curve points; receivers MUST parse and require the P-256 key algorithm. A fingerprint is SHA-256 over the exact wire public-key bytes, base64url.

A `Signed` wrapper is `{payload,sig}`: payload is base64url of exact UTF-8 document bytes and sig is base64url Ed25519 over those decoded bytes. Receivers MUST verify the exact received bytes, MUST NOT reserialize before verification, and MUST subsequently validate the decoded document against its named schema and semantic identity rules. Shape-valid wrappers do not attest the enclosed document. Wrapper/decoded-document nesting MUST be bounded; credentials are not recursively interpreted without a named expected kind.

(P0 decision) Presence signatures and enrollment request hashes use canonical JSON: recursively sort object keys by JavaScript UTF-16 code-unit order; preserve array order; use compact `JSON.stringify` escaping and finite number spelling; reject non-JSON values and unsafe integers. `canonicalJson` is the executable definition. This is a narrow protocol encoding, not a claim of implementing all RFC 8785 rules. Presence excludes only its `sig` property; enrollment request excludes only its `proof` property. encodeEnvelope produces canonical bytes for a new envelope; sign once and retain those returned bytes for retries. Receivers do not require envelope canonicalization. Normal envelope and Signed signatures continue to use exact received bytes.

## 2. Envelopes and event registry

An envelope is `{v:1,minor,id,stream,type,crit,author,ts,auth?,refs?,body|sealed,blobs?,origin?}`. `minor` is the minimum protocol minor required to interpret that event. Exactly one body representation MUST be present. `author` has node and positive keyEpoch plus exactly one of user or bot. A bot author resolves its user through a root-signed bot delegation and MUST match that delegation's hostNode. Every space stream event requires `auth:{metaEpoch,metaSeq}`, identifying the author's applied meta prefix. `refs` may contain replyTo, thread, mentions (at most 32 unique bot IDs), execution and subject. Edit/delete events use `refs.subject` to identify the original event. Bot run receipts require refs.execution and refs.subject. `origin` is reserved and MUST NOT confer authority or trigger bot-to-bot execution in v1.

An envelope including extensions and its sealed ciphertext is at most 65,536 bytes, exclusive of the detached 64-byte signature. Known 1.0 body shapes and nested objects are closed to unknown fields. Envelope extension fields and unknown event types survive decoding. Future-minor bodies remain structurally opaque until the consumer performs the criticality/version decision. Extensions MUST NOT widen access or execution rights. Receivers MUST preserve original bytes for replay and forwarding.

| Event type | Required body fields | Authority/content meaning |
|---|---|---|
| artifact.published | rpc, purpose:input or result; nonempty envelope.blobs | Request-bound same-user Bridge artifact publication |
| space.created | descriptor:Signed, settings, owner:MemberRecord | Genesis; owner and descriptor evidence |
| space.descriptor | descriptor:Signed | Owner host/epoch update |
| space.frozen | reason:string | Owner freezes host writes |
| settings.changed | settings:nonempty partial settings | Owner/admin settings update |
| member.joined | member:MemberRecord, invite?:Signed, inviteUse?:number | Authorized addition with verifiable invite evidence where required |
| member.left | user | Self leave; owner cannot leave |
| member.removed | user | Owner/admin removal with role restrictions |
| member.roleChanged | user, role | Owner/admin role restrictions; owner immutable |
| bot.added | record:BotRecord | Current bot owner adds qualified delegation and policy |
| bot.removed | bot | Bot owner or owner/admin removes |
| bot.policyChanged | bot, profile? and/or policy? | Bot owner changes enforceable policy |
| channel.created | stream, name | Owner/admin creates |
| channel.renamed | stream, name | Owner/admin renames |
| channel.archived | stream | Owner/admin archives |
| message.posted | text | Current member content; explicit mentions only |
| message.edited | text | Authorized edit of refs.subject |
| message.deleted | empty object | Authorized tombstone of refs.subject |
| thread.opened | stream, title, private:boolean | Opens linked work/audience stream |
| thread.snapshot.begin | threadId, snapshot:UUID, totalBytes:1..32 MiB, chunks:1..1024, sha256:32-byte base64url | Begins a display-only source snapshot in a node.thread stream |
| thread.snapshot.chunk | threadId, snapshot:UUID, index:0..1023, data:canonical base64url (at most 32 KiB decoded) | Ordered snapshot segment |
| thread.snapshot.end | threadId, snapshot:UUID, sha256:32-byte base64url | Adopts display only after exact length, count, order and SHA verification |
| thread.event | threadId, type:allowlisted display event, data | Updates display; never dispatches a tool or run |
| thread.closed | stream | Closes linked work stream |
| participants.changed | controller, participants[], visibilityEpoch, keyEpoch, writers[], wrapped[] | Signed critical visibility/key-epoch change |
| bot.run.accepted | title | Durable admission receipt |
| bot.run.progress | text | Durable coarse progress |
| bot.run.toolSummary | tool, summary | Durable sanitized tool summary |
| bot.run.waitingApproval | summary | Run suspended pending approval |
| bot.run.completed | text | Terminal success |
| bot.run.failed | code, message | Terminal failure |
| bot.run.cancelled | by:user | Terminal cancellation |
| bot.run.uncertain | summary | Possible unrecorded effect; do not blindly retry |
| bot.run.expired | empty object | Durable no-run receipt for expired trigger |
| bot.permission.requested | kind,requester,bot,trigger,summary,expiresAt,binding; proposedPolicy or execution/actionHash/profileDigest | Private scoped approval request |
| bot.permission.granted | kind,request,requestHash,expiresAt; runtimeAction also execution/actionHash/profileDigest/binding | Owner approval; bound evidence remains required |
| bot.permission.denied | request:event | Owner denial |

Settings are `{name,membersMayAddBots,maxBlobBytes,minProtoMinor}`. MemberRecord is `{user,rootKey,role,displayName}`. BotRecord is `{bot,owner,delegation:Signed,displayName,profile,policy}`. Profiles: chat, reader, operator. Policies: `steer:{kind:'owner'|'everyone'}` or `{kind:'roles',roles:[owner|admin|member]}`, and visibility public/private. Operator MUST be owner-steered. Runtime qualification and compartment constraints are in `bot-runtime.md` and `compartments.md`; accepting a schema never qualifies a runtime.

Every record in a space.meta stream is critical regardless of its flag; all registered meta events and participants.changed are critical regardless of flag in every stream. A sender may raise criticality with crit:true on either a known or unknown type; it cannot lower registry/meta criticality with crit:false. A consumer encountering unknown critical meaning or a critical event whose minor exceeds its supported minor MUST mark the space upgradeRequired. A member continues durable replication but suspends writes and all execution. A host stops authority operations including subscriptions, replay, snapshots, blobs and fan-out because read authorization is unknown. Unknown or future-minor noncritical content is stored and relayed but skipped for interpretation and execution. An unsupported envelope major yields unsupported_version.

Private-stream content MUST use sealed, encrypted blobs and matching key epochs. (P0 decision) participants.changed is the sole plaintext control exception: its signed body exposes participant metadata and individually wrapped content keys, never plaintext content keys. Its rotation, authenticated wrapping, AAD and participant authorization rules are fixed by `state-machines.md` and `compartments.md`. Opened private payloads MUST pass validateEventBody for their known type before interpretation; unknown opened bodies remain non-executable. Public streams MUST reject sealed bodies; space.private MUST reject any other plaintext content. Schema validation cannot decide a stream kind from an ID.

## 3. Message encoding and mux

(P0 decision) A complete mux message is:

```
uint32_be headerUtf8Bytes
headerUtf8Bytes bytes of one JSON object
part[0] bytes || part[1] bytes || ...
```

The JSON header is at most 65,536 bytes and the complete message including its four-byte prefix, header and binary parts is at most 1,048,576 bytes. `parts` lists raw byte lengths in order, never base64-encoded copies. Messages without a declared parts field have no binary parts. A decoder MUST reject truncated prefixes/headers/parts, undeclared trailing bytes, wrong part count or lengths, wrong lane and unknown wire t. A session MAY skip an unknown complete message under forward compatibility; it MUST NOT dispatch it, grant credit based on unvalidated length, or treat it as a critical stored event. Malformed known messages produce bad_request and close the offending session. Byte limits produce too_large. Signature errors are separately bad_signature.

Events and snapshot chunks carry two parts per record: exact envelope UTF-8 bytes (1..65,536 bytes), then exactly 64 signature bytes. Header record metadata is `{seq,epoch,recvTs}`; record batches MUST be dense, ordered, and of one epoch. Append has exactly those same two parts. Blob chunks have one part of 1..49,152 bytes. A final empty snapshot chunk MAY contain records:[]/parts:[]/done:true. Empty blobs use begin/end with no chunks. Per batch at most 500 records, further bounded by the complete-message byte budget. The codec validates structure and batch ordering; the stream consumer MUST bind enclosed envelope stream/id to the header and verify signature before accepting.

(P0 decision) Each mux frame has a 16-byte header followed by payload:

| Offset | Encoding | Meaning |
|---|---|---|
| 0 | uint8 | framing version, exactly 1 |
| 1 | uint8 | lane: control=0, bulk=1 |
| 2 | uint8 | flags: FIRST=1, LAST=2, CREDIT=4; other bits zero |
| 3 | uint8 | reserved, zero |
| 4 | uint32 BE | sender message ID for data; zero for credit |
| 8 | uint32 BE | payload bytes; frame total <=65,536 |
| 12 | uint32 BE | credit grant bytes for CREDIT; zero for data |

Data FIRST creates a message; later frames on that lane have the same ID through LAST. IDs are nonzero, monotonic per sender connection, and MUST NOT wrap: reopen before exhaustion. Per lane at most one partial message; lanes MAY interleave. A CREDIT frame has exactly flags=4, payloadBytes=0, messageId=0, positive grant. FIRST|LAST is an unfragmented message. Empty data frames are forbidden. New FIRST before LAST, missing FIRST, changing ID, reserved values, invalid lengths or accumulated bytes over the message cap are bad_request/too_large and close the mux.

Each sender initially has 262,144 payload-byte credit on control and 1,048,576 on bulk. Credit applies to payload bytes, not the 16-byte header. Windows are independent. Credit frames are uncharged and MUST be processed without waiting for data credit; grants MUST NOT raise a window above its initial value. Receivers grant only validated, released fragment bytes, so complete-message reassembly cannot deadlock behind a smaller control window. Per-lane outstanding reassembly is bounded by the message cap; one active outbound message per lane is bounded by the complete-message cap, while additional waiting payload is bounded by that lane’s initial window. queued(lane) reports all unsent payload, including the active message. An idle lane may accept a complete message larger than its waiting budget; a busy lane MUST reject rather than retain unbounded waiting payload or promises. Control is scheduled before bulk whenever it has data and credit; blocked control MUST NOT block eligible bulk. Fragment stalls are measured by byte progress: 30 seconds without accepted payload progress aborts the partial message and closes/reconnects the mux, since no partial-message cancel frame exists. Absolute duration is not a timeout while bytes continue arriving.

## 4. Complete wire catalogue

Directions: A is a stream authority, S its subscriber/writer; Q is an RPC caller and X its executor; E is an enrollment joiner and I the inviter. Either endpoint may have several roles. All traffic except the specified replay, snapshot and blob chunks uses control. Required and optional fields below are in addition to `t`. `?` means optional. Exclusive result variants MUST NOT contain both result and error.

| t | Direction | Lane/capability | Header fields and outcome |
|---|---|---|---|
| hello | both | control/base | protoMajor, protoMinor, caps[], node, now; delegation?, roster?, routes?; only enrollment may omit delegation |
| helloAck | both | control/base | protoMinor, caps[], now; negotiated subset and minimum minor |
| ping | both | control/base | n, now; request liveness/clock measurement |
| pong | both | control/base | n, now; echo n, sender current time |
| goAway | both | control/base | error; terminal session reason |
| error | both | control/base | error, re?; request correlation, never success |
| subscribe | S→A | control/streams.v1 | stream, after:{epoch,seq}; authorize current read before replay |
| subscribed | A→S | control/streams.v1 | stream, head, replayThrough; frozen head boundary |
| events | A→S | replay bulk, live control/streams.v1 | stream, records[], replay, parts[]; signed exact bytes |
| caughtUp | A→S | control/streams.v1 | stream; replay transmitted; subscriber still waits for durable contiguous cursor |
| snapshotRequired | A→S | control/streams.v1 | stream, reason, head; reasons cursorTooOld/cursorAhead/epochChanged/gapOverBudget |
| snapshot.get | S→A | control/streams.v1 | stream; independently reauthorize read |
| snapshot.chunk | A→S | bulk/streams.v1 | stream, epoch, throughSeq, records[], done, parts[]; fixed target across chunks |
| unsubscribe | S→A | control/streams.v1 | stream; idempotently remove subscription |
| metaHead.get | S→A | control/streams.v1 | stream, n; space.meta only; authorize read |
| metaHead | A→S | control/streams.v1 | stream, n, head, now; confirms head, does not mean locally applied |
| append | S→A | control/streams.v1 | stream, id, parts:[envelopeBytes,64]; idempotent signed append |
| appendResult | A→S | control/streams.v1 | stream,id and either epoch,seq,recvTs or error |
| blob.put.begin | S→A | control/blobs.v1 | stream,blob,bytes,sealed; authorized pending upload |
| blob.chunk | uploader→receiver | bulk/blobs.v1 | blob,offset,parts:[chunkBytes]; only an active authorized transfer |
| blob.put.end | S→A | control/blobs.v1 | blob; hash/length/commit check |
| blob.put.result | A→S | control/blobs.v1 | blob,error?; absent error means durable commit |
| blob.get | S→A | control/blobs.v1 | stream,blob,offset; stream-bound authorized fetch/resume |
| blob.end | A→S | control/blobs.v1 | blob,error?; download terminator |
| rpc.request | Q→X | control/rpc.v1 | id,method,params,deadlineMs,idem?; deny unregistered methods; mutating methods require idem |
| rpc.progress | X→Q | control/rpc.v1 | id,data; nonterminal, ordered per request |
| rpc.result | X→Q | control/rpc.v1 | id and either result,blob? or error |
| rpc.cancel | Q→X | control/rpc.v1 | id; abort signal, cancellation is not rollback |
| rpc.result.get | Q→X | control/rpc.v1 | id; persisted result only, scoped to original caller |
| presence | both/authorized relay | control/presence.v1 | stream,subject,counter,ts,state,sig,activity?; signed end-to-end |
| ephemeral | both/authorized relay | control/presence.v1 | stream,kind:typing|delta,data; never persisted or executable |
| revoked | both | control/base | subject; notification only, adopt signed roster evidence before trust change |
| rosterUpdate | both | control/base | roster:Signed; verify pinned root, ordering, lineage and conflicts |
| enroll.request | E→I | control/enroll.v1 | invite,node,keys,name,proof; quarantine only |
| enroll.result | I→E | control/enroll.v1 | either delegation:Signed,roster:Signed or error |
| space.join.request | joiner→host | control/enroll.v1 | invite,space,user,rootKey,node,delegation:Signed,roster:Signed,name,proof; bounded quarantine admission |
| space.join.result | host→joiner | control/enroll.v1 | space and either descriptor:Signed,member:{epoch,seq,recvTs},parts:[envelopeBytes,64] or error; exact member.joined receipt |

There is no `blob.have`, `blob.put.chunk`, `blob.get.end`, `rosterHead`, pong.echo, or goAway.code in 1.0. The catalogue above follows `wire.ts`; the PLAN's shorthand is not an alternate wire spelling. Relay authentication/pairing is a transport-specific P4 contract and `relay.v1` advertises that optional facility; it does not bypass inner TLS or authorize core domain messages.

## 5. TLS, identity, session and versions

Each connection uses TLS 1.3 over the untrusted transport. Both peers MUST present self-signed P-256 transport certificates. Chain validation is intentionally replaced by key verification. TLS session resumption/tickets and 0-RTT MUST be disabled. A known expected fingerprint (invite, pinned peer, space descriptor) MUST match in constant time before SecureChannel exposes or sends any application byte. A missing certificate or wrong key closes with peer_key_mismatch.

(P0 decision) An acceptor whose peer key is initially unknown enters quarantine after the TLS handshake. It may receive only the bounded hello, node enrollment or space-join exchange, not domain messages, logs, RPC, blobs or subscriptions. NodeDelegation is verified against the pinned user root and the delegation transport SPKI MUST equal the certificate SPKI before opening the authenticated session. A hello node MUST equal its delegation subject. Enrollment has a separate proof authorization below. Quarantine MUST enforce 16 KiB total application bytes and a 10-second authentication deadline. The term “no application bytes before pinning” applies to pre-pinned SecureChannel connections; the quarantine exception is essential because unknown inbound peer credentials arrive in hello.

Session code exposes clockEstimate() including offsetMs, measuredAtMonotonic, rttMs and wallDeltaMs, or undefined until a qualifying probe; bare clockOffsetMs is not admission evidence. Both sides send hello once and helloAck once; domain traffic MUST wait until both hellos are authenticated and both acknowledgments have negotiated the same version/features. Majors MUST equal 1; a peer major mismatch closes incompatible_peer, unsupported encoded envelopes use unsupported_version. Negotiated minor is min(local,peer). Caps are the intersection of advertised known capability strings; unrecognized advertised capability names are ignored, not adopted. helloAck MUST NOT add unoffered caps or raise minor. Streams is required for normal Bridge/Spaces sessions; enrollment-only sessions may negotiate enroll.v1 without streams. Optional messages require their capability. Base control messages always remain available after hello. Below a space's minProtoMinor a peer may read, but MUST NOT write or execute; unknown critical data separately suspends authority reads.

hello.now is an initial unqualified clock estimate, not permission to execute. Ping n values correlate probes and cannot prove subject/bot liveness. The session pings every 20 seconds and closes after three missed intervals. Signed presence determines subject liveness independently.

(P0 decision) Qualified offset uses a correlated pong: local wall send t0, monotonic RTT, local receive wall t1, peer pong.now tp; offset=tp−(t0+t1)/2, uncertainty=RTT/2. Reject a probe if wall elapsed and monotonic elapsed differ by more than 1 second or RTT exceeds 5 seconds. An execution clock estimate must be at most 30 seconds old; |offset| must be <=60 seconds. Admission uses hostNow=localNow+offset and requires 0<=hostNow−recvTs<=30,000 and 0<=recvTs−author.ts<=120,000; negative ages produce clock_skew, old triggers expire. Measurement uncertainty MUST NOT extend those windows or justify clamping a future timestamp. Offset freshness/uncertainty is execution-time evidence, not merely a live socket. Delivery guards, duplicate lookup, and approval clocks are in `state-machines.md` and `compartments.md`.

Connection resolution/connect/TLS/hello deadlines are 5/10/10/10 seconds respectively. Backoff uses exponential growth with jitter from 1 to 60 seconds and resets only after a session lasting at least 30 seconds. Route failures preserve their original cause and do not imply bot offline by themselves.

## 6. Stream authority, replication and snapshots

A stream descriptor is `{id,kind,authority,space?,parent?,participants?,artifact?,createdAt}`. node.artifact requires immutable artifact context `{user,caller,rpc,method,capability}` and forbids space/parent/participants; other kinds forbid artifact context. validateStreamDescriptor enforces the structural scope, while authority checks enforce the identity binding. Kinds: node.thread, node.artifact, space.meta, space.channel, space.thread, space.private. Every space kind requires space; thread/private requires parent; private has an explicit participant set. Exactly one authority assigns dense sequence numbers in each epoch. An owner-signed space descriptor pins the host and epoch; a relay/host cannot unilaterally advance it. Bridge stream generations and destructive restore behavior are fixed by `state-machines.md`.

A cursor `(stream,epoch,seq)` represents a gap-free durably stored prefix. On subscribe A captures head H, returns subscribed with replayThrough=H.seq, replays after.seq < seq <= H.seq on bulk, and sends later records live on control. replayThrough MUST equal returned head.seq. S buffers live records ahead of its contiguous cursor, at most 1,000 records or 4 MiB of envelope/signature bytes. On overflow it drops the uncommitted overlap and reconnects/resubscribes from its persisted cursor. It MUST NOT advance to the largest observed live sequence. Exact duplicate records are harmless; reused positions or event IDs with different bytes/signatures/metadata are conflict. caughtUp does not override missing records or authorize execution before persistence.

Epoch mismatch, cursor ahead, retention loss or unrecoverable overlap require a snapshot. Target epoch/throughSeq stays fixed across chunks. Each chunk retains one original epoch and a dense original sequence range; historical record epochs may be lower than the target and their sequence values are not capped by the final epoch's throughSeq. Future record epochs and current-epoch sequences above throughSeq are rejected. Cross-chunk epoch/descriptor transitions require full semantic chain validation at stage commit; the codec does not infer their legitimacy. space.meta snapshots contain every complete original epoch's signed history, followed by the target epoch through throughSeq (never truncated). Consumers rederive authorization, signatures and descriptor/epoch evidence; host-provided roles are not trusted. Signed invite authorizations bind invite, space/epoch, issuer node/user/delegation, auth position, granted role, issuedAt/expiresAt, bounded uses and optional joiner. Live invite admission checks issuer role at the signed auth position and current state, and uses the independently adopted current roster. Historical replay verifies the embedded root-signed delegation at original issuance/use time and roles in the pre-join state; later expiry, rotation, revocation or removal does not retroactively invalidate committed membership. In either mode an admin may grant member only, an owner member/admin. Host joins carry invite plus paired inviteUse (1..uses), with unique (invite,inviteUse) receipts. For live admission, current issuer roster is independently obtained through IdentityService.roster(user); it is not nested inside the invite. Non-meta snapshots are non-executable projections: they may display history but MUST NOT trigger runs. Snapshots larger than a bounded store transaction are staged under a separate generation; the final active-generation pointer and cursor change atomically after validation, rather than installing partial active state. Crash/reconnect discards incomplete staging. StreamStore.openSnapshot returns a SnapshotReader that pins the target and pages bounded original records; StreamStore.beginSnapshot creates an invisible stage whose bounded append calls precede one atomic commit. The installSnapshot convenience wrapper MUST reject inputs exceeding 500 rows or 1 MiB. A wholly zero-record snapshot is valid only for a genuinely empty target. Recheck read permission while serving chunks.

Append authorization happens before assigning a position: session identity is current and not revoked; envelope author resolves to session user and local node placement; exact signature valid and epoch current (not verify-only); stream and event id equal append header; envelope version/criticality understood; space auth.metaEpoch matches active epoch and auth.metaSeq is no later than the applied authority head (the sole new-epoch bootstrap exception is owner-signed space.descriptor at sequence 1 referring to the prior frozen safe meta head, as fixed by state-machines.md); role/profile/participant rights at current head allow it; space not frozen/upgradeRequired; min minor satisfied; byte, rate, storage and quota limits allow it. A transaction stores bytes/id/position and recvTs before success. Same `(stream,id)` and exact original signed bytes returns the original result, even after response loss. Different bytes or signatures under that id yield conflict. Author clocks never choose ordering.

Optional `space.discovery.v1` adds purpose-specific Space proof requests after the normal authenticated handshake. It does not change the same-user checks on `rpc.request`, `rpc.result.get` or `rpc.cancel`. `space.identity.get {n,space,user,metaHead}` returns only that current member's root-signed roster, or an error, echoing every request field. The current authority checks its exact descriptor/host identity, current caller membership/node/SPKI, requested member root and conflict-free current roster; it checks them again after the asynchronous boundary before sending. Consumers verify the root from validated Space meta and retain this evidence in a separate Space-scoped current cache; ordinary replay evidence never populates that cache or global identity. A stale requested applied meta head returns `meta_stale` and requires ordinary verified meta catchup.

`space.discovery.get {n,space,stream,metaHead}` addresses one already learned child ID. A successful `space.discovery.result` echoes the request context and carries the current descriptor/head, original committed parent opening and ordered signed private control records as binary envelope/signature pairs. The source is the current Space authority, uses only active local generations and exact registered streams, and rechecks current parent/child access and private audience before each evidence send and the final proof. Public discovery requires an actual registered execution thread; private discovery requires adopted, unblocked current control and the requester's exact current node wrap. There is no listing operation. A recipient independently requires the exact original opening already committed in its parent store before adopting any child descriptor. Private bootstrap retains full original control-chain, historical authorization and exact self-wrap verification; a descriptor alone never gives private access.

Each session permits at most eight concurrent proof requests in each direction, twenty source requests per rolling ten seconds and a thirty-second deadline. `space.proof.cancel {n}` cancels that session's corresponding source job. Close/abort removes jobs and pending response slots; late responses are ignored, while a live response with different Space/user/stream/head is a conflict. A private proof carries at most sixty-four controls and 128 KiB of cumulative control envelope/signature bytes. Original retained roster evidence is verify-only and bounded to sixty-four documents/512 KiB per proof; individual messages retain the ordinary header/message bounds. Consumers reject incomplete or oversized proof chains; no truncated chain authorizes adoption. A host may withhold discovery or proofs, and profile rollback remains a separate residual risk.

Reads (subscribe, snapshot.get, metaHead.get, blob.get and ongoing fan-out) MUST check current membership/participant access. A removed member cannot fetch old history or blobs using a retained stream/blob ID. node.thread is same-user only with read capability and remains authority-write-only. node.artifact is same-user and request-scoped; it applies the bound method capability and caller/executor identity checks below, independently of read capability. space.meta/channel/thread follow current membership, with archived/frozen behavior as defined in the state machine. private streams additionally require explicit participation, including for a host reading as a user. A host stores private ciphertext for delivery but does not get plaintext keys merely because it is authority.

The complete per-event role transition rules and invalid-host-record handling are in `state-machines.md`; no implicit default allow exists. A consumer independently verifies authors and authorization before execution. A host can withhold current removals or availability; it cannot make unverified signatures confer rights.

## 7. Blobs, RPC and presence

Upload begins only after write/size/quota authorization for its stream; the pending slot binds blob, stream, authenticated caller, expected length and sealed state. Blob IDs alone MUST NOT identify authorized transfer ownership. One active transfer of a given blob per connection is permitted because chunk/end have no transfer ID. offset is the exact next accepted byte; retry chunks already accepted require byte equality. Out-of-order offsets fail bad_request. Disconnect aborts the connection transfer; restarting begin may resume verified pending bytes only with identical ownership and parameters. There is no upload-resume-offset response in 1.0, so a portable uploader restarts from offset 0 using idempotent matching chunks.

End verifies exact length and SHA-256 blob id, fsyncs and atomically publishes; mismatch is conflict. Append references MUST be checked against committed bytes/sealed metadata; successful put alone does not publish a message. Fetch binds `(stream,blob)` to a readable event reference and current access; offset must be <= stored length. Chunks are sent from that offset and end terminates; the receiver verifies complete stored bytes against id before treating a resumed download as complete. Per-space max is 25 MiB default; negotiation does not silently raise configured max. Private blobs are encrypted with the stream key before hashing/upload; authorization and sealing epochs follow the referencing event. Pending uploads expire after 1 hour; unreferenced committed blobs are collected after 24 hours. Transfers are cancelled on access loss/revoke.

SyncSession.rpc requires the caller to choose and persist its RpcId before sending, including on reconnect. rpcResult(id) and rpcCancel(id) are explicit authenticated query/cancel seams; callers do not recover identity from a hidden transport request ID. RPC only serves the same user's certified nodes. The server registry supplies the required NodeCapability and mutating flag; unregistered methods are forbidden even if a similarly named local GUI method exists. Method parameters/results require method-specific validation in addition to the generic JSON schema. Idempotency keys (1..256 characters) are scoped by authenticated calling node and exact method; mutating request params are hashed with the fixed canonical encoding, and a changed hash is conflict. Durable executions/result/side effects follow `state-machines.md` and `bot-runtime.md`. Request IDs correlate transport; they do not authorize someone else's result retrieval. Servers MUST bind stored request IDs and idem keys to the caller and recheck current capabilities on cancel/result.get.

(P0 decision) Bridge artifacts use the existing blob and append messages with node.artifact stream scopes. The caller journals its planned RPC id and calls registered same-user `bridge.artifacts.open {forRpcId,forMethod}` with durable idem. The target checks that forMethod is upload-enabled and that the caller currently holds its required capability, creates/reuses the immutable `(user,caller,rpc,method,capability)` artifact context and returns the descriptor/id. The caller uses putBlob, then authors `artifact.published {rpc,purpose:'input'}` with nonempty blobs in that stream. Dispatch parameters carry the full `{stream,event,blob}` reference; the target validates caller/user/RPC/method/capability, publication signature, exact committed event blob reference and hash/bundle integrity before any effect. Opening/uploading an artifact never authorizes executing the planned method.

For results the target authors `artifact.published {rpc,purpose:'result'}` with nonempty blobs and commits publication plus RPC terminal result/reference atomically. The original caller verifies context, request identity, publication author and referenced blob before getBlob(stream,blob) and decoding. Reads/uploads/appends recheck current caller/method capability and stream binding; guessed blob/event/stream IDs cannot authorize cross-request access. Input publication is permitted only by the bound caller and result publication only by the target authority. Node artifacts are excluded from Space exports and cannot borrow a Space or node.thread write scope. No additional wire operation is introduced.

DeadlineMs is a receiver-local monotonic budget 1..86,400,000ms, beginning when admitted. Deadline and cancel signal cooperative abort; neither claims rollback of an external effect. A terminal result is emitted at most once for a request. Disconnection/restart never silently reruns a mutation; uncertain external-effect/result gaps yield outcome_uncertain. `rpc.result.get` retrieves the persisted original outcome, does not execute the method, and reports outcome_uncertain if no provable terminal result remains. Progress is ephemeral and cannot commit outcomes. Oversize results use an authorized RpcArtifactRef `{stream,event,blob}` with inline result metadata, never a bare BlobId; they never exceed the message cap.

Presence signs the canonical complete header excluding sig, including stream, subject, counter, ts, state and activity if present. Verify the subject's current delegation, node placement, signature, stream access and increasing counter before refreshing lastSeen. Counters MUST survive restart per signing key; rotation starts a new verified key identity. A host cannot create a fresh heartbeat by replaying one. workingPrivate MUST omit activity detail; peers reveal only that private work exists. Heartbeats every 20 seconds; reconnecting after 45 seconds without fresh signed evidence, offline after 90 seconds. A ping or relay socket is not signed subject evidence. Counter/time authenticity does not stop a host withholding heartbeats. Unsigned typing/delta is display-only, session-authorized, bounded and never stored or executable.

## 8. Enrollment proof and identity updates

Bearer strings mj1/sj1, their exact outer codecs and CLI presentation are explicitly phase-deferred to P2/P5. No exact outer-string codec is implemented or frozen by P0. The inner P1 wire enrollment/space-join requests, token proof construction and signed route/authority pinning are frozen here; state-machines.md specifies their authorization and durable consumption. The TLS enrollment exporter label is exactly `EXPORTER-mousse-net-enroll`, length 32, explicit empty context (zero bytes). Invite bearer T is 32 random bytes. (P0 decision) `proofKey=HKDF-SHA256(ikm=T,salt=empty,info=UTF8('mousse-net/enroll/v1'),length=32)`. `tokenId=SHA256(T)[0:16]` is an internal lookup, not the separately randomized public inv_ ID. Inviter stores proofKey encrypted, never T.

For enroll.request, let R be canonicalJson of that exact header with only proof omitted. Proof is base64url `HMAC-SHA256(proofKey, exporter32 || UTF8(inviteId) || SHA256(R))`. Lengths are fixed (32 + 30 + 32 bytes); no separator is needed. The request's transport key MUST equal the actual joiner certificate SPKI. Altered name, keys, invite, node or connection changes the proof. Both proof comparison and fingerprint comparison use constant-time byte equality. The joiner verifies inviter pin before sending its proof. Tokens, proofs, private keys and message text are never logged.

One authority transaction verifies expiry/proof, consumes the invite bound to node ID plus exact keys/authorized claims, creates delegation and bumps roster. Retry on a new TLS connection requires a new exporter-bound proof but identical stable claims and returns the original delegation/roster; other node/key/name claims are invite_invalid. Consumption is durable before reply. Expiry is evaluated using authority time with the exact boundary expiresAt <= now rejected; a consumed identical retry remains retrievable without reissuing authority. Only the user authority holds the root and issues node invitations.

Space admission uses space.join.request/result, not a Bridge same-user RPC. The joiner pins the host transport key from the owner-signed descriptor before proving its invitation. Its request is at most 16 KiB including the four-byte prefix/header; excessive delegation/roster credentials fail too_large rather than bypassing quarantine. The session also enforces cumulative preauthentication bytes and the 10-second deadline. Successful response follows durable admission and may carry a full <=64 KiB member.joined envelope plus signature, within the normal message budget; error responses never confer membership.

(P0 decision) A space invite's 32-byte token derives `spaceProofKey=HKDF-SHA256(ikm=T,salt=empty,info=UTF8('mousse-net/space-join/v1'),length=32)`. The TLS exporter label is exactly `EXPORTER-mousse-net-space-join`, length 32, explicit empty context. Let J be canonicalJson of the full space.join.request excluding only proof. Proof is base64url `HMAC-SHA256(spaceProofKey, exporter32 || UTF8(inviteId) || SHA256(J))`. Changing space, user, root key, node, credentials, name, invite or TLS session invalidates the proof. It is domain-separated from node enrollment even with the same token.

The compliant host verifies the token proof and independently signed issuer-authorized invite, current issuer/member rights, expiry/use slot, root-key/roster user match, current node delegation and its certificate transport-key equality. TLS possession proves the joining node holds its transport private key; an unrelated member cannot substitute its own root/user claims. Admission commits a unique inviteUse receipt bound to exact user/root/node identity before responding. Success parts contain the exact host-signed member.joined event at member epoch/seq/recvTs; the joiner verifies host/descriptor signature and event/member/root/invite bindings before opening streams. Retry never creates a second use/member: a matching consumed stable identity returns its original receipt after exporter proof and current key-possession checks; conflicting claimed identities are invite_invalid. Tokens/proof keys remain local and never appear in signed meta history. A malicious host possessing bearer invitation state can fabricate redemption; the issuer's granted role/use bounds still remain verifiable and the residual joiner-intent limitation is documented in threat-model.md.

IdentityService.verifyAuthor uses explicit purpose history or newWork. History verification can return verifyOnly/revoked metadata while cryptographically verifying stored old records; that result never authorizes execution. NewWork rejects expired/revoked/noncurrent author epochs.

Roster ordering is lexicographic `(recoveryEpoch,version)`; conflicting different payloads at a position or different lineages at one recovery epoch cause roster_conflict and fail closed. Rotation history can verify past signatures but only current epochs author new work or open sessions. Revoked notifications are hints; verified rosterUpdate closes revoked sessions and cancels in-flight work. Connected peers enforce within one roster propagation; disconnected nodes stop trusting by delegation expiry (7 days). Authority transfer/recovery and the residual double-import/withheld-revocation risks are in `state-machines.md` and `threat-model.md`.

## 9. Limits and errors

The executable constants in `src/shared/net/limits.ts` are normative. JSON string limits count Unicode code points under AJV; encoded byte limits additionally apply. Names/titles/display names <=256 characters; methods/type/error codes <=128; diagnostics/text summaries <=4096; route address <=2048; route transport name <=64; cause chain <=8; routes <=32; session capability names <=32 of <=64 characters each; refs mentions <=32; envelope blobs <=32; participants/wrapped recipients <=256; roster nodes/bots <=256 each and revocations <=512. Signed payload is at most the base64url expansion of 64 KiB. Future scalability requires an explicit minor/version contract rather than bypassing these bounds.

| Resource/timing | Bound/default |
|---|---|
| Envelope / frame / JSON header | 64 KiB each (frame includes its 16-byte header) |
| Complete message / replay batch | 1 MiB including message prefix/header |
| Blob chunk / default blob maximum | 48 KiB / 25 MiB |
| Store transaction | <=500 rows and <=1 MiB; yield between batches |
| Overlap | <=1,000 records and <=4 MiB |
| Preauthentication | <=32 connections total, <=4/address, <=16 KiB, <=10 s |
| Session subscriptions / in-flight RPC / blob transfers | 256 / 64 / 8 |
| Fragment no-progress | 30 s |
| Ping / missed intervals | 20 s / 3 |
| Signed heartbeat / reconnecting / offline | 20 s / 45 s / 90 s |
| Delivery / author delay / host clock offset | 30 s / 120 s / 60 s |
| Confirmed applied meta freshness | 30 s |
| Node delegation / node invite / space invite | 7 days / 10 min / 24 h |
| Pending approval requests / approval TTL | 20 per bot / 24 h |
| Bot concurrency / member runs | 2 / 20 per hour default |
| Member event rate / uploads | 20 per 10 s / 60 MiB per hour default |
| Space quota | 5 GiB default |

Inbound carriers share one profile-owned admission allocator. A lease is reserved synchronously when a carrier hands over its byte stream and remains charged through TLS and hello/enrollment quarantine, until authentication or close. The ten-second preauthentication deadline starts at that handoff and is never restarted after TLS or gateway handoff. Address buckets are shared across direct and tunnel listeners; relay streams use the configured relay URL origin (scheme, host and port), never the relay-advertised peer ID. Relay listeners pause rearming while that principal or the total budget is full and resume when a lease is released. Direct HTTP/WebSocket limits remain additional bounds; authenticated sessions have a separate capacity of 64.

WireError is `{code,message,retryable,cause?}` with a cause array outermost first of `{message,code?}`. Code and retryability MUST follow `NET_ERRORS`; receivers derive retryability from their own registry rather than trusting a peer flag. Diagnostic messages/causes MUST redact secrets and sealed/private/message content. Errors do not prove replay safety. A response error preserves causes while stable code drives the UI.

The exhaustive stable codes are: unsupported_version, incompatible_peer, upgrade_required, downgrade_unsupported, bad_request, too_large, bad_signature, bad_delegation, peer_key_mismatch, revoked, not_enrolled, not_member, forbidden, invite_invalid, roster_conflict, conflict, stream_unknown, snapshot_required, meta_stale, space_frozen, rate_limited, quota_exceeded, storage_full, storage_corrupt, keystore_locked, keystore_missing, clock_skew, route_unreachable, peer_offline, deadline_exceeded, cancelled, budget_exhausted, profile_unsupported, repo_not_bound, outcome_uncertain, internal. The exact categories/default messages/retryability are in `errors.ts`.

Schema/codec fixtures and focused tests establish encoding and rejection behavior only. They do not establish a working distributed session or a security-qualified runtime; P0 independent review and P1 integration gates remain required.
