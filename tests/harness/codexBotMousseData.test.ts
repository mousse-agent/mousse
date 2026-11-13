/**
 * What a bot's turn on the real Codex reaches of what is closed to bots (`botClosedPlaces`): Mousse's own data (the owner
 * token, a saved sign-in, the installation's settings, the service's socket, another bot's browser profile, Mousse's
 * folders in the temporary folder, the in-app browser's cookie store) and the sign-ins of the CLIs it runs (Codex's
 * `auth.json`, Claude Code's credentials and `.claude.json`), by name, through links and by search; and that the entry's
 * own Codex still signs in with its own `auth.json`, which the bot can't read.
 * Bots with file access, with and without "run commands", and one with commands but no file access; on an entry of the
 * owner's own Codex (its package outside the Mousse home) and on one Mousse manages (its package and Codex home inside
 * it). The model is a fake Responses endpoint in this process; every token, sign-in and setting is a fake made in a test
 * home, and nobody signs in.
 *
 * Linux only: Codex's sandbox there is bubblewrap, shipped in its package. Which binaries: as in `codexBotTools.test.ts`
 * (the pinned one, or `MOUSSE_CODEX_BINARIES`).
 */
import { createServer, type Server } from 'node:http'
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, type Dirent, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexProviderService, codexEnvironment } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { CodexConnection } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import type { CodexModel } from '../../src/mms/harness/vendors/codex/protocol'
import { CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { CODEX_BOT_WRITE_LIMIT_TEXT, codexPackageOf } from '../../src/mms/harness/vendors/codex/childPolicy'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botClosedPlaces } from '../../src/mms/data/closedPlaces'
import type { NeutralTool } from '../../src/shared/harness/tools'

const pinned = new CodexInstallation({ installationHome: resolve(__dirname, '..', '..', '.cache', 'codex-pin') }).installed()
const listed = (process.env.MOUSSE_CODEX_BINARIES || process.env.MOUSSE_CODEX_BINARY || '').split(delimiter).filter(Boolean)
const BINARIES: Array<string | undefined> = listed.length ? listed : [pinned && !pinned.broken ? pinned.path : undefined]
const versionOf = (binary: string): string => execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1)!
const LINUX = process.platform === 'linux'

type Item = Record<string, unknown>
type Body = { input?: Item[]; tools?: Array<{ type?: string; name?: string }> }
/** One call the fake model makes, built from the request it answers (to pick the form of `apply_patch` it was offered). */
type Call = (body: Body, n: number) => Item

