# In-thread applets implementation plan

Status: first-release offline implementation completed; platform release qualification remains.
Date: 2026-10-06

## Outcome and first-release scope

Implement in-thread applets as durable, interactive parts of an assistant response. An LLM can produce a diagram, infographic, calculator, comparison tool, or dashboard using HTML/CSS/JavaScript. Mousse displays it inside the thread, preserves it across restarts, and supports revisions through follow-up messages.

The first release supports offline, self-contained applets across providers, with automatic preview after a complete, validated response. Live data connections and applet-triggered agent actions come later.

## 1. User experience

An applet appears at its intended position within an assistant message alongside explanatory text. Each card provides:

- A title and short description.
- An inline interactive preview.
- Expand, restart, view source, and export controls.
- A revision indicator when an existing applet is updated.
- A compact error state that preserves source and offers retry.

Example: a request to compare three pricing plans produces explanatory prose and an interactive calculator. Usage sliders run locally. A follow-up asking for annual billing creates a new revision of that applet; the previous revision remains available.

Interactions do not invoke the LLM by default. Sending a selection or revised assumptions back to the conversation requires an explicit user action.

## 2. Rendering architecture prototype

The existing Markdown preview deliberately skips HTML. Preserve that behavior and add a dedicated applet component. Generated JavaScript must execute outside the privileged Mousse UI. The current main window has a desktop preload and `sandbox: false`; generated code must not execute directly in its DOM.

Compare these approaches in a small prototype:

| Approach | Benefit | Main concern |
| --- | --- | --- |
| Sandboxed iframe on a dedicated applet origin | Natural inline layout, scrolling, and clipping | Prove renderer/process isolation and recovery from runaway JavaScript |
| Dedicated sandboxed WebContentsView | Explicit guest lifecycle, session, and permission control | Inline placement, clipping, overlays, and compositor behavior require additional work |

Avoid introducing another webview-based subsystem. Electron recommends considering iframe or WebContentsView alternatives.

The prototype must demonstrate:

- An infinite loop cannot freeze the thread or composer.
- A failed applet can be terminated independently.
- Scrolling stays smooth with several applet cards.
- Applets clip correctly behind the composer and under menus.
- Linux resizing and rounded corners remain correct.
- Keyboard focus enters and leaves an applet predictably.

Select the runtime from measured results. An iframe sandbox alone does not establish availability or process isolation.

References:

- https://www.electronjs.org/docs/latest/api/webview-tag
- https://www.electronjs.org/docs/latest/api/web-contents-view

## 3. Versioned applet contract

The LLM supplies content and presentation metadata. Mousse assigns ownership, identifiers, revisions, and permissions.

Proposed submission:

```json
{
  "schemaVersion": 1,
  "title": "Pricing comparison",
  "description": "Compare monthly costs at different usage levels.",
  "html": "<main>...</main>",
  "css": "...",
  "js": "...",
  "data": {},
  "stateVersion": 1
}
```

Mousse adds applet ID, immutable revision ID, profile/thread/message/turn ownership, source hash, creation timestamp, runtime policy version, and an optional reference to the revision being replaced.

HTML is a document fragment. Mousse owns the surrounding document, security policy, asset loading, and bootstrap.

Provisional, configurable limits:

- 512 KiB combined source and data.
- Three applets per assistant response.
- Bounded title, description, and saved interaction state.
- No remote dependencies, arbitrary imports, or package installation.
- Ordinary JavaScript, CSS, inline SVG, and canvas support.

Tune limits with realistic dashboards before treating them as final requirements.

## 4. Provider output and ingestion

Use a shared ingestion contract with two output paths:

1. A structured `publish_applet` tool for providers supporting Mousse tools.
2. A designated `mousse-applet` JSON fence for native providers and other text-only paths.

Both enter the same validation, persistence, and presentation pipeline.

Parser rules:

- Only explicit applet submissions become executable content.
- Ordinary HTML/CSS/JavaScript examples remain code blocks.
- User messages, tool results, and quoted documents never automatically become applets.
- Handle fences split across streaming chunks.
- Incomplete or cancelled submissions remain inert.
- Retries cannot publish duplicates.
- Nested-agent output cannot accidentally publish into the root thread.

