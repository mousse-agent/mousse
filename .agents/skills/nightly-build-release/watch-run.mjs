#!/usr/bin/env node
// Waits on a GitHub Actions run and exits as soon as one of its jobs finishes that an
// earlier call has not reported, or when the whole run ends. Each call prints the newly
// finished jobs, the run's state and the jobs still going, so the caller can post an
// update and start it again. Reported jobs are kept in a file in the temp folder.
//
//   node .agents/skills/nightly-build-release/watch-run.mjs <run id> [poll seconds]
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [run, pollArg] = process.argv.slice(2)
if (!/^\d+$/.test(run ?? '')) {
  console.error('Usage: watch-run.mjs <run id> [poll seconds]')
  process.exit(2)
}
const pollMs = Number(pollArg ?? 30) * 1000
const seenFile = join(tmpdir(), `mousse-run-${run}.seen`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const view = () => JSON.parse(execFileSync('gh', ['run', 'view', run, '--json', 'status,conclusion,jobs'], { encoding: 'utf8' }))
const line = (job) => `${job.conclusion || job.status}\t${job.name}`

for (;;) {
  let data
  try {
    data = view()
  } catch {
    await sleep(pollMs)
    continue
  }
  const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : [])
  const finished = data.jobs.filter((job) => job.status === 'completed' && !seen.has(job.name))
  const ended = data.status === 'completed'
  if (finished.length > 0 || ended) {
    if (finished.length > 0) appendFileSync(seenFile, finished.map((job) => `${job.name}\n`).join(''))
    console.log('FINISHED:')
    for (const job of finished) console.log(line(job))
    console.log(`RUN: ${data.status} ${data.conclusion ?? ''}`.trimEnd())
    console.log('STILL GOING:')
    for (const job of data.jobs.filter((job) => job.status !== 'completed')) console.log(line(job))
    process.exit(0)
  }
  await sleep(pollMs)
}
