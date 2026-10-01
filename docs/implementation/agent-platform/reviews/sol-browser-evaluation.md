# Sol review: Q03 browser evaluation harness

Date: 2026-09-11

Reviewed base: `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8`

Reviewed implementation: `ef80e6be511cc3ce17e023d1664d3460ea84ba38`

## Result

The harness is suitable for bounded executor conformance and local adapter development. It does not establish live-model quality or an external BrowserGym benchmark, so Q03 and the related release gate remain open.

The implementation runs typed browser operations through the production `BrowserToolDispatcher`, session manager, broker, worker, and certified Chrome. Task success comes from fixture server state or post-action observations. Fixture-oracle and executor scripts remain separate from the injectable HTTP model driver, and unavailable model cost is `null` rather than zero.

## Findings fixed

- Screenshot-only live-model requests previously always ran as hybrid and could expose element refs and semantic text. Model runs now honor the requested observation mode. Screenshot-only HTTP payloads retain screenshot/viewport metadata while stripping URL, title, tabs, elements, warnings, and refs. Every later model step obtains a fresh observation in the same mode. Executor-script screenshot trials are documented as scripted coordinate-path checks, not screenshot-only model ablations.
- The HTTP driver applied elapsed time per call and did not enforce cumulative token/image budgets. It now fences cumulative elapsed time, actions/tool calls, tokens, and images before returning an action. Bounded token/image runs stop when usage is absent. Usage fields are strict non-negative integers with no unknown keys.
- The model endpoint path was previously proven only through an injected fetch function. A test now uses a real loopback HTTP server, checks the pinned model/revision request, verifies strict image-point output and measured usage, and asserts semantic strings/refs never enter screenshot-only input.
- BrowserGym 0.14.3 was conflated with a later repository snapshot. Pins now identify PyPI 0.14.3 release commit `0a785fbed075224ae81ca9c1fe924f66050696fe`; `9e779f087de9a65668b6974d11f9ce9816026e96` is labeled as the later inspected snapshot.
- The checked-in sample is explicitly labeled as a six-task smoke sample rather than full-catalog evidence.

## Verification

```text
npx vitest run tests/platformBrowserEvaluation.test.ts --maxWorkers=2
16 tests passed

npm run typecheck
node and web TypeScript passed
```

A fresh single-repeat full-catalog executor run used all observation modes and the read-only certified Chrome:

```text
node scripts/evaluation/browser/run.mjs --mode executor --observation all --split all --repeats 1 --stress-cycles 2 --out C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\runtime\browser-evaluation-q03-full --research
```

Evidence: `C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\runtime\browser-evaluation-q03-full\report.json`.

The run covered all 15 catalog tasks in 20 trials: 16 supported trials and explicit closed-shadow, canvas, and overlay unsupported cases, plus the unavailable live-model record. It recorded 40/40 successful supported actions, 16/16 successful supported tasks, zero false successes, and zero duplicate effects. Wilson 95% lower bounds were 0.912 for actions and 0.806 for tasks, below the nominal 0.99/0.90 targets; the point-estimate gates must not be treated as statistically qualified from this run.

## Remaining qualification

- No live model or certified model endpoint ran. Model quality and real token/image cost remain unavailable.
- The BrowserGym implementation is a Mousse-native protocol adapter over local fixtures. `browsergym-core`, MiniWoB/WebArena/WorkArena, and a shared external environment were not installed or run, so it is not a BrowserGym leaderboard score.
- The full-catalog run used one repeat and reduced stress cycles. It establishes coverage and harness operation, not stable quality thresholds, long-duration resource limits, or release-grade confidence intervals.
- Screenshot-only HTTP projection is tested, but no visual model consumed the screenshot artifact. Screenshot-only task quality remains unmeasured.
- Human takeover, platform-specific behavior beyond the current Windows fixture host, and external benchmark reproducibility remain separate qualification work.

## Final compatibility and repeat run

Follow-up commit replaces the undeclared transitive `vite-node` executable with the declared Vite 7 programmatic SSR API. The entry uses an isolated temporary transform cache and awaits `runCli` and runtime cleanup directly. `node scripts/evaluation/browser/run.mjs --help` passed through this path.

The requested three-repeat full-catalog conformance run completed with all catalog rows retained: 50 total report rows, 46 supported trials, 145/145 supported actions, 44/46 supported tasks, zero false successes, zero duplicate effects, and four explicit unsupported rows. Navigation initial-observation races caused the two task failures (`navigation.basic` trial 2 and `navigation.race` trial 0); their zero-action failures remain in `runtime/browser-evaluation-q03-conformance-3/report.json`. Point estimates passed, while Wilson lower bounds remained below the targets (actions 0.974, tasks 0.855).

The harness now waits for production `document-ready` after `browser_open`. A five-repeat follow-up of both navigation tasks then passed 10/10 tasks and 15/15 actions; evidence is `runtime/browser-evaluation-q03-navigation-5/report.json`. This targeted confirmation does not replace or erase the full-catalog failure rows.
