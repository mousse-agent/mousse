/** Opt-in wall-clock observations; fixture arguments and credentials are never logged. */
export function beginFixturePhase(fixture: string, phase: string): () => void {
  if (process.env.MOUSSE_TEST_PHASE_TIMING !== '1') return () => {}
  const started = performance.now()
  return () => console.error('[fixture-phase]', JSON.stringify({
    fixture, phase, pid: process.pid, durationMs: Number((performance.now() - started).toFixed(2))
  }))
}

export async function fixturePhase<T>(fixture: string, phase: string, operation: () => T | Promise<T>): Promise<T> {
  const finish = beginFixturePhase(fixture, phase)
  try { return await operation() } finally { finish() }
}
