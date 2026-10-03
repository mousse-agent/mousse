# Public Spaces daemon soak

I use this standalone harness to qualify a public conversation across three independent, protected MMS daemons. It invokes the built CLI and actual TLS Space join/sync/append paths. It does not replace module, security, private-stream, bot, relay, Tailscale, archive, or platform qualification.

## Prepare an immutable application capsule

Use a supported Node 24.20+ executable without replacing the user’s global Node. Build the CLI at the exact source checkpoint being tested. Copy `out`, `package.json`, `package-lock.json`, the complete dependency tree, and the tracked `macros` runtime assets into a dedicated application directory. The daemon reads `macros/claude-code.json` during startup even though the conversation has no bots. Resolve or copy any dependency symlinks that escape that directory. Record the source SHA and SHA-256 hashes of the executable, CLI, lockfile, and assets in a private artifact manifest. Keep that capsule unchanged during the run.

Use a fresh, short canonical run directory, such as `/private/tmp/mnqa-public-<random>`. The Unix MMS endpoint is `<home>/mms.sock`; a deep capsule-cache run root produced a real `listen EINVAL` failure on macOS. The harness enforces a conservative local guard of at most 90 bytes for each socket path; this is a harness resource limit, not a claim about every OS socket limit. The application capsule can have a longer path.

## Smoke and actual elapsed run

Set `QA_NODE` to the supported executable and `QA_ENTRY` to the frozen capsule’s `out/cli/index.js`. These are shell variables used only for this task.

```sh
TMPDIR=/private/tmp "$QA_NODE" scripts/net/qa/public-daemon-soak.mjs \
  --entry "$QA_ENTRY" --run-dir "/private/tmp/mnqa-smoke-REPLACE" \
  --source-sha "REPLACE_WITH_EXACT_SOURCE_SHA" \
  --duration-ms 150000 --interval-ms 1000 --fault-every-ms 5000
```

A smoke completion always reports `qualified: false`. Check all four entries in `faultCounts` are nonzero before using the harness for a longer run. Short runs only test the harness and fault paths.

```sh
TMPDIR=/private/tmp "$QA_NODE" scripts/net/qa/public-daemon-soak.mjs \
  --entry "$QA_ENTRY" --run-dir "/private/tmp/mnqa-public24h-REPLACE" \
  --source-sha "REPLACE_WITH_EXACT_SOURCE_SHA" \
  --duration-ms 86400000 --interval-ms 30000 --fault-every-ms 300000
```

Keep the driver alive for the entire run. A detached launch must preserve its stdout/stderr in a private log and record its PID. The 24-hour clock starts after all three daemons have joined the conversation. Both monotonic elapsed time and wall time must satisfy the requested duration. Starting a run does not pass the qualification; inspect the eventual report. The harness has no clock acceleration or continuation of an interrupted run.

## Checks and bounds

The driver rotates ordinary public posts across all three authors. Every CLI result chooses and records the original event ID; pending recovery only queries that ID. It does not repeat a mutation after a lost response. It validates the actual signed envelope’s author, body, original ID, dense host position, and ordered replica pages. Host outages enqueue two consecutive originals from one author and one from another, then check the original receipts and FIFO. Other faults kill and restart each member separately and suspend/resume one recipient with `SIGSTOP`/`SIGCONT`. Each restarted daemon must retain a locked protected keystore until explicitly unlocked through piped stdin. Passphrases exist only in driver memory and piped stdin.

The driver samples live daemon RSS and FD counts, installation disk use, and outbox states through read-only SQLite connections. It resolves the actual UUID default profile from `installation.json`. SQLite `quick_check` runs at the beginning and end. It guards 1 GiB RSS, 1,024 FDs, 512 MiB disk per daemon, baseline-relative RSS/FD growth, at most 128 unresolved outbox rows per state, and at most 16,384 original messages. Helpers have a 30-second deadline and 2 MiB output cap. Daemon log buffers retain at most 8,000 characters. These are explicit harness qualification limits, not protocol membership or storage semantics.

`report.json` is updated atomically. `events.jsonl` records originals, receipt transitions and fault injections; `samples.jsonl` records resource samples; `processes.json` records only owned daemon PIDs and start identities. A passing report requires `status: completed`, the complete requested conversation duration, every original `sent`, all three validated replica cursors equal to the sent count, healthy final SQLite checks, and cleanup of owned processes. `validatedOrderSha256` identifies the validated ordered position/ID list. `qualified: true` applies only to the public scope and exact source/build/runtime recorded in that report. Bot, private-stream and external-transport flags remain false. Later source changes need their own qualification.

## Stop and cleanup

Send `SIGTERM` or `SIGINT` to the recorded driver PID to mark the run interrupted and clean up its own children. Reports and protected profiles are retained. Normal completion and failure also clean up owned children. If the driver was itself killed abruptly, use its exact frozen entry and recorded run directory:

```sh
"$QA_NODE" scripts/net/qa/public-daemon-soak.mjs \
  --entry "$QA_ENTRY" --run-dir "/private/tmp/mnqa-public24h-REPLACE" \
  --cleanup yes
```

That cleanup checks each target home is within the run directory, the MMS owner PID, the OS process start identity, and the command’s exact capsule/home/service-run arguments before signalling it. It never searches for or kills existing user daemons. It refuses changed identities; investigate that evidence rather than broadening cleanup.