const command = (cmd: string): Call => (_body, n) => ({ type: 'function_call', id: `f${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd, yield_time_ms: 10_000 }) })
const patch = (text: string): Call => (body, n) => (body.tools ?? []).find((tool) => tool.name === 'apply_patch')?.type === 'custom'
  ? { type: 'custom_tool_call', id: `p${n}`, call_id: `call_${n}`, name: 'apply_patch', input: text }
  : { type: 'function_call', id: `p${n}`, call_id: `call_${n}`, name: 'apply_patch', arguments: JSON.stringify({ input: text }) }

const ENTRIES = ['the owner\'s own Codex', 'a Codex Mousse manages'] as const

for (const BINARY of BINARIES) for (const entry of ENTRIES) describe.skipIf(!BINARY || !LINUX)(`what a bot on Codex ${BINARY && LINUX ? versionOf(BINARY) : ''} reaches of Mousse's own data, on ${entry}${BINARY ? '' : ' [skipped: no pinned Codex; run npm run codex:pin]'}`, () => {
  /** A mark only this run's fake secrets and files carry. */
  const MARK = `m${randomUUID().slice(0, 8)}`
  let root: string
  let server: Server
  let socket: SocketServer
  let service: CodexProviderService
  let questions: UserQuestionService
  let model: string
  let requests: Body[] = []
  /** The `Authorization` of every model request: Codex's own sign-in, from its home's `auth.json`. */
  let bearers: string[] = []
  let codexHome = ''
  let script: Call[] = []
  const at: Record<string, string> = {}

  beforeAll(async () => {
    // Beside the pinned Codex rather than in the temporary folder: with file access, every entry beside the way down to
    // the Mousse home is a writable root, and a temporary folder can hold thousands.
    const cache = resolve(__dirname, '..', '..', '.cache')
    mkdirSync(cache, { recursive: true })
    root = realpathSync(mkdtempSync(join(cache, 'codex-bot-data-')))
    const home = join(root, 'user')
    const mousse = join(home, '.mousse')
    const profile = join(mousse, 'profiles', 'p1')
    Object.assign(at, {
      home, mousse,
      token: join(mousse, 'mms.owner.json'),
      settings: join(mousse, 'mousse.conf'),
      signIn: join(profile, 'harness', 'codex', 'entry-a', 'auth.json'),
      socket: join(mousse, 'mms.sock'),
      files: join(profile, 'bots', 'files', 'bot-1'),
      scratch: join(profile, 'bots', 'scratch', 'act-1'),
      elsewhere: join(root, 'elsewhere'),
      temp: mkdtempSync(join(tmpdir(), 'mousse-pr-')),
      // Mousse's own data outside its home: the app's Electron user data (the in-app browser's cookie store), and inside
      // the home another bot's browser profile.
      electron: join(home, '.config', 'mousse'),
      cookies: join(home, '.config', 'mousse', 'Partitions', 'mousse-browser', 'Cookies'),
      otherBot: join(mousse, 'browser', 'user-data', 'p1', 'workspaces', 'botbrowser_other', 'Default', 'Cookies'),
      // The owner's own CLIs: Codex's sign-in, Claude Code's credentials and its global config (an API key from /login),
      // and beside them ordinary configuration that stays open.
      codexAuth: join(home, '.codex', 'auth.json'),
      claudeCredentials: join(home, '.claude', '.credentials.json'),
      claudeSettings: join(home, '.claude', 'settings.json'),
      claudeJson: join(home, '.claude.json'),
      bashrc: join(home, '.bashrc')
    })
    for (const dir of [at.files, at.scratch, at.elsewhere, join(profile, 'harness', 'codex', 'entry-a'), join(at.cookies, '..'), join(at.otherBot, '..'), join(home, '.codex'), join(home, '.claude')]) mkdirSync(dir, { recursive: true })
    writeFileSync(at.token, JSON.stringify({ pid: 1, token: `OWNER-${MARK}` }))
    writeFileSync(at.settings, `SETTINGS-${MARK}\n`)
    writeFileSync(at.signIn, JSON.stringify({ tokens: { access_token: `SIGNIN-${MARK}` } }))
    writeFileSync(join(at.temp, 'body.md'), `TEMP-${MARK}\n`)
    writeFileSync(join(at.files, 'own.txt'), `OWN-${MARK}\n`)
    writeFileSync(join(at.elsewhere, 'ordinary.txt'), `ORDINARY-${MARK}\n`)
    writeFileSync(at.cookies, `COOKIE-${MARK}\n`)
    writeFileSync(at.otherBot, `BOTCOOKIE-${MARK}\n`)
    writeFileSync(at.codexAuth, JSON.stringify({ OPENAI_API_KEY: `sk-fake-CODEXAUTH-${MARK}` }))
    writeFileSync(at.claudeCredentials, JSON.stringify({ claudeAiOauth: { accessToken: `CLAUDECRED-${MARK}` } }))
    writeFileSync(at.claudeSettings, `{"CLAUDESETTINGS": "${MARK}"}\n`)
    writeFileSync(at.claudeJson, JSON.stringify({ primaryApiKey: `CLAUDEJSON-${MARK}` }))
    writeFileSync(at.bashrc, 'before\n')
    symlinkSync(at.token, join(at.elsewhere, 'token-link'))
    symlinkSync(join(mousse, 'profiles'), join(at.elsewhere, 'profiles-link'))
    symlinkSync(at.cookies, join(at.elsewhere, 'cookie-link'))
    symlinkSync(join(home, '.claude'), join(at.elsewhere, 'claude-link'))
    symlinkSync(at.codexAuth, join(at.elsewhere, 'codex-auth-link'))
    socket = createSocketServer((connection) => connection.end('connected\n'))
    await new Promise<void>((done) => socket.listen(at.socket, done))

    // The Codex that runs the turn: the binary as it is, or a copy of its package inside the Mousse home, with a Codex
    // home there too, as for an entry Mousse manages.
    let binary = BINARY!
    codexHome = join(home, '.codex')
    if (entry === 'a Codex Mousse manages') {
      const real = realpathSync(BINARY!)
      const codexPackage = codexPackageOf(real)!
      const copy = join(mousse, 'managed', 'codex', versionOf(real))
      mkdirSync(join(copy, '..'), { recursive: true })
      try {
        execFileSync('cp', ['-al', codexPackage, copy])
      } catch {
        cpSync(codexPackage, copy, { recursive: true })
      }
      binary = join(copy, relative(codexPackage, real))
      codexHome = join(profile, 'harness', 'codex', 'entry-b')
    }
    mkdirSync(codexHome, { recursive: true })
    // The entry's own sign-in, which its Codex reads for every model request (`requires_openai_auth` below).
    if (codexHome !== join(home, '.codex')) writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: `sk-fake-managed-${MARK}` }))

    server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return }
        const body = JSON.parse(text) as Body
        requests.push(body)
        bearers.push(String(req.headers.authorization ?? ''))
        // Each call's output brings the next call; after the last, the model is done.
        const answered = (body.input ?? []).filter((item) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output').length
        const next = script[answered]
        const item = next ? next(body, answered) : { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        send('response.output_item.done', { item })
        send('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
        res.end()
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const port = (server.address() as { port: number }).port
    writeFileSync(join(codexHome, 'config.toml'), [
      'model_provider = "probe"',
      '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = true', ''
    ].join('\n'))
    questions = new UserQuestionService()
    service = new CodexProviderService(join(root, 'state-home'), questions, {}, {
      dir: join(root, 'state'),
      env: () => ({ ...codexEnvironment(), CODEX_HOME: codexHome, USERPROFILE: home, HOME: home }),
      modelProvider: 'probe',
      launch: () => ({ binaryPath: binary }),
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, label: 'data check', subject: 'data-check' }) }
    })
    await service.status()
    const conn = (service as unknown as { app: { conn: CodexConnection } }).app.conn
    const models: CodexModel[] = (await conn.request('model/list', { includeHidden: true })).data
    model = (models.find((candidate) => candidate.multiAgentVersion === null) ?? models[0]!).id
  }, 120_000)

  afterAll(async () => {
    service?.stop()
    await service?.processesExited()
    questions?.shutdown()
    server?.close()
    socket?.close()
    if (at.temp) rmSync(at.temp, { recursive: true, force: true })
    // A bot's `mv` of the Mousse home left a copy of its closed view: folders it may not open.
    if (root) execFileSync('chmod', ['-R', 'u+rwX', root])
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }, 30_000)

  let threads = 0
  /** A bot holding `tools`, with file access (as Allow writes it) or without. */
  function botOf(tools: NeutralTool[], fileAccess: boolean) {
    // What compile gives a bot with file access: the Mousse home closed, and every other place `botClosedPlaces` lists, for
    // this test home (the owner's Codex runs with `CODEX_HOME`; the app's Electron user data is the test home's).
    const outside = botClosedPlaces({ mousseHome: at.mousse, env: { CODEX_HOME: codexHome, MOUSSE_ELECTRON_USER_DATA: at.electron }, userHome: at.home, temps: [tmpdir()], entryEnvs: [] })
    const workspace = fileAccess
      ? { roots: ['/'], access: 'write' as const, writeRoots: ['/'], scratch: at.scratch, files: at.files, computer: { closed: at.mousse, outside } }
      : { roots: [], access: 'read' as const, writeRoots: [], scratch: at.scratch, files: at.files }
    const bot = createBotAuthority({
      activationId: `act-${threads}`, role: 'activation',
      permissions: { tools, appTools: [], mcp: [], skills: [], workspace },
      waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    return { bot }
  }

  /** One turn whose model makes `calls` in order: what each call's output was, and every request the model saw. */
  async function turn(calls: Call[], bot?: ReturnType<typeof botOf>['bot']) {
    requests = []
    bearers = []
    script = calls
    await service.chat({ threadId: `data-${threads++}`, cwd: bot ? at.scratch : at.elsewhere, model, prompt: 'Go.', mcp: null, ...(bot ? { bot } : {}), onText: () => undefined })
    const outputs = new Map<string, string>()
    for (const item of requests.at(-1)?.input ?? [])
      if (typeof item.call_id === 'string' && String(item.type).endsWith('_call_output')) outputs.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output))
    return { outputs: calls.map((_call, n) => outputs.get(`call_${n}`) ?? '(no output)'), seen: JSON.stringify(requests), offered: (requests[0]?.tools ?? []).map((tool) => tool.name ?? tool.type ?? '?') }
  }

  /** Mousse's own data: none of it may reach the model. */
  const SECRETS = () => [`OWNER-${MARK}`, `SIGNIN-${MARK}`, `SETTINGS-${MARK}`, `TEMP-${MARK}`, `COOKIE-${MARK}`, `BOTCOOKIE-${MARK}`, `CODEXAUTH-${MARK}`, `managed-${MARK}`, `CLAUDECRED-${MARK}`, `CLAUDEJSON-${MARK}`]

  /** The files under `dir` (links not followed) whose text holds one of `marks`. */
  function holding(dir: string, marks: readonly string[]): string[] {
    const found: string[] = []
    const walk = (at: string): void => {
      let entries: Dirent[]
      try {
        entries = readdirSync(at, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(at, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) {
          try {
            const text = readFileSync(path, 'utf8')
            if (marks.some((mark) => text.includes(mark))) found.push(path)
          } catch {
            // Unreadable: it holds nothing the bot could use.
          }
        }
      }
    }
    walk(dir)
    return found
  }

  // Every way in a command has: by name, through a link to the file and to a folder on the way, a search of the whole
  // home, a program of its own, Mousse's folder in /tmp; then the control, an ordinary file and the bot's own.
  const reads = (): Array<[string, string, string | undefined]> => [
    ['the owner token, with cat', `cat ${at.token}`, undefined],
    ['a saved sign-in, with cat', `cat ${at.signIn}`, undefined],
    ['the settings file, with head', `head ${at.settings}`, undefined],
    ['a link to the token', `cat ${join(at.elsewhere, 'token-link')}`, undefined],
    ['a link to a folder on the way', `cat ${join(at.elsewhere, 'profiles-link', 'p1', 'harness', 'codex', 'entry-a', 'auth.json')}`, undefined],
    ['the Mousse home, listed', `ls -la ${at.mousse}`, undefined],
    ['the Mousse home, searched', `grep -r ${MARK} ${at.mousse}`, undefined],
    ['Mousse\'s folder in /tmp', `cat ${join(at.temp, 'body.md')}`, undefined],
    ['the token, by a program', `python3 -c "print(open('${at.token}').read())"`, undefined],
    ['the in-app browser\'s cookie store', `cat ${at.cookies}`, undefined],
    ['a link to the cookie store', `cat ${join(at.elsewhere, 'cookie-link')}`, undefined],
    ['the Electron user data, searched', `grep -r ${MARK} ${at.electron}`, undefined],
    ['another bot\'s browser profile', `cat ${at.otherBot}`, undefined],
    ['the owner\'s Codex sign-in', `cat ${at.codexAuth}`, undefined],
    ['a link to the Codex sign-in', `cat ${join(at.elsewhere, 'codex-auth-link')}`, undefined],
    ['Claude Code\'s credentials', `cat ${at.claudeCredentials}`, undefined],
    ['Claude Code\'s credentials, through a link to its folder', `cat ${join(at.elsewhere, 'claude-link', '.credentials.json')}`, undefined],
    ['Claude Code\'s global config', `cat ${at.claudeJson}`, undefined],
    ['Claude Code\'s settings beside its credentials', `cat ${at.claudeSettings}`, 'CLAUDESETTINGS'],
    ['an ordinary file', `cat ${join(at.elsewhere, 'ordinary.txt')}`, `ORDINARY-${MARK}`],
    ['its own file', `cat ${join(at.files, 'own.txt')}`, `OWN-${MARK}`]
  ]

  it.skipIf(!LINUX)('with file access and "run commands": no command reads or changes Mousse\'s data, a link and a program included; an ordinary file and its own folder are read and written', async () => {
    const { bot } = botOf(['read', 'list', 'search', 'edit', 'write', 'shell'], true)
    const probes = reads()
    const changes: Array<[string, string]> = [
      ['a new file in the Mousse home', `sh -c 'echo x > ${join(at.mousse, 'new.txt')}'`],
      ['the settings file, overwritten', `sh -c 'echo x > ${at.settings}'`],
      ['a copy of the token', `cp ${at.token} ${join(at.elsewhere, 'copy.json')}`],
      ['a hard link to the token', `ln ${at.token} ${join(at.elsewhere, 'hard.json')}`],
      ['the home moved away', `mv ${at.mousse} ${join(at.elsewhere, 'moved')}`],
      ['the service\'s socket', `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${at.socket}'); print(s.recv(64).decode())"`],
      ['an ordinary folder', `sh -c 'echo x > ${join(at.elsewhere, 'made.txt')}'`],
      ['its own folder', `sh -c 'echo x > ${join(at.files, 'made.txt')}'`],
      ['a file directly in the home folder', `sh -c 'echo x >> ${at.bashrc}'`]
    ]
    // The same file changed with the file tool, which asks Mousse's check instead of running in the sandbox.
    const bashrcPatch = patch(`*** Begin Patch\n*** Update File: ${at.bashrc}\n@@\n-before\n+after\n*** End Patch`)
    const { outputs, seen, offered } = await turn([...probes.map(([, cmd]) => command(cmd)), ...changes.map(([, cmd]) => command(cmd)), bashrcPatch], bot)
    for (const secret of SECRETS()) expect(seen, `${secret.split('-')[0]} reached the model`).not.toContain(secret)
    probes.forEach(([what, , expected], n) => { if (expected) expect(outputs[n], what).toContain(expected) })
    expect(outputs[probes.length + 5], 'the service\'s socket').not.toContain('connected')
    // Mousse's data is where it was, unchanged; `mv` could only copy the closed view of it (empty, unreadable folders),
    // and no file the bot made holds anything of it.
    expect(readFileSync(at.token, 'utf8')).toContain(`OWNER-${MARK}`)
    expect(readFileSync(at.settings, 'utf8')).toBe(`SETTINGS-${MARK}\n`)
    expect(readFileSync(at.signIn, 'utf8')).toContain(`SIGNIN-${MARK}`)
    for (const made of [join(at.mousse, 'new.txt'), join(at.elsewhere, 'copy.json'), join(at.elsewhere, 'hard.json')]) expect(existsSync(made), made).toBe(false)
    expect(holding(at.elsewhere, SECRETS())).toEqual([])
    for (const made of [join(at.elsewhere, 'made.txt'), join(at.files, 'made.txt')]) expect(existsSync(made), made).toBe(true)
    // A file directly in the home folder: the command can't change it (the system's own refusal, which Codex doesn't offer
    // to retry), the turn's instructions say so and what to use instead, and the file tool can (when Codex offers it).
    expect(outputs[probes.length + changes.length - 1], 'a file directly in the home folder').toContain('Read-only file system')
    expect(seen).toContain(JSON.stringify(CODEX_BOT_WRITE_LIMIT_TEXT).slice(1, -1))
    if (offered.includes('apply_patch')) expect(readFileSync(at.bashrc, 'utf8')).toBe('after\n')
    // The entry's own Codex signed in with its own sign-in for every model request, closed to the bot as it was.
    expect(bearers.length).toBeGreaterThan(0)
    expect(new Set(bearers)).toEqual(new Set([codexHome === join(at.home, '.codex') ? `Bearer sk-fake-CODEXAUTH-${MARK}` : `Bearer sk-fake-managed-${MARK}`]))
  }, 240_000)

  it.skipIf(!LINUX)('with file access and no "run commands": no command tool, and a file change in Mousse\'s data is refused while one elsewhere and in its own folder goes through', async () => {
    const { bot } = botOf(['read', 'list', 'search', 'edit', 'write'], true)
    const ordinary = join(at.elsewhere, 'patched.txt')
    writeFileSync(ordinary, 'before\n')
    const calls = [
      command(`cat ${at.token}`),
      patch(`*** Begin Patch\n*** Add File: ${join(at.mousse, 'added.txt')}\n+x\n*** End Patch`),
      patch(`*** Begin Patch\n*** Delete File: ${at.signIn}\n*** End Patch`),
      patch(`*** Begin Patch\n*** Delete File: ${at.codexAuth}\n*** End Patch`),
      patch(`*** Begin Patch\n*** Delete File: ${join(at.elsewhere, 'claude-link', '.credentials.json')}\n*** End Patch`),
      patch(`*** Begin Patch\n*** Add File: ${join(at.cookies, '..', 'added')}\n+x\n*** End Patch`),
      patch(`*** Begin Patch\n*** Update File: ${ordinary}\n@@\n-before\n+after\n*** End Patch`),
      patch(`*** Begin Patch\n*** Add File: ${join(at.files, 'added.txt')}\n+x\n*** End Patch`)
    ]
    const { seen, offered } = await turn(calls, bot)
    expect(offered.filter((name) => /^(shell|exec_command|write_stdin|local_shell)$/.test(name))).toEqual([])
    for (const secret of SECRETS()) expect(seen, `${secret.split('-')[0]} reached the model`).not.toContain(secret)
    expect(existsSync(join(at.mousse, 'added.txt'))).toBe(false)
    expect(readFileSync(at.signIn, 'utf8')).toContain(`SIGNIN-${MARK}`)
    expect(readFileSync(at.codexAuth, 'utf8')).toContain(`CODEXAUTH-${MARK}`)
    expect(readFileSync(at.claudeCredentials, 'utf8')).toContain(`CLAUDECRED-${MARK}`)
    expect(existsSync(join(at.cookies, '..', 'added'))).toBe(false)
    // The control: Codex offered `apply_patch` to this model, and the same bot's changes outside Mousse's data went through.
    if (offered.includes('apply_patch')) {
      expect(readFileSync(ordinary, 'utf8')).toBe('after\n')
      expect(existsSync(join(at.files, 'added.txt'))).toBe(true)
    }
  }, 240_000)

  it.skipIf(!LINUX)('with "run commands" and no file access: no command reads Mousse\'s data; its own folder is read', async () => {
    const { bot } = botOf(['read', 'shell'], false)
    const probes = reads()
    const { outputs, seen } = await turn(probes.map(([, cmd]) => command(cmd)), bot)
    for (const secret of SECRETS()) expect(seen, `${secret.split('-')[0]} reached the model`).not.toContain(secret)
    expect(outputs[probes.length - 1], 'its own file').toContain(`OWN-${MARK}`)
    expect(outputs[probes.length - 2], 'an ordinary file, outside its grant').not.toContain(`ORDINARY-${MARK}`)
  }, 240_000)

  it.skipIf(!LINUX)('the owner\'s own thread on the same Codex is unchanged: a command they allow reads what it could before', async () => {
    // The owner allows what their thread asks, as they would in the app.
    questions.on('pending', (request: { requestId: string }) => questions.submitAnswers(request.requestId, { permission: 'allow' }, { kind: 'user' }))
    const { outputs } = await turn([command(`cat ${at.token}`)])
    expect(outputs[0]).toContain(`OWNER-${MARK}`)
  }, 120_000)
})
