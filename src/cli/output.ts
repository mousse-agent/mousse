import type { OutputMode } from './parseArgs'

export function writeOutput(
  mode: OutputMode,
  data: unknown,
  textFormatter?: (data: unknown) => string
): void {
  if (mode === 'json') {
    const lines = Array.isArray(data) ? data : [data]
    for (const line of lines) {
      process.stdout.write(`${JSON.stringify(line)}\n`)
    }
    return
  }

  const text = textFormatter ? textFormatter(data) : formatDefaultText(data)
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function writeError(message: string, mode: OutputMode): void {
  if (mode === 'json') {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`)
  } else {
    process.stderr.write(`Error: ${message}\n`)
  }
}

export function exitWithError(message: string, mode: OutputMode, code = 1): never {
  writeError(message, mode)
  process.exit(code)
}

function formatDefaultText(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)
  return JSON.stringify(data, null, 2)
}

export function formatTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => (row[col] ?? '').length))
  )
  return rows
    .map((row) => row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  '))
    .join('\n')
}
