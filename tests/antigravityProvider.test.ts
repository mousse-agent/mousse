import { once } from 'node:events'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService, antigravityStdout, forwardAntigravityCallback } from '../src/mms/providers/antigravity/AntigravityProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=owned-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A41414%2F'

describe('Antigravity ACP auth transport', () => {
  it('removes the official auth line from ACP stdout without altering JSON-RPC', async () => {
    const onAuth = vi.fn()
    const output: Buffer[] = []
    const transform = antigravityStdout(onAuth)
    transform.on('data', (chunk: Buffer) => output.push(chunk))
    Readable.from([`{"jsonrpc":"2.0","id":1}\nOpen the following link to authenticate the ACP server: ${authUrl}\n`, '{"jsonrpc":"2.0","id":2}\n']).pipe(transform)
    await once(transform, 'end')
    expect(onAuth).toHaveBeenCalledWith(authUrl)
    expect(Buffer.concat(output).toString()).toBe('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n')
  })

  it('rejects a callback for a different sign-in state before making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(forwardAntigravityCallback(authUrl, 'http://127.0.0.1:41414/?state=other&code=abc')).rejects.toThrow(/does not match/)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('forwards only the pending Google callback to its loopback listener', async () => {
    let received = ''
    const server = createServer((request, response) => { received = request.url ?? ''; response.end('ok') })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback port')
      const redirect = `http://127.0.0.1:${address.port}/`
      const ownedAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=owned-state&redirect_uri=${encodeURIComponent(redirect)}`
      await forwardAntigravityCallback(ownedAuthUrl, `${redirect}?state=owned-state&code=one-time-code`)
      expect(received).toBe('/?state=owned-state&code=one-time-code')
    } finally { server.close() }
  })

  it.skipIf(process.platform === 'win32')('runs a selected model through an ACP session and streams its reply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-acp-test-'))
    const binaryDir = join(home, 'official-pair')
    mkdirSync(binaryDir)
    const binary = join(binaryDir, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par')
    const helper = join(binaryDir, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
    const sdk = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/@agentclientprotocol/sdk/dist/acp.js')).href
    const script = `import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '${sdk}';\nimport { Readable, Writable } from 'node:stream';\nagent({name:'fixture'}).onRequest(methods.agent.initialize, () => ({protocolVersion:PROTOCOL_VERSION,authMethods:[],agentCapabilities:{}})).onRequest(methods.agent.session.new, () => ({sessionId:'fixture-session',configOptions:[{id:'model',name:'Model',type:'select',currentValue:'account-model',options:[{value:'account-model',name:'Account Model'}]}]})).onRequest(methods.agent.session.setConfigOption, () => ({configOptions:[]})).onRequest(methods.agent.session.prompt, async (c) => {await c.client.notify(methods.client.session.update,{sessionId:c.params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Research',name:'start_subagent'}});await c.client.notify(methods.client.session.update,{sessionId:c.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP says hello'}}});await c.client.notify(methods.client.session.update,{sessionId:c.params.sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'}});return {stopReason:'end_turn'};}).onNotification(methods.agent.session.cancel,()=>{}).connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));\n`
    const fixture = join(binaryDir, 'fixture.mjs')
    writeFileSync(fixture, script)
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`)
    writeFileSync(helper, '')
    chmodSync(binary, 0o755)
    const profile = join(home, 'profile')
    mkdirSync(join(profile, 'providers', 'antigravity'), { recursive: true })
    writeFileSync(join(profile, 'providers', 'antigravity', 'settings.json'), JSON.stringify({ binaryPath: binary, signedIn: true, models: [{ id: 'older-model', label: 'Older Model' }] }))
    const service = new AntigravityProviderService(profile, home, new UserQuestionService())
    try {
      let streamed = ''
      const tools: Array<{ phase: string; title: string }> = []
      const result = await service.chat({ threadId: 'thread-1', cwd: home, model: 'account-model', prompt: 'Hello', onText: (value) => { streamed = value }, onTool: (event) => tools.push(event) })
      expect(result).toBe('ACP says hello')
      expect(streamed).toBe(result)
      expect(service.llmProvider()?.models).toEqual([{ id: 'account-model', label: 'Account Model' }])
      expect(tools).toEqual([
        expect.objectContaining({ phase: 'start', title: 'Antigravity subagent: Research' }),
        expect.objectContaining({ phase: 'complete', title: 'Antigravity subagent: Research' })
      ])
    } finally {
      service.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
