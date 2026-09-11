#!/usr/bin/env node
/**
 * Reusable Linux Q04 qualification runner.
 * Exercises the production Node CLI and, when host libraries permit,
 * production electron-builder Linux AppImage/dir paths.
 *
 * Usage (from a Linux source tree after overlay install + production build):
 *   node scripts/qualification/linux/run-linux-qualification.mjs [--phase all|probe|cli|package] [--root <dir>]
 *
 * Never uses ~/.mousse, live accounts, Chrome downloads, Docker, or privileged package installs.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { QualMmsClient, readOwnerRecord, unixSocketPath } from './protocol-client.mjs'
import { plantLegacyHome } from '../../../tests/fixtures/agent-platform/package-linux/plant-legacy-home.mjs'
import {
  passthroughWorkflowBundle,
  scriptOnlyWorkflowBundle
} from '../../../tests/fixtures/agent-platform/package-linux/script-only-workflow.mjs'

const args = parseArgv(process.argv.slice(2))
const projectRoot = resolve(args.root ?? process.cwd())
const phase = args.phase ?? 'all'
const evidenceDir = resolve(args.evidence ?? join(projectRoot, 'qualification-evidence'))
const runtimeRoot = resolve(args.runtime ?? join(projectRoot, 'qualification-runtime'))
const MIN_WSL_FREE_BYTES = 5 * 1024 * 1024 * 1024
const MIN_WIN_FREE_BYTES = 1 * 1024 * 1024 * 1024
const CLI_TIMEOUT_MS = 45_000
const SERVICE_WAIT_MS = 45_000
const STOP_WAIT_MS = 35_000

const evidence = {
  startedAt: new Date().toISOString(),
  phase,
  projectRoot,
  candidate: {},
  host: {},
  disk: [],
  commands: [],
  cli: {},
  package: {},
  blockers: [],
  g7: 'pending',
  notes: []
}

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) out[key] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out[key] = argv[i + 1]
        i += 1
      } else out[key] = true
    }
  }
  return out
}

function sha256File(path) {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function truncate(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… truncated ${value.length - max} bytes`
}

function runCommand(command, commandArgs, opts = {}) {
  const cwd = opts.cwd ?? projectRoot
  const timeoutMs = opts.timeoutMs ?? CLI_TIMEOUT_MS
  const env = { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) }
  const started = Date.now()
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  })
  const record = {
    command: [command, ...commandArgs].join(' '),
    cwd,
    exit: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : null
  }
  evidence.commands.push({ ...record, stdout: truncate(record.stdout), stderr: truncate(record.stderr) })
  return record
}

function dfBytes(mount) {
  const result = spawnSync('df', ['-B1', '--output=avail,target', mount], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const line = result.stdout.trim().split('\n').at(-1)
  const avail = Number((line ?? '').trim().split(/\s+/)[0])
  return Number.isFinite(avail) ? avail : null
}

function recordDisk(label) {
  const snapshot = {
    at: new Date().toISOString(),
    label,
    wslRoot: dfBytes('/'),
    winC: dfBytes('/mnt/c')
  }
  evidence.disk.push(snapshot)
  if (snapshot.wslRoot != null && snapshot.wslRoot < MIN_WSL_FREE_BYTES) {
    throw new Error(`Stopping: WSL free space ${snapshot.wslRoot} bytes is below ${MIN_WSL_FREE_BYTES}`)
  }
  if (snapshot.winC != null && snapshot.winC < MIN_WIN_FREE_BYTES) {
    evidence.notes.push(`Windows C: free space is ${snapshot.winC} bytes; refusing writes to /mnt/c`)
  }
  return snapshot
}

function which(bin) {
  const result = spawnSync('bash', ['-lc', `command -v ${bin} || true`], { encoding: 'utf8' })
  return (result.stdout ?? '').trim() || null
}

function ldconfigMatch(pattern) {
  const result = spawnSync('bash', ['-lc', `ldconfig -p 2>/dev/null | grep -E ${JSON.stringify(pattern)} || true`], {
    encoding: 'utf8'
  })
  return (result.stdout ?? '').trim().split('\n').filter(Boolean)
}

function cliBin() {
  return join(projectRoot, 'out', 'cli', 'index.js')
}

function nodeCli(cliArgs, opts = {}) {
  const home = opts.home
  const env = { ...(opts.env ?? {}) }
  if (home) env.MOUSSE_HOME = home
  const argv = home ? ['--home', home, ...cliArgs] : cliArgs
  return runCommand(process.execPath, [cliBin(), ...argv], { ...opts, env, timeoutMs: opts.timeoutMs ?? CLI_TIMEOUT_MS })
}

function parseJsonLines(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const values = []
  for (const line of lines) {
    try {
      values.push(JSON.parse(line))
    } catch {
      values.push({ unparsed: line })
    }
  }
  return values
}

function readJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertOwnedPath(root, parent) {
  const resolvedRoot = resolve(root)
  const resolvedParent = resolve(parent)
  const rel = relative(resolvedParent, resolvedRoot)
  if (!rel || isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Refusing path outside owned parent: ${resolvedRoot}`)
  }
  return resolvedRoot
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function environHasHome(pid, homeDir) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`)
    return raw.toString('utf8').split('\0').includes(`MOUSSE_HOME=${homeDir}`)
  } catch {
    return false
  }
}

function ownedPidsForHome(homeDir) {
  const pids = []
  if (!existsSync('/proc')) return pids
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    if (environHasHome(pid, homeDir)) pids.push(pid)
  }
  return pids
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function addBlocker(kind, detail) {
  evidence.blockers.push({ kind, detail })
}

function probeHost() {
  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : ''
  const node = runCommand(process.execPath, ['-v'])
  const npm = runCommand('npm', ['-v'])
  evidence.host = {
    osRelease,
    uname: spawnSync('uname', ['-a'], { encoding: 'utf8' }).stdout.trim(),
    id: spawnSync('id', [], { encoding: 'utf8' }).stdout.trim(),
    node: (node.stdout ?? '').trim(),
    npm: (npm.stdout ?? '').trim(),
    nproc: spawnSync('nproc', [], { encoding: 'utf8' }).stdout.trim(),
    display: process.env.DISPLAY ?? null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ?? null,
    wslg: existsSync('/mnt/wslg'),
    xvfb: which('Xvfb'),
    docker: which('docker'),
    dockerRunning: spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0,
    chrome: which('google-chrome') || which('chromium') || which('chromium-browser'),
    fusermount: which('fusermount') || which('fusermount3'),
    fuseLibs: spawnSync('bash', ['-lc', 'ls /lib64/libfuse.so* /usr/lib64/libfuse.so* 2>/dev/null || true'], {
      encoding: 'utf8'
    }).stdout.trim(),
    appimagetool: which('appimagetool'),
    mksquashfs: which('mksquashfs'),
    gcc: which('gcc'),
    electronCache: existsSync(join(homedir(), '.cache/electron')),
    electronBuilderCache: existsSync(join(homedir(), '.cache/electron-builder')),
    gtkNss: ldconfigMatch('libgtk-3|libnss3|libasound|libgbm|libX11.so|libXss|libatk-bridge|libcups|libdrm.so|libpango-1|libcairo.so|libXcomposite|libXdamage|libXrandr|libxkbcommon.so')
  }
  if (!evidence.host.chrome) {
    addBlocker('missing-certified-browser', 'No google-chrome/chromium on PATH; Chrome for Testing was not downloaded.')
  }
  if (!evidence.host.xvfb) {
    evidence.notes.push('Xvfb not found; using existing DISPLAY/WSLg if present.')
  }
  if (evidence.host.dockerRunning) {
    evidence.notes.push('Docker daemon is running; this runner does not start or use it.')
  }
}

function captureCandidate() {
  const git = runCommand('git', ['rev-parse', 'HEAD'])
  const status = runCommand('git', ['status', '--short'])
  const pkg = readJson(join(projectRoot, 'package.json'))
  const marker = [join(projectRoot, 'SOURCE_SHA'), join(projectRoot, '..', 'SOURCE_SHA')]
    .find((path) => existsSync(path))
  const markerSha = marker ? readFileSync(marker, 'utf8').trim() : ''
  const gitSha = (git.stdout ?? '').trim()
  evidence.candidate = {
    sourceSha: git.exit === 0 && gitSha ? gitSha : markerSha,
    sourceShaSource: git.exit === 0 && gitSha ? 'git' : marker ? marker : 'unknown',
    gitStatus: (status.stdout ?? '').trim(),
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    engines: pkg?.engines ?? null,
    overlay: {
      packageJsonSha256: sha256File(join(projectRoot, 'package.json')),
      packageLockSha256: sha256File(join(projectRoot, 'package-lock.json')),
      cleanupScriptSha256: sha256File(join(projectRoot, 'scripts/remove-vulnerable-bundled-deps.mjs'))
    },
    dependencies: {
      piCodingAgent: pkg?.dependencies?.['@earendil-works/pi-coding-agent'] ?? null,
      piCursorSdk: pkg?.dependencies?.['pi-cursor-sdk'] ?? null,
      electron: pkg?.devDependencies?.electron ?? null,
      electronBuilder: pkg?.devDependencies?.['electron-builder'] ?? null,
      vitest: pkg?.devDependencies?.vitest ?? null
    }
  }
}

async function qualifyNodeCli() {
  if (!existsSync(cliBin())) {
    addBlocker('missing-cli-build', `Production CLI bundle missing at ${cliBin()}`)
    evidence.cli.skipped = true
    return
  }
  mkdirSync(runtimeRoot, { recursive: true })
  const home = assertOwnedPath(join(runtimeRoot, 'node-cli-home'), runtimeRoot)
  if (existsSync(home)) throw new Error('Qualification home already exists; choose a fresh --runtime directory')
  plantLegacyHome(home)
  evidence.cli.home = home

  const help = nodeCli(['--help'], { home })
  const version = nodeCli(['--version'], { home })
  evidence.cli.help = { exit: help.exit, stdout: truncate(help.stdout, 1200) }
  evidence.cli.version = { exit: version.exit, stdout: (version.stdout ?? '').trim() }
  if (help.exit !== 0) addBlocker('cli-help', `help exit ${help.exit}`)
  if (version.exit !== 0 || !/mousse-cli 0\.1\.1/.test(version.stdout ?? '')) {
    addBlocker('cli-version', `unexpected version output: ${truncate(version.stdout, 200)}`)
  }

  const preStatus = nodeCli(['--json', 'service', 'status'], { home })
  evidence.cli.preStatus = { exit: preStatus.exit, json: parseJsonLines(preStatus.stdout) }

  const start = nodeCli(['--json', 'service', 'start'], { home, timeoutMs: SERVICE_WAIT_MS })
  evidence.cli.start = { exit: start.exit, json: parseJsonLines(start.stdout), stderr: truncate(start.stderr, 1500) }
  if (start.exit !== 0) {
    addBlocker('daemon-start', `service start exit ${start.exit}: ${truncate(start.stderr || start.stdout, 800)}`)
    return
  }

  const status = nodeCli(['--json', 'service', 'status'], { home })
  evidence.cli.status = { exit: status.exit, json: parseJsonLines(status.stdout) }
  const statusJson = evidence.cli.status.json.find((row) => row && typeof row === 'object' && 'running' in row) ?? {}
  const daemonPid = Number(statusJson.pid)
  evidence.cli.daemonPid = daemonPid

  try {
    await waitFor(() => existsSync(unixSocketPath(home)) && existsSync(join(home, 'mms.owner.json')), 10_000, 'owner+socket')
    const owner = readOwnerRecord(home)
    const client = new QualMmsClient({
      homeDir: home,
      ownerToken: owner.token,
      endpoint: owner.endpoint ?? unixSocketPath(home)
    })
    const hello = await client.connect()
    evidence.cli.hello = {
      protocolVersion: hello.protocolVersion,
      instanceId: hello.instanceId,
      capabilities: hello.capabilities,
      serverVersion: hello.serverVersion ?? null
    }
    const profilesStatus = await client.request('profiles.status', {})
    const listed = await client.request('profiles.list', {})
    evidence.cli.profiles = { status: profilesStatus, list: listed }
    const defaultId = profilesStatus.defaultProfileId
    if (!defaultId) addBlocker('migration-default-profile', 'Daemon started without defaultProfileId')
    await client.request('profiles.bind', { profile: defaultId })
    const created = await client.request('profiles.create', { displayName: 'Linux Qual', slug: 'linux-qual' })
    evidence.cli.createdProfile = created
    const installation = readJson(join(home, 'installation.json'))
    evidence.cli.installation = {
      schemaVersion: installation?.schemaVersion ?? null,
      defaultProfileId: installation?.defaultProfileId ?? null,
      migrationStatus: installation?.migration?.status ?? null,
      profileCount: installation?.profiles?.length ?? null
    }
    if (installation?.migration?.status !== 'committed') {
      addBlocker('migration', `installation.migration.status=${installation?.migration?.status ?? 'missing'}`)
    }
    const personalConf = join(home, 'profiles', defaultId, 'mousse.conf')
    evidence.cli.migratedPersonalConf = existsSync(personalConf)
    evidence.cli.sharedAuthRetained = existsSync(join(home, 'auth.json'))

    const passthrough = passthroughWorkflowBundle()
    const createdWf = await client.request('workflows.create', {
      profileId: defaultId,
      name: passthrough.manifest.name,
      slug: passthrough.manifest.slug,
      bundle: passthrough
    })
    const published = await client.request('workflows.publish', {
      profileId: defaultId,
      id: createdWf.id,
      expectedDraftSemanticHash: createdWf.semanticHash
    })
    evidence.cli.publishedPassthrough = {
      id: published.id,
      slug: published.slug,
      revisionId: published.head?.revisionId ?? null,
      runnable: published.compiled?.runnable ?? null
    }
    await client.close()

    const wfList = nodeCli(['--json', '--profile', defaultId, 'workflow', 'list'], { home })
    evidence.cli.workflowList = { exit: wfList.exit, json: parseJsonLines(wfList.stdout) }
    const wfRun = nodeCli(
      ['--json', '--profile', defaultId, 'workflow', 'run', published.slug, '--input', '{"ping":"linux"}'],
      { home, timeoutMs: 40_000 }
    )
    evidence.cli.workflowRun = { exit: wfRun.exit, json: parseJsonLines(wfRun.stdout), stderr: truncate(wfRun.stderr, 800) }
    if (wfRun.exit !== 0) addBlocker('workflow-run', `passthrough workflow exit ${wfRun.exit}`)

    const scriptClient = new QualMmsClient({
      homeDir: home,
      ownerToken: readOwnerRecord(home).token,
      endpoint: readOwnerRecord(home).endpoint ?? unixSocketPath(home)
    })
    await scriptClient.connect()
    await scriptClient.request('profiles.bind', { profile: defaultId })
    const scriptBundle = scriptOnlyWorkflowBundle()
    const scriptDraft = await scriptClient.request('workflows.create', {
      profileId: defaultId,
      name: scriptBundle.manifest.name,
      slug: scriptBundle.manifest.slug,
      bundle: scriptBundle
    })
    const scriptPublished = await scriptClient.request('workflows.publish', {
      profileId: defaultId,
      id: scriptDraft.id,
      expectedDraftSemanticHash: scriptDraft.semanticHash
    })
    await scriptClient.close()
    const scriptRun = nodeCli(
      ['--json', '--profile', defaultId, 'workflow', 'run', scriptPublished.slug, '--input', '{"count":3}'],
      { home, timeoutMs: 40_000 }
    )
    evidence.cli.scriptWorkflow = {
      exit: scriptRun.exit,
      json: parseJsonLines(scriptRun.stdout),
      stderr: truncate(scriptRun.stderr, 800),
      note: 'CLI admission followed by explicit authenticated fixture GUI approval'
    }
    const admitted = evidence.cli.scriptWorkflow.json.find((row) => row.kind === 'accepted')
    if (!admitted?.runId) throw new Error('Script CLI did not admit a run')
    const approver = new QualMmsClient({ homeDir: home, ownerToken: readOwnerRecord(home).token, clientType: 'gui' })
    await approver.connect()
    try {
      await approver.request('profiles.bind', { profile: defaultId })
      let view
      const deadline = Date.now() + 30_000
      do {
        view = await approver.request('workflowRuns.get', { profileId: defaultId, runId: admitted.runId })
        for (const approval of view.pendingApprovals ?? (view.pendingApproval ? [view.pendingApproval] : [])) {
          const { approvalId, nodeId, instanceKey, attempt } = approval
          await approver.request('workflowRuns.approve', { profileId: defaultId, runId: admitted.runId, approvalId, nodeId, instanceKey, attempt, approved: true })
        }
        if (['succeeded', 'failed', 'cancelled', 'unknown-effect'].includes(view.state)) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 40))
      } while (Date.now() < deadline)
      evidence.cli.scriptWorkflow.terminal = view
      if (view.state !== 'succeeded' || view.result?.script !== true || view.result?.input?.count !== 3) {
        addBlocker('script-workflow-execution', `Unexpected script result: ${JSON.stringify(view)}`)
      }
    } finally {
      await approver.close()
    }

    const browser = nodeCli(['--json', 'browser', 'status'], { home })
    evidence.cli.browserStatus = { exit: browser.exit, json: parseJsonLines(browser.stdout), stderr: truncate(browser.stderr, 800) }
    const browserJson = evidence.cli.browserStatus.json.find((row) => row && typeof row === 'object') ?? {}
    if (JSON.stringify(browserJson).includes('downloading') || JSON.stringify(browserJson).includes('installing')) {
      addBlocker('browser-auto-install', 'browser status appeared to start an install; Chrome download is forbidden here')
    }
  } catch (err) {
    addBlocker('authenticated-cli', err instanceof Error ? err.stack ?? err.message : String(err))
  }

  const stop = nodeCli(['--json', 'service', 'stop'], { home, timeoutMs: STOP_WAIT_MS })
  evidence.cli.stop = { exit: stop.exit, json: parseJsonLines(stop.stdout), stderr: truncate(stop.stderr, 800) }
  try {
    await waitFor(() => !pidAlive(daemonPid), STOP_WAIT_MS, `daemon pid ${daemonPid} exit`)
  } catch (err) {
    addBlocker('daemon-stop', err instanceof Error ? err.message : String(err))
    if (pidAlive(daemonPid)) process.kill(daemonPid, 'SIGTERM')
  }

  const restart = nodeCli(['--json', 'service', 'start'], { home, timeoutMs: SERVICE_WAIT_MS })
  evidence.cli.restart = { exit: restart.exit, json: parseJsonLines(restart.stdout), stderr: truncate(restart.stderr, 800) }
  const restartStatus = nodeCli(['--json', 'service', 'status'], { home })
  evidence.cli.restartStatus = { exit: restartStatus.exit, json: parseJsonLines(restartStatus.stdout) }
  const restartPid = Number(
    (evidence.cli.restartStatus.json.find((row) => row && typeof row === 'object' && 'pid' in row) ?? {}).pid
  )
  evidence.cli.restartPid = restartPid
  if (restart.exit === 0) {
    try {
      const owner = readOwnerRecord(home)
      const client = new QualMmsClient({
        homeDir: home,
        ownerToken: owner.token,
        endpoint: owner.endpoint ?? unixSocketPath(home)
      })
      const hello = await client.connect()
      const again = await client.request('profiles.status', {})
      evidence.cli.restartHello = { instanceId: hello.instanceId, defaultProfileId: again.defaultProfileId }
      await client.close()
    } catch (err) {
      addBlocker('daemon-restart-auth', err instanceof Error ? err.message : String(err))
    }
  } else {
    addBlocker('daemon-restart', `service start after stop exit ${restart.exit}`)
  }

  const stop2 = nodeCli(['--json', 'service', 'stop'], { home, timeoutMs: STOP_WAIT_MS })
  evidence.cli.finalStop = { exit: stop2.exit, json: parseJsonLines(stop2.stdout) }
  if (pidAlive(restartPid)) {
    try {
      await waitFor(() => !pidAlive(restartPid), STOP_WAIT_MS, `restart pid ${restartPid} exit`)
    } catch {
      process.kill(restartPid, 'SIGTERM')
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
      if (pidAlive(restartPid)) process.kill(restartPid, 'SIGKILL')
    }
  }

  const leftover = ownedPidsForHome(home).filter((pid) => pidAlive(pid))
  evidence.cli.leftoverPids = leftover
  if (leftover.length) {
    addBlocker('process-cleanup', `owned leftover pids: ${leftover.join(',')}`)
    for (const pid of leftover) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const require = (await import('node:module')).createRequire(import.meta.url)
    const pty = require(join(projectRoot, 'node_modules/node-pty'))
    evidence.cli.nodePtyLoad = { ok: typeof pty.spawn === 'function' }
    if (pty.spawn) {
      await new Promise((resolvePty, rejectPty) => {
        let output = ''
        const child = pty.spawn('bash', ['-lc', 'printf pty-ok'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: runtimeRoot
        })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          rejectPty(new Error('node-pty spawn timed out'))
        }, 8_000)
        child.onData((data) => {
          output += data
        })
        child.onExit(({ exitCode }) => {
          clearTimeout(timer)
          evidence.cli.nodePtySpawn = { exitCode, output: truncate(output, 200) }
          resolvePty()
        })
      })
    }
  } catch (err) {
    evidence.cli.nodePtyLoad = { ok: false, error: err instanceof Error ? err.message : String(err) }
    addBlocker('node-pty-system-node', evidence.cli.nodePtyLoad.error)
  }
}

async function cleanupOwnedCliProcesses() {
  const home = evidence.cli.home
  if (!home) return
  const found = ownedPidsForHome(home).filter((pid) => pidAlive(pid))
  for (const pid of found) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* process already exited */
    }
  }
  if (found.length) {
    try {
      await waitFor(
        () => found.every((pid) => !pidAlive(pid)),
        5_000,
        'task-owned Linux qualification processes to exit'
      )
    } catch {
      for (const pid of found) {
        if (!pidAlive(pid)) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* process already exited */
        }
      }
    }
  }
  const residual = ownedPidsForHome(home).filter((pid) => pidAlive(pid))
  evidence.cli.finallyCleanup = { found, residual }
  if (residual.length) addBlocker('process-cleanup', `owned leftover pids after final cleanup: ${residual.join(',')}`)
}

