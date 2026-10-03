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

## Private controls and remote display checkpoint

I added explicit human-audience aside creation and private send controls,
bot-owner permission decisions, and device/thread selection with the verified
Bridge multipart decoder. These remote originals stay in display state rather
than entering an executable local thread. Each uncertain mutation retains its
original ID and input or exact approval decision. Registration retries freeze
the original bot policy. Current Chat authorization denial clears the held
network conversation and unmounts private views.

The actual two-Root Electron IPC check now creates one human aside, retries its
opening and sealed message exactly, and reads the private body as the authorized
foreign member. The shared channel contains only its opening marker; the private
envelope has no plaintext body. It still creates no bot, provider job, blob or
executable thread. I also verified that retired Control/pairing methods deny at
the GUI allowlist. Evidence: `/private/tmp/mousse-net-ui-private-gui.log`.

I reproduced the delivery page problem: selecting only the oldest outbox page
can hide pending originals behind sent records. The bounded metadata API now
filters validated delivery states before keyset pagination. Actual pending
originals beyond the sent prefix and a second filtered page pass, without
returning message text or signed payloads. Nested state arrays deny. The focused
store, display and Space run passes 21 checks; the final state-validator check
passes separately. Both source TypeScript projects and scoped source lint pass.
These checks do not establish mounted approval or remote-display lifecycle
qualification.

The native browser could not reach the host's loopback server. I served only
the compiled, mocked layout fixture through an owned Cloudflare quick tunnel;
the browser then loaded the real React controls. I reproduced a named-tunnel
checkbox stretching to 1,184.7 CSS pixels and verified its fix at 13×13 pixels,
in a row label, with no horizontal overflow at 1280×800. The current fixture
build uses the renderer's React and Tailwind plugins. Native snapshots still
fail with `PreviewAutomationExecutionError`; I claim DOM/control bounds only,
not screenshot or visual approval. The fixture has no daemon or mutation
authority.

## Integrated profile rollback and task metadata

I integrated the durable task-ID/status API and profile-local opt-in/rollback
implementation. Devices displays the persisted flags and explicit disable,
restart-required and fresh opt-in controls. Disabled profiles query status and
doctor only; they do not make denied transport/device reads. Late settings
responses are fenced against unmounted views. I reproduced a cached network
Chat surviving the actual `cancelled` rollback error and added that error to the
view-clearing guard; all 12 store checks pass.

The integrated source run passes 29 checks across ten files, covering actual
rollback/restart, pending-original retention, TLS task recovery, private GUI
IPC, multipart Bridge GUI isolation, transport reuse and Darwin native
identity. Its one failing framed fixture had not opted its foreign profile
into networking under the new default-off contract. I retained the off denial,
explicitly opted that fixture in, and reran its original authorization/retry
check successfully. I did not weaken an admission gate. The exact original
composed child/grandchild profile drain also passes on this integrated source.
Evidence: `/private/tmp/mousse-net-ui-integrated-focused.log`,
`/private/tmp/mousse-net-ui-integrated-framed-final.log`, and
`/private/tmp/mousse-net-ui-integrated-profile-tree.log`.

The emitted production CLI was rebuilt before the daemon rollback checks.
Source Node/web typechecks and scoped source lint pass. The later mounted
checks below cover the task picker and private/display lifecycle; neither these
focused checks nor the prior baseline full-suite failures qualify a complete
application/platform release.

## Mounted task picker and private/display lifecycle

I integrated the durable task picker and preserved its actual mounted React/
Electron regression. It reads bounded saved-task pages, rediscovers original
tasks after remount, separates Start from readonly original-result retrieval,
and keeps preparation IDs/inputs fixed through two lost original replies.
I reproduced the absence of a new-task action after an original completed.
The explicit Prepare another task control now resets only the exact known
completed/failed original, issues no API call on reset, and leaves the old saved
task intact. A subsequent explicit preparation uses new intent/ID; its uncertain
retry preserves that second original. Unknown/prepared/cancel-requested tasks
cannot reset. Actual rollback cancellation clears held results/controls.

The independent mounted review reproduced late private-opening and approval
callbacks after unmount, plus an offline remote pane still showing Working.
The exact late opening, permission and WorkView cases now issue no extra read or
callback. Private opening/approval retries retain exact original input/decision.
Remote views retain a labeled cached transcript; a new connection waits for a
complete current display. Incremental-only and incomplete real browser
WebCrypto-hashed multipart input cannot promote it. Complete fresh input updates
the body/Working label, with exact serial attach/detach and listener cleanup.
The repeatable scenarios and qualification limits are in
[the mounted lifecycle record](qa/gui-mounted-lifecycle.md).

The combined current-source run at `39e107cd` passes seven checks in three files
(five task-state checks, one actual mounted picker and one six-scenario lifecycle
check), in 3.59 seconds. Web source TypeScript and scoped source lint pass.
Evidence: `/private/tmp/mousse-net-ui-current-mounted-final.log`,
`/private/tmp/mousse-net-ui-current-mounted-web-ts.log`, and
`/private/tmp/mousse-net-ui-current-mounted-lint.log`. These controlled API-port
fixtures establish mounted behavior; they do not replace actual authorization,
preload/MMS, paid-provider, screenshot or packaged renderer qualification.
