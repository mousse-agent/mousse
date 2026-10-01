# Workflow background ingress handoff

Authenticated channel and scheduled prompts that contain `/workflow_name` now use the same profile-owned `MmsWorkflowChatBridge` prepare/execute receipts as GUI and CLI chat. Reserved channel commands stay on the existing slash handlers. Plain prompts still run through the current per-turn model path. Main per-turn browser factory and `runAgentDefinition` are unchanged.

## Host identity

Channel and schedule ingress never accept a caller `workflowInvocationId`, source label, or filesystem path as admission authority. `ChannelRouter` passes the real platform/chat/message identity into `runChannelTurn`. Missing adapter message IDs are assigned once at that host boundary. Scheduled jobs pass the durable job ID plus the `nextRunAt` captured at claim time. Those host tokens are hashed into the receipt UUID. A later retry of the same message or occurrence rereads the receipt and keeps the pinned revision even if publication moved.

## Admission and delivery

Preparation stores the receipt before a channel turn or scheduled claim is completed. Execution admits the graph through the existing coordinator. The thread execution lease is released before observation so a durable child run cannot sit under an inverted parent lease. Observation waits until a waiting or terminal state, then the host delivers that state. Waiting-condition timers stay durable; `/stop` closes the observer and awaits its promise without cancelling the admitted run. Channel and schedule sources are unattended: approval-required effects fail closed with `unattended approval required` instead of synthesizing success.

Scheduled claims record `waiting` instead of `ok` when the admitted graph is still waiting. Workflow transcript already persisted by chat admission is not appended again.

## Evidence

`tests/platformWorkflowBackgroundIngress.test.ts` uses real `MousseMainService`, profile-owned orchestrator/scheduler, and `ChannelRouter` host callbacks with a fake local adapter. Two tests passed: recognized slash workflows with no model call; same channel message and scheduled occurrence retries after a new published head; two-profile isolation; missing required inputs; unattended trusted-local scripts failing closed instead of success; durable delay waits delivered as `waiting-condition`; `/stop` after delivery leaving the run durable; claimed scheduled jobs recording `waiting`; and plain prompts still reaching the model spy. `tests/channels.test.ts` (29) still covers reserved `/help` locally and now expects unrecognized slash text to reach the host turn with the inbound message ID. `tests/scheduledJobs.test.ts` (20) and `tests/platformOwnedWorkLifecycle.test.ts` (6) passed. Node/web typecheck and `npm run build:cli` passed.

No live channel, provider, or account traffic is used. Sandbox/package qualification is out of scope.

Root wiring: `MmsProfileServices` forwards claimed-job identity into `runIsolatedScheduledJob`. `WorkflowRunAdmission.source` accepts `channel` and `schedule` for this host path; RPC starts remain GUI/CLI.
