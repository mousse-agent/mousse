import React, { memo, useContext } from "react";
import { MultiFileDiff, PatchDiff, type FileContents } from "@pierre/diffs/react";
import { TextShimmer } from "../text-shimmer";
import type { TimelineStep } from "../types/timeline";
import { File, FilePlus, GitCompare, IconChevronRight, Pencil } from "../../../../lib/icons";
import { CODE_FONT } from "../../../../lib/typography";
import { diffAsPatch, diffSides, type ActivityFileChange } from "../../../../../shared/agentActivity";
import {
  extractFilePathArg,
  mapPartStateToInvocationState,
  mapToolInvocationToStep,
} from "../utils/tool-adapters";
import { cn } from "../utils/cn";
import { ToolApprovalFooter, type ToolApproval } from "./tool-approval-footer";
import { openFileInPanel } from "../../../../utils/chatLinks";
import { openTurnInReview } from "../../../../components/review/openReview";
import { useAppStore } from "../../../../stores/appStore";
import { TurnIdContext } from "../turn-context";

/** What one file's diff is drawn from. */
type DiffSource =
  | { kind: "patch"; patch: string }
  | { kind: "sides"; oldFile: FileContents; newFile: FileContents };

type FileVerb = "edit" | "create" | "delete";

/** One file an edit call changed, the same whether the call came as a typed item or as raw tool input. */
export type EditedFile = {
  /** The path the agent wrote: absolute, or relative to the thread's folder. */
  path?: string;
  /** The file name shown on the row. */
  name: string;
  verb: FileVerb;
  added: number;
  removed: number;
  diff?: DiffSource;
  /** Why there is no full diff ("Diff truncated", "Diff not available"). */
  note?: string;
  /** The error this file failed with. */
  error?: string;
};

type RowStatus = "pending" | "done" | "failed" | "interrupted";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Lines added and removed between two texts, counted the way the changed-files line after the turn counts them. */
function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  if (!oldText && !newText) return { added: 0, removed: 0 };
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < max; i += 1) {
    if (oldLines[i] !== undefined && newLines[i] !== undefined) {
      if (oldLines[i] !== newLines[i]) {
        added += 1;
        removed += 1;
      }
    } else if (oldLines[i] !== undefined) {
      removed += 1;
    } else {
      added += 1;
    }
  }
  return { added, removed };
}

function parseStats(stats: string | undefined): { added: number; removed: number } {
  const added = Number(/\+(\d+)/.exec(stats ?? "")?.[1] ?? 0);
  const removed = Number(/-(\d+)/.exec(stats ?? "")?.[1] ?? 0);
  return { added, removed };
}

/** Lines in a whole file's text; a final newline does not start another line. */
function lineCount(content: string): number {
  if (!content) return 0;
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n").length;
}

function verbOf(change: ActivityFileChange["change"] | undefined): FileVerb {
  return change === "add" ? "create" : change === "delete" ? "delete" : "edit";
}

/** The files a typed item's `changes` hold, each with its diff or the reason there is none. */
function filesFromChanges(changes: unknown): EditedFile[] | undefined {
  if (!Array.isArray(changes)) return undefined;
  return changes.flatMap((entry): EditedFile[] => {
    if (!entry || typeof entry !== "object") return [];
    const change = entry as ActivityFileChange;
    if (typeof change.path !== "string") return [];
    const name = baseName(change.path);
    const file: EditedFile = {
      path: change.path,
      name,
      verb: verbOf(change.change),
      added: change.added ?? (change.change === "add" ? change.linesWritten : undefined) ?? 0,
      removed: change.removed ?? 0,
      ...(change.error ? { error: change.error } : {}),
    };
    if (change.diff) {
      // A patch with real hunk headers keeps each hunk's line numbers and the gaps between hunks;
      // anything else (a whole added or deleted file's text) is drawn from its two sides.
      const patch = diffAsPatch(change.path, change.diff);
      if (patch) {
        file.diff = { kind: "patch", patch };
      } else {
        const { oldText, newText } = diffSides(change.diff, change.change);
        // A new file recorded without its line count still shows +N: its text is all added lines.
        if (file.verb === "create" && change.added === undefined && change.linesWritten === undefined) {
          file.added = lineCount(newText);
        }
        file.diff = {
          kind: "sides",
          oldFile: { name, contents: oldText },
          newFile: { name, contents: newText },
        };
      }
      if (change.diffTruncated) file.note = "Diff truncated";
    } else if (change.diffUnavailable) {
      file.note =
        typeof change.linesWritten === "number"
          ? `Diff not available (${change.linesWritten} ${change.linesWritten === 1 ? "line" : "lines"} written)`
          : "Diff not available";
    }
    return [file];
  });
}

