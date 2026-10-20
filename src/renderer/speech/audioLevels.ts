/**
 * Live loudness for the sound wave. An AnalyserNode watches the audio that is playing or being
 * recorded, and each bar of the wave shows one band of the speech range.
 */

/** Returns one level per bar, each 0 (silent) to 1 (loud). */
export type AudioLevels = () => readonly number[]

/** Bars of the wave, from low to high pitch. */
export const WAVE_BARS = 4

/** Speech energy sits between these frequencies. */
const LOW_HZ = 100
const HIGH_HZ = 4000
/** Spectrum floor and ceiling in dB, mapped to levels 0 and 1. */
const MIN_DB = -85
const MAX_DB = -25

/** Splits LOW_HZ..HIGH_HZ into `bars` bands of equal width on a log scale; returns FFT bin edges. */
export function bandEdges(sampleRate: number, fftSize: number, bars: number): number[] {
  const binHz = sampleRate / fftSize
  const edges: number[] = []
  for (let index = 0; index <= bars; index += 1) {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (index / bars)
    edges.push(Math.max(1, Math.round(hz / binHz)))
  }
  return edges
}

/** Average of each band of a dB spectrum, mapped to 0..1. */
export function bandLevels(spectrum: ArrayLike<number>, edges: readonly number[]): number[] {
  const levels: number[] = []
  for (let band = 0; band < edges.length - 1; band += 1) {
    const from = edges[band]
    const to = Math.max(from + 1, edges[band + 1])
    let sum = 0
    for (let bin = from; bin < to; bin += 1) sum += spectrum[bin] ?? MIN_DB
    const db = sum / (to - from)
    levels.push(Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB))))
  }
  return levels
}

/** Creates an analyser in `context` and the levels it reports. Connect the audio into `analyser`. */
export function createLevelMeter(context: BaseAudioContext): { analyser: AnalyserNode; levels: AudioLevels } {
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.55
  analyser.minDecibels = -100
  analyser.maxDecibels = 0
  const spectrum = new Float32Array(analyser.frequencyBinCount)
  const edges = bandEdges(context.sampleRate, analyser.fftSize, WAVE_BARS)
  return {
    analyser,
    levels: () => {
      analyser.getFloatFrequencyData(spectrum)
      return bandLevels(spectrum, edges)
    }
  }
}
