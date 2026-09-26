import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

// Optional local browser qualification; CI still exercises the same API in gitFoundationProtocol.test.ts.
it.runIf(Boolean(process.env.MOUSSE_FOUNDATION_BROWSER_BIN))('rendered Undo and Redo buttons change real Git and preserve transcript history through the daemon API', async () => {
  const f = gitFoundationFixture()
  const session = `mousse-foundation-${Date.now()}`
  const browser = (...args: string[]) => promisify(execFile)(process.env.MOUSSE_FOUNDATION_BROWSER_BIN!, ['--session', session, ...args], { timeout: 30_000, windowsHide: true })
  let main: MousseMainService | undefined
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined
  const requests: string[] = []
  const http = createServer(async (req, res) => {
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(join(f.root, 'app.js'))); return }
    if (req.url === '/rpc' && req.method === 'POST') {
      try {
        let body = ''; for await (const chunk of req) body += chunk
        const { method, params } = JSON.parse(body)
        if (!['actions.list', 'workspace.getStatus', 'actions.undoLatest', 'actions.redo'].includes(method)) throw new Error('Unexpected fixture method')
        requests.push(method)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(await client!.request(method, params)))
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><html><head><title>Task change controls qualification</title></head><body><h1>Task changes</h1><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
  })
  try {
    await build({ entryPoints: ['tests/fixtures/git-foundation-ui.tsx'], outfile: join(f.root, 'app.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent' })
    main = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await main.start()
    const ownerToken = main.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms: main, ownerToken, version: 'test' })
    client = new LocalMmsClient({ homeDir: f.home, ownerToken, endpoint: await server.start(), clientType: 'gui' })
    await client.connect()
    const project = main.projects.openProject(f.repo)
    const thread = main.threads.createThread('UI task', project.id)
    const directory = main.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    main.orchestrator.replaceConversationState(thread.id, [
      { id: 'u', role: 'user', content: 'Change task', timestamp: Date.now() },
      { id: 'a', role: 'assistant', content: 'Changed task', timestamp: Date.now() }
    ], { version: 2, fidelity: 'native', activeStartIndex: 0, messages: [
      { role: 'user', content: 'Change task', timestamp: Date.now() },
      { role: 'user', content: 'Result', timestamp: Date.now() }
    ] })
    await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(workspace), threadId: thread.id }, () => writeFileSync(join(workspace, 'value.txt'), 'from UI task\n'))
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    const address = http.address() as { port: number }
    await browser('open', `http://127.0.0.1:${address.port}/?threadId=${thread.id}`)
    await browser('wait', '--text', 'Undo latest turn')
    expect((await browser('snapshot', '-i')).stdout).toContain('Undo latest turn')
    await browser('find', 'role', 'button', 'click', '--name', 'Undo latest turn')
    await browser('wait', '--text', 'Redo last undo')
    expect(f.read(workspace)).toBe('base\n')
    expect(main.orchestrator.getMessages(thread.id)).toHaveLength(0)
    expect(main.orchestrator.getMessagesForPersistence(thread.id)).toHaveLength(2)
    expect((await browser('snapshot', '-i')).stdout).toContain('Redo last undo')
    await browser('find', 'role', 'button', 'click', '--name', 'Redo last undo')
    await browser('wait', '--text', 'Undo latest turn')
    expect(f.read(workspace)).toBe('from UI task\n')
    expect(main.orchestrator.getMessages(thread.id)).toHaveLength(2)
    expect(requests.filter((method) => method === 'actions.undoLatest')).toHaveLength(1)
    expect(requests.filter((method) => method === 'actions.redo')).toHaveLength(1)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  } finally {
    await browser('close').catch(() => undefined)
    await new Promise<void>((done) => http.close(() => done()))
    await client?.close(); await server?.stop(); await main?.stop()
    f.dispose()
  }
}, 90_000)
