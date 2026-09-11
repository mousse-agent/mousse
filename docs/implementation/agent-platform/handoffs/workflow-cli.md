# Structured workflow CLI handoff

Root-owned structured CLI ingress uses the same profile-bound framed MMS run service as the desktop. The `workflow` command has a `workflows` alias. It supports definition list/info, published or exact saved-draft runs, history/show/trace, watch, pause/resume/cancel, explicit approval/answer, and fail-only uncertain-effect reconciliation.

`--json` selects one JSON event per line. Run waits by default; `--no-wait` returns after durable admission. Run input is inline JSON or a bounded regular JSON file (1 MiB), with no shell interpretation. Draft execution requires both `--draft` and `--expected-draft`; published execution optionally accepts `--revision`. Without an explicit revision, the coordinator atomically selects and persists the published head. CLI retries with the same request identity and arguments therefore preserve the original revision after publication changes. The CLI prints its request identity and resolved definition UUID before sending and accepts `--request-id` for an explicit retry.

The command validates arguments and reads local input before connecting. It connects through `DaemonClient`, binds the chosen profile, and uses the binding returned by the daemon. It deliberately avoids the chat-oriented `openMms` override path; provider/model/API-key overrides and `--continue` are rejected. Normal commands acquire no installation lease.

Wait exit codes are 0 success, 1 workflow failure, 2 invalid/dependency/connection request, 3 pending human input/approval, 4 cancellation, and 5 interrupted/uncertain/recovery state. Human waits remain durable for later explicit actions. Approval requires a supplied approval UUID and `--yes` or `--deny`; the client verifies that exact pending approval and sends only its node/instance/attempt identity. Answer and reconciliation similarly require explicit instance selectors. History and trace preserve bounded page cursors.

Ctrl+C during a foreground run requests cancellation of that run, including when approval is pending. Ctrl+C during `watch` returns 130 and leaves the run active. Closing a client alone does not cancel. A cancellation response may still be `cancelling`; the event is labelled `cancellation-requested` rather than claiming cleanup has already finished.

## Evidence and limits

`tests/platformWorkflowCli.test.ts` starts the actual composed MMS service with a real owner lease, endpoint publication and runtime record. Separate built `out/cli/index.js` processes connect through normal daemon discovery and authentication. The fixture verifies typed file input, published-head changes with exactly one run/thread, profile isolation, bounded trace/history, real approved Node execution, stale approvals and detached runs. Cancellation signal semantics use the exported command implementation against the same real framed daemon with an injected AbortSignal; they do not simulate a Windows console keypress. Invalid flags/input and state-to-exit-code mapping are covered separately.

Initial verification: 3 files / 13 tests passed (workflow CLI, existing interactive slash commands, existing CLI launch), both TypeScript projects passed, and `npm run build:cli` passed. A final targeted rerun is required after the small pending-approval interruption correction and reviewed integration merge; the central ledger records the final result.

This delivers structured workflow commands. Main-agent slash dispatch/completion, chat run cards, schedule/channel targets, external execution adapters, complete multiwait projections, installer/packaged CLI qualification and full W03/W04 remain open. The CLI does not claim provider execution merely because a definition contains an Agent node; unconfigured adapters are rejected by admission.
