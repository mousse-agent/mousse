import { cpus, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { BROWSER_CONTRACT_VERSION } from '../../../../src/shared/browser/types'
import type { EvaluationBudgets, PinRecord, ReferenceMachine } from './types'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '../../../..')
export const PIN_FILE = resolve(REPO_ROOT, 'scripts/evaluation/browser/pin.json')

export const PROMPT_ID = 'mousse-browser-eval-v1'
export const BROWSERGYM_PYPI_NAME = 'browsergym-core'
export const BROWSERGYM_PYPI_VERSION = '0.14.3'
export const BROWSERGYM_PYPI_RELEASE_COMMIT = '0a785fbed075224ae81ca9c1fe924f66050696fe'
export const BROWSERGYM_GITHUB_COMMIT = '9e779f087de9a65668b6974d11f9ce9816026e96'
export const BROWSERGYM_DOCS = 'https://browsergym.readthedocs.io/en/latest/'
export const BROWSERGYM_REPO = 'https://github.com/ServiceNow/BrowserGym'

export const DEFAULT_BUDGETS: EvaluationBudgets = {
  maxActions: 100,
  maxElapsedMs: 15 * 60_000,
  maxToolCalls: 120,
  maxTokens: null,
  maxImages: null
}

export function readStaticPin(): { sourceShaFallback: string; certifiedChromeVersion: string } {
  const raw = JSON.parse(readFileSync(PIN_FILE, 'utf8')) as {
    mousse: { sourceSha: string; certifiedChromeVersion: string }
  }
  return {
    sourceShaFallback: raw.mousse.sourceSha,
    certifiedChromeVersion: raw.mousse.certifiedChromeVersion
  }
}

export function gitSourceSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return readStaticPin().sourceShaFallback
  }
}

export function referenceMachine(): ReferenceMachine {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: cpus().length,
    osRelease: `${release()}`
  }
}

export function buildPin(input: {
  browserVersion: string
  browserSha256: string
  taskSeed: number
  budgets?: EvaluationBudgets
}): PinRecord {
  return {
    sourceSha: gitSourceSha(),
    browserVersion: input.browserVersion,
    browserSha256: input.browserSha256,
    toolSchemaVersion: BROWSER_CONTRACT_VERSION,
    promptId: PROMPT_ID,
    taskSeed: input.taskSeed,
    budgets: input.budgets ?? DEFAULT_BUDGETS,
    referenceMachine: referenceMachine(),
    browsergym: {
      pypiName: BROWSERGYM_PYPI_NAME,
      pypiVersion: BROWSERGYM_PYPI_VERSION,
      pypiReleaseCommit: BROWSERGYM_PYPI_RELEASE_COMMIT,
      githubCommit: BROWSERGYM_GITHUB_COMMIT,
      docs: BROWSERGYM_DOCS
    }
  }
}
