import { ipcErrorMessage } from '../utils/voiceErrors'
import type { ModelFileRequest, ModelFileResponse } from './workerSupport'

/**
 * Page-side half of the local model file hand-off: answers a worker's `file-request` messages with
 * bytes read from the app's downloaded copy of the model.
 */
export function serveModelFiles(worker: Worker, readFile: (path: string) => Promise<Uint8Array>): void {
  const reply = (response: ModelFileResponse, transfer: Transferable[] = []): void => worker.postMessage(response, transfer)

  const answer = async (reqId: number, path: string): Promise<void> => {
    try {
      const bytes = await readFile(path)
      const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      const buffer = (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer
      reply({ type: 'file-response', reqId, bytes: buffer }, [buffer])
    } catch (error) {
      reply({ type: 'file-response', reqId, error: ipcErrorMessage(error) || 'Model file unavailable' })
    }
  }

  worker.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
    if (event.data.type !== 'file-request') return
    const request = event.data as ModelFileRequest
    void answer(request.reqId, request.path)
  })
}
