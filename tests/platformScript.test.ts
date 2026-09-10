import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptRunner } from '../src/mms/execution/ScriptRunner'
import { UnconfiguredSandboxAdapter, isSandboxUnavailable } from '../src/mms/execution/SandboxAdapter'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('ScriptRunner', () => {
  it('spawns node with argv, JSON stdin/stdout, and bounded output', async () => {
    const dir = tempDir('mousse-script-')
    const script = join(dir, 'echo.mjs')
    writeFileSync(
      script,
      'let s=""; for await (const c of process.stdin) s+=c; const j=JSON.parse(s); process.stdout.write(JSON.stringify({ok:true,n:j.n,argv:process.argv.slice(2)}));\n'
    )
    const runner = new ScriptRunner()
    const result = await runner.run({
      runtime: 'node',
      scriptPath: script,
      scriptHash: 'x',
      argv: ['--flag'],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      stdin: JSON.stringify({ n: 3 }),
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 1024,
      signal: new AbortController().signal
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, n: 3, argv: ['--flag'] })
  })

  it('aborts an owned child process', async () => {
    const dir = tempDir('mousse-script-abort-')
    const script = join(dir, 'sleep.mjs')
    writeFileSync(script, 'await new Promise((r) => setTimeout(r, 30000))\n')
    const runner = new ScriptRunner()
    const controller = new AbortController()
    const pending = runner.run({
      runtime: 'node',
      scriptPath: script,
      scriptHash: 'x',
      argv: [],
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      stdin: '{}',
      timeoutMs: 20_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 80)
    const result = await pending
    expect(result.exitCode === 0).toBe(false)
  })

  it('fails closed when sandboxed mode has no backend', async () => {
    const adapter = new UnconfiguredSandboxAdapter()
    await expect(
      adapter.execute({
        runtime: 'node',
        scriptPath: 'x.mjs',
        scriptHash: 'x',
        argv: [],
        cwd: tempDir('s-'),
        env: {},
        stdin: '{}',
        timeoutMs: 10,
        maxStdoutBytes: 10,
        maxStderrBytes: 10,
        signal: new AbortController().signal
      })
    ).rejects.toSatisfy((error: unknown) => isSandboxUnavailable(error))
  })
})

void mkdirSync
