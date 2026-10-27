/**
 * Quoting for commands that run on another machine.
 *
 * `ssh` joins the remote command into one string and hands it to the account's login shell
 * (bash, zsh, fish, ...). Every command Mousse sends is therefore `exec /bin/sh -c <script>`, so
 * only POSIX `sh` ever parses the script, and every value inside that script is quoted with the
 * same rule. Nothing is interpolated unquoted into either layer. Secrets and documents travel on
 * stdin, never in the command string.
 *
 * The command string contains no backslash. fish reads `\\` and `\'` inside single quotes, so a
 * value carrying one would reach `sh` changed, and the usual `'\''` escape would end a quote early.
 * An embedded apostrophe is written `'"'"'` instead, which every shell reads the same way, and a
 * value with a backslash is refused.
 */

/** Single quotes keep every character literal; an embedded `'` closes, adds a quoted `'` and reopens. */
export function q(value: string): string {
  if (value.includes('\0')) throw new Error('A shell argument cannot contain a NUL byte.')
  if (value.includes('\\')) throw new Error('A shell argument cannot contain a backslash.')
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** The one remote command shape: the script is a single quoted word for the login shell. */
export function remoteCommand(script: string): string {
  if (script.includes('\\')) throw new Error('A remote script cannot contain a backslash.')
  return `exec /bin/sh -c ${q(script)}`
}
