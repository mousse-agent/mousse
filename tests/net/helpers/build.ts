import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { getCliBuildOptions } from '../../../scripts/build-cli.mjs'
import { getBrowserWorkerBuildOptions } from '../../../scripts/build-browser-worker.mjs'
import { buildPackagedNativeReader } from '../../../scripts/build-net-native-reader.mjs'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Build the real daemon configuration without reading or writing the checkout's out directory. */
export async function buildTestCli(options: { nativeReader?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'net-test-build-')))
  const outputRoot = join(directory, 'out')
  const entry = join(outputRoot, 'cli', 'index.js')
  const cleanup = () => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const cliOptions = getCliBuildOptions(projectRoot)
  const buildEntry = async (source: string, relativeOutput: string) => {
    const outfile = join(outputRoot, relativeOutput)
    await build({
      ...cliOptions,
      absWorkingDir: projectRoot,
      entryPoints: [resolve(projectRoot, source)],
      outfile,
      sourcemap: false,
      logLevel: 'silent'
    })
    return outfile
  }

  try {
    // External packages must resolve to the existing installation, including native SQLite modules.
    symlinkSync(realpathSync(join(projectRoot, 'node_modules')), join(directory, 'node_modules'))
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
    if (options.nativeReader) buildPackagedNativeReader(outputRoot)
    await buildEntry('src/cli/index.ts', 'cli/index.js')
    await build({
      ...getBrowserWorkerBuildOptions(projectRoot),
      absWorkingDir: projectRoot,
      outfile: join(outputRoot, 'browser-worker', 'index.mjs'),
      sourcemap: false,
      logLevel: 'silent'
    })
    return { entry, buildEntry, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
