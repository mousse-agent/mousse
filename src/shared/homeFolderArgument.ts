/** Hands this computer's home folder to the window, so paths can be shown as `~/…`. */
const ARGUMENT_PREFIX = '--mousse-home-folder='

export function homeFolderArgument(home: string): string {
  return ARGUMENT_PREFIX + encodeURIComponent(home)
}

export function readHomeFolderArgument(argv: string[]): string | undefined {
  const argument = argv.find((value) => value.startsWith(ARGUMENT_PREFIX))
  if (!argument) return undefined
  try {
    return decodeURIComponent(argument.slice(ARGUMENT_PREFIX.length)) || undefined
  } catch {
    return undefined
  }
}
