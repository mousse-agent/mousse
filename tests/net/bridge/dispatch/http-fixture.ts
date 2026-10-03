import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { devNull } from 'node:os'
import { join } from 'node:path'

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Loopback-only smart HTTP, with fake credentials and entirely test-owned configuration. */
export async function authenticatedRemote(root: string) {
  const marker = join(root, 'credential-helper.log')
  const helper = join(root, 'credential-helper.cjs')
  const globalConfig = join(root, 'global.gitconfig')
  await writeFile(
    helper,
    `
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n')
process.stdin.resume()
process.stdin.on('end', () => {
  if (process.argv[2] === 'get') {
    process.stdout.write('username=fixture\\npassword=test-owned-password\\n\\n')
  }
})
`
  )
  let authenticatedFetches = 0
  let authenticatedPushes = 0
  const errors: Error[] = []
  const children = new Set<ReturnType<typeof execFile>>()
  const server = createServer((request, response) => {
    const authorization = `Basic ${Buffer.from('fixture:test-owned-password').toString('base64')}`
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dispatch-fixture"' })
      response.end()
      request.resume()
      return
    }
    const url = new URL(request.url!, 'http://127.0.0.1')
    if (url.pathname.endsWith('/git-upload-pack')) authenticatedFetches++
    if (url.pathname.endsWith('/git-receive-pack')) authenticatedPushes++
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key]
    }
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      CONTENT_LENGTH: request.headers['content-length'] ?? '',
      REMOTE_USER: 'fixture',
      REMOTE_ADDR: '127.0.0.1'
    })
    const backendOptions = {
      env,
      encoding: 'buffer' as const,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000
    }
    const child = execFile('git', ['http-backend'], backendOptions, (error, stdout) => {
      children.delete(child)
      if (error) {
        errors.push(error)
        response.writeHead(500)
        response.end()
        return
      }
      const boundary = stdout.indexOf('\r\n\r\n')
      if (boundary < 0) {
        errors.push(new Error('Missing CGI response headers'))
        response.writeHead(500)
        response.end()
        return
      }
      let status = 200
      for (const line of stdout.subarray(0, boundary).toString().split('\r\n')) {
        const colon = line.indexOf(':')
        const name = line.slice(0, colon)
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else response.setHeader(name, value)
      }
      response.writeHead(status)
      response.end(stdout.subarray(boundary + 4))
    })
    children.add(child)
    request.pipe(child.stdin!)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const url = `http://127.0.0.1:${address.port}/remote.git`
  await writeFile(globalConfig, '')
  // Use Git itself to quote paths and configuration values correctly.
  const configure = (key: string, value: string) =>
    new Promise<void>((resolve, reject) => {
      execFile('git', ['config', '--file', globalConfig, '--add', key, value], (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  await configure('credential.helper', '')
  await configure('credential.helper', `!${shellQuote(process.execPath)} ${shellQuote(helper)}`)
  await configure(`url.http://127.0.0.1:${address.port}/.insteadOf`, 'http://127.0.0.1:1/')
  return {
    url,
    rewrittenUrl: 'http://127.0.0.1:1/remote.git',
    marker,
    globalConfig,
    errors,
    counts: () => ({ fetch: authenticatedFetches, push: authenticatedPushes }),
    clearMarker: () => writeFile(marker, ''),
    close: async () => {
      for (const child of children) child.kill()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }
}
