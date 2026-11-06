/** The last part of a folder path, as a short name for it ("/work/mousse/" → "mousse"); null for no path. */
export function folderName(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The last two parts of a folder path ("/work/a/app" → "a/app"), for two folders with the same name. */
function folderWithParent(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : (parts[0] ?? path)
}

export interface TerminalPlace {
  id: string
  /** The folder the terminal was started in, as the app resolved it; unknown until it starts. */
  cwd?: string
  /** The computer the terminal runs on; undefined for this computer. */
  node?: string
  /** That computer's name, shown when it tells two terminals apart. */
  computerName?: string
}

export interface TerminalLocation {
  /** Short words that stay on the tab: the folder, and the computer only when the folder alone is ambiguous. */
  label: string
  /** The full folder, and the computer when it is another one. */
  title: string
}

/**
 * Where each terminal works, for its tab. The folder name alone when it is unique among the
 * terminals shown; its parent too when two folders on one computer share a name; the computer's
 * name when the same folder name is open on different computers. Never read from shell output.
 */
export function terminalLocations(terminals: readonly TerminalPlace[]): Record<string, TerminalLocation> {
  const located = terminals.flatMap((terminal) => {
    const name = folderName(terminal.cwd)
    return terminal.cwd && name ? [{ ...terminal, cwd: terminal.cwd, name }] : []
  })
  const result: Record<string, TerminalLocation> = {}
  for (const terminal of located) {
    const sameName = located.filter((other) => other.name === terminal.name)
    const otherComputer = sameName.some((other) => other.node !== terminal.node)
    const otherFolderHere = sameName.some((other) => other.node === terminal.node && other.cwd !== terminal.cwd)
    const folder = otherFolderHere ? folderWithParent(terminal.cwd) : terminal.name
    const computer = terminal.node ? terminal.computerName : 'This computer'
    result[terminal.id] = {
      label: otherComputer && computer ? `${folder} · ${computer}` : folder,
      title: terminal.node && terminal.computerName ? `${terminal.cwd} on ${terminal.computerName}` : terminal.cwd
    }
  }
  return result
}
