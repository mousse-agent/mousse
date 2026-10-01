import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { browserWorkerModulePath } from '../src/mms/browser/workerModulePath'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-browser-build-') || path.includes('..')) throw new Error('Unexpected browser build fixture root')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('browser worker build and Electron host', () => {
  it('resolves an unpacked module and launches the real worker from Electron without opening another app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-browser-build-'))
    roots.push(root)
    const applicationRoot = join(root, 'app.asar')
    const modulePath = join(applicationRoot + '.unpacked', 'out', 'browser-worker', 'index.mjs')
    mkdirSync(dirname(modulePath), { recursive: true })
    writeFileSync(applicationRoot, '')
    const worker = await build({ entryPoints: [resolve('src/browser-worker/index.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true })
    expect(Object.keys(worker.metafile!.inputs).some((file) => /node_modules\/(?:electron|playwright|puppeteer)\//.test(file))).toBe(false)
    expect(browserWorkerModulePath(applicationRoot)).toBe(modulePath)
    expect(() => browserWorkerModulePath(root)).toThrow(/missing/)
    const developmentModule = join(root, 'out', 'browser-worker', 'index.mjs')
    mkdirSync(dirname(developmentModule), { recursive: true })
    copyFileSync(modulePath, developmentModule)
    expect(browserWorkerModulePath(root)).toBe(developmentModule)

    const probePath = join(root, 'host.cjs')
    const source = `
      import { app } from 'electron';
      import { join } from 'node:path';
      import { BrowserBroker } from ${JSON.stringify(resolve('src/mms/browser/BrowserBroker.ts'))};
      const fixtureRoot = process.argv[2];
      const workerPath = process.argv[3];
      app.setPath('userData', join(fixtureRoot, 'electron-data'));
      const deadline = setTimeout(() => app.exit(2), 15000);
      let broker;
      app.whenReady().then(async () => {
        broker = new BrowserBroker({ profileRoot: join(fixtureRoot,'profiles'), browserRoot: join(fixtureRoot,'browser'), artifactRoot: join(fixtureRoot,'artifacts'), workerModulePath: workerPath, policy: { authorize: async () => ({ allowed: false, code: 'policy_denied' }) } });
        const capability = await broker.start();
        if (!capability.setupRequired || capability.ready) throw new Error('Unexpected empty-fixture capability');
        await broker.close();
        process.stdout.write('MOUSSE_BROWSER_BUILD_PROBE:' + JSON.stringify({ success:true, hostElectron: Boolean(process.versions.electron), setupRequired: capability.setupRequired }) + '\\n');
        clearTimeout(deadline); app.exit(0);
      }).catch(async (error) => { process.stderr.write(error.message+'\\n'); await broker?.close(); clearTimeout(deadline); app.exit(1); });
    `
    await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'browser-host-probe.ts' }, outfile: probePath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] })
    const require = createRequire(import.meta.url)
    const electronPath = require('electron') as string
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const environment = { ...process.env, MOUSSE_HOME: join(root, 'installation') }
      delete environment.ELECTRON_RUN_AS_NODE
      delete environment.MOUSSE_BROWSER_WORKER
      const child = spawn(electronPath, [probePath, root, modulePath], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron browser host probe timed out')) }, 25000)
      child.stdout.on('data', (bytes: Buffer) => { stdout = (stdout + bytes.toString()).slice(-64 * 1024) })
      child.stderr.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-64 * 1024) })
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code) => { clearTimeout(timeout); done({ code, stdout, stderr }) })
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('MOUSSE_BROWSER_BUILD_PROBE:{"success":true,"hostElectron":true,"setupRequired":true}')
  }, 35000)
})
