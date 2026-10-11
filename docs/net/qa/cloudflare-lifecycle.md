# Cloudflare route transition and packaged foreground cleanup

I reproduced the retained failures in an isolated worktree based on Net `6d67b65b`. This is scoped work for issue #44; it is separate from the Control cutover/Chats candidate, and neither a default-branch release nor whole-platform qualification.

## Evidence and source changes

The original `/private/tmp/mousse-packaged-cloudflare-cached-routes-01.json` retains a signed route to `counter-avatar-carrying-room.trycloudflare.com` before direct withdrawal. `NetService.activate()` previously tore down and recreated every configured listener for any single transport change. A protected two-profile actual TLS regression reproduces that behavior: the follower persists signed `run0.trycloudflare.com` routes, then disabling only direct makes the host start a second child and publish `run1.trycloudflare.com`.

I preserve the existing managed transport set during activation, reuse unchanged live registered instances, and replace their status subscriptions only when an instance changes. Failed/disabled instances remain eligible for explicit reconfiguration. Authenticated sessions still close and reopen through the existing hello exchange; no new route-update message or unsigned route alias is introduced. The regression verifies the retained quick-tunnel hostname remains in the published route set, direct disappears, the signed route version advances and only one tunnel child was started. It does not qualify arbitrary hostname-changing crashes or every reconnect scenario.

The immutable original production app matches the retained ASAR/executable hashes `864c516e68fd9d981f0052601d224bfd3e926f49b0fae86fc332e24d9f40f01d` / `79019361f697c1a81489dba3e94631b0977770c1ab15236f1f033f9de6238874`. I reproduced SIGTERM failure at `/private/tmp/mnqa-cf-stop-red/evidence.json`: the daemon exited code 0, without the `Shutting down MMS` log, while its runtime/owner records, tunnel process and tunnel directory remained. An actual Electron signal probe recorded `before-quit` and no Node SIGTERM event.

I added a foreground-only Electron `before-quit` hook after the MMS owner has been created. It prevents immediate app exit and invokes the foreground owner's existing awaited shutdown. The foreground lifetime decides when the CLI entry exits; the hook neither fabricates a cleanup ACK nor directly exits the app. It is disposed when that lifetime ends. Held-drain and failed-drain unit checks verify repeated quit events remain fenced. This change does not claim startup-before-owner termination, forced-kill cleanup, noncooperative provider cleanup or fixes to the preexisting outer daemon shutdown error policy.

## Focused qualification

Supported Node 24.20.0 and `/private/tmp` are used. The protected TLS route regression passed after failing on the old source; directly affected transport/add-on/relay checks passed (12 tests). Foreground startup correction, held/retry Electron quit and route regression checks passed (15 tests). Source Node TypeScript passed; changed-source ESLint has zero errors and the preexisting NetService floating-promise warning. No full suite was run.

The actual production CLI app built from source `5eaad179` passed the exact SIGTERM reproduction at `/private/tmp/mnqa-cf-stop-green/evidence.json`: it logged `Shutting down MMS (electron-before-quit)`, exited 0, and removed the owned tunnel, its directory, runtime and owner records without emergency cleanup.

The actual three-daemon protected direct-to-Quick-Tunnel gate completed at `/private/tmp/mnqa-cf-life-01/cloudflare-evidence.json`. The follower's separately read persisted signed-route payload hash is `ac4d306c3af324e68855ba4dc7ecd4046060e5448d601cd7d1bcb61eb6d99537` at version 2. Before and after direct withdrawal, the address was `wss://favourite-purse-court-grad.trycloudflare.com/mousse-net`, with exactly one owned tunnel child. Normal system DNS passed, and the same-user follower reconnected through the Cloudflare-only target, created/listed a Bridge thread and reconstructed its verified 347-byte snapshot. An independently protected foreign member joined a public Space and delivered its original event with a sent receipt at epoch 1/sequence 1; host and member both read it back.

All three actual daemon stops used SIGTERM without escalation and exited 0 after 388/30/24 ms. The owned tunnel process, directory, runtime records, owner records and profile directories were observed gone before declaring completion. Bounded `daemon-0.log` through `daemon-2.log` preserve the cleanup logs. This qualifies this normal ready-owner app cleanup, not forced kills or every shutdown failure path.

The artifact used actual production main `out/main/cli.js`, Electron 43.2.0 on macOS arm64, with Node 24.20.0 as driver. Its immutable hashes are:

| Artifact | SHA-256 |
| --- | --- |
| app.asar | `9c3776d859775882f059834e6f1bacac63302806ae7604597e178c15bba9c575` |
| executable | `79019361f697c1a81489dba3e94631b0977770c1ab15236f1f033f9de6238874` |
| main entry | `1f482a528bcb2c06785d7ab9af31b92f8285a19ac9a612b986c4e7faa3965417` |

The task-owned app is `.mousse-dev/net-packaging/production-cli/mac-arm64/mousse-cli.app` in the isolated Cloudflare worktree. The source tests remain focused; final source TS passed and source ESLint reported zero errors with the same preexisting warning. There is no injected resolver, paid provider qualification, private/bot/Native execution qualification, named tunnel, full GUI, other-platform package qualification or whole P9 claim. The original red tunnel required exact PID/start-time/command-checked emergency cleanup. Existing cloudflared processes 353/3370 and the 24-hour soak 67888 were left untouched.
