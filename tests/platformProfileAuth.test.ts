import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { DesktopPkceAuth } from '../src/mms/control/auth/desktopPkce'
import { CliHeadlessAuth } from '../src/mms/control/auth/cliHeadless'
import { ControlStore } from '../src/mms/control/storage/controlStore'
import { MmsControlService } from '../src/mms/control/MmsControlService'
import { MmsEventBus } from '../src/mms/events'
import type { AuthFetch } from '../src/mms/control/auth/authTransport'

const homes: string[] = []
const auths: Array<{ cancel(): void }> = []
function store() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-profile-auth-'))
  homes.push(root)
  return new ControlStore(root)
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const validTokens = { account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh', email: 'fixture@example.test' }

async function desktop(fetcher: AuthFetch, target = store()) {
  let launched!: (url: string) => void
  const launch = new Promise<string>((resolve) => { launched = resolve })
  const auth = new DesktopPkceAuth(target, fetcher)
  auths.push(auth)
  const result = auth.startLogin({ openExternal: async (url) => { launched(url) }, controlOrigin: 'https://control.example.test', dashboardUrl: 'https://dashboard.example.test', timeoutMs: 8000 })
  const url = new URL(await launch)
  const callback = new URL(url.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', url.searchParams.get('state')!)
  callback.searchParams.set('code', 'fixture-code')
  return { auth, result, callback, target }
}

afterEach(() => {
  for (const auth of auths.splice(0)) auth.cancel()
  vi.unstubAllGlobals()
  for (const root of homes.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-profile-auth-') || path.includes('..')) throw new Error('Unexpected auth fixture path')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('truthful profile-scoped Plus authentication', () => {
  it('prevents a self-hosted enrollment response from signing in after logout', async () => {
    const target = store()
    const service = new MmsControlService({ homeDir: homes[homes.length - 1], store: target, eventBus: new MmsEventBus() })
    let respond!: (response: Response) => void
    vi.stubGlobal('fetch', async () => new Promise<Response>((resolve) => { respond = resolve }))
    const enrollment = service.enrollSelfHosted('https://selfhost.example.test', 'fixture-code')
    await service.logout()
    respond(json({ device_token: 'late-fixture-device' }))
    expect((await enrollment).ok).toBe(false)
    expect(target.getCredentials()).toBeNull()
    await service.stop()
  })

  it('does not manufacture credentials after a failed desktop token exchange', async () => {
    const flow = await desktop(async () => json({ error: 'unavailable' }, 503))
    expect((await fetch(flow.callback)).status).toBe(500)
    expect(await flow.result).toMatchObject({ ok: false, error: 'Token exchange failed with status 503' })
    expect(flow.target.getCredentials()).toBeNull()
  })

  it('bounds authentication response bodies before accepting credentials', async () => {
    const flow = await desktop(async () => json({ ...validTokens, padding: 'x'.repeat(300 * 1024) }))
    await fetch(flow.callback)
    expect(await flow.result).toMatchObject({ ok: false, error: 'Authentication response is too large' })
    expect(flow.target.getCredentials()).toBeNull()
  })

  it('rejects malformed tokens and unsuccessful enrollment without overwriting an existing account', async () => {
    const target = store()
    target.saveCredentials({ accountId: 'prior-fixture', deviceEnrollmentToken: 'prior-device', updatedAt: new Date().toISOString() })
    const invalid = await desktop(async () => json({ account_id: 'new-account' }), target)
    await fetch(invalid.callback)
    expect((await invalid.result).ok).toBe(false)
    const enrollment = await desktop(async (url) => String(url).endsWith('/token') ? json(validTokens) : json({ error: 'denied' }, 403), target)
    await fetch(enrollment.callback)
    expect(await enrollment.result).toMatchObject({ ok: false, error: 'Device enrollment failed with status 403' })
    expect(target.getCredentials()?.accountId).toBe('prior-fixture')
  })

  it('saves only validated token and enrollment responses in the owning profile', async () => {
    const a = store(), b = store()
    const flow = await desktop(async (url) => String(url).endsWith('/token') ? json(validTokens) : json({ device_token: 'fixture-device' }), a)
    expect((await fetch(flow.callback)).status).toBe(200)
    expect(await flow.result).toMatchObject({ ok: true, accountId: 'fixture-account' })
    expect(a.getCredentials()).toMatchObject({ accountId: 'fixture-account', deviceEnrollmentToken: 'fixture-device' })
    expect(b.getCredentials()).toBeNull()
  })

  it('drops a late token response after desktop cancellation', async () => {
    let respond!: (value: Response) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const flow = await desktop(async () => { entered(); return new Promise<Response>((resolve) => { respond = resolve }) })
    const callback = fetch(flow.callback)
    await started
    flow.auth.cancel()
    respond(json(validTokens))
    await callback
    expect(await flow.result).toMatchObject({ ok: false, error: 'Login cancelled' })
    expect(flow.target.getCredentials()).toBeNull()
  })

  it('keeps prior credentials when a replacement desktop login cancels a late exchange and then fails', async () => {
    const target = store()
    target.saveCredentials({
      accountId: 'prior-account', deviceEnrollmentToken: 'prior-device', updatedAt: new Date().toISOString()
    })
    let finishFirst!: (value: Response) => void
    let firstEntered!: () => void
    const entered = new Promise<void>((resolve) => { firstEntered = resolve })
    let tokenCalls = 0
    const auth = new DesktopPkceAuth(target, async (url) => {
      if (!String(url).endsWith('/token')) return json({ device_token: 'unexpected-device' })
      tokenCalls += 1
      if (tokenCalls === 1) {
        firstEntered()
        return new Promise<Response>((resolve) => { finishFirst = resolve })
      }
      return json({ error: 'replacement-failed' }, 503)
    })
    auths.push(auth)
    const launch = () => {
      let opened!: (url: string) => void
      const url = new Promise<string>((resolve) => { opened = resolve })
      const result = auth.startLogin({
        openExternal: async (value) => opened(value),
        controlOrigin: 'https://control.example.test',
        dashboardUrl: 'https://dashboard.example.test',
        timeoutMs: 8000
      })
      return { url, result }
    }
    const first = launch()
    const firstUrl = new URL(await first.url)
    const firstCallback = new URL(firstUrl.searchParams.get('redirect_uri')!)
    firstCallback.searchParams.set('state', firstUrl.searchParams.get('state')!)
    firstCallback.searchParams.set('code', 'first-code')
    const firstHttp = fetch(firstCallback)
    await entered

    const replacement = launch()
    const replacementUrl = new URL(await replacement.url)
    const replacementCallback = new URL(replacementUrl.searchParams.get('redirect_uri')!)
    replacementCallback.searchParams.set('state', replacementUrl.searchParams.get('state')!)
    replacementCallback.searchParams.set('code', 'replacement-code')
    await fetch(replacementCallback)
    expect(await replacement.result).toMatchObject({ ok: false, error: 'Token exchange failed with status 503' })

    finishFirst(json(validTokens))
    await firstHttp
    expect(await first.result).toMatchObject({ ok: false, error: 'Login cancelled' })
    expect(target.getCredentials()).toMatchObject({
      accountId: 'prior-account', deviceEnrollmentToken: 'prior-device'
    })
  })

  it('validates state before accepting errors and escapes callback HTML', async () => {
    const flow = await desktop(async () => { throw new Error('Must not exchange') })
    flow.callback.searchParams.set('error', 'access_denied')
    flow.callback.searchParams.set('error_description', '<script>fixture()</script>')
    const html = await (await fetch(flow.callback)).text()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect((await flow.result).ok).toBe(false)
  })

  it('fails CLI transaction creation without a fabricated prompt', async () => {
    const target = store(), prompt = vi.fn()
    const auth = new CliHeadlessAuth(target, async () => json({}, 503))
    auths.push(auth)
    expect(await auth.startLogin({ onPrompt: prompt })).toMatchObject({ ok: false })
    expect(prompt).not.toHaveBeenCalled()
    expect(target.getCredentials()).toBeNull()
  })

  it('cancels CLI polling immediately and rejects malformed successful exchanges', async () => {
    const target = store()
    target.saveCredentials({
      accountId: 'prior-account', deviceEnrollmentToken: 'prior-device', updatedAt: new Date().toISOString()
    })
    const transaction = { id: 'fixture-tx', human_code: 'FIXTURE', poll_interval_ms: 1000, expires_in: 30 }
    const auth = new CliHeadlessAuth(target, async (url) => String(url).endsWith('/exchange') ? json({ account_id: 'fixture-account' }) : json(transaction))
    auths.push(auth)
    expect(await auth.startLogin({ onPrompt: () => auth.cancel() })).toMatchObject({ ok: false, error: 'Login cancelled by user' })
    expect(await auth.startLogin({ onPrompt: () => {} })).toMatchObject({ ok: false, error: 'Invalid authentication response: device_token' })
    expect(target.getCredentials()).toMatchObject({
      accountId: 'prior-account', deviceEnrollmentToken: 'prior-device'
    })
  }, 10_000)

  it('accepts server-issued CLI enrollment and does not equate access tokens with enrollment', async () => {
    const target = store()
    const auth = new CliHeadlessAuth(target, async (url) => String(url).endsWith('/exchange')
      ? json({ account_id: 'fixture-cli', device_token: 'fixture-device' })
      : json({ id: 'fixture-tx', human_code: 'FIXTURE', poll_interval_ms: 1000, expires_in: 30 }))
    auths.push(auth)
    expect(await auth.startLogin({ onPrompt: () => {} })).toEqual({ ok: true, accountId: 'fixture-cli' })
    const service = new MmsControlService({ homeDir: homes[homes.length - 1], store: target, eventBus: new MmsEventBus() })
    expect(service.getStatus().enrolled).toBe(true)
    target.saveCredentials({ accountId: 'fixture-account', accessToken: 'fixture-access', updatedAt: new Date().toISOString() })
    expect(service.getStatus().enrolled).toBe(false)
    vi.stubGlobal('fetch', async () => json({}))
    expect((await service.enrollSelfHosted('https://selfhost.example.test', 'fixture-code')).ok).toBe(false)
    expect(target.getCredentials()?.deviceEnrollmentToken).toBeUndefined()
    await service.stop()
  }, 10_000)

  it('does not autoconnect the relay with an access token but no device enrollment', async () => {
    const target = store()
    target.saveCredentials({
      accountId: 'fixture-account', accessToken: 'fixture-access', updatedAt: new Date().toISOString()
    })
    const service = new MmsControlService({
      homeDir: homes[homes.length - 1], store: target, eventBus: new MmsEventBus()
    })
    const start = vi.spyOn(service.relay, 'start').mockImplementation(() => {})
    await service.start()
    expect(start).not.toHaveBeenCalled()
    await service.stop()

    target.saveCredentials({
      accountId: 'fixture-account', deviceEnrollmentToken: 'fixture-device', updatedAt: new Date().toISOString()
    })
    await service.start()
    expect(start).toHaveBeenCalledTimes(1)
    await service.stop()
  })
})
