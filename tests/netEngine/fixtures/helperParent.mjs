// A parent for the hard-kill tests: starts the helper as the daemon does (its stdin and stdout piped), prints the
// helper's pid once the helper answered hello, and then waits to be killed. With a stdio, it starts a helper that
// does not speak the app channel (`init`) with that stdio and prints its pid at once.
//   node helperParent.mjs <helper> <json args> [<json stdio>]
//
// The helper is started detached: on Windows, Node puts its other children in a job that ends them with it, which
// would hide whether the helper ends on its own when its stdin closes (as it must on macOS and Linux).
import { spawn } from 'node:child_process'

const [binary, args, stdio] = process.argv.slice(2)
const options = { detached: true, windowsHide: true }

if (stdio) {
  const child = spawn(binary, JSON.parse(args), { ...options, stdio: JSON.parse(stdio) })
  console.log(`helper ${child.pid}`)
} else {
  const child = spawn(binary, JSON.parse(args), { ...options, stdio: ['pipe', 'pipe', 'inherit'] })
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
}
setInterval(() => undefined, 1_000)
