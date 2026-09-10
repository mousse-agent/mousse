import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../src/mms/execution/ArtifactStore'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('FileArtifactStore', () => {
  it('rejects path-shaped ids and detects blob tampering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-artifacts-'))
    dirs.push(root)
    const store = new FileArtifactStore({ profileId: 'p1', profileRoot: root })
    await expect(store.get('../../outside', 'p1')).rejects.toThrow(/Invalid artifact id/)
    const ref = await store.put({ profileId: 'p1', runId: 'r1', bytes: new TextEncoder().encode('original'), mediaType: 'text/plain', displayName: 'a.txt' })
    writeFileSync(join(root, 'artifacts', ref.id, 'blob'), 'changed')
    await expect(store.get(ref.id, 'p1')).rejects.toThrow(/integrity mismatch/)
  })
})
