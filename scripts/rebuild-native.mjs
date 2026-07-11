import { execSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')
).version

const msbuild =
  process.env.MSBUILD_PATH ??
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe'

const nodePtyDir = join(root, 'node_modules/node-pty')

console.log(`Rebuilding node-pty for Electron ${electronVersion}...`)

execSync(
  `npx node-gyp configure --target=${electronVersion} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: nodePtyDir, stdio: 'inherit', shell: true }
)

const msbuildResult = spawnSync(
  msbuild,
  ['build/binding.sln', '/p:Configuration=Release', '/p:SpectreMitigation=false', '/m'],
  { cwd: nodePtyDir, stdio: 'inherit' }
)

if (msbuildResult.status !== 0) {
  process.exit(msbuildResult.status ?? 1)
}

console.log('Native rebuild complete.')
