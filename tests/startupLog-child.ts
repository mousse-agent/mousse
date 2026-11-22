// A stand-in for a daemon the app started: caps its output as `service run` does, then logs far past the cap.
import { capDaemonStartupOutput } from '../src/cli/startupLog'

capDaemonStartupOutput()
console.log('first line')
const line = 'x'.repeat(200)
for (let i = 0; i < 500; i++) {
  if (i % 2) console.error(`[reconciler] ${i} ${line}`)
  else process.stdout.write(`[heartbeat] ${i} ${line}\n`)
}
