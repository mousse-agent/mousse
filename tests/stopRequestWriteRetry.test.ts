/**
 * A stop request is written even while another process has the previous one open (Windows refuses to replace an
 * open file for a moment), and no temporary file is left in the home.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { getMmsStopRequestPath, readStopRequest, writeStopRequest } from '../src/cli/mmsRuntime'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** Holds `path` open without delete sharing for `ms`, then lets go. Resolves once it holds the file. */
function holdOpen(path: string, ms: number): Promise<void> {
  const script = `$f = [System.IO.File]::Open('${path.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Write-Output held; Start-Sleep -Milliseconds ${ms}; $f.Close()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => { if (data.toString().includes('held')) resolve() })
    child.on('error', reject)
  })
}

it.runIf(process.platform === 'win32')('writes a stop request while the previous one is held open for a moment, leaving no temporary file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-stop-request-'))
  homes.push(home)
  writeFileSync(getMmsStopRequestPath(home, 'token-a'), JSON.stringify({ token: 'token-a', requestedAt: new Date(0).toISOString() }))
  await holdOpen(getMmsStopRequestPath(home, 'token-a'), 100)
  writeStopRequest(home, 'token-a')
  expect(new Date(readStopRequest(home, 'token-a')!.requestedAt).getTime()).toBeGreaterThan(0)
  expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([])
  expect(existsSync(getMmsStopRequestPath(home, 'token-a'))).toBe(true)
}, 30_000)
