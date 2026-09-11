# Q03 / BR-02 browser evaluation

Reproducible harness for Mousse's own browser executor. It does **not** drive Mousse actions with Playwright or Puppeteer, does **not** treat fixture-oracle scripts as live-model quality, and does **not** download Chrome.

## Run

From the worktree root (no `package.json` change required):

```sh
node scripts/evaluation/browser/run.mjs --mode all --observation structured --repeats 3 --stress-cycles 20
```

Useful flags: `--mode executor|browsergym|all`, `--observation structured|screenshot|hybrid|all`, `--split calibration|held-out|all`, `--repeats N`, `--stress-cycles N`, `--seed N`, `--task-ids id1,id2`, `--out DIR`, and `--research`. Conformance mode exits nonzero when a required gate fails; `--research` keeps exploratory runs usable while preserving failed gates in the report.

The checked-in `samples/` report is a bounded six-task smoke sample. It is not the full catalog result or a release gate.

Chrome is the certified binary at sibling `core/.mousse-dev/browser-binaries`, used read-only. Session, user-data, and artifact roots are unique temp trees. The cached core user-data/journals/locks are never written.

## Layers

1. **Executor conformance** — recorded typed actions on local fixture pages through `BrowserToolDispatcher` → `BrowserSessionManager` → `BrowserBroker` → worker CDP.
2. **Observation adapters** — structured, screenshot, and hybrid `browser_observe` / targeting. Executor-script screenshot trials use catalog semantics to choose fixture actions and therefore are not a screenshot-only model ablation. Live-model screenshot input strips URLs, titles, tabs, elements, and semantic refs before the HTTP call.
3. **Model driver** — fixed model/revision/budget interface. Fixture-oracle is labeled `fixture-oracle`. Live-model is refused in this task (no credentials, no paid calls). Cost is `null` / `unavailable`, never a fake 0.
4. **BrowserGym adapter** — gymnasium `reset` / `step(action: str)` / `close` with pinned observation keys and high-level actions from `browsergym-core==0.14.3` (release commit `0a785fbed075224ae81ca9c1fe924f66050696fe`). GitHub commit `9e779f087de9a65668b6974d11f9ce9816026e96` is a later inspected repository snapshot. Actions execute on Mousse's executor, not Playwright.

## External BrowserGym environment

This worktree does not ship MiniWoB, WebArena, WorkArena, or Playwright as the Mousse action backend. Native protocol fixtures are **not** a BrowserGym leaderboard score.

Exact external command once the environment exists:

```sh
python -m pip install browsergym-core==0.14.3 gymnasium
python -m pip install browsergym-miniwob==0.14.3
playwright install chromium
python -c "import gymnasium as gym, browsergym.miniwob; env=gym.make('browsergym/miniwob.click-test'); obs,info=env.reset(seed=0); print(sorted(obs)); env.close()"
```

Mousse must still execute mapped actions through its own CDP executor. Sharing Playwright's page as the Mousse action backend is unsupported.

## Tests

```sh
npx vitest run tests/platformBrowserEvaluation.test.ts --maxWorkers=2 --minWorkers=1
```
