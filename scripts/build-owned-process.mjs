import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function buildOwnedProcess(outputRoot = join(project, 'out')) {
  if (process.platform !== 'darwin') return { supported: false }
  const directory = join(outputRoot, 'net-native', `${process.platform}-${process.arch}`)
  const artifact = join(directory, 'owned-process.node'),
    manifestPath = join(directory, 'owned-process-manifest.json')
  const source = join(project, 'src/mms/terminals/darwinProcess.cc'),
    sourceSha256 = sha(readFileSync(source))
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (
      manifest.v === 1 &&
      manifest.platform === process.platform &&
      manifest.arch === process.arch &&
      manifest.napi === 8 &&
      manifest.sourceSha256 === sourceSha256 &&
      manifest.artifactSha256 === sha(readFileSync(artifact))
    )
      return manifest
  } catch {
    /* Never reuse a binary without its exact source and artifact hashes. */
  }
  const candidates = [
    process.env.NODE_HEADERS,
    resolve(dirname(process.execPath), '../include/node')
  ]
  for (const cache of [
    join(homedir(), 'Library/Caches/node-gyp'),
    join(homedir(), '.cache/node-gyp')
  ]) {
    if (existsSync(cache))
      for (const version of readdirSync(cache)
        .filter((value) => /^24\./.test(value))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
        candidates.push(join(cache, version, 'include/node'))
  }
  const headers = candidates.find((path) => path && existsSync(join(path, 'node_api.h')))
  if (!headers)
    throw new Error(
      'Owned-process packaging requires installed Node headers; set NODE_HEADERS at build time'
    )
  mkdirSync(directory, { recursive: true })
  execFileSync(
    'c++',
    [
      '-std=c++17',
      '-O2',
      '-fPIC',
      '-shared',
      '-DNAPI_VERSION=8',
      `-I${headers}`,
      source,
      '-o',
      artifact,
      '-undefined',
      'dynamic_lookup',
      '-lproc'
    ],
    { timeout: 60000, stdio: 'pipe' }
  )
  const manifest = {
    v: 1,
    platform: process.platform,
    arch: process.arch,
    napi: 8,
    artifact: 'owned-process.node',
    sourceSha256,
    artifactSha256: sha(readFileSync(artifact))
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(buildOwnedProcess()))
