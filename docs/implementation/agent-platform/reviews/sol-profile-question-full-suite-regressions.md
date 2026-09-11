# Profile cleanup and question full-suite regression review

## Baseline and implementation

- Baseline: `109bc15a6182996a48d94e57fbf9de629f56c998`, including root setup composition `06af7cf7805d8349f4b3c35bbbf7b1cccc771a81`.
- Implementation: `cdbfb67672734a56989080dc845f158b1f8b0129`.

## Findings and fixes

- The Phase 4 protocol tests created pending questions in the legacy process-wide fallback while production protocol handlers read the profile-owned `MmsProfileServices.questions` instance. The assertions failed and the orphaned fallback promises produced two unhandled rejections during teardown. The fixtures now create, inspect, answer, dismiss, and interrupt questions through the actual profile-owned service.
- The profile cleanup fixture invoked the current `MmsProfileServices.stop` implementation on an obsolete shape that lacked the admission barrier and newer owned services. It now represents the current lifecycle contract and verifies the retained profile state after failure.
- Production `finishStop` invoked shutdown methods while constructing the input to `Promise.allSettled`. A synchronous failure therefore prevented every later service from receiving shutdown. Each cleanup is now invoked inside its own promise; all owners are attempted and failures remain aggregated. Configuration watching and the started/stopped state only commit after a fully successful drain.

## Evidence

- `npx vitest run tests/platformProfileStoreInjection.test.ts --maxWorkers=1 --testTimeout=30000`: 9 passed.
- Focused Phase 4 question cases (`pending question`, visible answer, visible dismissal, restart interruption, snapshot): 5 passed, 7 unrelated cases skipped, with no unhandled rejection.
- `npx vitest run tests/platformOwnedWorkLifecycle.test.ts --maxWorkers=1 --testTimeout=30000`: 6 passed.
- `npx vitest run tests/composerQuestions.test.ts --maxWorkers=1 --testTimeout=30000`: 4 passed.
- `npm run typecheck`: node and web TypeScript passed.
- `git diff --check`: passed.

## Limits

- Pending questions remain process-memory-only by design. Profile shutdown and daemon restart reject them rather than claiming they can be resumed.
- The process-wide `userQuestionService` remains as an explicit fallback for isolated `LlmClient` construction. Production profile services inject their own instance and protocol requests never use that fallback.
