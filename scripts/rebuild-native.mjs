import { execSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ensureNodePtyHelperExecutable } from './ensure-native-executables.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')
).version

const msbuild =
  process.env.MSBUILD_PATH ??
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe'

const nodePtyDir = join(root, 'node_modules/node-pty')

if (process.platform !== 'win32') {
  const helpers = ensureNodePtyHelperExecutable()
  console.log(
    `Using node-pty prebuild for ${process.platform}-${process.arch}; ` +
      'Windows MSBuild rebuild skipped.'
  )
  for (const helper of helpers) console.log(`Ensured executable node-pty helper: ${helper}`)
  process.exit(0)
}

console.log(`Rebuilding node-pty for Electron ${electronVersion}...`)

execSync(
  `npx node-gyp configure --target=${electronVersion} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit', shell: true }
)

const msbuildResult = spawnSync(
  msbuild,
  [
    'build/binding.sln',
    '/t:Rebuild',
    '/p:Configuration=Release',
    '/p:Platform=x64',
    '/p:SpectreMitigation=false',
    '/p:GenerateDebugInformation=false',
    '/p:DebugSymbols=false',
    '/p:DebugType=None',
    '/p:LinkIncremental=false',
    '/m'
  ],
  { cwd: nodePtyDir, stdio: 'inherit' }
)

if (msbuildResult.status !== 0) {
  process.exit(msbuildResult.status ?? 1)
}

console.log('Native rebuild complete.')
