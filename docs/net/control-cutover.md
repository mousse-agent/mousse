# P9 Control backend cutover candidate

This preparation is based on the frozen combined Chats candidate `74abef64`. It is a stacked draft, not a default-branch release or completion of P9. The owner accepted deprecation of old Control clients. GUI/preload/renderer removal remains a separate workstream, and auth/credential changes still require human teammate review under the team policy.

## Retired backend

The candidate removes `src/mms/control/**`, its per-profile construction/start/shutdown/event ownership, Control/pairing local protocol methods and events, and the advertised `control.v2`, `pairing.v2` and `connections` capabilities. Existing `control`, `connections`, `login` and `logout` CLI names produce a deprecation error before daemon connection, login, credential mutation or enrollment. They are not aliases for Net or Bridge commands.

I retained channel adapters and ChannelAuth, provider authentication, browser control, the `ws` transport dependency, and generic profile ownership/drain tests. Only tests for the removed transport are retired. The static Control wire-vector JSON remains historical evidence. `src/shared/controlTypes.ts` remains temporarily for the separate GUI workstream; it can be deleted once those imports are removed. GUI-owned production-profile event fixtures must also replace synthetic Control events with supported profile events.

## Legacy inventory and credentials

`profiles/migration/LegacyControlCredentials.ts` is a migration-only AES compatibility codec. It neither generates an identity nor interprets pairings, grants or connection preferences. The migration adapter retains its existing interface and name. The physical `control/` paths, inventory classification, journal steps, manifest commit guard and ciphertext readback remain unchanged.

The legacy layout is salt (16 bytes), IV (12 bytes), GCM tag (16 bytes), then ciphertext. The key uses SHA-256 over the original username/hostname/control-directory string and salt, with the original machine-information fallback. The exact directory string remains part of the key: byte-copying encrypted credentials to a different home fails. Migration decrypts the old location, re-encrypts at the live profile location, verifies the original credential fields, and preserves the original file. Identity, pairings and autoconnect configuration remain byte-preserved inert inventory. None becomes a Net root, roster, delegation, key, route, invite or execution permission.

I verified old-to-new compatibility using an independent original-format fixture writer and new-to-old compatibility using independent AES decoding. Focused tests cover tampering, truncation, path-bound byte-copy denial, migration readback/idempotence, and actual SIGKILL recovery after both promote-staging and migrate-credentials. The actual composed MMS test starts migrated autoconnect/pairing inventory without Control, a Net database or a Net identity; actual local IPC rejects every retired method. Only explicit `net.init` creates an independent fresh root and one self node. The emitted CLI test checks all four retired routes and unchanged ciphertext with no new daemon/config/identity files.

## Rollback remains an explicit design prerequisite

On the frozen pre-rollback cutover candidate, I inspected actual Net initialization rather than adding guessed rollout flags. Net configuration defaults to disabled; startup with no Net database creates no runtime. Existing enabled configuration can activate on start/unlock. That frozen candidate has no `net.disable` API, and `activate()` does not itself implement a universal disabled admission fence. The `netBridge`/`netSpaces` names in PLAN were not implemented feature flags at that checkpoint.

A rollback implementation must persist disabled intent, synchronously fence new domain work and transport/session creation, cancel and await real owned domain/session/transport work, retain stores and report uncertainty if drain fails, and preserve all Net data and original outbox IDs. Existing transport configuration alone does not fence local mutations. The current Net shutdown is permanent for that service instance; a minimal honest disable could therefore require MMS restart before explicit re-enable, rather than pretending same-instance rollback is supported. Separate Bridge/Spaces rollout flags would also need trusted typed composition and admission checks, not just GUI visibility. The cutover checkpoint added none of these controls; the separate reviewed rollback candidate now implements the profile-local contract and focused evidence described in [rollback.md](rollback.md). Until that candidate passes review, the root workstream must select and qualify the rollback contract before backend-on-default release.

## Focused evidence and limits

The supported runtime is Node 24.20.0; temporary paths use `/private/tmp`. Source Node TypeScript and changed-source ESLint pass. The migration/channel/profile ownership batch passes 52 of 53 tests. Its one failure is the existing real child/grandchild drain case: `profile_busy` after roughly 15.7 seconds. I reproduced the same unchanged case on a separate detached `74abef64` baseline with the same runtime and environment. I did not infer a process root cause or change unrelated lifecycle code. No full suite was run for this cutover.

Local logs: `/private/tmp/mousse-control-cutover-migration.log`, `/private/tmp/mousse-control-cutover-drain-repro.log`, `/private/tmp/mousse-control-cutover-drain-baseline74.log`, `/private/tmp/mousse-control-cutover-final-qualified.log`, `/private/tmp/mousse-control-cutover-source-ts.log`, and `/private/tmp/mousse-control-cutover-lint.log`. These are local evidence paths, not repository artifacts or public CI attestations.
