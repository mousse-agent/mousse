import React, { memo } from "react";
import { MultiFileDiff, PatchDiff, type FileContents } from "@pierre/diffs/react";
import { TextShimmer } from "../text-shimmer";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { IconChevronDown, IconChevronRight } from "../../../../lib/icons";
import { FileExtIcon } from "../icons/file-ext-icon";
import { CODE_FONT } from "../../../../lib/typography";
import { diffAsPatch, diffSides, type ActivityFileChange } from "../../../../../shared/agentActivity";
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
  /** The call failed: the header says so. */
  isError?: boolean;
};

/** One file's change as a typed activity item saves it (`AgentActivityItem` `file_change`). */
type ChangeSection = {
  path: string;
  label: string;
  /** The stored unified patch, when it has real hunk headers. */
  patch?: string;
  oldFile?: FileContents;
  newFile?: FileContents;
  added?: number;
  removed?: number;
  note?: string;
  error?: string;
};

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The sections a typed item's `changes` draw as: a diff, or the reason there is none. */
function changeSections(changes: unknown): ChangeSection[] | undefined {
  if (!Array.isArray(changes)) return undefined;
  return changes.flatMap((entry): ChangeSection[] => {
    if (!entry || typeof entry !== "object") return [];
    const change = entry as ActivityFileChange;
    if (typeof change.path !== "string") return [];
    const label = baseName(change.path);
    const section: ChangeSection = {
      path: change.path,
      label,
      added: change.added,
      removed: change.removed,
      ...(change.error ? { error: change.error } : {}),
    };
    if (change.diff) {
      // A patch with real hunk headers keeps each hunk's line numbers and the gaps between hunks;
      // anything else (a whole added or deleted file's text) is drawn from its two sides.
      const patch = diffAsPatch(change.path, change.diff);
      if (patch) {
        section.patch = patch;
      } else {
        const { oldText, newText } = diffSides(change.diff, change.change);
        section.oldFile = { name: label, contents: oldText };
        section.newFile = { name: label, contents: newText };
      }
      if (change.diffTruncated) section.note = "Diff truncated";
    } else if (change.diffUnavailable) {
      section.note =
        typeof change.linesWritten === "number"
          ? `Diff not available (${change.linesWritten} ${change.linesWritten === 1 ? "line" : "lines"} written)`
          : "Diff not available";
    }
    return [section];
  });
}