function collectArtifacts(dir) {
  if (!existsSync(dir)) return []
  const found = []
  const consider = (path) => {
    if (!existsSync(path) || !statSync(path).isFile()) return
    const st = statSync(path)
    found.push({ path, bytes: st.size, sha256: sha256File(path) })
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && /\.(AppImage|yml|yaml|blockmap)$/i.test(entry.name)) consider(path)
    if (entry.isDirectory() && (entry.name === 'cli' || entry.name === 'linux-unpacked' || entry.name === 'linux-arm64-unpacked')) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isFile() && /\.(AppImage|yml|yaml|blockmap)$/i.test(child.name)) consider(join(path, child.name))
      }
      for (const bin of ['mousse', 'Mousse', 'mousse-cli']) consider(join(path, bin))
      consider(join(path, 'resources', 'app.asar'))
    }
  }
  return found
}

function qualifyPackage() {
  const before = recordDisk('before-package')
  if (before.winC != null && before.winC < 1500 * 1024 * 1024) {
    addBlocker(
      'package-disk',
      `Windows C: has only ${before.winC} bytes free; WSL writes expand the VHDX on C:. Linux AppImage/dir packaging was not started.`
    )
    return
  }
  const electron = join(projectRoot, 'node_modules/electron/dist/electron')
  evidence.package.electronBinary = existsSync(electron) ? electron : null
  evidence.package.electronVersion = readJson(join(projectRoot, 'node_modules/electron/package.json'))?.version ?? null
  if (!existsSync(electron)) {
    addBlocker('electron-dist', 'node_modules/electron/dist/electron is missing; AppImage/Electron CLI not attempted')
    return
  }

  const builder = join(projectRoot, 'node_modules/electron-builder/cli.js')
  const builderBin = existsSync(builder) ? [process.execPath, builder] : ['npx', 'electron-builder']
  const common = ['--linux', 'AppImage', '--publish', 'never']
  const desktop = runCommand(builderBin[0], [...builderBin.slice(1), ...common], {
    timeoutMs: 20 * 60_000,
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: join(homedir(), '.cache/electron-builder'),
      USE_SYSTEM_FPM: 'false'
    }
  })
  evidence.package.desktopAppImage = {
    exit: desktop.exit,
    signal: desktop.signal,
    stderr: truncate(desktop.stderr, 2500),
    stdout: truncate(desktop.stdout, 2500)
  }
  if (desktop.exit !== 0) {
    addBlocker(
      'linux-appimage-desktop',
      `electron-builder --linux AppImage exit ${desktop.exit}: ${truncate(desktop.stderr || desktop.stdout, 1200)}`
    )
    const dirPkg = runCommand(builderBin[0], [...builderBin.slice(1), '--linux', 'dir', '--publish', 'never'], {
      timeoutMs: 20 * 60_000,
      env: {
        ...process.env,
        ELECTRON_BUILDER_CACHE: join(homedir(), '.cache/electron-builder')
      }
    })
    evidence.package.desktopDir = {
      exit: dirPkg.exit,
      stderr: truncate(dirPkg.stderr, 2500),
      stdout: truncate(dirPkg.stdout, 2500)
    }
    if (dirPkg.exit !== 0) {
      addBlocker('linux-dir-desktop', `electron-builder --linux dir exit ${dirPkg.exit}`)
    }
  }

  const cliPkg = runCommand(
    builderBin[0],
    [...builderBin.slice(1), '--linux', 'AppImage', '--publish', 'never', '--config', 'electron-builder.cli.yml'],
    {
      timeoutMs: 20 * 60_000,
      env: {
        ...process.env,
        ELECTRON_BUILDER_CACHE: join(homedir(), '.cache/electron-builder')
      }
    }
  )
  evidence.package.cliAppImage = {
    exit: cliPkg.exit,
    stderr: truncate(cliPkg.stderr, 2500),
    stdout: truncate(cliPkg.stdout, 2500)
  }
  if (cliPkg.exit !== 0) {
    addBlocker(
      'linux-appimage-cli',
      `electron-builder --linux AppImage --config electron-builder.cli.yml exit ${cliPkg.exit}: ${truncate(
        cliPkg.stderr || cliPkg.stdout,
        1200
      )}`
    )
  }

  evidence.package.artifacts = [
    ...collectArtifacts(join(projectRoot, 'release')).filter((row) =>
      /\.(AppImage|yml|yaml|blockmap)$/i.test(row.path) || /linux-unpacked|linux-arm64-unpacked/.test(row.path)
    )
  ]
  const unpacked = ['linux-unpacked', 'linux-arm64-unpacked']
    .map((name) => join(projectRoot, 'release', name))
    .find((path) => existsSync(path))
  if (unpacked) {
    evidence.package.unpackedDir = unpacked
    const electronCli = join(unpacked, 'mousse')
    const alt = join(unpacked, 'Mousse')
    const bin = existsSync(electronCli) ? electronCli : existsSync(alt) ? alt : null
    evidence.package.unpackedBinary = bin
    if (bin) {
      const help = runCommand(bin, ['--cli', '--home', join(runtimeRoot, 'electron-cli-home'), '--help'], {
        timeoutMs: 30_000,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY ?? ':0',
          MOUSSE_CLI: '1',
          MOUSSE_HOME: join(runtimeRoot, 'electron-cli-home')
        }
      })
      evidence.package.electronCliHelp = { exit: help.exit, stdout: truncate(help.stdout, 1000), stderr: truncate(help.stderr, 1500) }
      const version = runCommand(bin, ['--cli', '--home', join(runtimeRoot, 'electron-cli-home'), '--version'], {
        timeoutMs: 30_000,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY ?? ':0',
          MOUSSE_CLI: '1',
          MOUSSE_HOME: join(runtimeRoot, 'electron-cli-home')
        }
      })
      evidence.package.electronCliVersion = {
        exit: version.exit,
        stdout: (version.stdout ?? '').trim(),
        stderr: truncate(version.stderr, 800)
      }
      mkdirSync(join(runtimeRoot, 'electron-cli-home'), { recursive: true })
      const browser = runCommand(
        bin,
        ['--cli', '--home', join(runtimeRoot, 'electron-cli-home'), '--json', 'browser', 'status'],
        {
          timeoutMs: 45_000,
          env: {
            ...process.env,
            DISPLAY: process.env.DISPLAY ?? ':0',
            MOUSSE_CLI: '1',
            MOUSSE_HOME: join(runtimeRoot, 'electron-cli-home')
          }
        }
      )
      evidence.package.electronBrowserStatus = {
        exit: browser.exit,
        json: parseJsonLines(browser.stdout),
        stderr: truncate(browser.stderr, 1200)
      }
    }
    evidence.package.electronNativePty = {
      qualified: false,
      reason: 'Packaged Electron CLI help/version/browser status ran, but packaged daemon PTY was not exercised.'
    }
  } else {
    evidence.notes.push('No linux-unpacked directory; Electron --cli packaged startup was not exercised.')
    addBlocker('electron-native-pty', 'Packaged Electron native PTY was not proven. Node CLI success is not a substitute.')
  }

  const appImages = evidence.package.artifacts.filter((row) => row.path.endsWith('.AppImage'))
  if (!appImages.length) {
    addBlocker('missing-appimage', 'No AppImage artifact was produced.')
  }
  recordDisk('after-package')
}

