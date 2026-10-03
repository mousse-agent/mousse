import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { linuxGuiLaunchArgs } from './linux-gui-launch.mjs'

const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)), ...linuxGuiLaunchArgs(process.argv.slice(2))], { stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1 })
