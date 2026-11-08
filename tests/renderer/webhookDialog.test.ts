// @vitest-environment jsdom
/**
 * The webhook dialog (an automation's request URL): the secret is shown once, disabling asks first, and the recent
 * requests say what became of each. A small host owns the dialog the way the Automations page does: it shows it for
 * the open automation and closes it when that automation is gone.
 */
import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledJob, ScheduledWebhookDelivery } from '../../src/shared/types'
import { SECRET_VISIBLE_MS, WebhookDialog, type WebhookApi } from '../../src/renderer/components/scheduled/WebhookDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = '2026-10-27T10:00:00.000Z'
const webhookTrigger = { webhook: { scheme: 'mousse' as const, secretRef: 'ref', createdAt: NOW } }
const URL_OF = (id: string) => `http://127.0.0.1:18790/hooks/${id}`
const SECRET = 'whsec_SECRETVALUE1234567890abcdefghijklmnopqrs'

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return { id: 'job-1', name: 'Nightly', prompt: 'Check CI', schedule: { kind: 'interval', minutes: 30 }, enabled: true, state: 'scheduled', nextRunAt: '2026-10-27T11:00:00.000Z', createdAt: NOW, updatedAt: NOW, ...patch }
}

interface Harness {
  api: { scheduled: { webhook: { enable: ReturnType<typeof vi.fn>; rotate: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn>; deliveries: ReturnType<typeof vi.fn> } } }
  emit(jobs: ScheduledJob[]): Promise<void>
  emitNow(jobs: ScheduledJob[]): void
  clipboard: { writeText: ReturnType<typeof vi.fn> }
}

let root: Root
let host: HTMLElement
let openRequest: ((id: string) => void) | null = null
let pushJobs: ((jobs: ScheduledJob[]) => void) | null = null

function Host({ initial, api }: { initial: ScheduledJob[]; api: WebhookApi }) {
  const [jobs, setJobs] = useState(initial)
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => { openRequest = setOpenId; pushJobs = setJobs; return () => { openRequest = null; pushJobs = null } }, [])
  const open = openId ? jobs.find((entry) => entry.id === openId) : undefined
  return open ? createElement(WebhookDialog, { job: open, api, onClose: () => setOpenId(null) }) : null
}

