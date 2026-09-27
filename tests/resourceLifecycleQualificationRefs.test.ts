import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { readDirectLifecycleRef } from '../src/mms/lifecycle/WorktreeRetirementService'
import { gitFoundationFixture } from './fixtures/gitFoundation'

it.each(['not an object identity\n', '', '0'.repeat(40) + '\n', 'f'.repeat(40) + '\n', '1234\n'])
  ('does not mistake malformed existing ref bytes for verified absence: %j', (bytes) => {
    const f = gitFoundationFixture()
    try {
      const name = 'refs/mousse/qualification/corrupt'
      const path = join(f.repo, '.git', name)
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
      let observed: string | undefined
      try { observed = readDirectLifecycleRef(f.repo, name) } catch { return }
      // A syntactically valid SHA can remain a direct ref even if its object is
      // missing; callers will reject an unexpected SHA. It must never be absent.
      expect(observed, 'An existing malformed ref must not be reported as absent').toBeDefined()
    } finally { f.dispose() }
  })
