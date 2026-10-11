# P0 security fixture contract

These files freeze decision oracles and cryptographic byte construction. They are not a running network, identity, store or bot implementation.

- `meta-sequences.json`: complete materialized projections after valid and invalid role/bot/channel/freeze/activation records. Invalid records model a malicious host storing an event a compliant host must reject.
- `invite-decisions.json`: independently checked issuer role/delegation/current roster, role bounds, expiry, epoch, use slots and host receipt binding.
- `critical-roster-decisions.json`: criticality, blocked disclosure, lineage conflicts and verify-only epochs.
- `private-key-decisions.json`: participant/visibility/key epochs, rewrap authorization and nonce reservation/restore cases.
- `private-crypto.json`: deterministic X25519/HKDF-SHA256/AES-256-GCM wrap/content/blob known answers and negative mutations. All keys here are public fixture material.
- `admission.json`: normalized admission/approval/transaction/race oracles owned by the consumer-contract workstream. Consult that file's description and schema.

Every JSON file declares its fixture kind and security test IDs where assigned. Abstract normalized fields and aliases are deliberately distinct from wire envelopes: an implementation runner constructs verified credentials/records from the stipulated evidence, drives the real phase-owned machine, then compares the listed expected state/effects. It must not convert expected values into a mock that merely returns the oracle. The crypto fixture uses real encoded IDs and raw known keys, but does not replace signed controller authorization.

P0 validation checks JSON integrity, matching security IDs/phase checklist, internal sequence/projection consistency and concrete crypto round trips/AAD rejection. Later security tests must reproduce the actual attacks in `docs/net/threat-model.md`; no fixture parse or catalogue test establishes end-to-end security.
