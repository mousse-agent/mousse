# Sol review: native browser model adapters

Reviewed base: `8f9e4af8fe9ca8bfb00da16e06eac5cacee96aa3`

Candidate head: `b534cc38e042cbd3a7cb8365193631db5f92759d`

Integration merge: `6ec461b`

Review fix: `26e452c`

## Findings fixed

- The OpenAI decoder and all fixtures used an `actions` array inside one `computer_call`. Installed OpenAI `4.104.0` types and the primary Responses reference define one singular `action`; batching is represented by multiple ordered `computer_call` output items. Decoding, fixtures, result cardinality, and the real two-call Chromium case now follow that schema.
- OpenAI continuations copied every pending safety-check ID into `acknowledgedSafetyCheckIds` before the host approved anything. Pending decisions are now kept separate; only a host-supplied approved continuation can generate `acknowledged_safety_checks`.
- Provider result encoders did not consistently validate provider/call continuation identity, duplicate call IDs, or excess results. OpenAI, Anthropic, and Gemini now reject mismatches and ambiguous IDs; the OpenAI encoder enforces one result per decoded call.
- Unknown OpenAI click buttons silently became left-clicks. `back` and `forward` map explicitly; unknown values fail closed.
- Cancellation before the next action appended an `unknown-effect` result for an action that was never dispatched. The ordered executor now stops without fabricating an effect result while preserving already completed results.
- Gemini accepted a missing `steps`/`output` envelope as a normal no-call response. Malformed envelopes now fail closed.
- Screenshot result encoders accepted arbitrary data-URL media types. They now allow only bounded PNG, JPEG, or WebP raster images.
- The real Chromium test claimed to use the authorized M01 executor but sent its effect directly to `BrowserBroker`. It now invokes `BrowserToolDispatcher.browser_act` with the current generation, observation, control lease, context, policy, and tool budget. The fixture still observes exactly one HTTP submit.
- Test profile labels failed the stricter reviewed M01 profile identity contract. They now use canonical UUIDs.
- The synthetic B1 catalog row was marked Available without an exact model evaluation. All positive rows are now Experimental; unknown provider/model pairs remain B0/Unavailable.

Primary schema checks used the installed SDK sources plus the current [OpenAI Responses API reference](https://platform.openai.com/docs/api-reference/responses) and [Gemini Computer Use guide](https://ai.google.dev/gemini-api/docs/computer-use). Google's guide confirms one `function_result` per parallel call and the `previous_interaction_id` continuation pattern. The installed Google SDK does not expose this current Interactions computer-use schema, so its adapter remains plain-JSON and experimental.

## Evidence

```text
npx vitest run tests/platformBrowserModelAdapters.test.ts --maxWorkers=2 --reporter=dot
  1 file, 5 tests passed, including real managed Chromium and exactly one local HTTP submit
npx vitest run tests/platformBrowserModelAdapters.test.ts tests/platformBrowserAutomation.test.ts tests/platformBrowserContracts.test.ts --maxWorkers=2 --reporter=dot
  3 files, 19 tests passed
npm run typecheck
  passed
npm run build:cli
  passed
```

The five M03 cases contain many assertions but remain a narrow qualification set. They establish deterministic envelope parsing/encoding, coordinate conversion, safety blocking, ordered stop behavior, capability labeling, and one policy-authorized local Chromium batch. They do not establish provider behavior.

## Remaining work and limits

- No live or paid provider request was made. Exact model revisions have not passed repeated seeded B1/B2/B3 task evaluations, so no positive capability record is Available.
- Production selection, provider requests, continuation persistence, approval binding, fresh-observation advancement, retry/unknown-effect journaling, and the M01 dispatcher callback remain root composition work.
- The Anthropic schema is derived from installed beta tool declarations and deterministic `tool_use`/`tool_result` fixtures; no actual beta Messages loop was run.
- The Google Interactions shape is based on primary documentation because installed `@google/genai` lacks the current typed surface. Official schema drift must keep this record experimental or unavailable.
- Request prompts, provider response frames, screenshots, and action results still require outer protocol/model token, byte, and elapsed budgets. This adapter layer bounds arrays, strings used as actions, and encoded image URLs but does not own the full provider transport budget.
- Provider-native prompt-injection and safety signals must enter the durable host approval policy. This package only preserves and blocks on decoded decisions; it cannot authorize acknowledgement.
- The local executor handles common mapped actions. Unsupported provider-native actions remain fail-closed and require explicit conformance work.

M03 remains an experimental adapter seam. No browser capability or release gate closes from these deterministic fixtures.
