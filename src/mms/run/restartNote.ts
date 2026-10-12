/** Payload of a `restart.note` thread event (SPEC §12.5 step 5), written by `reconcileOnBoot`. */
export interface RestartNote {
  runIds: string[]
  uncertainRunIds: string[]
  cutOffTools: Array<{ runId: string; invocationId: string; tool: string; idempotent: boolean }>
  epoch: number
}

/** The system note the next turn on the thread shows once after a daemon restart. */
export function formatRestartNote(note: RestartNote): string {
  const count = note.runIds.length
  let text = `The Mousse daemon restarted during the previous turn. Interrupted: ${count} run(s).`
  if (note.uncertainRunIds.length) {
    const uncertain = new Set(note.uncertainRunIds)
    const inUncertainRuns = note.cutOffTools.filter((tool) => uncertain.has(tool.runId))
    const unsafe = inUncertainRuns.filter((tool) => !tool.idempotent)
    const tools = [...new Set((unsafe.length ? unsafe : inUncertainRuns).map((tool) => tool.tool))]
    text += ` These tool calls may have run without a recorded result; verify before repeating: ${
      tools.length ? tools.join(', ') : 'unknown'
    }.`
  }
  return text
}
