# Native browser runtime binding

This slice wires the eight generic `BROWSER_AUTOMATION_TOOLS` into the existing native `LlmClient` / Agent Editor tool loop through the committed `BrowserRuntimePort`. It does not implement Electron attached execution, the managed worker, protocol, GUI, or profile composition. Root binds `platform.browser` after merge.

## Importable host API

```ts
import type { BrowserRuntimePort } from '../src/shared/browser/runtime'
import type { BrowserExecutionBinding } from '../src/mms/orchestrator/browser'

orchestrator.setBrowserRuntime(port)
orchestrator.setMainAgentBrowserExecution(binding) // GUI chat only
agentRuns.setBrowserRuntime(port)
```

`BrowserRuntimePort` is the injectable contract. Do not deserialize an execution context, target, or port from model arguments. Root adapts the existing `MmsBrowserService` dispatcher and selected-tab resolver to this exact interface.

`setBrowserRuntime` must be called on **both** `OrchestratorService` and `MmsAgentExecutionService`. Definition admission reads the port from the execution host object; the isolated per-run `LlmClient` also needs the same port. Do not share task queues or budgets across native definition runs — `runAgentDefinition` already constructs a fresh `LlmClient` and uses the admitted thread's queue.

## What this runtime does

- Advertises `browser_open`, `browser_tabs`, `browser_observe`, `browser_find`, `browser_act`, `browser_wait`, `browser_extract`, `browser_request_human` using the existing semantic tool schemas.
- Resolves the GUI/managed target from `port.resolveTarget(execution)` and passes it as `BrowserToolContext.target`. Models cannot supply `backend`, `uiTabId`, `profile`, `execution`, or other host claims; those keys fail closed before `dispatch`.
- GUI/editor/workflow sources require an explicit attached or managed target. Missing GUI target returns `setup_required` and never launches managed Chromium. CLI/scheduled/channel sources default to `{ backend: 'managed-chromium' }` when the port returns no target.
- Feeds bounded JSON observations/action outputs back into the continuation. Page text is untrusted tool data (`provenance: 'untrusted-page'`). Screenshot bytes and local artifact paths are not injected.
- Preserves cancellation, elapsed, and tool-call budgets. Unknown-effect / failed / blocked action outcomes are `isError` tool results and are never treated as successful actions or auto-replayed.
- Reuses the compiled definition policy plus a narrowed `ExecutionPolicySnapshot` of granted browser tools/capabilities/effects. Approval still goes through `prepareTrustedToolDispatch` / `host.approveToolRequest`. This does not enable allow-all policy.

## Admission (`runtimePolicy` + Agent Editor)

`collectUnsupportedRuntimeSettings` no longer rejects every non-disabled browser mode. Effective checks:

| Condition | Pointer | Result |
|---|---|---|
| CLI runtime kind + any browser mode | `/settings/browser/mode` | Unsupported. CLI adapters do not dispatch these tools. |
| Native + mode enabled + no injected port | `/settings/browser/mode` | Unsupported **before provider dispatch**. |
| Native + `hybrid` / `native` | `/settings/browser/mode` | Unsupported. Only `structured` is implemented here. |
| Native + `workspaceId` | `/settings/browser/workspaceId` | Unsupported. Persistent workspaces are not implemented. Attached tabs keep existing storage. |
| Native + `traceRetention !== 'none'` | `/settings/browser/traceRetention` | Unsupported. |

`disabled` remains a harmless default. `MmsAgentExecutionService` puts the injected port on the trusted host object so `assertRuntimeSettingsSupported` and `runAgentDefinition` see the same binding.

## Main-agent seam

`OrchestratorService.setMainAgentBrowserExecution(binding)` is the trusted GUI-chat setter. Root must supply `execution` (profile/thread/turn/cancellation/source) and a policy snapshot of resolved grants. The GUI send path passes that binding per turn. Scheduled and channel turns do **not** inherit it — unattended sources need their own binding with `source: 'cli' | 'schedule' | 'channel'` if root enables them later.

Do not infer a tab, profile, or browser owner from model text.

## Field policy / editor catalog

The eight tools are in `MOUSSE_BUILTIN_TOOLS` under group `browser`, so Settings and definition allowlists can grant them. Catalog membership is not enablement:

- Native dispatch still requires `browser.mode === 'structured'`, an injected `BrowserRuntimePort`, a trusted execution binding, and a grant.
- Profile lookup only grants tools that are on `settings.integrations.tools.enabledTools`.
- Default inherit allowlists will include the new ids on fresh settings; this runtime still hides them until the host binding is present.
- Do not treat catalog presence as vision, computer-use, or persistent-workspace support.

## Image / vision

This loop is semantic-ref (B1) only. `BrowserExecutionBinding.vision` defaults to false, so screenshots and image-point actions fail at the existing dispatcher rules. Image continuation is **not** implemented here: tool results stay text JSON with artifact ids, not `image` blocks or `file://` URLs. Exact provider computer-use adapters remain a separate binding.

## Root composition after merge

1. Adapt `MmsBrowserService` to `BrowserRuntimePort` (`resolveTarget` from the selected GUI tab or managed default; `dispatch` through `BrowserToolDispatcher.invoke`, throwing or mapping `ok: false` to an error with the worker `code`).
2. Call `orchestrator.setBrowserRuntime(port)` and `platform.agentRuns.setBrowserRuntime(port)`.
3. For the existing-tab demo, keep GUI selection as `electron-attached` + `uiTabId`. Do not fall back to managed Chromium on attached failure.
4. For main-agent chat, also call `setMainAgentBrowserExecution` with the turn's `ExecutionContext` and policy snapshot before `send`.
5. Keep Agent Editor definitions on `browser.mode = 'structured'`, no `workspaceId`, `traceRetention: 'none'`, and an explicit grant of the tools you want advertised.

## Validation

- `tests/platformNativeBrowserRuntime.test.ts` — scripted local provider, injected recording port, open/observe/act continuation, host-missing, settings-disabled, forged target args, budgets, pre-aborted cancellation, unknown-effect, ask_user still advertised, CLI/persistent limitations.
- `tests/platformAgentRuntimePolicy.test.ts` — structured + injected port is no longer a browser admission failure; native/hybrid still is.
- `tests/platformAgentProductionExecution.test.ts` — framed Agent Editor Try Run with `setBrowserRuntime` on both owners.

No live providers, accounts, or browser downloads.
