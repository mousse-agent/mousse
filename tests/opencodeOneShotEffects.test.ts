/**
 * `opencode:sealed` claims `isolation: verified` and `tools: none_offered`: nothing of the person's OpenCode setup loads
 * into a single request, and the model is offered no tool. Shown on the real OpenCode (`realOpencode.ts`: throwaway
 * folders, a loopback stub model, a dummy key), started through the runtime's single-request transport as a title
 * request starts it.
 *
 * The person's home holds what would change the request if it loaded: OpenCode's global config (`~/.config/opencode`)
 * with a plugin and an MCP server that each write a marker when they start, its `AGENTS.md` with a unique line, and
 * `~/.claude`/`~/.agents` with a unique `CLAUDE.md` line and skill. Mousse's profile is in that home, as it is on a real
 * computer, so the folders above every place hold a project's own too: `opencode.json` and `.opencode/` with a plugin
 * and an MCP server each, a `plugins/` folder plugin, and `AGENTS.md` lines; and `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`
 * in Mousse's environment and in the entry's own variables name configs with more. Nothing may run, the request at the
 * stub may carry none of it and declare no tool, and the person's OpenCode data folder is never made.
 *
 * Each is seen when its guard is dropped (checked on OpenCode 2.0.20): without `OPENCODE_DISABLE_PROJECT_CONFIG` the
 * plugins of `opencode.json`, `.opencode/opencode.json` and `.opencode/plugins/` run and both MCP servers start; without
 * the reserved roots (the person's own folders) the global config's plugin and MCP server run and its `AGENTS.md`
 * reaches the model; without dropping the entry's `OPENCODE_*` variables its named config and folder load (plugins and MCP
 * servers); without the deny-all rules OpenCode's tools are declared.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DriverRuntime } from '../src/mms/harness/driver'
import { modelStub, opencodeBinary, opencodeRuntime, placesLeft, sendOnce, stubProviderConfig, throwawayUser, type ModelStub } from './harness/realOpencode'

const binary = opencodeBinary()
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A plugin folder (OpenCode 2.0's `{ id, setup }` module) that writes `markers/plugin-<name>` when it loads. */
function plugin(dir: string, markers: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(join(markers, `plugin-${name}`))}, 'x')\nexport default { id: 'test.${name}', setup: async () => {} }\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `test-${name}`, type: 'module' }))
  return pathToFileURL(dir).href
}

/** A config that loads a plugin and starts an MCP server, each leaving a marker named `name`. */
function config(root: string, markers: string, name: string): string {
  const server = join(root, `mcp-${name}.cjs`)
  writeFileSync(server, `require('fs').writeFileSync(${JSON.stringify(join(markers, `mcp-${name}`))}, 'x'); setTimeout(() => {}, 60000)\n`)
  return JSON.stringify({ plugins: [plugin(join(root, `plugin-${name}`), markers, name)], mcp: { [`test_${name}`]: { type: 'local', command: [process.execPath, server] } } })
}

describe.skipIf(!binary)('opencode:sealed holds the person’s OpenCode setup out of a single request (real OpenCode)', () => {
  let stub: ModelStub
  let runtime: DriverRuntime

  it('runs no plugin or MCP server of theirs, sends none of their instructions, declares no tool, and leaves nothing behind', async () => {
    const user = throwawayUser()
    cleanups.push(user.remove)
    stub = await modelStub()
    cleanups.push(() => stub.close())
    const markers = join(user.root, 'markers')
    mkdirSync(markers)
    const { home, profile } = user
    // The person's own OpenCode setup.
    const global = join(home, '.config', 'opencode')
    mkdirSync(global, { recursive: true })
    writeFileSync(join(global, 'opencode.json'), config(user.root, markers, 'global'))
    writeFileSync(join(global, 'AGENTS.md'), 'UNIQUE_GLOBAL_AGENTS')
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'UNIQUE_CLAUDE_MD')
    mkdirSync(join(home, '.agents', 'skills', 'unique'), { recursive: true })
    writeFileSync(join(home, '.agents', 'skills', 'unique', 'SKILL.md'), '---\nname: unique\ndescription: UNIQUE_SKILL\n---\nUNIQUE_SKILL_BODY\n')
    writeFileSync(join(home, 'AGENTS.md'), 'UNIQUE_HOME_AGENTS')
    // A project's own, in the folders above every place.
    writeFileSync(join(profile, 'opencode.json'), config(user.root, markers, 'project'))
    writeFileSync(join(profile, 'AGENTS.md'), 'UNIQUE_PROJECT_AGENTS')
    mkdirSync(join(home, '.opencode', 'plugins'), { recursive: true })
    writeFileSync(join(home, '.opencode', 'opencode.json'), config(user.root, markers, 'dotopencode'))
    writeFileSync(join(home, '.opencode', 'plugins', 'folder.js'), `import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(join(markers, 'plugin-folder'))}, 'x')
export default { id: 'test.folder', setup: async () => {} }
`)

    // OpenCode's own variables naming a config, in Mousse's environment and in the entry's.
    const named = join(user.root, 'named')
    mkdirSync(named)
    writeFileSync(join(named, 'opencode.json'), config(user.root, markers, 'basedir'))
    writeFileSync(join(user.root, 'entry.json'), config(user.root, markers, 'entryfile'))
    const entryDir = join(user.root, 'entrydir')
    mkdirSync(entryDir)
    writeFileSync(join(entryDir, 'opencode.json'), config(user.root, markers, 'entrydir'))
    runtime = opencodeRuntime(binary!, { ...user.env, OPENCODE_CONFIG_DIR: named }, profile, { oneShotConfigContent: stubProviderConfig(stub, 'dummy-key') }, { OPENCODE_CONFIG: join(user.root, 'entry.json'), OPENCODE_CONFIG_DIR: entryDir })
    cleanups.push(() => runtime.stop())
    const { seen, sent } = sendOnce(runtime)
    expect(await sent).toBe('Fix login bug')
    expect(seen.sent).toBe(1)
    expect(seen.launched).toEqual([binary])

    expect(stub.requests).toHaveLength(1)
    const [request] = stub.requests
    expect(request!.tools).toEqual([])
    expect(request!.body.tools).toBeUndefined()
    expect(request!.text).toContain('The login page loops after OAuth.')
    expect(request!.text.match(/UNIQUE_[A-Z_]+/g) ?? []).toEqual([])
    // Give a late plugin or MCP server time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(readdirSync(markers)).toEqual([])
    // The person's OpenCode data (their database, sign-ins and sessions) was never opened, and the place is gone.
    expect(existsSync(join(home, '.local', 'share', 'opencode'))).toBe(false)
    expect(placesLeft(profile)).toEqual([])
  }, 120_000)
})
