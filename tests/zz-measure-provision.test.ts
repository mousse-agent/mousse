import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const LOG: string[] = []
;(globalThis as any).__gitLog = LOG
const short = (a: unknown[]) => (a as string[]).filter((x) => typeof x === 'string').filter((x, i, all) => !(x === '-c' || all[i - 1] === '-c')).join(' ').slice(0, 160)
for (const name of ['spawn', 'execFile'] as const) {
  const orig = (cp as any)[name]
  ;(cp as any)[name] = function (file: string, args: unknown[], ...rest: unknown[]) {
    if (/git/i.test(String(file)) && process.env.TRACE2) { const o = rest.find((x: any) => x && typeof x === 'object' && 'env' in x) as any; if (o?.env) o.env = { ...o.env, GIT_TRACE2_PERF: process.env.TRACE2 } }
    const t = performance.now(); const child = orig.call(this, file, args, ...rest); const blocked = performance.now() - t
    if (/git/i.test(String(file))) child.once('exit', () => LOG.push(`${Math.round(performance.now() - t)}ms (spawn ${Math.round(blocked)}) ${short(args ?? [])}`))
    return child
  }
}
for (const name of ['spawnSync', 'execFileSync'] as const) {
  const orig = (cp as any)[name]
  ;(cp as any)[name] = function (file: string, args: unknown[], ...rest: unknown[]) {
    const t = performance.now(); try { return orig.call(this, file, args, ...rest) } finally { if (/git/i.test(String(file))) LOG.push(`SYNC ${Math.round(performance.now() - t)}ms ${short(args ?? [])}`) }
  }
}
syncBuiltinESMExports()
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { inTurnBoundary, turnBoundaryMark } from '../src/mms/diagnostics/turnBoundary'
import { openRepositoryFacts, closeRepositoryFacts, withRepositoryFactsScope } from '../src/mms/git/repositoryFacts'

const REPO = process.env.MEASURE_REPO ?? 'J:/tmp/wtperf/repo'
const OUT = process.env.MEASURE_OUT ?? 'J:/tmp/wtperf/out'
const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }

it('measures a new thread worktree and its first snapshot', async () => {
  const runs = Number(process.env.MEASURE_RUNS ?? 2)
  for (let run = 0; run < runs; run++) {
    const id = `measure-${Date.now()}-${run}`
    const threadDir = join(OUT, 'threads', id); mkdirSync(threadDir, { recursive: true })
    const lines: string[] = []
    await withRepositoryFactsScope(() => inTurnBoundary({ threadId: id }, async () => {
      const t0 = performance.now()
      const ws = await new WorkspaceResolver(threadDir, id, REPO, 'worktree').resolve('agent', 'main', undefined, undefined, undefined, (step) => lines.push(`step ${step} at ${Math.round(performance.now() - t0)}`))
      turnBoundaryMark(id, 'workspace')
      const t1 = performance.now(); lines.push('--- provision git:', ...LOG.splice(0)); 
      openRepositoryFacts()
      const recorded = await new ThreadActionService(threadDir).recordOutsideChanges({ threadId: id, conversationBranchId: 'main', workspacePath: ws.workspacePath!, presentationMessageStart: 0, nativeContextBoundary: boundary })
      turnBoundaryMark(id, 'startCheck')
      closeRepositoryFacts()
      const t2 = performance.now(); lines.push('--- snapshot git:', ...LOG.splice(0)); 
      lines.push(`run ${run}: provision ${Math.round(t1 - t0)} ms, first snapshot ${Math.round(t2 - t1)} ms, start ${recorded.startSha}`)
      const again = async (label: string) => {
        const a = performance.now(); openRepositoryFacts()
        await new ThreadActionService(threadDir).recordOutsideChanges({ threadId: id, conversationBranchId: 'main', workspacePath: ws.workspacePath!, presentationMessageStart: 0, nativeContextBoundary: boundary })
        closeRepositoryFacts(); turnBoundaryMark(id, label)
        lines.push(`--- ${label} git:`, ...LOG.splice(0), `${label}: ${Math.round(performance.now() - a)} ms`)
      }
      await again('unchangedSnapshot')
      const { readdirSync, readFileSync } = await import('node:fs')
      const dir = join(ws.workspacePath!, 'src', 'mms', 'actions')
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts')).slice(0, 20)) writeFileSync(join(dir, name), readFileSync(join(dir, name), 'utf8') + '\n// edit\n')
      mkdirSync(join(ws.workspacePath!, 'scratch'), { recursive: true })
      for (let i = 0; i < 5; i++) writeFileSync(join(ws.workspacePath!, 'scratch', `new${i}.txt`), `new ${i}\n`)
      await again('editedSnapshot')
    }, (line) => lines.push(line)))
    appendFileSync(join(OUT, 'measure.log'), lines.join('\n') + '\n')
    console.log(lines.join('\n'))
  }
}, 900_000)
