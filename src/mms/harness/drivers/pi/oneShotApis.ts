/**
 * Whether a pi-ai model's API can run a one-shot (a chat title, a pull request draft, a commit
 * message) in Mousse's own process. Bedrock cannot: pi-ai builds its AWS client without
 * `maxAttempts` and takes no per-call setting, so the AWS SDK would retry below Mousse here. Its
 * one-shots wait until they run in a process Mousse configures (the Pi RPC child holds Bedrock to
 * one attempt). The model pickers for these uses leave such models out, and `runPiOneShot` refuses
 * them with `unsupported` if a stored choice still names one.
 */
export function piOneShotRunsOn(api: string): boolean {
  return api !== 'bedrock-converse-stream'
}
