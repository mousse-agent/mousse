import type { WorkflowBundle } from './bundle'

/** JSON transport carries binary assets explicitly; JSON.stringify(Uint8Array) is not a bundle. */
export interface WorkflowWireBundle extends Omit<WorkflowBundle, 'assets'> {
  assets: Array<{ relativePath: string; encoding: 'utf8' | 'base64'; data: string; sha256?: string }>
}

export function encodeWorkflowBundle(bundle: WorkflowBundle): WorkflowWireBundle {
  return {
    ...bundle,
    assets: bundle.assets.map(({ relativePath, bytes, sha256 }) => {
      if (typeof bytes === 'string') return { relativePath, encoding: 'utf8' as const, data: bytes, sha256 }
      let raw = ''
      for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      return { relativePath, encoding: 'base64' as const, data: btoa(raw), sha256 }
    })
  }
}

/** Call after the receiving boundary validates sizes, keys, encodings and package paths. */
export function decodeWorkflowBundle(bundle: WorkflowWireBundle): WorkflowBundle {
  return {
    ...bundle,
    assets: bundle.assets.map(({ relativePath, encoding, data, sha256 }) => ({
      relativePath, sha256,
      bytes: encoding === 'utf8' ? data : Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
    }))
  }
}
