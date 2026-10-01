/**
 * Deterministic local PTY fixture. No network, no model, no agent.
 * Prints a ready marker, echoes one stdin line, then exits.
 */
const READY = 'Q04-PTY-READY'
const PREFIX = 'Q04-PTY-ECHO:'
const timeoutMs = Number(process.env.MOUSSE_Q04_PTY_TIMEOUT_MS || 15_000)

process.stdout.write(`${READY}\n`)

let buffer = ''
const timer = setTimeout(() => {
  process.stderr.write('Q04-PTY-TIMEOUT\n')
  process.exit(2)
}, timeoutMs)
timer.unref?.()

function finish(line) {
  clearTimeout(timer)
  process.stdout.write(`${PREFIX}${line}\n`)
  process.exit(0)
}

if (!process.stdin || process.stdin.destroyed) {
  finish('')
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  if (/[\r\n]/.test(buffer)) {
    finish(buffer.replace(/[\r\n]+/g, '').trim())
  }
})
process.stdin.on('end', () => finish(buffer.replace(/[\r\n]+/g, '').trim()))