/** One edit's text on each side, from whichever shape the tool sent. */
type EditPair = { oldText: string; newText: string };

function editPairs(input: Record<string, unknown> | undefined): EditPair[] {
  if (!input) return [];
  // Several edits in one call: `{ edits: [{ old_string, new_string }] }`, or `{ oldText, newText }` per edit.
  if (Array.isArray(input.edits)) {
    return input.edits.flatMap((edit): EditPair[] => {
      if (!edit || typeof edit !== "object") return [];
      const row = edit as Record<string, unknown>;
      return [{ oldText: textOf(row.old_string ?? row.oldText), newText: textOf(row.new_string ?? row.newText) }];
    });
  }
  return [{ oldText: textOf(input.old_string ?? input.oldText), newText: textOf(input.new_string ?? input.newText) }];
}

/** The one file a raw (untyped) Edit, MultiEdit or Write call changed. */
function fileFromRawCall(
  step: Extract<TimelineStep, { type: "tool-call" }>,
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): EditedFile {
  const isWrite = step.toolName === "Write";
  const path = step.filePath || extractFilePathArg(input) || undefined;
  const name = path ? baseName(path) : step.toolDetail || "";
  const label = name || "file";

  const oldFromOutput = typeof output?.old_content === "string" ? output.old_content : undefined;
  const newFromOutput = typeof output?.content === "string" ? output.content : undefined;
  const pairs = editPairs(input);
  const joinedOld = pairs.map((pair) => pair.oldText).join("\n");
  const joinedNew = pairs.map((pair) => pair.newText).join("\n");
  const fallbackOld = step.diffLines
    ?.filter((line) => line.type !== "add")
    .map((line) => line.content)
    .join("\n");
  const fallbackNew = step.diffLines
    ?.filter((line) => line.type !== "remove")
    .map((line) => line.content)
    .join("\n");
  const oldContents = (joinedOld || undefined) ?? oldFromOutput ?? fallbackOld ?? "";
  const newContents = (joinedNew || undefined) ?? newFromOutput ?? fallbackNew ?? "";

  let stats: { added: number; removed: number };
  if (Array.isArray(output?.structuredPatch)) {
    stats = parseStats(step.diffStats);
  } else if (isWrite) {
    // The same keys the changed-files line after the turn reads, so the rows add up to it.
    const content = textOf(output?.content) || textOf(input?.content) || textOf(input?.contents);
    stats = { added: lineCount(content), removed: 0 };
  } else {
    stats = pairs.reduce(
      (sum, pair) => {
        const delta = lineDelta(pair.oldText, pair.newText);
        return { added: sum.added + delta.added, removed: sum.removed + delta.removed };
      },
      { added: 0, removed: 0 },
    );
  }

  return {
    path,
    name,
    verb: isWrite ? "create" : "edit",
    ...stats,
    ...(oldContents || newContents
      ? {
          diff: {
            kind: "sides" as const,
            oldFile: { name: label, contents: oldContents },
            newFile: { name: label, contents: newContents },
          },
        }
      : {}),
  };
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
  // Every other mousse theme id (dark, solarized-dark, github-dark,
  // high-contrast, blacksphere-plus, …) is dark-only.
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

/** The diff's light or dark syntax theme, following the app theme while the diff is open. */
function useDiffThemeType(): "light" | "dark" {
  const [themeType, setThemeType] = React.useState<"light" | "dark">(() =>
    resolveEditDiffThemeIsDark() ? "dark" : "light",
  );
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const updateTheme = () => setThemeType(resolveEditDiffThemeIsDark() ? "dark" : "light");
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", updateTheme);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", updateTheme);
    };
  }, []);
  return themeType;
}

