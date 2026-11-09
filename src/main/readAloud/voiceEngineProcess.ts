import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { KokoroTtsModel } from '../../shared/readAloud'
import type { VoiceEngineProcess } from './NativeTtsSlots'

/**
 * The native voice engine binary (`native/voice-engine`, built by scripts/build-voice-engine.mjs).
 * A package carries it as `resources/voice-engine/mousse-voice[.exe]`; a checkout runs the crate's
 * own release build.
 */
export function voiceEnginePath(app: { isPackaged: boolean; getAppPath(): string }): string {
  const name = process.platform === 'win32' ? 'mousse-voice.exe' : 'mousse-voice'
  return app.isPackaged
    ? join(process.resourcesPath, 'voice-engine', name)
    : join(app.getAppPath(), 'native', 'voice-engine', 'target', 'release', name)
}

/** The ONNX file of each Kokoro dtype, as transformers.js names them. */
const KOKORO_ONNX_FILES: Record<KokoroTtsModel['dtype'], string> = { q8: 'onnx/model_quantized.onnx' }

export const kokoroOnnxFile = (model: KokoroTtsModel): string => KOKORO_ONNX_FILES[model.dtype]

/** Starts the engine at `path`; throws when it is not there. Its log lines go to main's console. */
export function spawnVoiceEngine(path: string): VoiceEngineProcess {
  if (!existsSync(path)) throw new Error('The native voice engine is not part of this build')
  const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // Writing to an engine that just ended fails; its exit is reported instead.
  child.stdin.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    for (const line of text.split(/\r?\n/)) if (line.trim()) console.warn(`[voice engine] ${line}`)
  })
  return {
    write: (bytes) => {
      if (child.stdin.writable) child.stdin.write(bytes)
    },
    onData: (listener) => child.stdout.on('data', listener),
    onExit: (listener) => {
      let called = false
      const once = (): void => {
        if (called) return
        called = true
        listener()
      }
      child.on('error', once)
      child.on('exit', once)
    },
    kill: () => {
      child.kill()
    }
  }
}
