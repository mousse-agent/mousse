export interface WorkflowCommandToken { value: string; start: number; end: number; quoted: boolean }
export class WorkflowCommandSyntaxError extends Error {
  readonly code = 'invalid_invocation'
  constructor(message: string, readonly offset: number) { super(message); this.name = 'WorkflowCommandSyntaxError' }
}

/** A text tokenizer, never a shell: no expansion, interpolation, globbing, or evaluation. */
export function tokenizeWorkflowCommand(text: string): WorkflowCommandToken[] {
  if (text.length > 128 * 1024 || text.includes('\0')) throw new WorkflowCommandSyntaxError('Command text is too large or contains NUL', 0)
  const tokens: WorkflowCommandToken[] = []
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++
    if (index >= text.length) break
    if (tokens.length >= 1024) throw new WorkflowCommandSyntaxError('Too many command arguments', index)
    const start = index
    const quoted = text[index] === '"' || text[index] === "'"
    let quote: string | undefined, value = ''
    while (index < text.length) {
      const character = text[index]
      if (!quote && /\s/.test(character)) break
      if (character === '\\') {
        const next = text[index + 1]
        if (next && (next === '\\' || next === '"' || next === "'" || (!quote && /\s/.test(next)))) { value += next; index += 2; continue }
        value += character; index++; continue
      }
      if (quote) {
        if (character === quote) quote = undefined
        else value += character
      } else if (character === '"' || character === "'") quote = character
      else value += character
      index++
    }
    if (quote) throw new WorkflowCommandSyntaxError('Unclosed quoted argument', start)
    tokens.push({ value, start, end: index, quoted })
  }
  return tokens
}
