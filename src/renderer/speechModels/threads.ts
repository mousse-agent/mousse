/**
 * Most threads a dictation model gets. On Parakeet 110M (issue #513), 4 threads ran the encoder
 * 2.4 times faster than 1; 8 added less than 10% more while taking twice the cores.
 */
export const MAX_SPEECH_THREADS = 4

/**
 * Threads for a speech model's ONNX Runtime: half the logical cores, so the rest of the app stays
 * responsive, and at most `MAX_SPEECH_THREADS` (ONNX Runtime's own default rule). Threads share
 * memory through SharedArrayBuffer; without it the runtime can only use one.
 */
export function speechModelThreads(logicalCores: number | undefined, sharedMemory: boolean): number {
  if (!sharedMemory) return 1
  return Math.min(MAX_SPEECH_THREADS, Math.max(1, Math.ceil((logicalCores || 1) / 2)))
}
