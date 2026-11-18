// A parent for the hard-kill test: starts the helper as the daemon does (its stdin and stdout piped), prints the
// helper's pid once the helper answered hello, and then waits to be killed.
//   node helperParent.mjs <helper> <json args>
import { spawn } from 'node:child_process'

const [binary, args] = process.argv.slice(2)
const child = spawn(binary, JSON.parse(args), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
let buffered = Buffer.alloc(0)
child.stdout.on('data', (bytes) => {
  buffered = Buffer.concat([buffered, bytes])
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const length = buffered.readUInt32BE(0)
    const body = buffered.subarray(5, 4 + length)
    const type = buffered[4]
    buffered = buffered.subarray(4 + length)
    if (type === 1 && JSON.parse(body.toString('utf8')).re === 1) console.log(`helper ${child.pid}`)
  }
})
const hello = Buffer.from(JSON.stringify({ id: 1, op: 'hello', proto: [1, 0] }))
const frame = Buffer.alloc(5 + hello.length)
frame.writeUInt32BE(1 + hello.length, 0)
frame.writeUInt8(1, 4)
hello.copy(frame, 5)
child.stdin.write(frame)
setInterval(() => undefined, 1_000)
