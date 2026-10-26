import { GIT_NULL_DEVICE } from './gitNullDevice'

/**
 * Environment for Git that runs without the user asking for it (the bridge's bundle
 * ingest, a future background fetch): no prompt of any kind can open. Callers add
 * `-c credential.interactive=false` to the command line; it is not an environment variable.
 */
export function nonInteractiveGitEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: GIT_NULL_DEVICE,
    SSH_ASKPASS: GIT_NULL_DEVICE,
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never'
  }
}

/**
 * Environment for a Git action the user just pressed. The service has no terminal, so a
 * terminal prompt could never be answered and is turned off. Git Credential Manager,
 * askpass helpers and SSH passphrase prompts keep working; a silence timer stops an
 * action that waits on one forever.
 */
export function explicitActionGitEnv(): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: '0' }
}
