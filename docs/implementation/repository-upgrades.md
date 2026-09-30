# Repository upgrades and structured errors

I reviewed this plan twice and iterated on implementation criticisms with Claude CLI using `claude-opus-5-5`. The first review identified whole-turn retries and unstructured chat IPC as the largest risks. The revised review accepted request-scoped retry against the current native transcript, with progress guards and separate usage accounting. Implementation and testing use an isolated worktree; the primary checkout's existing conflict and unrelated edits are preserved.

## Plan and delivery criteria

1. I introduce a browser-safe `AppErrorShape` (`code`, `message`, `details`, optional `errorInfo`) and small domain error providers built from closed catalogs. An `AppError` can retain its local cause, but explicit serialization sends plain bounded data. `errorInfo` contains category, transient classification, and optional bounded retry delay; it is not replay authority. Existing codes and lowercase profile wire codes remain intact.
2. I normalize provider failures before retry classification. Permanent errors take precedence over transport wording, cancellation takes precedence over timeouts, and unfamiliar provider messages use static public text. Pi's installed `AssistantMessage` generally exposes errors through `errorMessage`, not top-level HTTP status or headers; source-specific string fallback remains necessary. Some adapters expose allowlisted diagnostics; Bedrock diagnostics remain a documented follow-on rather than being flattened indiscriminately. Supported Anthropic/OpenAI HTTP adapters capture only status and Retry-After before SDK stringification; adapter response callbacks supply the same allowlisted metadata where available. Transport adapters that do not expose it retain the conservative string fallback.
3. I retry one provider request against its current native transcript, before it emits text, thinking, or tool-call events/content. Earlier tool batches are not replayed. Each attempt has its own abort controller. Failed response usage remains billable. The outer connection retry is removed; context-overflow retry is allowed only before any provider progress or tool work. Retry notifications remain visible. Five retries and ten-second waits remain; server-requested waits over ten seconds require a later user retry. With the default 180-second stream timeout, six fully silent attempts can take 18 minutes plus 50 seconds of waits; cancellation and execution budgets remain authoritative.
4. I expose host-selected browser backend capabilities and shape tool schemas accordingly. Attached sessions omit tab creation/closure, uploads and downloads; managed sessions retain them. Runtime validation and action outcomes still decide whether a specific operation succeeds. Capability reporting does not grant authority or replace unknown-effect outcomes.
5. I compare Git status/log with the configured upstream and use plain configured Git push behavior. Missing upstream, detached HEAD and unborn branches are explicit states. Git chooses destinations/refspecs; the application does not create tracking or retry another destination implicitly.
6. I add voice pending/error/retry/dismiss UI with static domain messages and cleanup for recorder failures and late microphone permission results after unmount.
7. I refresh Storage inventory every five seconds while visible, separate saved retention policy from editable drafts, and preserve drafts through action refreshes. Dates use the existing purge timestamp fallback and saved grace period. Blockers remain authoritative; this does not change retention or deletion rules.
8. I split static checks from the existing Application checks job without removing Linux/browser or Windows coverage. I inspect the independent job outcomes before merging and do not claim a performance improvement without measurement.

## Covered boundaries and compatibility

| Path | Behavior |
| --- | --- |
| Local provider error → LlmClient → orchestrator | Domain code/classification, local cause, safe public message. Single-request retry and progress guards. |
| Orchestrator → response, chat message, turn state | Optional descriptor alongside existing text. Older saved transcripts remain readable. |
| Daemon → local protocol client | Existing code/message/details. `errors.v1` is explicitly requested; older peers receive no classification field, including replayed/cached payloads. |
| Protocol client → GUI main → preload → renderer | Plain data preserves classification. Chat admission failures resolve with an error response instead of losing code in Electron invoke rejection. |
| CLI one-shot chat | Structured JSON error plus failure exit status; text output includes code and safe message. |
| Browser tool errors | Existing known browser codes adapted; unexpected exceptions become internal errors, not invalid-action errors. |
| Git push and renderer voice | Closed domain catalogs with local cause and actionable static messages. |
| Storage refresh | Safe generic fallback with support reference, preserving existing policy/actions. |

