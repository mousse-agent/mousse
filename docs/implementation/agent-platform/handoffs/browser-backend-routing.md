# Host-selected browser backend routing

This root candidate implements the routing portion of the 2026-09-11 clarification: GUI Browser Use must target existing in-app tabs. It does not implement the Electron executor, authenticated bridge, or final BrowserPanel connection.

`BrowserToolContext.target` is supplied by the host, outside model tool arguments. GUI opens require an explicit attached-tab or managed target. CLI and other unattended sources default to managed Chromium. Attached opens retain existing storage and reject managed workspace/persistence arguments. Tool descriptions now cover both backends; `browser_open` rejects unknown fields, including model-supplied backend/tab selection.

`BrowserBackendRouter` forwards a selected attached tab only to the attached port, removes its internal backend selector before dispatch, and binds successful session IDs to the original backend. It checks response correlation, profile/thread/run/backend identity, rejects duplicates and backend substitution, and never retries or falls back to managed Chromium after an attached failure. A fresh router has no live routes for pre-restart sessions; the session manager separately restores their inventory as disconnected.

The router tracks backend promises, closes admission synchronously, and retains pending ownership through caller abort/shutdown deadlines. It does not treat a timeout wrapper as underlying completion. Backend shutdown and actual process/guest close proof remain separate host responsibilities; router idle alone does not prove those owners have stopped. The existing BrowserBroker must be hardened before full profile-drain closure.

Validation:

- New routing suite: seven cases through the real session manager/tool dispatcher with bounded fake backend ports: exact selected tab, immutable backend, run isolation, explicit GUI target, CLI default, unavailable/disconnected attached backend, no fallback, model field rejection, storage/response substitution, close replay, pre-cancel, and retained raw operation across drain timeout.
- Combined routing/contracts/automation/viewer/model-adapter suite: 28/28 passed. Existing actual managed-Chrome actions, model-adapter dispatch, and takeover remain passing.
- Both TypeScript projects and CLI build passed.
- Initial routing run exposed permissive `browser_open` argument filtering; the dispatcher now rejects the fields and the original expectation passes.

No G5 gate closes here. Grok owns the required Electron-attached executor in the browser worktree. Root still owns targeted daemon/main transport, trusted registration, production composition, artifact authorization, UI lifecycle/input gating, and model/workflow admission. The full in-app acceptance test must act on the existing live page, not a replacement managed viewer.
