import type { NativeToolTable } from '../../../shared/harness/tools'

/**
 * Pi's own tools for each neutral tool (PR 6 §2), on the RPC engine. Pi has no web tools, and its
 * `powershell` has no neutral name. Every name exists in the pinned Pi's `tools/index.js`
 * (`toolNames` test). The legacy loop runs Mousse's own tools and maps none.
 */
export const PI_NATIVE_TOOLS: NativeToolTable = Object.freeze({
  read: ['read'],
  list: ['ls'],
  search: ['find', 'grep'],
  edit: ['edit'],
  write: ['write'],
  shell: ['bash']
})
