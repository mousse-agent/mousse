/** A project's two-letter mark, where it has no icon of its own: "mousse-net" → "MN", "fin" → "FI". */
export function projectInitials(name: string): string {
  const parts = name.split(/[\s/._-]+/).filter(Boolean)
  const letters = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? parts[0]?.[1] ?? ''}`
  return letters.toUpperCase() || '•'
}
