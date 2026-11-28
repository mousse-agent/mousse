/**
 * Two Grok processes on homes of Mousse's refreshing one sign-in at once (`grok/held.ts`, and a single request's inputs,
 * `grok/oneShot.ts`: `GROK_AUTH_PATH` points each at the entry's own `auth.json`, which Grok refreshes in place under its
 * own locks). Each runs on its own single-request home, headless, as the vehicle for a request. A stub issuer rotates the refresh
 * token on every refresh and refuses one used twice, as xAI's does; the sign-in in the fixture's `auth.json` has
 * expired, so both processes must refresh before their request. Held: one refresh per round, no refused token, both
 * requests sent with the new access token, the rotated token saved in the one `auth.json`, and no second credential
 * file anywhere. A dummy issuer and model on the loopback: no account is used. Only with MOUSSE_LIVE_GROK=1;
 * MOUSSE_GROK_BINARIES as in `grokHeldCheck.test.ts`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cliNames, findOnPath } from '../../src/mms/harness/env'
import { grokOneShotInputs } from '../../src/mms/harness/grok/oneShot'

const live = process.env.MOUSSE_LIVE_GROK === '1'
const binaries = (process.env.MOUSSE_GROK_BINARIES?.split(delimiter).filter(Boolean)) ??
  [findOnPath(cliNames('grok'), { env: process.env, searchPath: [] })].filter((path): path is string => Boolean(path))
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const ROUNDS = 3

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) })

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (subject: string, expires: Date, issuer: string) =>
  [b64({ alg: 'RS256', typ: 'JWT' }), b64({ sub: subject, email: 'fixture@example.invalid', exp: Math.floor(expires.getTime() / 1000), iat: Math.floor(Date.now() / 1000), iss: issuer }), 'c2ln'].join('.')

/** A child's output to its end; `signal` kills it. */
function finished(child: ChildProcess, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    signal.addEventListener('abort', () => child.kill(), { once: true })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The stub issuer and model: each refresh token works once; a model request must carry the newest access token. */
async function startIssuer() {
  const state = { valid: new Set<string>(), issued: 0, refreshes: 0, reused: 0, staleBearer: 0, models: 0, access: '' }
  let origin = ''
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.url === '/.well-known/openid-configuration') {
        return json(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, device_authorization_endpoint: `${origin}/oauth/device`, jwks_uri: `${origin}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
      }
      if (req.url === '/oauth/token') {
        const token = new URLSearchParams(body).get('refresh_token') ?? ''
        if (!state.valid.delete(token)) {
          state.reused += 1
          return json(400, { error: 'invalid_grant', error_description: 'refresh token already used' })
        }
        state.refreshes += 1
        state.issued += 1
        const next = `rt-${state.issued}`
        state.valid.add(next)
        state.access = jwt(`u1-${state.issued}`, new Date(Date.now() + 6 * 3600e3), origin)
        // Answered late, so the other process starts while this refresh is still open.
        setTimeout(() => json(200, { access_token: state.access, refresh_token: next, expires_in: 21600, token_type: 'Bearer' }), 500)
        return
      }
      if (/\/responses$/.test(req.url ?? '')) {
        state.models += 1
        if (String(req.headers.authorization ?? '') !== `Bearer ${state.access}`) state.staleBearer += 1
        const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A title', annotations: [] }] }
        const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
        const response = { id: 'resp_1', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'stub', output: [item], usage }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let sequence = 0
        const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
        event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
        event('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } })
        event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'A title' })
        event('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'A title' })
        event('response.output_item.done', { output_index: 0, item })
        event('response.completed', { response })
        res.end()
        return
      }
      json(404, { error: { message: 'not here' } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return { origin, state, close: () => server.close() }
}

/** Every file named `auth.json` under `root`, relative to it. */
function authFiles(root: string): string[] {
  const found: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'auth.json') found.push(relative(root, path))
    }
  }
  walk(root)
  return found.sort()
}

describe.runIf(live && binaries.length)('two held Grok processes refreshing one sign-in', () => {
  for (const binary of binaries) {
    it(`refresh it once, in place, with no refused token: ${binary}`, async () => {
      const version = /(\d+\.\d+\.\d+)/.exec(execFileSync(binary, ['--version'], { encoding: 'utf8' }))?.[1]
      const root = mkdtempSync(join(tmpdir(), 'mousse-live-grok-refresh-'))
      roots.push(root)
      const issuer = await startIssuer()
      try {
        const person = join(root, 'person-home')
        mkdirSync(person)
        const auth = join(person, 'auth.json')
        const scope = `${issuer.origin}::${CLIENT_ID}`
        for (let round = 0; round < ROUNDS; round += 1) {
          // An expired sign-in whose refresh token the issuer holds.
          const token = `rt-start-${round}`
          issuer.state.valid.add(token)
          const expired = new Date(Date.now() - 3600e3)
          writeFileSync(auth, JSON.stringify({
            [scope]: {
              key: jwt('u1', expired, issuer.origin), auth_mode: 'oidc', create_time: new Date().toISOString(), user_id: 'u1', email: 'fixture@example.invalid',
              first_name: 'F', last_name: 'X', profile_image_asset_id: '', principal_type: 'User', principal_id: 'u1', team_id: 't1',
              team_zero_data_retention: false, coding_data_retention_opt_out: true, coding_data_team: '', refresh_token: token,
              expires_at: expired.toISOString(), oidc_issuer: issuer.origin, oidc_client_id: CLIENT_ID
            }
          }, null, 2))
          const before = { refreshes: issuer.state.refreshes, models: issuer.state.models }
          const base: NodeJS.ProcessEnv = {}
          for (const [name, value] of Object.entries(process.env)) if (!/^(XAI_|GROK_)/i.test(name)) base[name] = value
          const runs = [0, 1].map((index) => {
            const folder = join(root, `round-${round}`, `process-${index}`)
            const cwd = join(folder, 'work')
            mkdirSync(cwd, { recursive: true })
            const promptFile = join(folder, 'prompt.txt')
            writeFileSync(promptFile, `Name this chat ${round}-${index}`)
            const env = {
              ...base,
              ...grokOneShotInputs(join(folder, 'inputs'), auth),
              HOME: folder,
              USERPROFILE: folder,
              GROK_OIDC_ISSUER: issuer.origin,
              GROK_OIDC_CLIENT_ID: CLIENT_ID,
              GROK_XAI_API_BASE_URL: `${issuer.origin}/v1`,
              GROK_CLI_CHAT_PROXY_BASE_URL: `${issuer.origin}/v1`,
              GROK_TELEMETRY_ENABLED: '0'
            }
            const child = spawn(binary, ['--prompt-file', promptFile, '--output-format', 'json', '--max-turns', '1'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
            return finished(child, AbortSignal.timeout(90_000))
          })
          const results = await Promise.all(runs)
          const saved = (JSON.parse(readFileSync(auth, 'utf8')) as Record<string, { refresh_token?: string; expires_at?: string }>)[scope]
          console.log(JSON.stringify({ version, round, refreshes: issuer.state.refreshes - before.refreshes, reused: issuer.state.reused, models: issuer.state.models - before.models, staleBearer: issuer.state.staleBearer, saved: saved?.refresh_token }))
          for (const result of results) expect(JSON.stringify(result)).toContain('A title')
          // One refresh for both: the second process read the token the first one saved.
          expect(issuer.state.refreshes - before.refreshes).toBe(1)
          expect(issuer.state.models - before.models).toBe(2)
          expect(saved?.refresh_token).toBe(`rt-${issuer.state.issued}`)
          expect(Date.parse(saved!.expires_at!)).toBeGreaterThan(Date.now())
        }
        expect(issuer.state.reused).toBe(0)
        expect(issuer.state.staleBearer).toBe(0)
        // The one sign-in, in its one file: no held home holds a copy.
        expect(authFiles(root)).toEqual([join('person-home', 'auth.json')])
        expect(statSync(auth).isFile()).toBe(true)
      } finally {
        issuer.close()
      }
    }, 300_000)
  }
})
