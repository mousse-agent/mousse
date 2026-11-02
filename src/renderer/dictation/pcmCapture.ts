/**
 * Raw audio from a media stream, as it is recorded, at the rate a local model takes. The browser
 * resamples the stream into an AudioContext running at that rate, and a small AudioWorklet copies
 * each block out. Dictation used to record a compressed file and decode it after the stop.
 */
export interface PcmCapture {
  /** Resolves once every sample recorded so far has reached `onSamples`. */
  flush: () => Promise<void>
  /** Stops capturing; the stream itself stays open. */
  close: () => void
}

/** Samples per message from the worklet (64 ms at 16 kHz). */
const BATCH_SAMPLES = 1024
/** A suspended context never answers a flush; the stop does not wait longer than this. */
const FLUSH_TIMEOUT_MS = 500

const PROCESSOR_NAME = 'mousse-pcm-capture'

// Plain JavaScript: AudioWorklet modules are loaded from a URL, not bundled.
const PROCESSOR_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.batch = new Float32Array(${BATCH_SAMPLES})
    this.filled = 0
    this.flushing = false
    this.port.onmessage = (event) => { if (event.data === 'flush') this.flushing = true }
  }
  send() {
    if (this.filled === 0) return
    const out = this.batch.slice(0, this.filled)
    this.port.postMessage(out, [out.buffer])
    this.filled = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0) {
      const frames = input[0].length
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < input.length; c++) sum += input[c][i]
        this.batch[this.filled++] = sum / input.length
        if (this.filled === this.batch.length) this.send()
      }
    }
    if (this.flushing) {
      this.flushing = false
      this.send()
      this.port.postMessage('flushed')
    }
    return true
  }
}
registerProcessor('${PROCESSOR_NAME}', PcmCapture)
`

let processorUrl: string | null = null

/** Starts copying `stream`'s audio, mixed to mono at `sampleRate`, to `onSamples`. */
export async function capturePcm(stream: MediaStream, sampleRate: number, onSamples: (samples: Float32Array) => void): Promise<PcmCapture> {
  const context = new AudioContext({ sampleRate })
  try {
    processorUrl ??= URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }))
    await context.audioWorklet.addModule(processorUrl)
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const flushes: Array<() => void> = []
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (event.data === 'flushed') flushes.shift()?.()
      else if (event.data instanceof Float32Array) onSamples(event.data)
    }
    // The node writes nothing, so the destination stays silent; it only keeps the node running.
    source.connect(node).connect(context.destination)
    await context.resume()
    if (context.state !== 'running') throw new Error(`The audio context is ${context.state}`)
    let closed = false
    return {
      flush: () =>
        closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
              flushes.push(() => {
                clearTimeout(timer)
                resolve()
              })
              node.port.postMessage('flush')
            }),
      close: () => {
        if (closed) return
        closed = true
        source.disconnect()
        node.disconnect()
        node.port.onmessage = null
        void context.close().catch(() => undefined)
      }
    }
  } catch (error) {
    void context.close().catch(() => undefined)
    throw error
  }
}
