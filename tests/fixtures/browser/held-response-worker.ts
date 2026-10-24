import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { runBrowserWorkerHost } from '../../../src/browser-worker/ipc/host'
import { WorkerFrameDecoder } from '../../../src/browser-worker/ipc/framing'

// Exercise the production host and executor; only the completed reply is held at the transport boundary.
const requests = new WorkerFrameDecoder()
let marker: string | undefined
let held: Buffer | undefined
const input = new Transform({ transform(chunk: Buffer, _encoding, callback) {
  requests.push(chunk)
  for (const frame of requests.shiftAll()) {
    const record = frame as { kind?: string; profileRoot?: string }
    if (record.kind === 'init' && record.profileRoot) {
      mkdirSync(record.profileRoot, { recursive: true })
      marker = join(record.profileRoot, 'held-action-response.json')
    }
  }
  callback(null, chunk)
} })
const responses = new WorkerFrameDecoder()
const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
  responses.push(chunk)
  const frames = responses.shiftAll() as Array<{ ok?: boolean; result?: { requestId?: string } }>
  const completed = frames.find((frame) => frame.ok && frame.result?.requestId === 'submit_once')
  if (completed) {
    if (!marker || held) { callback(new Error('Unexpected duplicate held action response')); return }
    held = Buffer.from(chunk)
    writeFileSync(marker + '.tmp', JSON.stringify({ pid: process.pid, response: completed }))
    renameSync(marker + '.tmp', marker)
    // Keep the reply out of the broker, but allow independent observation replies through.
    callback()
  } else process.stdout.write(chunk, callback)
} })

void runBrowserWorkerHost(input, output).catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
process.stdin.pipe(input)
