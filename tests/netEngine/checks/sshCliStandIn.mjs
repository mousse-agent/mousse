#!/usr/bin/env node
/**
 * Test only: `mousse-cli` as the SSH test server runs it in a real-helper check (1b §14, Add over SSH). The B app
 * runs inside the check's process, so this carries the session there: it connects to the loopback port the check
 * opened (`Fabric.cliStandIn`), sends the check's token, then passes stdin on and the answer back to stdout. The
 * check answers with `net-engine ssh`'s own code (the marker, then the reply).
 *
 *   node sshCliStandIn.mjs <port> <token> net-engine ssh
 */
import { connect } from 'node:net'

const [port, token, ...command] = process.argv.slice(2)
if (command.join(' ') !== 'net-engine ssh') {
  process.stderr.write('usage: mousse-cli net-engine ssh\n')
  process.exit(2)
}
const socket = connect(Number(port), '127.0.0.1', () => {
  socket.write(`${token}\n`)
  process.stdin.pipe(socket)
})
socket.pipe(process.stdout)
socket.on('close', () => process.exit(0))
socket.on('error', (error) => {
  process.stderr.write(`mousse-cli stand-in: ${error.message}\n`)
  process.exit(1)
})
