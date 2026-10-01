import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const REMOVE_SCRIPT = join(fixtureDir, '..', 'process-lifecycle', 'remove-owned-temp.ps1')
const PREFIX = 'mousse-browser-cmd-'

function assertAbsoluteUnderTemp(root: string, tmp: string): string {
  if (!isAbsolute(root) || !isAbsolute(tmp)) {
    throw new Error(`owned temp paths must be absolute: root=${root} tmp=${tmp}`)
  }
  const resolvedRoot = resolve(root)
  const resolvedTmp = resolve(tmp)
  const rel = relative(resolvedTmp, resolvedRoot)
  if (rel === '') throw new Error('owned temp root must be a unique subdirectory of temp')
  if (isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`owned temp root escapes temp: root=${resolvedRoot} tmp=${resolvedTmp}`)
  }
  if (!rel.split(/[/\\]/)[0]?.startsWith(PREFIX)) {
    throw new Error(`owned temp root must use prefix ${PREFIX}: ${rel}`)
  }
  return resolvedRoot
}

export function makeBrowserCommandTempRoot(): string {
  const tmp = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(tmp, PREFIX))
  return assertAbsoluteUnderTemp(root, tmp)
}

export function removeBrowserCommandTempRoot(root: string): void {
  const tmp = realpathSync.native(tmpdir())
  const resolved = assertAbsoluteUnderTemp(resolve(root), tmp)
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REMOVE_SCRIPT, resolved, tmp],
        { timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!existsSync(resolved)) return
      throw new Error(`PowerShell owned-temp cleanup failed for ${resolved}: ${detail}`)
    }
    if (!existsSync(resolved)) return
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
