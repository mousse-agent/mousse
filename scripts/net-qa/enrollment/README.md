# Actual daemon enrollment and authority qualification

I use the production CLI bundle and separate Node 24 daemon/CLI processes with disposable profile homes. These tests do not invoke a model or alter existing profiles.

```sh
node scripts/build-cli.mjs
node node_modules/vitest/vitest.mjs run tests/net/daemon.test.ts
node node_modules/vitest/vitest.mjs run tests/net/cli/authority-daemon.test.ts
```

`daemon.test.ts` covers pasted invitation input, protected profile restarts, rename, and connected revocation.

`authority-daemon.test.ts` covers encrypted recovery export to an exclusively created `0600` file; a requesting CLI stopped after the first durable transfer marker and killed before reading the result; successful daemon handoff; both daemons killed, restarted, and unlocked; repeat transfer resolved using existing receipts with unchanged original import/activation RPC IDs and exactly two completed recipient mutation executions; and explicit recovery on the survivor after stopping the successor. Recovery retains the pinned root/user and advances the recovery epoch.

I verified the authority test on macOS arm64 with Node 24.20.0. The response-loss fixture uses POSIX `SIGSTOP` and skips Windows. The test does not qualify Windows or external provider execution. The original core enrollment tests separately cover exporter-bound response loss and atomic consumption.

The CLI reads passphrases from hidden/piped stdin. It rejects passphrase arguments and flags. Export refuses overwrite; import requires a private regular file and explicit `--become-authority`. The export itself remains encrypted and requires its separate recovery passphrase.
