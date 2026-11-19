/**
 * Whether this process runs under an owner check's egress guard (`MOUSSE_CHECK_EGRESS_GUARD`, which the check kit
 * sets, as the in-process checks do): background lookups that leave the computer (the daily agent version check,
 * the model lists) are skipped, so the only traffic a check sees is the traffic it judges.
 */
export function inCheckRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.MOUSSE_CHECK_EGRESS_GUARD?.trim()
}
