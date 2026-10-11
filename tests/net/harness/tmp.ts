import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

export function makeTempDir(prefix = 'mousse-net-'): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const cleanup = () => rmSync(path, { recursive: true, force: true })
  afterEach(cleanup)
  return { path, cleanup }
}