function writeEvidence() {
  mkdirSync(evidenceDir, { recursive: true })
  evidence.finishedAt = new Date().toISOString()
  evidence.blockerCount = evidence.blockers.length
  evidence.outcome = evidence.blockers.length === 0 ? 'passed' : 'blocked'
  const jsonPath = join(evidenceDir, 'linux-qualification-evidence.json')
  writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`)
  const summary = [
    `Linux qualification ${evidence.finishedAt}`,
    `source=${evidence.candidate.sourceSha}`,
    `phase=${phase}`,
    `cliVersion=${evidence.cli.version?.stdout ?? 'n/a'}`,
    `blockers=${evidence.blockers.length}`,
    ...evidence.blockers.map((row) => `- ${row.kind}: ${row.detail}`),
    `g7=${evidence.g7}`,
    `evidence=${jsonPath}`
  ].join('\n')
  writeFileSync(join(evidenceDir, 'linux-qualification-summary.txt'), `${summary}\n`)
  process.stdout.write(`${summary}\n`)
  return jsonPath
}

async function main() {
  try {
    recordDisk('start')
    probeHost()
    captureCandidate()
    if (phase === 'all' || phase === 'cli') await qualifyNodeCli()
    if (phase === 'all' || phase === 'package') qualifyPackage()
  } finally {
    await cleanupOwnedCliProcesses()
  }
  recordDisk('end')
  writeEvidence()
  if (evidence.blockers.some((row) => ['daemon-start', 'cli-help', 'cli-version', 'missing-cli-build'].includes(row.kind))) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  addBlocker('runner-crash', err instanceof Error ? err.stack ?? err.message : String(err))
  try {
    writeEvidence()
  } catch {
    process.stderr.write(String(err))
  }
  process.exitCode = 1
})
