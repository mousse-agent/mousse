import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { certifiedInstallDir, certifiedMetadataPath } from '../src/browser-worker/binary/resolver'
import {
  createEvaluationRuntime,
  createHttpModelDriver,
  inspectChromeSource,
  runModelSuite,
  runNativeBrowserGymTask,
  nativeGymTasks,
  startEvaluationSite
} from './fixtures/browser/evaluation'
import { DEFAULT_BUDGETS } from './fixtures/browser/evaluation/pin'
import { haystack } from './fixtures/browser/evaluation/observations'
import type { TaskTrialResult } from './fixtures/browser/evaluation/types'

function readOnlyTreeSnapshot(root: string): string[] {
  const visit = (directory: string, prefix = ''): string[] => readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    const stat = lstatSync(path)
    const digest = !stat.isDirectory() && name === 'metadata.json'
      ? `:${createHash('sha256').update(readFileSync(path)).digest('hex')}` : ''
    const key = `${prefix}${name}:${stat.isDirectory() ? 'd' : 'f'}:${stat.size}${digest}`
    return stat.isDirectory() ? [key, ...visit(path, `${prefix}${name}/`)] : [key]
  })
  return visit(root).sort()
}

const chrome = inspectChromeSource()

describe.skipIf(!chrome.ok)('Q03 evaluation against the production executor', () => {
  const runtimes: Array<{ close(): Promise<void> }> = []
  let site: Awaited<ReturnType<typeof startEvaluationSite>> | undefined

  afterAll(async () => {
    while (runtimes.length) await runtimes.pop()!.close()
    await site?.close()
  })

  it('does not fabricate closed-shadow refs and maps a BrowserGym native form through the adapter', async () => {
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    const context = runtime.context(false, 'eval-closed')
    const opened = await runtime.tools.invoke('browser_open', { url: `${site.origin}/closed-shadow.html` }, context)
    expect(opened.ok).toBe(true)
    const observation = opened.ok ? opened.value.observation : undefined
    expect(haystack(observation)).toContain('page-idle')
    expect(runtime.broker.capabilityReport?.capabilities.closedShadowDom).toBe('unsupported')
    expect(haystack(observation)).not.toContain('page-leaked')
    const gym = await runNativeBrowserGymTask({
      runtime,
      origin: site.origin,
      task: nativeGymTasks()[0],
      seed: 7,
      actions: ["fill('Name', 'Ada')", "click('Save')"]
    })
    expect(gym.protocolKeys).toBe(true)
    expect(gym.lastError).toBe('')
    expect(gym.reward, JSON.stringify(gym.obs.axtree_object)).toBe(1)
  }, 180_000)

  it('uses a unique browser root and does not add files to the sibling core cache', async () => {
    if (!chrome.ok) throw new Error(chrome.message)
    const sourceRoot = realpathSync(chrome.browserRoot)
    const certifiedRoot = realpathSync(certifiedInstallDir(sourceRoot))
    const before = readOnlyTreeSnapshot(certifiedRoot)
    const metadataBefore = readFileSync(certifiedMetadataPath(sourceRoot))
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    expect(realpathSync(runtime.home).startsWith(sourceRoot)).toBe(false)
    const after = readOnlyTreeSnapshot(certifiedRoot)
    expect(after).toEqual(before)
    expect(readFileSync(certifiedMetadataPath(sourceRoot))).toEqual(metadataBefore)
    expect(chrome.ok && chrome.version).toBeTruthy()
  }, 60_000)

  it('runs every selected model task, mode, and repeat while reading bounded profile-owned screenshot bytes', async () => {
    site = site ?? await startEvaluationSite()
    const runtime = await createEvaluationRuntime()
    runtimes.push(runtime)
    const received: Array<Record<string, any>> = []
    const model = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        received.push(parsed)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          decision: { kind: 'unavailable', reason: 'fixture stops after inspecting input' },
          usage: { input_tokens: 2, output_tokens: 1, images: parsed.screenshot ? 1 : 0 }
        }))
      })
    })
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    let factories = 0
    let trials!: TaskTrialResult[]
    try {
      trials = await runModelSuite({
        runtime,
        site,
        driverFactory: () => {
          factories += 1
          return createHttpModelDriver({
            endpoint: `http://127.0.0.1:${(model.address() as AddressInfo).port}/decision`,
            modelId: 'local-fixture', revision: 'rev-all',
            budgets: { ...DEFAULT_BUDGETS, maxActions: 2, maxToolCalls: 2, maxImages: 2 }
          })
        },
        options: {
          taskIds: ['forms.fill-save', 'unsupported.canvas'],
          observationModes: ['structured', 'screenshot'],
          repeats: 2,
          seed: 41
        }
      })
    } finally {
      await new Promise<void>((resolve, reject) => model.close((error) => error ? reject(error) : resolve()))
    }
    expect(trials).toHaveLength(8)
    const failed = trials.filter((trial) => trial.taskId === 'forms.fill-save')
    expect(failed).toHaveLength(4)
    expect(failed.every((row) => !row.taskSuccess && Boolean(row.error))).toBe(true)
    const unsupported = trials.filter((trial) => trial.taskId === 'unsupported.canvas')
    expect(unsupported).toHaveLength(4)
    expect(unsupported.every((row) => row.unsupportedReported && row.support === 'unsupported')).toBe(true)
    expect(received).toHaveLength(4)
    expect(factories).toBe(4)
    expect(received.every((body) => body.stepIndex === 0)).toBe(true)
    expect(received.filter((body) => body.screenshot)).toHaveLength(2)
    for (const body of received.filter((item) => item.screenshot)) {
      const bytes = Buffer.from(body.screenshot.bytesBase64, 'base64')
      expect(bytes.byteLength).toBe(body.screenshot.byteLength)
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(body.screenshot.sha256)
      expect(body.observation.elements).toEqual([])
      expect(body.observation.tabs).toEqual([])
    }
  }, 180_000)

})