async function mount(jobs: ScheduledJob[]): Promise<Harness> {
  const clipboard = { writeText: vi.fn(async (_text: string) => undefined) }
  const webhook = {
    enable: vi.fn(),
    rotate: vi.fn(),
    disable: vi.fn(),
    deliveries: vi.fn(async (id: string) => ({ deliveries: [] as ScheduledWebhookDelivery[], url: URL_OF(id) }))
  }
  const api: WebhookApi = {
    enable: (id) => webhook.enable(id),
    rotate: (id) => webhook.rotate(id),
    disable: (id) => webhook.disable(id),
    deliveries: (id) => webhook.deliveries(id),
    copy: (text) => clipboard.writeText(text)
  }
  await act(async () => root.render(createElement(Host, { initial: jobs, api })))
  return {
    api: { scheduled: { webhook } },
    clipboard,
    emit: async (next) => { await act(async () => pushJobs?.(next)) },
    emitNow: (next) => { pushJobs?.(next) }
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string) => buttons().find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const click = async (element: HTMLElement | undefined | null) => {
  if (!element) throw new Error('Not found: element to click')
  await act(async () => element.click())
}
const key = async (element: Element | Document, name: string, init: KeyboardEventInit = {}) => {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent ?? '')
const openDialog = async (id: string) => { await act(async () => openRequest?.(id)) }

describe('The webhook dialog: the webhook secret is shown once', () => {
  const hooked = () => job({ trigger: webhookTrigger })
  const grant = (secret?: string) => ({ job: hooked(), url: URL_OF('job-1'), ...(secret ? { secret } : {}) })

  it('shows the secret after enabling with a copy button, then never again', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await openDialog('job-1')
    expect(document.body.textContent).toContain('Enable webhook')
    expect(h.api.scheduled.webhook.deliveries).not.toHaveBeenCalled()
    await click(button('Enable webhook'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
    expect(document.querySelector('[data-testid="webhook-url"]')?.textContent).toBe(URL_OF('job-1'))
    expect(document.body.textContent).toContain('shown only this once')

    await click(button('Copy secret'))
    expect(h.clipboard.writeText).toHaveBeenCalledWith(SECRET)
    expect(button('Copied')).toBeDefined()

    await click(button('Done'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)

    // Opening it again shows the address and the log but not the secret; nothing can ask for it.
    await openDialog('job-1')
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.querySelector('[data-testid="webhook-secret"]')).toBeNull()
    expect(document.querySelector('[data-testid="webhook-secret-hidden"]')?.textContent).toContain('not shown again')
    expect(document.querySelector('[data-testid="webhook-url"]')?.textContent).toBe(URL_OF('job-1'))
  })

  it('shows the secret even when the answer arrives before the job update', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockResolvedValue(grant(SECRET))
    await openDialog('job-1')
    await click(button('Enable webhook'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
    await h.emit([hooked()])
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
  })

  it('drops the secret when the dialog is closed with Escape or the close button', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return grant(SECRET) })
    await openDialog('job-1')
    await click(button('Enable webhook'))
    await key(document, 'Escape')
    expect(document.body.textContent).not.toContain(SECRET)
    await openDialog('job-1')
    expect(document.body.textContent).not.toContain(SECRET)
    await click(button('Close'))
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('rotating shows the new secret once, says the old one stopped, and the old one is gone from the page', async () => {
    const h = await mount([hooked()])
    const NEW_SECRET = 'whsec_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW1'
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(NEW_SECRET))
    await openDialog('job-1')
    expect(document.querySelector('[data-testid="webhook-secret"]')).toBeNull()
    await click(button('Rotate secret'))
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(NEW_SECRET)
    expect(document.body.textContent).toContain('The old secret no longer works.')
    expect(h.api.scheduled.webhook.rotate).toHaveBeenCalledWith('job-1')
    await click(button('Close'))
    expect(document.body.textContent).not.toContain(NEW_SECRET)
  })

  it('hides the secret by itself after a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = await mount([hooked()])
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(SECRET))
    await openDialog('job-1')
    await click(button('Rotate secret'))
    expect(document.body.textContent).toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(SECRET_VISIBLE_MS - 1) })
    expect(document.body.textContent).toContain(SECRET)
    await act(async () => { vi.advanceTimersByTime(2) })
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.querySelector('[data-testid="webhook-secret-hidden"]')?.textContent).toContain('The secret was hidden.')
  })

  it('keeps the secret out of the page when copying fails, and says so', async () => {
    const h = await mount([hooked()])
    h.api.scheduled.webhook.rotate.mockResolvedValue(grant(SECRET))
    h.clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
    await openDialog('job-1')
    await click(button('Rotate secret'))
    await click(button('Copy secret'))
    expect(alerts()).toEqual(['Copying failed. Select the text and copy it by hand.'])
    expect(button('Copied')).toBeUndefined()
  })

  it('cannot enable a webhook on a one-time automation or one an agent added, and says why', async () => {
    await mount([
      job({ schedule: { kind: 'once', runAt: '2030-01-01T00:00:00.000Z' } }),
      job({ id: 'job-2', name: 'Agent job', createdBy: { threadId: 't1' } })
    ])
    await openDialog('job-1')
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Change When to On demand first.')
    await key(document, 'Escape')
    await openDialog('job-2')
    expect(button('Enable webhook')?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Automations an agent added cannot have a webhook.')
  })

  it('shows a refusal from enabling, and a listener that did not start', async () => {
    const h = await mount([job()])
    h.api.scheduled.webhook.enable.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:enable': Error: Webhooks are not available in this profile."))
    await openDialog('job-1')
    await click(button('Enable webhook'))
    expect(alerts()).toEqual(['Webhooks are not available in this profile.'])
    h.api.scheduled.webhook.enable.mockImplementation(async () => { h.emitNow([hooked()]); return { ...grant(SECRET), listening: false, error: 'The webhook listener could not start on port 18790.' } })
    await click(button('Enable webhook'))
    expect(document.body.textContent).toContain('could not start on port 18790')
    expect(document.querySelector('[data-testid="webhook-secret"]')?.textContent).toBe(SECRET)
  })
})

describe('The webhook dialog: disabling a webhook needs a confirmation', () => {
  const hooked = () => job({ trigger: webhookTrigger })

  async function openWebhook(): Promise<Harness> {
    const h = await mount([hooked()])
    h.api.scheduled.webhook.disable.mockImplementation(async () => { h.emitNow([job()]); return job() })
    await openDialog('job-1')
    return h
  }
  const dialogs = () => document.querySelectorAll('[role="dialog"]')

  it('asks first; Keep webhook changes nothing', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    expect(dialogs()).toHaveLength(2)
    expect(document.body.textContent).toContain('stop working right away')
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
    await click(button('Keep webhook'))
    expect(dialogs()).toHaveLength(1)
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
  })

  it('disables only after the confirming button, then offers to enable again', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    const confirm = [...buttons()].filter((item) => item.textContent === 'Disable webhook').pop()
    await click(confirm)
    expect(h.api.scheduled.webhook.disable).toHaveBeenCalledTimes(1)
    expect(h.api.scheduled.webhook.disable).toHaveBeenCalledWith('job-1')
    expect(dialogs()).toHaveLength(1)
    expect(button('Enable webhook')).toBeDefined()
  })

  it('Escape cancels the question and leaves the webhook dialog open; focus starts on the dialog, not the destructive button', async () => {
    const h = await openWebhook()
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    const destructive = [...buttons()].filter((item) => item.textContent === 'Disable webhook').pop()
    expect(document.activeElement).not.toBe(destructive)
    expect(document.activeElement?.getAttribute('role') === 'dialog' || document.activeElement?.classList.contains('modal')).toBe(true)
    await key(document, 'Escape')
    expect(dialogs()).toHaveLength(1)
    expect(h.api.scheduled.webhook.disable).not.toHaveBeenCalled()
    await key(document, 'Escape')
    expect(dialogs()).toHaveLength(0)
  })

  it('a refusal from disabling is shown and the webhook stays', async () => {
    const h = await openWebhook()
    h.api.scheduled.webhook.disable.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:disable': Error: This job has no webhook."))
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook')[0])
    await click([...buttons()].filter((item) => item.textContent === 'Disable webhook').pop())
    expect(alerts()).toEqual(['This job has no webhook.'])
    expect(button('Rotate secret')).toBeDefined()
  })
})

