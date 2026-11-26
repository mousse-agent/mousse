/**
 * Stands in for the Mousse daemon in `tests/live/opencodeServer.test.ts`: starts OpenCode's server the way the runtime
 * does (`spawnOpencodeServer`), prints `{ url, pid }` on one line, then waits until it is killed.
 * Run as `node <jiti-cli> opencodeServerHolder.ts <opencode executable> <working folder>`, with OpenCode's isolated
 * environment in its own.
 */
import { instanceEnv } from '../../../src/mms/harness/env'
import { spawnOpencodeServer } from '../../../src/mms/harness/opencode/server'

const [command, cwd] = process.argv.slice(2)
if (!command || !cwd) throw new Error('usage: opencodeServerHolder <opencode> <cwd>')
const env = instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base: process.env })
const started = await spawnOpencodeServer(env, { command, args: [], env: {}, cwd }, AbortSignal.timeout(60_000))
process.stdout.write(`${JSON.stringify({ url: started.endpoint.url, pid: started.pid })}\n`)
setInterval(() => {}, 60_000)
