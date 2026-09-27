import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { browserWorkerEnvironment } from '../src/mms/browser/workerEnvironment'
import { inspectChromeSource } from './fixtures/browser/evaluation/chrome'

describe.skipIf(process.platform !== 'win32')('Windows browser worker network sandbox', () => {
  it('starts the network service sandboxed through the actual stripped child environment', async () => {
    const chrome = inspectChromeSource()
    if (!chrome.ok) throw new Error(chrome.message)
    const directory = await mkdtemp(join(tmpdir(), 'mousse-network-sandbox-test-'))
    try {
      const outfile = join(directory, 'probe.mjs')
      await build({ entryPoints: [resolve('tests/fixtures/browser/network-sandbox-probe.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
      const { stdout } = await promisify(execFile)(process.execPath, [outfile, chrome.browserRoot, directory], { env: browserWorkerEnvironment(), windowsHide: true, timeout: 45_000 })
      const report = JSON.parse(stdout) as { failedLaunchMajorVersion: number; result: { histograms: Array<{ name: string; buckets: Array<{ low: number; count: number }> }> } }
      expect(report.failedLaunchMajorVersion).toBe(0)
      expect(report.result.histograms.some(item => /LaunchFailed|EarlyLaunchCrashed/.test(item.name))).toBe(false)
      const state = report.result.histograms.find(item => item.name.endsWith('.NetworkSandboxState'))
      expect(state?.buckets.length).toBeGreaterThan(0)
      expect(state?.buckets.every(bucket => bucket.low === 1 && bucket.count > 0)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  }, 60_000)
})
