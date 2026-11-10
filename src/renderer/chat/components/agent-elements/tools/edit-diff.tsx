import React from "react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { diffSurfaceStyle, diffUnsafeCSS, useDiffThemeType } from "../../../../lib/diffTheme";
import type { DiffSource } from "./edit-tool";

const DIFF_CLASS = "an-edit-diff bg-an-tool-background";

/**
 * One file's diff. Rendered only while its row is open, so a collapsed row costs no diff and no theme watcher.
 * The diff points the library at the app theme tokens instead of hardcoded black, and `colorScheme` keeps the
 * library's `light-dark()` backgrounds in sync with the syntax tokens (without it dark text lands on a dark
 * background). The font matches the Changes tab.
 */
export function EditDiff({ diff }: { diff: DiffSource }) {
  const themeType = useDiffThemeType();
  const style = React.useMemo(() => diffSurfaceStyle(themeType), [themeType]);
  const options = React.useMemo(
    () => ({
      theme: { dark: "github-dark", light: "github-light" } as const,
      themeType,
      unsafeCSS: diffUnsafeCSS(themeType),
      diffStyle: "unified" as const,
      disableFileHeader: true,
    }),
    [themeType],
  );
  return diff.kind === "patch" ? (
    <PatchDiff key={themeType} patch={diff.patch} className={DIFF_CLASS} style={style} options={options} />
  ) : (
    <MultiFileDiff
      key={themeType}
      oldFile={diff.oldFile}
      newFile={diff.newFile}
      className={DIFF_CLASS}
      style={style}
      options={options}
    />
  );
}
