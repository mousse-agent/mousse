import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DesktopPkceAuth, generatePkcePair } from '../src/mms/control/auth/desktopPkce'
import { CliHeadlessAuth } from '../src/mms/control/auth/cliHeadless'
import { ControlStore } from '../src/mms/control/storage/controlStore'

describe('Control Protocol 2.0 - Auth Flows', () => {
  let tempHome: string
  let store: ControlStore

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mousse-control-auth-test-'))
    store = new ControlStore(tempHome)
  })

  afterEach(() => {
    if (existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  describe('PKCE Generation', () => {
    it('generates high-entropy S256 PKCE code challenge and verifier', () => {
      const { verifier, challenge } = generatePkcePair()

      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(challenge.length).toBeGreaterThanOrEqual(43)
      expect(verifier).not.toBe(challenge)

      // Ensure fresh pairs are unique
      const second = generatePkcePair()
      expect(second.verifier).not.toBe(verifier)
      expect(second.challenge).not.toBe(challenge)
    })
  })

  describe('DesktopPkceAuth', () => {
    it('starts loopback server, invokes openExternal with PKCE URL, and handles state mismatch', async () => {
      const auth = new DesktopPkceAuth(store)
      let launchedUrl = ''

      const loginPromise = auth.startLogin({
        openExternal: async (url: string) => {
          launchedUrl = url
        },
        timeoutMs: 5000
      })

      // Wait a moment for server to bind and call openExternal
      await new Promise((r) => setTimeout(r, 50))
      expect(launchedUrl).toContain('/login?client_id=mousse-desktop')
      expect(launchedUrl).toContain('&code_challenge_method=S256')

      // Parse port from redirect_uri in launched URL
      const parsedUrl = new URL(launchedUrl)
      const redirectUri = parsedUrl.searchParams.get('redirect_uri')!
      expect(redirectUri).toBeDefined()

      // 1. Simulate malicious or corrupted callback with invalid state
      const badCallbackUrl = `${redirectUri}?state=bad-state-value&code=some-code`
      const badResp = await fetch(badCallbackUrl)
      expect(badResp.status).toBe(400)

      const result = await loginPromise
      expect(result.ok).toBe(false)
      expect(result.error).toContain('State validation failed')
    })

    it('cancels loopback server cleanly', async () => {
      const auth = new DesktopPkceAuth(store)
      const loginPromise = auth.startLogin({
        openExternal: async () => {},
        timeoutMs: 10_000
      })

      auth.cancel()
      const res = await loginPromise
      expect(res.ok).toBe(false)
      expect(res.error).toBe('Login cancelled')
    })

    it('handles provider error callback gracefully', async () => {
      const auth = new DesktopPkceAuth(store)
      let launchedUrl = ''

      const loginPromise = auth.startLogin({
        openExternal: async (url) => {
          launchedUrl = url
        }
      })

      await new Promise((r) => setTimeout(r, 50))
      const parsedUrl = new URL(launchedUrl)
      const redirectUri = parsedUrl.searchParams.get('redirect_uri')!
      const state = parsedUrl.searchParams.get('state')!

      // Simulate provider access_denied
      const errCallbackUrl = `${redirectUri}?error=access_denied&error_description=User+cancelled+login&state=${state}`
      await fetch(errCallbackUrl)

      const res = await loginPromise
      expect(res.ok).toBe(false)
      expect(res.error).toContain('User cancelled login')
    })
  })

  describe('CliHeadlessAuth', () => {
    it('instantiates and can be cancelled without lingering state', () => {
      const auth = new CliHeadlessAuth(store)
      expect(auth).toBeDefined()
      auth.cancel()
    })
  })
})
