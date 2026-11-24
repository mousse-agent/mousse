---
name: check-on-real-data
description: Prove a change to how threads are stored, synced, sized or read against copies of the real threads on this machine, not only made-up test data. Use for storage, sync, size-limit and performance changes. Read-only on `~/.mousse`.
---

# Check on real data

Tests build small, tidy threads. Real ones have hundreds of tool calls, big outputs, images, odd rows from older versions and years of history, and they break limits and queries that tests never reach. A thread of 485 messages could not open on a phone because its snapshot passed a 16,384-node bound that no test thread came near; 4 of the 107 threads on one machine had the same problem (#1045). Run this check before the PR of any change that touches how threads are stored, synced, sized or read, and put its numbers in the PR's Verification section.

## Where the data is

- Each thread: `~/.mousse/profiles/<profile>/thread-data/**/<thread id>/thread.db`. Messages are rows of the `items` table with `coll = 'm'`. Images and text over 64 KiB are files in the thread's `blobs/` folder, and their place in a row is an empty string.
- The Net database: `~/.mousse/profiles/<profile>/net/net.db`. It holds the request ledger (`net_executions`), display streams (`bridge_thread_streams`, `net_records`) and everything else Net keeps. It is the one database that grows with every device and thread.
- A user's thread you are asked about can also be read there (see `docs/thread-storage.md`).

Read `docs/thread-storage.md` for the behavioural contracts the change touches (what a thread database holds, images and large outputs, paging, measuring), not the whole file by habit.

Never write to `~/.mousse`. Read copies: [`real-threads.ts`](real-threads.ts) copies each `thread.db` (with its write-ahead log) to a temporary folder and yields its messages.

## 1. Same result, every thread

Write a throwaway script outside the repository that runs every real thread through the old code and the new code, and counts the differences. Run it with `npx tsx` from the task's worktree. Import the new code from the worktree and the old code from a detached worktree at the default branch, or a constant you compare against.

```ts
const { realThreads } = require('<worktree>/moostack/skills/check-on-real-data/real-threads')
const fresh = require('<worktree>/src/mms/...')
const before = require('<default-branch worktree>/src/mms/...')
let changed = 0, failedBefore = 0, failedNow = 0
for (const thread of realThreads()) { /* run both on thread.messages, compare, count */ }
console.log({ changed, failedBefore, failedNow })
```

Check every thread; correctness never samples. Print only aggregates: threads checked, ones that failed before, ones that fail now, ones whose result changed, plus a bounded size summary (`summarizeSizes` in `real-threads.ts`: count, min, median, p90, max and the few largest). Never print thread ids, folders, titles or per-thread lines; when a thread needs a closer look inside the script, label it anonymously ("largest #2"). A change that is meant to keep the result must show zero changes. One that is meant to fix a failure shows how many threads it fixes.

## 2. Time and memory

- Time the old and new code on the 3 to 5 largest real threads plus representative shapes: the median thread, the smallest, one with images or blobs, and one written by an older version (`pickForTiming` picks the first three kinds). Report the median of several runs, warm and cold, as one line per label. For a cold read, copy the database to a new file and drop it from the page cache first (`dd if=<copy> iflag=nocache count=0`).
- Note the process's peak memory (`/usr/bin/time -v`) when the change builds whole threads or snapshots in memory.
- A migration that adds an index or rewrites rows runs at startup on every user's database: time it on the largest real copy you have and on copies in each older shape the migration handles, and say how long the first start takes.

## 3. Query plans

A new index can make SQLite pick a worse plan for a query that already existed. For a query on `net.db`, or one that runs on every open or send, add a test that reads `EXPLAIN QUERY PLAN` and fails when the expected index is not used (as `tests/net/sync/ledgerPruning.test.ts` does).

## What not to do

- Do not commit real data, thread ids, transcripts or check scripts. Report numbers only: aggregates and anonymous labels, no identifiers, folders or per-thread lines.
- Do not use this in place of tests. Turn each failure it finds into a small test with made-up data that has the same shape.
