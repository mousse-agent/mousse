/** Terminal escape sequences (colours, cursor moves, titles). The card renders plain text, so they would show as noise. */
const ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A line a test runner or compiler marks as a failure: `× adds`, `FAIL src/a.test.ts`, `AssertionError: …`, `npm ERR! …`. */
const FAILURE_LINE = /^\s*(?:[×✗✘✕]\s|(?:FAIL|FAILED)\b|ERR!|npm ERR!|[A-Za-z]*Error:|error(?:\[[A-Z0-9]+\])?:)/;

/** The line some runtimes (Claude Code) put before a failed command's output: `Exit code 1`. */
const EXIT_CODE_LINE = /^Exit code (-?\d+)(?:\r?\n|$)/;

export type BashOutputLine = { text: string; failed: boolean };

/** The output as lines, escape sequences removed, with failure lines marked so they read in the danger colour. */
export function bashOutputLines(output: string): BashOutputLine[] {
  return output
    .replace(ESCAPE_PATTERN, "")
    .split("\n")
    .map((text) => ({ text, failed: FAILURE_LINE.test(text) }));
}

/**
 * A command's result text split into its exit code and its output, when the text starts with the `Exit code N` line
 * some runtimes add; the output is returned whole otherwise.
 */
export function splitExitCode(result: string): { exitCode?: number; output: string } {
  const match = EXIT_CODE_LINE.exec(result);
  if (!match) return { output: result };
  return { exitCode: Number(match[1]), output: result.slice(match[0].length) };
}
