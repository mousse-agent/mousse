# Sol review: workflow background ingress

Reviewed candidate: `d680e2d`

## Result

Qualified after fixes to four durability boundaries:

- Channel workflow commands now require the adapter's stable message ID. A missing ID is never replaced by a process-local UUID, so a redelivery cannot create a second receipt. Ordinary non-slash prompts still use the existing model path.
- Aborting channel observation after graph admission no longer cancels the durable run. Abort before admission still fails closed; `/stop` after admission only stops observation and delivery.
- Scheduled workflow claims persist the exact workflow receipt ID before graph admission. A waiting occurrence does not advance the schedule or spend a finite repeat. Its next claim reuses the same occurrence and observes the same run until terminal; shutdown or process-death reconciliation preserves that resumable occurrence.
- Background observation reacquires the thread execution lease, reloads current thread data, and only then updates the matching workflow transcript message. It no longer writes a stale in-memory message list after releasing the admission lease.

The production tests include an actual `MousseMainService` stop/reconstruction and prove that redelivery of the same channel message returns the original revision-pinned run after a newer workflow head is published. They also cover the post-admission abort race and waiting scheduled occurrence finalization without repeat loss.

## Verification

- `npx vitest run tests/platformWorkflowBackgroundIngress.test.ts --maxWorkers=1 --reporter=dot` — 1 file, 4 tests passed.
- `npx vitest run tests/channels.test.ts tests/scheduledJobs.test.ts --maxWorkers=1 --reporter=dot` — 2 files, 49 tests passed.
- `npm run typecheck` — node and web TypeScript projects passed after the implementation changes.
- `npm run build:cli` — passed.
- `git diff --check` — passed with only expected LF-to-CRLF checkout notices.

No live channels, providers, accounts, or network calls were used.

## Reviewed limits

- A resumed scheduled wait is picked up on the next scheduler tick. The persisted `lastStatus` remains `waiting` until that terminal observation finishes.
- Channel transport remains at-least-once delivery: replaying an already completed message can deliver the same stored result again, but cannot create or dispatch another workflow run.
