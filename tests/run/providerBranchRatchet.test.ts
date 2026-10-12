import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..')
const script = join(repoRoot, 'scripts', 'check-provider-branches.mjs')

function runRatchet(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('provider-literal ratchet', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('passes against the committed baseline', () => {
    const result = runRatchet()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const summary = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1)) as { total: number }
    expect(typeof summary.total).toBe('number')
  })

  it('fails when a new provider literal is added outside the adapters', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-ratchet-'))
    tempRoots.push(root)
    cpSync(join(repoRoot, 'src', 'mms', 'orchestrator'), join(root, 'src', 'mms', 'orchestrator'), { recursive: true })
    cpSync(join(repoRoot, 'scripts', 'provider-branch-baseline.json'), join(root, 'scripts', 'provider-branch-baseline.json'))

    mkdirSync(join(root, 'src', 'mms', 'run', 'adapters'), { recursive: true })
    writeFileSync(join(root, 'src', 'mms', 'run', 'adapters', 'allowed.ts'), "export const id = 'codex'\n")
    expect(runRatchet('--root', root).status).toBe(0)

    writeFileSync(join(root, 'src', 'mms', 'run', 'leak.ts'), "export const isCodex = (id: string) => id === 'codex'\n")
    const result = runRatchet('--root', root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Provider-literal ratchet failed')
  })
})
