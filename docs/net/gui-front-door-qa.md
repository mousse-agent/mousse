# Electron Net, Chats, and Bridge front-door qualification

I exercised the production preload/contextBridge, `registerGuiIpc`,
`GuiMmsController`, and framed window-bound MMS connections on macOS arm64,
Electron 43.2.0, with Node 24.20.0 as the test driver. The daemon runs in the
Node process; real hidden Electron windows use context isolation, disabled
Node integration, and the production preload bundle. Each test creates and
removes its own installation, protected profiles, Electron user data, and
children. `ELECTRON_RUN_AS_NODE` is removed only from the owned child's env.

These checks qualify the preload/GUI IPC path. They do not qualify the complete
renderer application, production GUI packaging, Linux/Windows GUI operation,
or a paid provider. No Native adapter is installed or activated; actual model
calls remain zero.

## Focused checks

```sh
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run \
  tests/net/chats/gui-electron.test.ts \
  tests/net/bridge/gui-electron-display.test.ts --maxWorkers=1
```

The Net/Chats check uses two genuinely different protected Root users and
separate windows. I verified:

- Real GUI `net.init`, `net.protect`, `spaces.create`, and `spaces.list` calls.
- Local group creation, a trusted local-history/resource canary, publication,
  and a deliberately lost genuine framed publication response after commit.
  Query and explicit retry preserve the original publication/channel identity.
- Publication begins with empty network history; original local JSON remains
  byte-identical, and history, resources, and local agent prompt stay local.
- Explicit empty mentions on both owner and genuinely joined foreign-user
  sends, identical original event IDs on retry, and exact authenticated authors
  and readback at epoch 1, sequences 1 and 2.
- Joined network presentation allocates no local chat JSON, thread, or project.
- Forged profile/author, another profile's local or joined chat ID, changed
  original bytes, a valid unregistered Bot ID, renderer-supplied runtime path,
  and an unallowlisted method all deny with the asserted error catalogue.
- No bot registration, provider execution, blobs, or execution-ledger rows.

The Bridge check uses three protected profiles: two devices of the same Root
user and an independently enrolled foreign user. A trusted fixture writes one
message into the actual remote ThreadDataStore and live session without running
an agent. The GUI attaches the real remote thread and receives the actual
owner-scoped connection events. The shared `BridgeDisplayDecoder` runs inside
that real renderer, with its default bounded async queue and browser WebCrypto.
I verified a 2,970,426-byte snapshot, 91 chunks, exactly one complete decoded
view, exact message equality, transaction SHA-256 and stream/epoch/sequence,
a subsequent actual rename event, and zero decoder errors. The other user's
window receives zero parts. Disposing the preload listener removes delivery.
After real A→B→A profile binding, replaying the exact previously delivered framed
original with its old binding epoch yields zero parts in the rebound window.
The only execution-ledger entry is the legitimate completed `bridge.thread.open`
RPC; there are no bots, active bot jobs, model calls, or budget reservations.

## Reproduced delivery failure and fix verification

The baseline actual attachment acknowledged successfully, but the preload had
no Bridge subscription API. After adding the typed subscription alone, the
daemon emitted 11 genuine multipart connection-event parts, while the renderer
received zero. The sequenced/global protocol-event path did not carry these
connection events.

I verified the corrected dedicated connection lane: the controller checks the
held window-session identity and current profile ID/epoch; the main handler
checks the sender's binding again and sends only to that window. No generic
broadcast, event cursor, replay, or automatic mutation retry is introduced.
The larger snapshot check then passed, including isolation and stale-epoch
replay rejection. The dedicated connection-lane source fix is integrated in the renderer candidate
checkpoint after this QA checkpoint.

During fixture development, an opaque `data:` URL lacked `crypto.subtle` and
correctly failed the real decoder's digest. I changed only the owned fixture to
a local `file:` HTML page, matching the packaged renderer's secure local origin;
I did not polyfill crypto or weaken decoder validation.

For this run, detailed ephemeral evidence was retained at:

- `/private/tmp/mousse-gui-bridge-candidate-red.json` and matching `.log`:
  typed API exposed, 11 daemon parts, zero renderer parts/views.
- `/private/tmp/mousse-gui-bridge-fixed-nullguard-final.json` and matching `.log`:
  94 owner parts, 95 daemon parts including the later disposed-listener rename,
  one complete view, matching content, zero foreign/disposed/stale parts.
- `/private/tmp/mousse-gui-net-final-02.log`: passing Net/Chats flow; the Bridge
  child also passed but the initial final SQL assertion incorrectly counted its
  legitimate read RPC as a provider execution. I corrected that assertion to
  require the exact completed RPC and reran only the affected Bridge check.

After the final null-binding guard, I reran the affected actual Bridge check and
Node source TypeScript; both passed. Scoped source lint reported zero errors and
two existing async-callback warnings in `registerGuiIpc`.

These absolute evidence paths are local run artifacts, not required fixtures.
Set `MOUSSE_GUI_BRIDGE_EVIDENCE_OUT` to a fresh path to retain a new bounded
Bridge observation report; the test refuses to overwrite an existing report.

## Renderer candidate checkpoint

I added Devices settings and explicit network Chat publication, Space join,
Bot ID mention selection, bounded original-record pages, authorized bot work,
and explicit Bridge task preparation/dispatch to the current PR #47 shell.
Lost-reply send/publication retries keep the same admission identity. Ten store
checks pass, including a reproduced periodic-refresh pagination reset and
rejection of stale pages, changed original bytes/receipts, binding changes,
epoch changes, and head regression. Both source TypeScript projects pass;
changed-source lint reports zero errors and four existing warnings.

This remains an incomplete renderer candidate. Human aside controls, owner
approval rendering, remote device thread browsing, durable task rediscovery,
legacy GUI retirement, and visual/application qualification remain pending.
The layout-only fixture is explicitly labelled and uses no daemon. I attempted
it with the native collaborative preview, but the browser frame loaded
`chrome-error://chromewebdata/` despite local HTTP checks succeeding; no layout
screenshot or visual pass is claimed.
