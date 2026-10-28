// The ProxyCommand of the tests that run the system's `ssh`: it joins its own stdin and stdout to a loopback port of
// the test process, where the real `runSshProxy` runs against the in-test daemon. It is plain JavaScript so that
// `ssh` can start it with `node` and nothing else. usage: node proxyBridge.mjs <port>
import { connect } from 'node:net'

const port = Number(process.argv[2])
const socket = connect({ host: '127.0.0.1', port })
socket.setNoDelay(true)
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(0))
process.stdin.on('end', () => socket.end())
process.stdin.pipe(socket, { end: false })
socket.pipe(process.stdout)
