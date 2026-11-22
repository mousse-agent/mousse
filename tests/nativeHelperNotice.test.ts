import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isWatchOnlyThread, NativeHelperNoticeView } from '../src/renderer/components/NativeHelperNotice'
import { isNativeHelperThread, isSubagentThread, visibleThreads } from '../src/shared/threadLineage'
import type { ThreadNativeHelper } from '../src/shared/types'

const native = (patch: Partial<ThreadNativeHelper> = {}): ThreadNativeHelper => ({
  runtime: 'codex',
  instanceId: 'codex-main',
  sessionEpoch: 'codex:h:1',
  agentId: 'thr_1',
  hostRunId: 'run-1',
  state: 'running',
  ...patch
})

const render = (props: Parameters<typeof NativeHelperNoticeView>[0]) => renderToStaticMarkup(createElement(NativeHelperNoticeView, props))

describe("a native helper's mirror thread", () => {
  it('is watch-only, folds under the thread that hosts it, and is not a Mousse subagent', () => {
    const mirror = { id: 'native-x-thr_1', lineage: { parentThreadId: 'host', rootThreadId: 'host', relationship: 'native' as const }, native: native() }
    expect(isWatchOnlyThread(mirror)).toBe(true)
    expect(isWatchOnlyThread({})).toBe(false)
    expect(isNativeHelperThread(mirror)).toBe(true)
    expect(isNativeHelperThread({ lineage: { parentThreadId: 'host', rootThreadId: 'host', relationship: 'subagent' } })).toBe(false)
    expect(isSubagentThread(mirror)).toBe(true)
    expect(visibleThreads([{ id: 'host' }, mirror]).map((thread) => thread.id)).toEqual(['host'])
  })

  it('names the runtime, the host and the state, and offers Stop only when given one', () => {
    const running = render({ native: native(), hostName: 'Fix login', onOpenHost: () => undefined, onStop: () => undefined })
    expect(running).toContain('Codex helper of Fix login · running · watch only')
    expect(running).toContain('Open Fix login')
    expect(running).toContain('>Stop<')
    const done = render({ native: native({ runtime: 'claude', state: 'unknown', sendTo: 'agent-7' }), hostName: 'Fix login', onOpenHost: () => undefined })
    expect(done).toContain('Claude Code helper of Fix login · ended (how is not known) · watch only')
    expect(done).not.toContain('>Stop<')
    // How to write to it is named where the runtime gave an id for it.
    expect(done).toContain('SendMessage with agent-7')
  })
})
