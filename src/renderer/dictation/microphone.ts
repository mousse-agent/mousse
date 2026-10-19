import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

/** The microphone as dictation records it. `stop` releases the device and any audio processing. */
export interface Microphone {
  stream: MediaStream
  stop: () => void
}

/** RNNoise works on 48 kHz audio. */
const RNNOISE_SAMPLE_RATE = 48_000

let rnnoiseBinary: Promise<ArrayBuffer> | null = null

function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  if (!rnnoiseBinary) {
    const loading = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    loading.catch(() => {
      if (rnnoiseBinary === loading) rnnoiseBinary = null
    })
    rnnoiseBinary = loading
  }
  return rnnoiseBinary
}

const stopTracks = (stream: MediaStream): void => stream.getTracks().forEach((track) => track.stop())

/**
 * Opens the microphone with the browser's echo cancellation, noise suppression and gain control.
 * With `reduceNoise`, the audio also goes through RNNoise, a small neural network that removes
 * steady and sudden background noise (fans, typing, traffic) that the browser filter leaves in.
 * If RNNoise cannot start, the browser-filtered audio is recorded instead.
 */
export async function openMicrophone({ reduceNoise }: { reduceNoise: boolean }): Promise<Microphone> {
  const input = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  })
  const plain: Microphone = { stream: input, stop: () => stopTracks(input) }
  if (!reduceNoise) return plain
  let context: AudioContext | undefined
  try {
    context = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE })
    const [wasmBinary] = await Promise.all([loadRnnoiseBinary(), context.audioWorklet.addModule(rnnoiseWorkletUrl)])
    const source = context.createMediaStreamSource(input)
    const denoise = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 })
    const output = context.createMediaStreamDestination()
    source.connect(denoise).connect(output)
    // A suspended context would record silence, so it has to be running before the recorder starts.
    await context.resume()
    if (context.state !== 'running') throw new Error(`The audio context is ${context.state}`)
    const graph = context
    return {
      stream: output.stream,
      stop: () => {
        source.disconnect()
        denoise.destroy()
        stopTracks(output.stream)
        stopTracks(input)
        void graph.close().catch(() => undefined)
      }
    }
  } catch (error) {
    void context?.close().catch(() => undefined)
    console.warn('Background noise reduction is unavailable; recording without it.', error)
    return plain
  }
}