function statsFromSections(sections: ChangeSection[]): string | undefined {
  const added = sections.reduce((sum, section) => sum + (section.added ?? 0), 0);
  const removed = sections.reduce((sum, section) => sum + (section.removed ?? 0), 0);
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

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
  /** Collapse to header-only by default; click the header to expand. */
  isCollapsible = true,
  approval,
  isError = false,
}: EditToolDiffCardProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const isPending = state === "animating";
  const sections = React.useMemo(() => changeSections(output?.changes), [output]);
  const isInterrupted = output?.interrupted === true;
  const fileName =
    sections && sections.length > 1
      ? `${sections.length} files`
      : sections?.[0]?.label ||
        step.filePath?.split("/").pop() ||
        step.toolDetail ||
        extractFilePathArg(input)?.split("/").pop() ||
        "";
  const hasFileName = Boolean(fileName);
  const isWrite = step.toolName === "Write";
  const diffStats = sections ? statsFromSections(sections) : step.diffStats;
  const [themeType, setThemeType] = React.useState<"light" | "dark">(() =>
    resolveEditDiffThemeIsDark() ? "dark" : "light",
  );
  const [isExpanded, setIsExpanded] = React.useState(false);

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
    // A typed item draws its own sections below, never the legacy single diff.
    if (sections) return null;
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
  }, [fileName, input, output, sections, step.diffLines]);

  // Something to open: a diff, a note about the diff, or the error the edit failed with.
  const hasBody = sections
    ? sections.some((section) => section.patch || section.oldFile || section.note || section.error)
    : Boolean(diffFiles);

  // Theme-compliant diff surface: point the library at the app theme tokens
  // instead of hardcoded black so bg, gutters and separators follow the
  // active theme in both modes. `colorScheme` keeps the library's
  // `light-dark()` backgrounds in sync with the shiki `themeType` tokens —
  // without it dark text lands on a dark background (unreadable).
  // Font matches the Git tab diff (Monaco `fontFamily`).
  const diffCssVars = React.useMemo(
    () =>
      ({
        "--diffs-bg": "var(--an-tool-background)",
        "--diffs-bg-buffer-override": "var(--an-tool-background)",
        "--diffs-bg-context-override": "var(--an-tool-background)",
        "--diffs-bg-hover-override": "var(--an-background-secondary)",
        "--diffs-bg-separator-override": "var(--an-background-secondary)",
        "--diffs-font-family": CODE_FONT,
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
  --diffs-font-family: ${CODE_FONT};
  color-scheme: ${themeType};
}
`,
    [themeType],
  );

  const diffClassName = "an-edit-diff bg-an-tool-background";

  return (
    <div className="an-edit-tool-card rounded-an-tool-border-radius border border-an-tool-border-color bg-an-tool-background overflow-hidden">
      <button
        type="button"
        onClick={
          hasBody && isCollapsible
            ? () => setIsExpanded((prev) => !prev)
            : undefined
        }
        aria-expanded={hasBody && isCollapsible ? isExpanded : undefined}
        aria-label={
          hasBody && isCollapsible
            ? isExpanded
              ? `Collapse diff for ${fileName || "file"}`
              : `Expand diff for ${fileName || "file"}`
            : undefined
        }
        disabled={!hasBody || !isCollapsible}
        className={
          // Header keeps the theme tool background so it stays distinct from
          // the diff body below it.
          // `an-tool-chrome` lives on the header only: idle chrome dims to
          // keep contrast, but the diff body below always renders at full
          // opacity — dimming the code to 0.55 washes it out next to
          // full-opacity surfaces like the Git tab Monaco diff.
          "an-tool-chrome flex items-center justify-between px-2.5 py-0 h-7 w-full text-left bg-an-tool-background " +
          (isExpanded || !isCollapsible
            ? "border-b border-an-tool-border-color "
            : "") +
          (hasBody && isCollapsible ? "cursor-pointer" : "")
        }
      >
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {hasFileName && (
            <FileExtIcon filename={fileName} className="w-[18px] h-[18px] shrink-0" />
          )}
          {isPending && !hasBody ? (
            <TextShimmer as="span" duration={1.2} className="text-xs">
              Generating...
            </TextShimmer>
          ) : isPending ? (
            <TextShimmer as="span" duration={1.2} className="text-xs">
              {isWrite ? "Creating" : "Editing"} {fileName}
            </TextShimmer>
          ) : isInterrupted ? (
            <span className="text-xs text-an-tool-color-muted truncate">
              {isWrite ? "Create" : "Edit"} interrupted: {fileName}
            </span>
          ) : isError ? (
            <span className="text-xs text-red-400 truncate">
              Failed to {isWrite ? "create" : "edit"} {fileName}
            </span>
          ) : (
            <span className="text-xs text-an-tool-color-muted truncate">
              {isWrite ? "Created" : "Edited"} {fileName}
            </span>
          )}
        </span>
        {diffStats && !isPending && (
          <span className="text-[11px] font-sans text-an-tool-color-muted inline-flex gap-2">
            {diffStats.split(" ").map((token) => (
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
        {hasBody && isCollapsible && (
          <IconChevronRight
            className={
              "w-4 h-4 shrink-0 text-an-tool-color-muted transition-transform duration-150 ease-out ml-1 " +
              (isExpanded ? "rotate-90" : "rotate-0")
            }
          />
        )}
      </button>
      {hasBody && (!isCollapsible || isExpanded) ? (
        <div className={`${diffClassName} text-[12px]`} style={diffCssVars}>
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
              {sections
                ? sections.map((section, index) => (
                    <div key={`${section.path}:${index}`}>
                      {sections.length > 1 && (
                        <div className="flex items-center gap-1.5 px-2.5 h-6 text-[11px] text-an-tool-color-muted border-b border-an-tool-border-color">
                          <FileExtIcon filename={section.label} className="w-4 h-4 shrink-0" />
                          <span className="truncate">{section.path}</span>
                        </div>
                      )}
                      {section.error && (
                        <div className="px-2.5 py-1.5 text-[12px] text-red-400 whitespace-pre-wrap break-words">
                          {section.error}
                        </div>
                      )}
                      {section.patch && (
                        <PatchDiff
                          key={themeType}
                          patch={section.patch}
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
                      )}
                      {section.oldFile && section.newFile && (
                        <MultiFileDiff
                          key={themeType}
                          oldFile={section.oldFile}
                          newFile={section.newFile}
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
                      )}
                      {section.note && (
                        <div className="px-2.5 py-1.5 text-[11px] text-an-tool-color-muted">
                          {section.note}
                        </div>
                      )}
                    </div>
                  ))
                : diffFiles && (
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
                  )}
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
  isCollapsible = true,
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
      isError={part.state === "output-error"}
    />
  );
});
