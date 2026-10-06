#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import * as asar from '@electron/asar'
const directory = resolve(
    process.argv[2] ?? '.mousse-dev/net-packaging/linux/package-final/linux-arm64-unpacked'
  ),
  archive = join(directory, 'resources/app.asar'),
  hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
  reader = 'out/net-native/linux-arm64/reader.node'
const metadata = JSON.parse(asar.extractFile(archive, 'package.json')),
  manifest = JSON.parse(asar.extractFile(archive, 'out/net-native/linux-arm64/manifest.json')),
  stat = asar.statFile(archive, reader)
if (
  metadata.main !== 'out/main/cli.js' ||
  !stat.unpacked ||
  manifest.qualified !== false ||
  manifest.artifactSha256 !== hash(join(directory, 'resources/app.asar.unpacked', reader))
)
  throw Error('Package main/native manifest guard failed')
console.log(
  JSON.stringify(
    {
      source: process.env.MOUSSE_QA_SOURCE_SHA ?? 'unspecified',
      hostNode: process.version,
      platform: process.platform,
      arch: process.arch,
      main: metadata.main,
      asarSha256: hash(archive),
      executableSha256: hash(join(directory, 'mousse-cli')),
      readerSha256: manifest.artifactSha256,
      reader: stat,
      manifest,
      cliEntrySha256: createHash('sha256')
        .update(asar.extractFile(archive, 'out/main/cli.js'))
        .digest('hex'),
      supplementalEntry: 'out/main/linuxProbe.js',
      supplementalEntrySha256: createHash('sha256')
        .update(asar.extractFile(archive, 'out/main/linuxProbe.js'))
        .digest('hex'),
      sdkVersions: Object.fromEntries(
        [
          '@earendil-works/pi-ai',
          '@earendil-works/pi-coding-agent',
          '@agentclientprotocol/sdk'
        ].map((name) => [
          name,
          JSON.parse(asar.extractFile(archive, 'node_modules/' + name + '/package.json')).version
        ])
      )
    },
    null,
    2
  )
)
