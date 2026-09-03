import React, { memo } from "react";
import { MultiFileDiff, type FileContents } from "@pierre/diffs/react";
import { TextShimmer } from "../text-shimmer";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { IconChevronDown } from "@tabler/icons-react";
import { FileExtIcon } from "../icons/file-ext-icon";
import {
  extractFilePathArg,
  mapPartStateToInvocationState,
  mapToolInvocationToStep,
  mapToolStateToStepState,
} from "../utils/tool-adapters";
import { ToolApprovalFooter, type ToolApproval } from "./tool-approval-footer";

export type EditToolDiffCardProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  isCollapsible?: boolean;
  approval?: ToolApproval;
};

// The app themes via `html[data-theme="…"]` (+ `color-scheme`), not the
// `.dark` class, so checking only `.dark` leaves themeType stuck on "light".
// That renders light shiki tokens (dark text) on a dark `light-dark()` diff
// background — unreadable. Resolve against data-theme first, then computed
// color-scheme, then the legacy `.dark` class / OS preference.
function resolveEditDiffThemeIsDark(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  const dataTheme = root.getAttribute("data-theme");
  if (dataTheme === "light") return false;
  if (dataTheme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  }
  // Every other mousse theme id (dark, dark-modern, one-dark, monokai,
  // solarized-dark, github-dark, high-contrast, blacksphere-plus, …) is
  // dark-only.
  if (dataTheme) return true;
  if (root.classList.contains("dark")) return true;
  try {
    const colorScheme = getComputedStyle(root).colorScheme;
    if (colorScheme.includes("dark")) return true;
    if (colorScheme.includes("light")) return false;
  } catch {
    // getComputedStyle unavailable (SSR/test) — fall through.
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}

export function EditToolDiffCard({
  step,
  state,
  onComplete,
  input,
  output,
  isCollapsible = false,
  approval,
}: EditToolDiffCardProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const isPending = state === "animating";
  const fileName =
    step.filePath?.split("/").pop() ||
    step.toolDetail ||
    extractFilePathArg(input)?.split("/").pop() ||
    "";
  const hasFileName = Boolean(fileName);
  const isWrite = step.toolName === "Write";
  const [themeType, setThemeType] = React.useState<"light" | "dark">(() =>
    resolveEditDiffThemeIsDark() ? "dark" : "light",
  );
  const [isExpanded, setIsExpanded] = React.useState(!isCollapsible);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const updateTheme = () => {
      setThemeType(resolveEditDiffThemeIsDark() ? "dark" : "light");
    };
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMediaChange = () => updateTheme();
    media?.addEventListener?.("change", onMediaChange);

    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", onMediaChange);
    };
  }, []);

  React.useEffect(() => {
    setIsExpanded(!isCollapsible);
  }, [isCollapsible]);

  const diffFiles = React.useMemo(() => {
    const fileLabel = fileName || "file";
    const oldFromOutput =
      typeof output?.old_content === "string" ? output.old_content : undefined;
    const newFromOutput =
      typeof output?.content === "string" ? output.content : undefined;
    const oldFromInput =
      !oldFromOutput && typeof input?.old_string === "string"
        ? input.old_string
        : undefined;
    const newFromInput =
      !newFromOutput && typeof input?.new_string === "string"
        ? input.new_string
        : undefined;

    // Pi edit tool sends `{ path, edits: [{ oldText, newText }] }` instead of
    // Claude-style old_string/new_string — join each side so the diff renders.
    const editsOldText =
      !oldFromInput && !oldFromOutput && Array.isArray(input?.edits)
        ? input.edits
            .map((edit) =>
              edit && typeof edit.oldText === "string" ? edit.oldText : "",
            )
            .join("\n")
        : "";
    const oldFromEdits = editsOldText ? editsOldText : undefined;
    const editsNewText =
      !newFromInput && !newFromOutput && Array.isArray(input?.edits)
        ? input.edits
            .map((edit) =>
              edit && typeof edit.newText === "string" ? edit.newText : "",
            )
            .join("\n")
        : "";
    const newFromEdits = editsNewText ? editsNewText : undefined;

    const fallbackOld = step.diffLines
      ?.filter((line) => line.type !== "add")
      .map((line) => line.content)
      .join("\n");
    const fallbackNew = step.diffLines
      ?.filter((line) => line.type !== "remove")
      .map((line) => line.content)
      .join("\n");

    const oldContents =
      oldFromInput ?? oldFromOutput ?? oldFromEdits ?? fallbackOld ?? "";
    const newContents =
      newFromInput ?? newFromOutput ?? newFromEdits ?? fallbackNew ?? "";

    if (!oldContents && !newContents) return null;

    const oldFile: FileContents = {
      name: fileLabel,
      contents: oldContents,
    };
    const newFile: FileContents = {
      name: fileLabel,
      contents: newContents,
    };

    return { oldFile, newFile };
  }, [fileName, input, output, step.diffLines]);

  // Theme-compliant diff surface: point the library at the app theme tokens
  // instead of hardcoded black so bg, gutters and separators follow the
  // active theme in both modes. `colorScheme` keeps the library's
  // `light-dark()` backgrounds in sync with the shiki `themeType` tokens —
  // without it dark text lands on a dark background (unreadable).
  const diffCssVars = React.useMemo(
    () =>
      ({
        "--diffs-bg": "var(--an-tool-background)",
        "--diffs-bg-buffer-override": "var(--an-tool-background)",
        "--diffs-bg-context-override": "var(--an-tool-background)",
        "--diffs-bg-hover-override": "var(--an-background-secondary)",
        "--diffs-bg-separator-override": "var(--an-background-secondary)",
        colorScheme: themeType,
      }) as React.CSSProperties,
    [themeType],
  );

  const diffUnsafeCss = React.useMemo(
    () => `
[data-diff],
[data-file],
[data-diffs-header],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: var(--an-tool-background);
  --diffs-bg-buffer-override: var(--an-tool-background);
  --diffs-bg-context-override: var(--an-tool-background);
  --diffs-bg-hover-override: var(--an-background-secondary);
  --diffs-bg-separator-override: var(--an-background-secondary);
  color-scheme: ${themeType};
}
`,
    [themeType],
  );

  const diffClassName = "an-edit-diff bg-an-tool-background";

  return (
    <div className="an-tool-chrome an-edit-tool-card rounded-an-tool-border-radius border border-an-tool-border-color bg-an-tool-background overflow-hidden">
      <div
        className={
          // Header keeps the theme tool background so it stays distinct from
          // the diff body below it.
          "flex items-center justify-between px-2.5 py-0 h-7 bg-an-tool-background " +
          (isPending && !diffFiles
            ? ""
            : "border-b border-an-tool-border-color")
        }
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {hasFileName && (
            <FileExtIcon filename={fileName} className="w-3 h-3 shrink-0" />
          )}
          {isPending && !diffFiles ? (
            <TextShimmer as="span" duration={1.2} className="text-sm">
              Generating...
            </TextShimmer>
          ) : isPending ? (
            <TextShimmer as="span" duration={1.2} className="text-sm">
              {isWrite ? "Creating" : "Editing"} {fileName}
            </TextShimmer>
          ) : (
            <span className="text-sm text-an-tool-color-muted truncate">
              {isWrite ? "Created" : "Edited"} {fileName}
            </span>
          )}
        </div>
        {step.diffStats && !isPending && (
          <span className="text-[13px] font-mono text-an-tool-color-muted inline-flex gap-2">
            {step.diffStats.split(" ").map((token) => (
              <span
                key={token}
                className={
                  token.startsWith("+")
                    ? "text-an-diff-added-text"
                    : token.startsWith("-")
                      ? "text-an-diff-removed-text"
                      : undefined
                }
              >
                {token}
              </span>
            ))}
          </span>
        )}
      </div>
      {diffFiles ? (
        <div className={`${diffClassName} text-[14px]`} style={diffCssVars}>
          <div
            className={isCollapsible ? "group/edit-diff relative" : "relative"}
          >
            <div
              className={
                isCollapsible && !isExpanded
                  ? "max-h-[260px] overflow-hidden"
                  : undefined
              }
            >
              <MultiFileDiff
                key={themeType}
                oldFile={diffFiles.oldFile}
                newFile={diffFiles.newFile}
                className={diffClassName}
                style={diffCssVars}
                options={{
                  theme: { dark: "github-dark", light: "github-light" },
                  themeType,
                  unsafeCSS: diffUnsafeCss,
                  diffStyle: "unified",
                  disableFileHeader: true,
                }}
              />
            </div>
            {isCollapsible && (
              <>
                <button
                  type="button"
                  onClick={() => setIsExpanded((prev) => !prev)}
                  aria-label={isExpanded ? "Hide" : "Show more"}
                  className={
                    "group absolute inset-x-0 bottom-0 h-16 flex items-end justify-center pb-2 text-muted-foreground " +
                    (isExpanded
                      ? "bg-transparent"
                      : "bg-linear-to-b from-transparent to-background")
                  }
                >
                  <IconChevronDown
                    className={
                      "w-4 h-4 transition-opacity duration-150 opacity-0 group-hover:opacity-100 " +
                      (isExpanded ? "rotate-180" : "rotate-0")
                    }
                  />
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
    </div>
  );
}

export type EditToolProps = {
  part: any;
  isCollapsible?: boolean;
};

export const EditTool = memo(function EditTool({
  part,
  isCollapsible = false,
}: EditToolProps) {
  const approval = (part.input?.approval ?? part.args?.approval) as
    | ToolApproval
    | undefined;
  const toolName = (part.type as string)?.replace("tool-", "") || "Edit";
  const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "edit", {
    toolName,
    args: part.input ?? part.args ?? {},
    state: mapPartStateToInvocationState(part.state),
    result: part.output ?? part.result,
  });
  const stepState = mapToolStateToStepState(
    mapPartStateToInvocationState(part.state),
  );
  const noop = () => {};

  return (
    <EditToolDiffCard
      step={step}
      state={stepState}
      onComplete={noop}
      input={part.input ?? part.args}
      output={part.output ?? part.result}
      isCollapsible={isCollapsible}
      approval={approval}
    />
  );
});