For Claude Subscription, use the fenced format initially. Its current SDK configuration has no MCP servers; this feature must not require weakening that configuration.

## 5. Model instructions

Add capability-aware guidance to the shared system prompt and native-provider instruction paths. Tell models to:

- Prefer applets where interaction or visual comparison improves understanding.
- Keep simple answers in prose.
- Fit responsive layouts to the thread column.
- Include labels, units, legends, and explanatory text.
- Distinguish supplied data, calculated values, and illustrative sample data.
- Support keyboard interaction and reduced motion.
- Use local assets and supported capabilities.
- Revise existing applets when asked.
- Avoid claiming embedded or simulated data is live.

Provide small examples of an infographic, slider calculator, filterable dashboard, and diagram. Keep the instruction budget modest.

## 6. Restricted runtime and bridge

Applets have no access to `window.mousse`, Electron IPC, Node.js, filesystem paths, shell commands, provider credentials, other profiles/threads, unrestricted networking, popups, downloads, or microphone/camera/clipboard/device permissions.

Use a dedicated session, restrictive resource policy, navigation controls, and permission denial. Guest settings include disabled Node integration, enabled context isolation, and enabled process sandboxing. For iframe implementations, do not grant script execution and same-origin access to content sharing the host origin.

Expose only a narrow, validated bridge:

| Operation | Purpose |
| --- | --- |
| ready | Report successful startup |
| resize | Request bounded preview height |
| saveState | Save bounded JSON interaction state |
| reportError | Report a bounded diagnostic |
| requestConversationInput | Present a user-confirmed action to send information back |

Bind connections to the exact revision and runtime instance. Reject stale instances, oversized payloads, and unknown operations. Applet-supplied IDs or tokens never authorize access to another resource.

References:

- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/sandbox
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

## 7. Durable transcript ownership

Extend the chat message model with ordered presentation parts containing text and applet references. Maintain compatibility with legacy messages containing only `content`.

Store immutable bundles within the owning thread's durable storage, integrated with the existing thread data store.

Requirements:

- Commit validated source before publishing its transcript reference.
- Recover from interruption between those steps.
- Verify source hashes on load.
- Preserve applets through restart, rename, and export.
- Respect conversation branches and Undo/Redo visibility.
- Include applets in purge and storage accounting.
- Prevent cross-profile runtime or state exposure.

Keep interaction state separate from immutable source. Preserve state across compatible revisions; visibly reset incompatible state.

## 8. Scrolling and resource lifecycle

Protect thread performance using:

- Stable placeholders during generation.
- Execution only after validation and durable publication.
- Lazy mounting near the viewport.
- A bounded number of active runtimes.
- Suspension or teardown for distant applets.
- Snapshots for inactive cards where supported.
- Debounced, bounded height changes.
- No remount or rerender of completed applets on each assistant token.
- Teardown on thread/profile switches.

Inline previews have a sensible maximum height. Expanded mode retains the same revision and interaction state.

Measure scrolling with many completed applets and concurrent text streaming. Smooth applet interaction inside a lagging transcript does not satisfy acceptance criteria.

## 9. Revisions, recovery, and export

Follow-up edits create immutable revisions. Update requests include applet ID and expected revision. Reject stale updates and keep the working preview visible until its replacement is ready.

An error card includes a clear failure message, restart/source controls, and a user-triggered request for the assistant to repair it. Repair context contains relevant source and bounded diagnostics. Avoid automatic repair loops.

Initial export formats:

- Self-contained HTML.
- Source bundle.
- PNG snapshot if reliable capture is supported by the runtime.

Mousse owns file selection and saving. Exported HTML remains executable content; host-only bridge functions require an export fallback.

## 10. Delivery stages