describe('The webhook dialog: recent requests', () => {
  const row = (patch: Partial<ScheduledWebhookDelivery>): ScheduledWebhookDelivery => ({ receivedAt: '2026-10-27T09:00:00.000Z', outcome: 'accepted', bodyBytes: 120, ...patch })

  async function openLog(deliveries: ScheduledWebhookDelivery[]): Promise<Harness> {
    const h = await mount([job({ trigger: webhookTrigger })])
    h.api.scheduled.webhook.deliveries.mockResolvedValue({ deliveries, url: URL_OF('job-1') })
    await openDialog('job-1')
    return h
  }
  const items = () => [...document.querySelectorAll<HTMLElement>('.scheduled-request')]

  it('lists accepted and refused requests with a reason each', async () => {
    await openLog([
      row({ outcome: 'completed', occurrenceId: 'o1' }),
      row({ outcome: 'rejected_signature', bodyBytes: 1, receivedAt: '2026-10-27T09:01:00.000Z' }),
      row({ outcome: 'running', receivedAt: '2026-10-27T09:02:00.000Z' }),
      row({ outcome: 'too_large', bodyBytes: 2_000_000, receivedAt: '2026-10-27T09:03:00.000Z' }),
      row({ outcome: 'dispatch_failed', error: 'Thread was deleted.', receivedAt: '2026-10-27T09:04:00.000Z' })
    ])
    expect(document.querySelector('[aria-label="Recent requests"]')).not.toBeNull()
    expect(items()).toHaveLength(5)
    const [completed, signature, running, large, failed] = items()
    expect(completed.getAttribute('data-refused')).toBe('false')
    expect(completed.textContent).toContain('Accepted')
    expect(completed.textContent).toContain('The run finished.')
    expect(completed.textContent).toContain('120 bytes')
    expect(signature.getAttribute('data-refused')).toBe('true')
    expect(signature.textContent).toContain('Refused')
    expect(signature.textContent).toContain('The signature did not match.')
    expect(signature.textContent).toContain('1 byte')
    expect(running.textContent).toContain('The job was already running.')
    expect(large.textContent).toContain('The request body was too large.')
    expect(failed.textContent).toContain('Accepted')
    expect(failed.textContent).toContain('Thread was deleted.')
  })

  it('shows sizes and reasons only: a body or header that reached the page is never printed', async () => {
    const leaky = { ...row({ outcome: 'accepted' }), body: 'BODY-TEXT-FROM-SENDER', headers: { 'x-api-key': 'HEADER-VALUE' }, payload: { a: 'PAYLOAD-VALUE' } } as ScheduledWebhookDelivery
    await openLog([leaky])
    const text = document.body.textContent ?? ''
    expect(items()).toHaveLength(1)
    expect(text).toContain('120 bytes')
    for (const hidden of ['BODY-TEXT-FROM-SENDER', 'HEADER-VALUE', 'PAYLOAD-VALUE']) expect(text).not.toContain(hidden)
  })

  it('says so when there are no requests, and when the log cannot be read', async () => {
    const h = await openLog([])
    expect(document.body.textContent).toContain('No requests yet.')
    h.api.scheduled.webhook.deliveries.mockRejectedValueOnce(new Error("Error invoking remote method 'scheduled:webhook:deliveries': Error: Job not found: job-1"))
    await click(button('Refresh requests'))
    expect(alerts()).toEqual(['Job not found: job-1'])
  })

  it('shows the fields a template could not fill, when the log records them', async () => {
    await openLog([row({ missingPlaceholders: ['body.pull_request.title', 'headers.x-event'] })])
    expect(items()[0].textContent).toContain('Missing fields: body.pull_request.title, headers.x-event')
  })

  it('reloads the log when the job changes (a request started a run)', async () => {
    const h = await openLog([])
    expect(h.api.scheduled.webhook.deliveries).toHaveBeenCalledTimes(1)
    h.api.scheduled.webhook.deliveries.mockResolvedValue({ deliveries: [row({ outcome: 'queued' })], url: URL_OF('job-1') })
    await h.emit([job({ trigger: webhookTrigger, updatedAt: '2026-10-27T10:05:00.000Z', state: 'running' })])
    expect(h.api.scheduled.webhook.deliveries).toHaveBeenCalledTimes(2)
    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('Waiting in the queue behind another run.')
  })

  it('closes when the job is deleted, taking any secret with it', async () => {
    const h = await openLog([])
    await h.emit([job({ id: 'job-2', name: 'Other' })])
    expect(document.querySelector('[data-testid="webhook-dialog"]')).toBeNull()
  })
})
