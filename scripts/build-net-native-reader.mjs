import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNativeReader } from '../src/mms/bots/runtime/buildNativeReader.mjs'
import { buildOwnedProcess } from './build-owned-process.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function buildPackagedNativeReader(outputRoot = join(project, 'out')) {
  buildOwnedProcess(outputRoot)
  if (!['darwin', 'linux'].includes(process.platform))
    return { supported: false, platform: process.platform, qualified: false }
  const directory = join(outputRoot, 'net-native', `${process.platform}-${process.arch}`)
  const artifact = join(directory, 'reader.node')
  const manifestPath = join(directory, 'manifest.json')
  const sourceSha256 = sha(readFileSync(join(project, 'src/mms/bots/runtime/nativeReader.cc')))
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (
      manifest.v === 1 &&
      manifest.platform === process.platform &&
      manifest.arch === process.arch &&
      manifest.napi === 8 &&
      manifest.qualified === false &&
      manifest.sourceSha256 === sourceSha256 &&
      manifest.artifactSha256 === sha(readFileSync(artifact))
    )
      return manifest
  } catch {
    /* Build only host-owned source; never load an unverified previous binary. */
  }
  const caches = [join(homedir(), 'Library/Caches/node-gyp'), join(homedir(), '.cache/node-gyp')]
  const candidates = [
    process.env.NODE_HEADERS,
    resolve(dirname(process.execPath), '../include/node')
  ]
  for (const cache of caches)
    if (existsSync(cache))
      for (const version of readdirSync(cache)
        .filter((value) => /^24\./.test(value))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
        candidates.push(join(cache, version, 'include/node'))
  const headers = candidates.find((path) => path && existsSync(join(path, 'node_api.h')))
  if (!headers)
    throw new Error(
      'Native reader packaging requires installed Node headers. Set NODE_HEADERS to their include/node directory; no headers are downloaded automatically.'
    )
  mkdirSync(directory, { recursive: true })
  buildNativeReader({ headers, outfile: artifact })
  const manifest = {
    v: 1,
    platform: process.platform,
    arch: process.arch,
    napi: 8,
    artifact: 'reader.node',
    artifactSha256: sha(readFileSync(artifact)),
    sourceSha256,
    qualified: false
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(buildPackagedNativeReader()))
