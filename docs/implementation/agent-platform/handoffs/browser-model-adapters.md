# M03 browser model adapters handoff

Implementation date: 2026-09-11. This handoff covers the additive M03 model adapter package in `src/mms/browser/modelAdapters/**`, its public contracts in `src/shared/browser/modelAdapters.ts`, deterministic schema fixtures, and the real managed-Chromium qualification in `tests/platformBrowserModelAdapters.test.ts`.

The package exposes these composition APIs:

```ts
import {
  anthropicComputerAdapter,
  browserModelCapabilities,
  executeOrderedCall,
  getBrowserModelCapability,
  googleComputerAdapter,
  openAiComputerAdapter
} from './src/mms/browser/modelAdapters'
```

`BrowserModelAdapter.buildRequest` only builds a provider JSON envelope. `decodeResponse` returns a `BrowserModelCall` with every provider call ID/name in order, ordered common actions, safety decisions, and continuation state. OpenAI follows the installed Responses schema's singular `action` per `computer_call`; multiple calls remain ordered and receive one result each. Coordinate actions require the exact observation used for the provider image; the adapter converts viewport or normalized coordinates once into M01 screenshot pixels, applying `cssToImageScale*` and `cropOriginCss`, and rejects missing or invalid geometry. `encodeResult` handles one call and `encodeResults` preserves multi-call result cardinality. `executeOrderedCall` is the host loop: pass it an adapter call and a callback that invokes the already-authorized M01 `BrowserToolDispatcher`; it stops before later actions on cancellation, approval/block, failure, or unknown effect. Pending provider safety checks are never placed into the acknowledged continuation set; only a host-approved continuation can acknowledge them. The adapter never owns a browser session, provider credential, CDP transport, or arbitrary code path.

The host callback must bind each common action to the current profile/thread/run context, exact observation ID, control lease, and policy. For `kind: 'action'`, call `browser_act` with the action and fresh session metadata. For `kind: 'keyboard-type'` and `kind: 'keypress'`, the host maps the bounded keyboard operation to the existing browser action surface. For `screenshot` and `wait`, the host calls `browser_observe` or `browser_wait` and returns bounded evidence. A provider safety decision must be routed through the existing approval service; the reducer will not execute a required or blocked action.

Capability records currently publish:

| Provider/model record | Tier | Status | Coordinate convention | Qualification |
| --- | --- | --- | --- | --- |
| `mousse-generic-tool-loop` | B1 | Experimental | semantic refs | Existing M01 structured dispatcher contract; no exact model evaluation |
| `mousse-generic-vision-tool-loop` | B2 | Experimental | screenshot pixels, top-left | Host must attach exact screenshot geometry |
| `computer-use-preview` | B3 | Experimental | screenshot pixels, top-left | OpenAI Responses `computer-preview` tool envelope |
| `claude-sonnet-4-6` | B3 | Experimental | viewport pixels, top-left | Anthropic `computer_20251124` beta Messages envelope |
| `gemini-3.8-flash` | B3 | Experimental | normalized 1000 by 1000 | Gemini Interactions `computer_use` function loop |

Unknown provider/model pairs resolve to B0/unavailable and must keep browser tools hidden. Every current positive record remains experimental because this work uses deterministic schema fixtures and a local managed-Chromium executor; no exact model/provider evaluation or paid/live provider call is claimed. Native coordinate actions require a screenshot/viewport observation and are rejected when geometry is stale or missing. Provider-generated calls are requests, not evidence that an action ran. Missing provider IDs, malformed safety decisions, oversized arrays, and oversized screenshots fail closed.

Schema sources and installed package evidence reviewed on 2026-09-11:

- OpenAI computer-use guide: https://developers.openai.com/api/docs/guides/tools-computer-use
- Installed `openai` 4.104.0 `responses.ts`: `computer-preview`, `computer_call`, `computer_call_output`, pending and acknowledged safety checks.
- Installed `@anthropic-ai/sdk` 0.91.1 beta types: `computer_20241022`, `computer_20250124`, and `computer_20251124` tool definitions plus `tool_use`/`tool_result` blocks.
- Gemini Computer Use guide: https://ai.google.dev/gemini-api/docs/computer-use
- Installed `@google/genai` 1.52.0 is available transitively through the pinned Pi package; M03 uses plain JSON envelopes so root's provider client remains the SDK boundary.

Validation performed:

- `npm run typecheck`
- `npx vitest run tests/platformBrowserModelAdapters.test.ts --maxWorkers=2 --minWorkers=1` (5 passed, including a real managed Chromium batch and exactly one fixture POST; the real case is explicitly skipped if the certified browser prerequisite is unavailable)

Root composition remains responsible for selecting a catalog record, binding the adapter to `LlmClient`, wiring the host callback to M01 `BrowserToolDispatcher`, and persisting provider continuation state. This package does not edit `BrowserBroker`, viewer, automation, runtime CLI, protocol, or MMS composition files.
