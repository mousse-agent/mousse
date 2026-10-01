# Q03 / BR-02 browser evaluation

- Run kind: **fixture-only**
- Model quality: **unavailable**
- Source: `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8`
- Browser: 153.0.8010.36 (sibling-core-read-only)
- Tool schema: v1
- Prompt: mousse-browser-eval-v1
- Task seed: 20260911
- Reference machine: win32/x64 Node v22.23.2 cpus=12
- BrowserGym pin: browsergym-core 0.14.3 release 0a785fbed075224ae81ca9c1fe924f66050696fe; later inspected snapshot 9e779f087de9a65668b6974d11f9ce9816026e96

## Metrics

- Supported executor action success: 100.0% (14/14) Wilson95 [0.785, 1.000]
- Supported task success: 100.0% (6/6) Wilson95 [0.610, 1.000]
- False success: 0
- Duplicate effects: 0
- Human interventions: 0
- Retries: 1
- Recovery trials: 1
- Explicit unsupported cases: 1
- Observation latency median/p95 ms: 583.835500000001 / 603.5113000000006
- Executor overhead median/p95 ms: 585.7484500000003 / 604.6590250000008
- Cost tokens/images: null/unavailable / null/unavailable (No live model ran; token and image cost are unknown, not zero)
- Max RSS bytes: 107622400

## Gates

- Executor ≥99%: true
- Task ≥90%: true
- Zero false-success: true
- Zero duplicate effects: true
- Executor point estimate is 100.0% but the Wilson 95% lower bound 0.785 is below 0.99 at n=14.
- Task point estimate is 100.0% but the Wilson 95% lower bound 0.610 is below 0.90 at n=6.
- Model quality is reported separately and is not mixed into executor success.
- Unsupported cases are excluded from the supported-action denominator.

## External benchmark

- Protocol: browsergym-core-0.14.3
- Adapter implemented: true
- Full BrowserGym environment available: false
- Native fixture score claimed: false
- Native fixture adapter results are not a BrowserGym MiniWoB/WebArena leaderboard score.

### Missing environment

- Python interpreter with browsergym-core==0.14.3 is not installed in this worktree
- Official MiniWoB/WebArena/WorkArena task servers and datasets are not provisioned
- BrowserGym's Playwright page cannot be the Mousse action executor; Mousse actions use BrowserToolDispatcher/CDP
- A shared CDP target between Playwright observation and Mousse actions is not composed in this package

### External run command (not executed here)

```sh
python -m pip install browsergym-core==0.14.3 gymnasium
python -m pip install browsergym-miniwob==0.14.3
playwright install chromium
python -c "import gymnasium as gym, browsergym.miniwob; env=gym.make('browsergym/miniwob.click-test'); obs,info=env.reset(seed=0); print(sorted(obs)); env.close()"
```

## Trials

| Task | Split | Support | Mode | Driver | Success | False | Duplicate | Notes |
|---|---|---|---|---|---|---|---|---|
| forms.fill-save | calibration | supported | structured | executor-script | true | false | false | form saved |
| forms.fill-save | calibration | supported | hybrid | executor-script | true | false | false | form saved |
| forms.fill-save | calibration | supported | screenshot | executor-script | true | false | false | form saved |
| files.download | held-out | supported | structured | executor-script | true | false | false | download published |
| recovery.stale-no-replay | held-out | supported | structured | executor-script | true | false | false | stale replay refused; one submit |
| lists.virtualized | held-out | supported | structured | executor-script | true | false | false | picked virtualized item 12 |
| live-model.refused | held-out | unsupported | hybrid | live-model | false | false | false | Live-model quality is unavailable in this Q03 run; no paid calls were placed. |