| Stage | Deliverable | Acceptance criteria |
| --- | --- | --- |
| A: Runtime prototype | Inline isolation and scrolling experiment | Runaway code is independently recoverable; composer, scrolling, and clipping remain functional |
| B: Durable static applets | Contract, validation, storage, HTML/CSS/SVG previews | Restart preserves completed applets; ordinary HTML examples remain inert |
| C: Interactive applets | JavaScript, restricted bridge, saved state | Calculators, filters, and tabs work offline without host access |
| D: Provider integration | Structured tool, fenced fallback, model guidance | API/native providers share the validated pipeline |
| E: Revisions and export | Editing, source view, recovery, export | History survives updates; stale revisions fail; exports work independently |
| F: Release qualification | Focused security, lifecycle, performance checks | Packaged Linux, Windows, and macOS builds pass affected scenarios |

Focused checks cover malformed/interrupted output, duplicate retries, cross-profile access, forbidden networking, navigation, bridge spoofing, infinite loops, runtime crashes, Undo/Redo, restart, and purge.

Visual checks include a static infographic, interactive calculator, and dashboard at narrow/wide widths, in light/dark themes, with keyboard navigation and reduced motion.

Do not run the full suite unless explicitly requested or required by GitHub. Do not broaden passing focused checks without a new change, failure, or concrete concern.

## Implementation touchpoints

Existing integration points:

- `src/renderer/components/editors/MarkdownPreview.tsx`: preserve HTML-skipping behavior; route typed applet presentation separately.
- `src/renderer/components/OrchestratorChat.tsx` and its transcript presentation: inline cards, streaming placeholders, lifecycle, and scroll integration.
- `src/shared/types.ts`: backward-compatible message presentation references and ownership lineage.
- `src/mms/data/ThreadDataStore.ts`: durable publication and recovery.
- `src/mms/orchestrator/systemPrompt.ts`: capability-aware generation guidance.
- `src/mms/orchestrator/OrchestratorService.ts`: common ingestion, provider integration, and turn ownership.
- `src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService.ts`: native-provider instruction/output integration without relaxing MCP isolation.
- `src/main/index.ts`: isolated applet runtime/session lifecycle, not generated code execution in the main renderer.

Proposed new modules should separate shared contracts/validation, MMS bundle persistence, main-process runtime control, and renderer applet cards. Final names depend on the runtime prototype.

## Deferred scope

Keep live API connectors, arbitrary npm dependencies, workspace access, collaborative execution, and applet-triggered agent work outside the first release. Leave room for explicitly granted capabilities later.

This document is a planning artifact. It does not authorize implementation, remote publication, or changes to existing security boundaries.


## Implementation record — 2026-10-06

I implemented the offline first-release path in issue #67. The runtime uses sandboxed WebContentsView guests, isolated sessions, an opaque origin enforced by a response-header sandbox policy, a narrowly scoped event bridge, and a heartbeat watchdog. Native clipping keeps previews within their cards and above the composer; profile transitions destroy guest ownership. At most three guests execute per window, with bounded reusable session slots.

API providers receive a `publish_applet` tool. Claude Subscription and Antigravity receive the same generation contract through native instructions and explicit `mousse-applet` fences. Complete assistant responses publish immutable, hashed bundles and typed transcript references; streaming, malformed, interrupted, and failed output remains inert. Existing publication receipts allow crash recovery without executing arbitrary historical code fences.

Cards support inline expansion, restart, source inspection, repair drafts, HTML/JSON/PNG export, versioned saved interaction state, and user-confirmed conversation drafts. Follow-up edits supply applet ID and expected revision; stale revisions fail without replacing existing content. State and bundles live under the existing thread directory and follow its archive, restore, and purge lifecycle.

I verified contract/storage behavior, API and native-provider ingestion, profile fencing, renderer adaptation, host visibility, and the real Electron runtime/card integration. Native probes cover forbidden networking and host APIs, child-frame escape, runaway JavaScript, compositor clipping, interaction state, export, zoom, and session reuse. These checks do not establish packaged Windows/macOS qualification. Live connectors, packages, workspace capabilities, and automatic agent actions remain deferred.

For manual use, ask a supported model for an interactive infographic, calculator, or offline dashboard in the thread. A complete valid result appears automatically; use the card toolbar to inspect, restart, expand, or export it. Generated interactions do not send a model request until the user submits the resulting composer draft.
