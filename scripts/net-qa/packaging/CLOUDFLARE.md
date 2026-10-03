# Production CLI ASAR through a Quick Tunnel

I run this scoped gate against an existing immutable production app, without
changing its ASAR or selecting a probe main. Each daemon and CLI invocation uses
the app executable with `ELECTRON_RUN_AS_NODE` removed only from its child env.
The driver records physical ASAR/executable/main hashes and framework version.
It creates task-owned profiles, protects their keys, and uses actual profile CLI
commands. It calls no provider and supplies no Cloudflare login, named tunnel,
account resource, DNS write or injected resolver.

```sh
MOUSSE_NET_QA_OPT_IN=1 TMPDIR=/private/tmp node \
  scripts/net-qa/packaging/cloudflare-cli.mjs \
  --app /absolute/path/to/mousse-cli.app \
  --run-dir /tmp/mnqa-cf-new-run \
  --fixture-source <recorded-build-source> \
  --enrollment cloudflare
```

The app and run paths must be explicit; the run directory must not exist. This
macOS runner currently uses installed `/opt/homebrew/bin/cloudflared`. Source
provenance is the operator's recorded build checkpoint; hashes establish which
immutable artifact ran, not a new build at the driver's checkout.

I checked the retained production fixture attributed to `1745b57b` on macOS arm64
with a Node 24.20.0 driver and Electron 43.2.0. Its main is `out/main/cli.js` and
its hashes are:

| Artifact | SHA-256 |
| --- | --- |
| app.asar | `864c516e68fd9d981f0052601d224bfd3e926f49b0fae86fc332e24d9f40f01d` |
| executable | `79019361f697c1a81489dba3e94631b0977770c1ab15236f1f033f9de6238874` |
| main entry | `21257a21d8031bcd35cc5c7e7c2753d46b37f074b7df380f145bfc22a163b5ac` |

Two actual runs passed normal system DNS, protected same-user enrollment through
the Cloudflare-only target, Bridge thread creation/listing and a verified 347-byte
snapshot. An independent protected foreign member joined the public Space,
posted an original, received its actual `sent` receipt at epoch 1/seq 1 and read
back the identical event/text/author/position at both Host and member. Neither
run required another Cloudflare login. These snapshots contain no provider
messages; they do not qualify multipart displays or send/steer/abort.

The cleanup-qualified gate is still incomplete. The immediate cleanup sample in
run 02 was too early; run 03's bounded 10-second wait also failed to observe both
tunnel exit and automatic directory removal. The harness correctly reports
`status:failed`, `error:owned_cleanup_failed` despite its passed payload checks.
It subsequently removes its owned profile directories. My independent final
process/filesystem check found all three runs' profile directories absent and
zero process commands referencing their canonical or `/tmp` aliases. Existing
Cloudflare processes 353 and 3370 were left unchanged. This establishes eventual
owned cleanup; it does not qualify graceful app cleanup. I did not rerun the
unchanged payload checks to hide that limitation.

Local evidence retained for review:

- `/private/tmp/mnqa-cf-asar-03/cloudflare-evidence.json`: actual payload success and
  the failed automatic cleanup wait.
- `/private/tmp/mnqa-cf-asar-03/final-owned-cleanup.json`: subsequent independent
  owned-directory/process inventory.
- `/private/tmp/mousse-packaged-cloudflare-cached-routes-01.json`: the signed
  follower routes in the separate route-transition failure.

The `--enrollment direct-transition` mode reproduces a separate gap. Direct
protected enrollment succeeds, and adding Cloudflare propagates a signed route
containing its first quick hostname. Disabling direct then restarts the quick
tunnel with a different hostname. The follower retains the earlier signed
routes and cannot reconnect, even though normal DNS resolves the new hostname.
I preserved that failure rather than editing the production transport from this
QA task. Fresh Cloudflare-only enrollment exercises the successful path without
claiming that the direct-to-quick transition is fixed.

No paid provider, bot/reader activation, private Space recovery, named-tunnel
application, Linux/Windows packaged workflow, full GUI or complete P9 gate is
qualified by these checks.
