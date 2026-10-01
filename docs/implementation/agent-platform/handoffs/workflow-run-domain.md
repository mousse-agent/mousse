# Workflow run domain bridge

The production registration/client/coordinator follow-up is documented in [workflow-production-runs.md](workflow-production-runs.md). The composition-pending statements below describe this earlier domain-only checkpoint.

Root checkpoint, September 11, 2026. Built on reviewed runtime `d097ceb8517cd4f3227a12824ae967773dd5f2be`, merged into core as `8e9fd655af36051a70dc7c4b31510652a97f4ccc`.

This adds the shared desktop run DTOs, strict request validation, domain registration factory, and bounded run/trace/history projections. Production registration and GUI/CLI invocation are deliberately still absent until the profile-owned coordinator supplies real project/thread/policy admission and adapter lifecycle. `workflowRuns.v1` is not yet advertised by MousseMainService. This is an executable domain implementation exercised against the real durable engine, not a claim that the app Run button now works.

The domain exposes start/get/list/trace/pause/resume/cancel/approve/answer/reconcile. It requires a trusted profile binding and negotiated capability, rejects unknown fields including actor/source/policy/root paths, and verifies the selected service and every returned run belong to the admitted profile. Start requires a durable UUID request identity and either a published revision or exact saved draft hash. Source is provenance captured from the authenticated connection hello; client type never grants additional authority.

The host start contract must resolve the owning thread/project, select immutable execution inputs and installation policy, then call the engine's nonblocking `admit`. Public control methods use `deferExecution` so decision persistence completes before supervised execution continues. Approval uses the stored approval record, exact run/revision/policy/node/instance/attempt, expiry, consumed state, and the authenticated connection ID. Input answers use the engine's authoritative pending node identity. Unknown external effects can only be marked failed through this bridge; unsupported accept/retry requests return an explicit error. Full recovery remains required scope.

Run views exclude compiled bundles and private runtime envelopes. Result previews are capped at 32 KiB; views include up to 100 attempts, artifacts and events, explicit truncation flags and counts. Trace pages carry a sequence cursor; history pages use creation time plus run UUID so equal timestamps do not lose records. The response ceiling is 1 MiB. These are wire bounds, not a claim that the engine reads journals incrementally: current engine `trace`/`snapshot` still load their persisted journal and full checkpoint before projection. Persisted output remains exact.

Verification at this checkpoint:

- Eight new real-engine/domain tests cover durable duplicate admission, changed-request conflict, exact output, profile and capability rejection, forged authority fields, stale approval/input identity, authenticated approval actor, trace/history paging, malformed/deep DTOs, Unicode/breadth/cycle preview bounds, and exact persisted large output. The equal-timestamp history case explicitly substitutes a fixed catalog to isolate ordering from the clock.
- New domain tests plus definition/domain-registry regression: 17 tests passed.
- Existing framed protocol server, production composition and workflow UI regression: 45 tests passed.
- Full node/web type checking passed.
- Full app/CLI build passed. The existing malformed CSS comment and mixed import warnings remain unchanged.

Remaining root composition work: profile coordinator lifecycle/recovery timers; shared policy and cancellation ownership; stable thread selection on request replay; real workspace/Agent/MCP/Skill/browser adapters; registration/capability/preload allowlists; renderer execution client with explicit subscription error handling and duplicate-click protection; slash ingress pinned before queueing; structured CLI execution; main-agent tools and scheduled/channel targets. The pending per-instance multiple-wait runtime change must extend the singular approval/input UI contract without silently dropping parallel waits. Sol review of this bridge remains pending.
