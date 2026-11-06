/** Terminal escape sequences (colours, cursor moves, titles). The card renders plain text, so they would show as noise. */
const ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A line a test runner or compiler marks as a failure: `× adds`, `FAIL src/a.test.ts`, `AssertionError: …`, `npm ERR! …`. */
const FAILURE_LINE = /^\s*(?:[×✗✘✕]\s|(?:FAIL|FAILED)\b|ERR!|npm ERR!|[A-Za-z]*Error:|error(?:\[[A-Z0-9]+\])?:)/;

export type BashOutputLine = { text: string; failed: boolean };

/** The output as lines, escape sequences removed, with failure lines marked so they read in the danger colour. */
export function bashOutputLines(output: string): BashOutputLine[] {
  return output
    .replace(ESCAPE_PATTERN, "")
    .split("\n")
    .map((text) => ({ text, failed: FAILURE_LINE.test(text) }));
}
