/**
 * Architecture regression: production paths must not embed MMS or legacy IPC.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name === 'dist') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkTs(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

describe('architecture isolation (Phase 6)', () => {
  it('deleted legacy Electron embedded MMS modules', () => {
    const gone = [
      'src/main/ipc/registerIpc.ts',
      'src/main/data/ThreadContext.ts',
      'src/main/notifications/NotificationService.ts'
    ]
    for (const f of gone) {
      expect(() => read(f)).toThrow()
    }
  })

  it('src/main never constructs MousseMainService', () => {
    const files = walkTs(join(ROOT, 'src/main'))
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      expect(src, f).not.toMatch(/MousseMainService\.create/)
      expect(src, f).not.toMatch(/from ['\"].*registerIpc['\"]/)
      expect(src, f).not.toMatch(/ThreadContext/)
      expect(src, f).not.toMatch(/NotificationService/)
    }
  })

  it('production CLI has single owner factory; openMms is client-only', () => {
    const mmsContext = read('src/cli/mmsContext.ts')
    expect(mmsContext).toMatch(/LocalMmsClient|connectDaemonClient/)
    expect(mmsContext).not.toMatch(/MousseMainService\.create/)
    expect(mmsContext).not.toMatch(/openMmsOwner|createMms/)
    expect(mmsContext).toMatch(/client: DaemonClient/)

    const serviceLocator = read('src/cli/serviceLocator.ts')
    expect(serviceLocator).not.toMatch(/createMms|MousseMainService\.create/)

    const daemonOwner = read('src/cli/daemonOwner.ts')
    expect(daemonOwner).toMatch(/MousseMainService\.create/)
    expect(daemonOwner).toMatch(/ownerKind:\s*['\"]daemon['\"]/)

    const service = read('src/cli/commands/service.ts')
    expect(service).toMatch(/createDaemonOwner/)
    expect(service).not.toMatch(/openMmsOwner/)
  })

  it('no notPhase stubs in production sources', () => {
    const files = [...walkTs(join(ROOT, 'src/main')), ...walkTs(join(ROOT, 'src/cli')), ...walkTs(join(ROOT, 'src/mms'))]
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      expect(src, f).not.toMatch(/notPhase\d/)
      expect(src, f).not.toMatch(/Phase 5 stub/i)
    }
  })

  it('production src has no loadThreadData→saveThreadData partial update footguns', () => {
    const files = walkTs(join(ROOT, 'src'))
    for (const f of files) {
      if (f.includes(`${join('src', 'main', 'data', 'ThreadContext')}`)) continue
      const src = readFileSync(f, 'utf-8')
      // Flag classic clobber pattern in the same function-ish region
      if (/loadThreadData\s*\(/.test(src) && /saveThreadData\s*\(/.test(src)) {
        // Allowed: ThreadDataStore itself, tests are outside src/
        if (f.endsWith('ThreadDataStore.ts')) continue
        // Orchestrator channel path must use mutateThreadData not save
        expect(src, f).not.toMatch(
          /loadThreadData[\s\S]{0,400}saveThreadData/
        )
      }
    }
  })
})
