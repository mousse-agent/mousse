// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReleaseNotes } from '../../src/renderer/components/updates/InstallConfirm'
import { useUpdateStore } from '../../src/renderer/stores/updateStore'
import type { FiledBugReportView } from '../../src/shared/bugReports'
import type { UpdateState } from '../../src/shared/updates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const report = (patch: Partial<FiledBugReportView>): FiledBugReportView => ({
  number: 10, url: 'https://github.com/mousse-agent/mousse/issues/10', title: 'Save failed', signature: 's', filedAt: '2026-11-01T00:00:00Z',
  anonymous: true, state: 'closed', stateReason: 'completed', ...patch
})

let reports: FiledBugReportView[] = []
let root: Root
let host: HTMLElement

const notes: Pick<UpdateState, 'releaseNotes' | 'omittedReleaseCount'> = {
  releaseNotes: [{ version: '1.1.0', items: ['fix: the save by @a in #40'], totalItems: 30, url: 'https://github.com/mousse-agent/mousse/releases/tag/v1.1.0' }],
  omittedReleaseCount: 0
}

async function show(pullRequests: number[]): Promise<HTMLElement | null> {
  useUpdateStore.setState({ ...useUpdateStore.getState(), pullRequests })
  await act(async () => { root.render(createElement(ReleaseNotes, { state: notes })) })
  await act(async () => { await Promise.resolve() })
  return host.querySelector('[aria-label="This update fixes your bugs"]')
}

describe("an update's notes", () => {
  beforeEach(() => {
    ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request: async () => ({ reports }) } }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('list the reports a pull request in the update closes, even one past the items shown', async () => {
    reports = [report({ closedBy: [52] }), report({ number: 11, title: 'Pane blank', closedBy: [60] })]
    const section = await show([40, 52])
    expect(section?.textContent).toContain('Save failed')
    expect(section?.textContent).not.toContain('Pane blank')
  })

  it('show no section when no pull request in the update closes a report', async () => {
    reports = [report({ closedBy: [60] })]
    expect(await show([40, 52])).toBeNull()
  })
})
