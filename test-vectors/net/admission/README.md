# P0 admission consumer fixtures

`cases.json` contains complete normalized policy inputs and expected decisions for admission, approvals, restart/ledger loss, visibility epochs and a two-bot trigger. `schema.json` is the strict, bounded catalogue format. Fields such as `signatureVerified` and `runtimeQualified` are supplied evidence premises, **not** claims that P0 implements identity verification or qualifies an adapter. Signed byte/signature fixtures are in the protocol catalogue.

Expected `deltas` count writes in the admission transaction, relative to its pre-state. `modelCalls` is always zero at this boundary: starting a model is forbidden before commit. An admitted row reserves the full ceiling plus capacity/rate and journals one receipt; expiry journals only a dedup row/marker. A reject, duplicate or ignored input commits none of those new rows. Post-admission runtime calls belong to later real conformance.

Time values are integer milliseconds. Clock offset is `host - local`; corrected host age is `localNow + hostOffsetMs - hostRecvTs`. The exact 30 s/120 s/60 s bounds pass, and negative future values reject. Inputs exercise freshness and RTT gates separately. Amounts are integer micro-US dollars. Existing execution rows bind the exact `envelopeUtf8` SHA-256, including its whitespace and field order; the loader checks extracted evidence agrees with those bytes.

P0 validation command:

```sh
npm test -- tests/net/admission/fixtures.test.ts
```

This command validates catalogue integrity only. P1/P6 must run these cases against the real transaction/identity/context/approval paths, including concurrent admissions and failure injection at each named `failurePoint`. They must prove persisted counts and absence of model/tool calls; merely passing the loader is not end-to-end admission verification. A qualified runtime fixture is a future test premise; every actual adapter remains unqualified at the P0 checkpoint.
