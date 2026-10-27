// The process the Pi RPC replay (`piRpcReplay.ts`) puts in place of Pi's agent. It connects to the
// replay on 127.0.0.1, sends the bridge address and the settings the engine's launcher gave it,
// then forwards whole lines both ways. An inbound line framed as `\0<seq>\0<line>` is written to
// stdout and then acknowledged, so the replay plays the next frame only once the engine could read
// this one; `\0exit:<code>` exits. It makes no other connection.
const net = require('node:net')

const socket = net.connect(Number(process.argv[2]), '127.0.0.1', () => {
  socket.write(JSON.stringify({
    bridge: process.env.MOUSSE_PI_BRIDGE || null,
    aws: { maxAttempts: process.env.AWS_MAX_ATTEMPTS || null, retryMode: process.env.AWS_RETRY_MODE || null },
    offline: process.env.PI_OFFLINE || null,
    args: process.argv.slice(3)
  }) + '\n')
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    const end = input.lastIndexOf('\n')
    if (end < 0) return
    socket.write(input.slice(0, end + 1))
    input = input.slice(end + 1)
  })
})

let buffer = ''
socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    const exit = /^\u0000exit:(-?\d+)$/.exec(line)
    if (exit) process.exit(Number(exit[1]))
    const framed = /^\u0000(\d+)\u0000(.*)$/.exec(line)
    if (framed) process.stdout.write(framed[2] + '\n', () => socket.write(JSON.stringify({ ack: Number(framed[1]) }) + '\n'))
    else process.stdout.write(line + '\n')
  }
})
socket.on('close', () => process.exit(0))
socket.on('error', () => process.exit(1))
