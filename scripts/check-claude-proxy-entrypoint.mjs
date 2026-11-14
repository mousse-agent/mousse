// Offline wire check: real Claude Code via the Agent SDK, synthetic replies, no account or upstream.
// Usage: node scripts/check-claude-proxy-entrypoint.mjs <absolute claude executable>
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

assert(process.argv[2], 'Pass an absolute Claude Code executable path')
const home = mkdtempSync(join(tmpdir(), 'mousse-proxy-wire-'))
const captures = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: 1 }))
    return
  }
  captures.push({ headers: req.headers, body })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  event('message_start', { message: { id: `msg_${captures.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  event('message_stop', {})
  res.end()
})
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  // Deliberately allowlist OS variables; never inherit the caller's credentials, proxy or Claude settings.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'config'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only',
    CLAUDE_CODE_ENTRYPOINT: 'mousse', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })
  mkdirSync(env.CLAUDE_CONFIG_DIR)
  let session
  for (const prompt of ['Reply ok.', 'Reply ok again.']) {
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), 30_000)
    const run = query({ prompt, options: { cwd: home, env, pathToClaudeCodeExecutable: resolve(process.argv[2]),
      executable: resolve(process.argv[2]), abortController, settingSources: [], persistSession: true,
      model: 'claude-sonnet-4-6', maxTurns: 1, tools: [], systemPrompt: { type: 'preset', preset: 'claude_code' },
      settings: { useAutoModeDuringPlan: false }, ...(session ? { resume: session } : {}) } })
    try { for await (const frame of run) if (frame.session_id) session = frame.session_id } finally { clearTimeout(timer); run.close() }
  }
  assert.equal(captures.length, 2)
  for (const capture of captures) {
    assert.match(capture.headers['user-agent'], /mousse/)
    assert.match(JSON.stringify(capture.body.system), /cc_entrypoint=mousse/)
  }
  assert.deepEqual(captures[0].body.system, captures[1].body.system, 'system prefix stays byte-identical across resume')
  assert.deepEqual(captures[0].body.tools, captures[1].body.tools)
  // Claude moves the cache breakpoint to the newest turn; the previously cached content must stay identical.
  const content = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item))
  assert.deepEqual(content(captures[0].body.messages[0]), content(captures[1].body.messages[0]))
  // Optional synthetic-only capture for checking an external proxy implementation. No Authorization headers.
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(captures.map(({ headers, body }) => ({
    headers: Object.fromEntries(Object.entries(headers).filter(([key]) => !/authorization|api-key/i.test(key))), body
  }))))
  console.log(JSON.stringify({ requests: captures.length, userAgent: captures[0].headers['user-agent'], entrypoint: 'mousse', stableSystemAndTools: true, stableFirstMessage: true, upstreamRequests: 0 }))
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  rmSync(home, { recursive: true, force: true })
}