const DIFF_CLASS = "an-edit-diff bg-an-tool-background";

/**
 * One file's diff. Rendered only while its row is open, so a collapsed row costs no diff and no theme watcher.
 * The diff points the library at the app theme tokens instead of hardcoded black, and `colorScheme` keeps the
 * library's `light-dark()` backgrounds in sync with the syntax tokens (without it dark text lands on a dark
 * background). The font matches the Git tab diff.
 */
function EditDiff({ diff }: { diff: DiffSource }) {
  const themeType = useDiffThemeType();
  const style = React.useMemo(
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
  const options = React.useMemo(
    () => ({
      theme: { dark: "github-dark", light: "github-light" } as const,
      themeType,
      unsafeCSS: `
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

function Stat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="an-edit-row-stat inline-flex shrink-0 gap-1.5 text-[12.5px] tabular-nums">
      {added > 0 && <span className="turn-edits-add">+{added}</span>}
      {removed > 0 && <span className="turn-edits-del">−{removed}</span>}
    </span>
  );
}

const VERB_DONE: Record<FileVerb, string> = { edit: "Edited", create: "Created", delete: "Deleted" };
const VERB_RUNNING: Record<FileVerb, string> = { edit: "Editing", create: "Creating", delete: "Deleting" };
const VERB_BASE: Record<FileVerb, string> = { edit: "edit", create: "create", delete: "delete" };

function rowLabel(verb: FileVerb, status: RowStatus): string {
  switch (status) {
    case "pending":
      return VERB_RUNNING[verb];
    case "failed":
      return `Failed to ${VERB_BASE[verb]}`;
    case "interrupted":
      return `${VERB_BASE[verb][0]!.toUpperCase()}${VERB_BASE[verb].slice(1)} interrupted:`;
    default:
      return VERB_DONE[verb];
  }
}

// 28px targets that overhang the 22px line (negative margin), so showing them does not make the row taller.
const ROW_ICON_BUTTON =
  "inline-flex items-center justify-center size-7 -my-[3px] shrink-0 rounded-md text-muted-foreground hover:text-an-foreground hover:bg-an-background-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-an-border-color";

/**
 * The quiet line a tool row draws: an icon, the verb, the file name in the foreground colour (mono, 500), the line
 * totals and the tool rows' chevron. The line is a button that opens what is under it; `actions` follow the totals
 * and show on hover or keyboard focus.
 */
function EditLine({
  icon,
  label,
  name,
  isFileName = true,
  title,
  added,
  removed,
  status,
  open,
  canOpen,
  onToggle,
  toggleLabel,
  actions,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  name: string;
  /** False for a count ("3 files"), which stays in the muted label type. */
  isFileName?: boolean;
  title?: string;
  added: number;
  removed: number;
  status: RowStatus;
  open: boolean;
  canOpen: boolean;
  onToggle: () => void;
  toggleLabel: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const isPending = status === "pending";
  const isFailed = status === "failed";
  const text = (
    <>
      <span className={cn("font-[450] shrink-0 whitespace-nowrap", isFailed && "text-red-400")}>{label}</span>
      {name &&
        (isFileName ? (
          <span className="an-edit-row-name min-w-0 truncate font-mono font-medium text-[13px] text-an-foreground">{name}</span>
        ) : (
          <span className="an-edit-row-count shrink-0 whitespace-nowrap">{name}</span>
        ))}
    </>
  );
  return (
    <div className="an-edit-row flex flex-col min-w-0" data-status={status}>
      {/* The hover group is the line alone, so hovering a call's line does not show the actions of the file rows under it. */}
      <div className="an-tool-chrome group/edit-line flex items-center gap-1 min-w-0">
        <button
          type="button"
          className={cn(
            "an-edit-row-toggle flex items-center gap-2 min-w-0 text-left text-[15px] leading-[22px] text-muted-foreground rounded-sm",
            "focus-visible:outline focus-visible:outline-1 focus-visible:outline-an-border-color",
            canOpen ? "cursor-pointer" : "cursor-default",
          )}
          aria-expanded={canOpen ? open : undefined}
          aria-label={toggleLabel}
          title={title}
          onClick={canOpen ? onToggle : undefined}
        >
          <span
            className={cn(
              "flex items-center justify-center size-[18px] shrink-0",
              isFailed && "text-red-400",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          {isPending ? (
            <TextShimmer as="span" duration={1.2} className="flex items-center gap-2 min-w-0 m-0">
              {text}
            </TextShimmer>
          ) : (
            text
          )}
          {!isPending && <Stat added={added} removed={removed} />}
          {canOpen && (
            <IconChevronRight
              aria-hidden="true"
              className={cn(
                "an-edit-row-chevron shrink-0 size-[18px] -ml-1 text-muted-foreground transition-transform duration-150 ease-out",
                open && "rotate-90",
              )}
            />
          )}
        </button>
        {actions && (
          <span className="an-edit-row-actions flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/edit-line:opacity-100 group-has-[:focus-visible]/edit-line:opacity-100">
            {actions}
          </span>
        )}
      </div>
      {open && children}
    </div>
  );
}

/** Open, collapsed by default; a failure opens it once, when it happens. */
function useRowOpen(failed: boolean): [boolean, () => void] {
  const [open, setOpen] = React.useState(failed);
  const wasFailed = React.useRef(failed);
  React.useEffect(() => {
    if (failed && !wasFailed.current) setOpen(true);
    wasFailed.current = failed;
  }, [failed]);
  return [open, () => setOpen((prev) => !prev)];
}

function fileIcon(verb: FileVerb): React.ReactNode {
  return verb === "create" ? <FilePlus size={16} /> : <Pencil size={16} />;
}

/** One file's row: "Edited <name> +N −M", opening to its diff, with Review and Files actions on hover. */
function EditFileRow({ file, status }: { file: EditedFile; status: RowStatus }) {
  const turnId = useContext(TurnIdContext);
  const rowStatus: RowStatus = status === "done" && file.error ? "failed" : status;
  const failed = rowStatus === "failed";
  const [open, toggle] = useRowOpen(failed);
  const hasBody = Boolean(file.diff || file.note || file.error);
  const name = file.name || (status === "pending" ? "" : "file");
  const path = file.path;
  const actions = path ? (
    <>
      <button
        type="button"
        className={ROW_ICON_BUTTON}
        aria-label={`Open ${file.name} in Review`}
        title="Open in Review"
        onClick={() => void openTurnInReview(useAppStore.getState().activeThreadId, turnId, path)}
      >
        <GitCompare size={16} />
      </button>
      <button
        type="button"
        className={ROW_ICON_BUTTON}
        aria-label={`Open ${file.name}`}
        title="Open file"
        onClick={() => openFileInPanel({ path })}
      >
        <File size={16} />
      </button>
    </>
  ) : undefined;
  const label = rowLabel(file.verb, rowStatus);
  return (
    <EditLine
      icon={fileIcon(file.verb)}
      label={label}
      name={name}
      title={path}
      added={file.added}
      removed={file.removed}
      status={rowStatus}
      open={open && hasBody}
      canOpen={hasBody}
      onToggle={toggle}
      toggleLabel={`${label} ${name}`.trim()}
      actions={actions}
    >
      <div className="an-edit-surface mt-1 mb-1 rounded-an-tool-border-radius bg-an-tool-background overflow-hidden text-[12px]">
        {file.error && (
          <div className="px-2.5 py-1.5 text-[12px] text-red-400 whitespace-pre-wrap break-words">{file.error}</div>
        )}
        {file.diff && <EditDiff diff={file.diff} />}
        {file.note && <div className="px-2.5 py-1.5 text-[11px] text-an-tool-color-muted">{file.note}</div>}
      </div>
    </EditLine>
  );
}

/** A call that changed several files: "Edited 3 files +12 −4", opening to one row per file. */
function EditFilesGroup({ files, status }: { files: EditedFile[]; status: RowStatus }) {
  const failed = status === "failed" || files.some((file) => file.error);
  const rowStatus: RowStatus = status === "done" && failed ? "failed" : status;
  const [open, toggle] = useRowOpen(failed);
  const verb: FileVerb = files.every((file) => file.verb === "create")
    ? "create"
    : files.every((file) => file.verb === "delete")
      ? "delete"
      : "edit";
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const label = rowLabel(verb, rowStatus);
  const count = `${files.length} files`;
  return (
    <EditLine
      icon={fileIcon(verb)}
      label={label}
      name={count}
      isFileName={false}
      added={added}
      removed={removed}
      status={rowStatus}
      open={open}
      canOpen
      onToggle={toggle}
      toggleLabel={`${label} ${count}`}
    >
      <div className="an-edit-files mt-1 ml-[26px] flex flex-col gap-1">
        {files.map((file, index) => (
          <EditFileRow key={`${file.path ?? file.name}:${index}`} file={file} status={status === "failed" ? "done" : status} />
        ))}
      </div>
    </EditLine>
  );
}

export type EditToolProps = {
  part: any;
};

/** An Edit, MultiEdit or Write call: one quiet row per call, like the other tool rows. */
export const EditTool = memo(function EditTool({ part }: EditToolProps) {
  const approval = (part.input?.approval ?? part.args?.approval) as ToolApproval | undefined;
  const toolName = (part.type as string)?.replace("tool-", "") || "Edit";
  const input = (part.input ?? part.args) as Record<string, unknown> | undefined;
  const rawOutput = part.output ?? part.result;
  const output = rawOutput && typeof rawOutput === "object" ? (rawOutput as Record<string, unknown>) : undefined;
  const invocationState = mapPartStateToInvocationState(part.state);
  const isPending = invocationState !== "result";
  const status: RowStatus = isPending
    ? "pending"
    : output?.interrupted === true
      ? "interrupted"
      : part.state === "output-error"
        ? "failed"
        : "done";

  const files = React.useMemo((): EditedFile[] => {
    const typed = filesFromChanges(output?.changes);
    if (typed && typed.length > 0) return typed;
    const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "edit", {
      toolName: toolName === "MultiEdit" ? "Edit" : toolName,
      args: input ?? {},
      state: invocationState,
      result: rawOutput,
    });
    return [fileFromRawCall(step, input, output)];
  }, [input, output, rawOutput, invocationState, part.toolCallId, part.id, toolName]);

  // A failed call names its error on the row it opens; a typed file keeps its own.
  const errorText =
    status === "failed"
      ? textOf(part.errorText) || (typeof rawOutput === "string" ? rawOutput : textOf(output?.error))
      : "";
  const shown = errorText && files.length === 1 && !files[0]!.error ? [{ ...files[0]!, error: errorText }] : files;

  return (
    <>
      {shown.length > 1 ? (
        <EditFilesGroup files={shown} status={status} />
      ) : (
        <EditFileRow file={shown[0]!} status={status} />
      )}
      {approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
    </>
  );
});