Existing profile/domain validation errors retain legacy messages and bounded details for compatibility, with common secret-pattern filtering as defence in depth. The filtering is not a guarantee that arbitrary text is safe: unknown exceptions and provider/voice/Git failure causes never become public text. No raw SDK bodies, stacks, authorization headers or native causes are serialized. Public support references identify safe structured diagnostic records rather than dumping private causes.

## Remaining adoption

This is a shared foundation and covered-path migration, not a rewrite of every throw site. Existing profile/workflow error classes and most agent throw sites, scheduler persisted error strings, legacy service/channel errors, and remote-control transport are not converted wholesale. New producers should use a domain catalog; further migration should inspect each producer's message/details and its actual consumer. Domain-provided messages containing caught raw errors need explicit safe formatting before broader adoption. Normalized wire classification is presentation data; server-side retry and authorization decisions must never trust it as authority.

## Verification approach

I use focused behavioral regressions and actual boundary fixtures. Local bare Git remotes reproduce configured-upstream failures. Injected provider streams check start-only retries, progress guards, budgets, and earlier tool preservation. Real daemon socket tests cover new/old peers and unknown errors. A renderer fixture mounts the actual composer and Storage components to verify denied/missing microphones, recording failures, late permission cleanup, live inventory changes, and preservation of dirty drafts. The independent testing and review agents report verified behavior separately from remaining uncertainties.

## Implementation verification

The dedicated tester reproduced the configured-upstream Git failures and Storage draft loss on the baseline, then verified the changed behavior against real local Git remotes and the mounted production components. Composer checks include denied/missing microphones, constructor/recorder failures, pending capture, retry/dismiss, successful attachment, late permission cleanup, and timer/track cleanup. Storage checks include dirty draft preservation through actions, saved-policy dates, external inventory changes, single-flight refresh and unmount cleanup. T3 screenshots were unavailable due to tool failures; its document.hidden override also prevented a direct hidden-document check. These are DOM/action checks, not screenshot or hidden-state evidence.

The automated fixtures use actual daemon sockets with negotiated and legacy peers, production Electron main IPC plus production preload/contextBridge, and the actual root orchestrator/native LLM checkpoint flow. They verify that earlier completed tools remain once in the saved transcript and are available to a subsequent manual continuation. The manual connection retry method was additionally reviewed against the same checkpoint state; ordinary chat idempotency is not claimed. Actual installed Pi Anthropic adapter tests reproduce non-2xx response stringification while preserving server-requested delays.

Local typecheck, lint (zero errors with existing warnings), and production main/preload/renderer/CLI build pass. Focused existing protocol tests pass with TMPDIR=/private/tmp: the default macOS temp path alias caused an independently identified owned-root mismatch, so no path-containment code was changed for this task. The local Node version is 24.18.0; hosted CI uses the package minimum 24.20.0. No manual full-suite run was performed.

Independent source review found and closed GUI optimistic-queue cleanup, header propagation for SDK errors, delay limits for HTTP503, provider preflight identity, support diagnostics, and attached screenshot capability issues. Broader error migration remains explicitly deferred above.

Claude implementation review also found and corrected typed browser validation hints, accepted-send composer restoration, HTTP-200 SSE overload/rate-limit classification including numeric token limits, safe purge diagnostics in persisted inventory, and bounded legacy-peer classification removal. The tester verified accepted and rejected sends using the actual chat component/store with controlled responses, and Storage action descriptors through the actual IPC/preload API. Eighty-nine new focused cases across nine suites passed across relevant runs.

Hosted CI exposed known legacy throw sites whose useful messages had been hidden by the safe unknown-error boundary. The verified worktree lock, busy lifecycle, stale named-context, terminal binding, and agent settings producers/adapters now preserve typed errors. These are diagnostic changes; admission checks, deletion fences and ledger operation ordering are unchanged. Newly failed purges persist safe public messages; old persisted error strings are not rewritten by a data migration.
