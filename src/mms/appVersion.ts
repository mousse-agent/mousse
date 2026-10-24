/**
 * The running Mousse version, from `package.json`. Entry points set `MOUSSE_VERSION` (the packaged
 * app version, or the checkout's package.json under the CLI) and child processes inherit it.
 */
export function mousseVersion(): string {
  return process.env.MOUSSE_VERSION || process.env.npm_package_version || '0.0.0'
}
