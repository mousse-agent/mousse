import { useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { ChevronRight, FileText } from "../../../lib/icons";
import { useActiveProjectPath } from "../../../hooks/useActiveProjectPath";
import { useAppStore } from "../../../stores/appStore";
import { openTurnInReview } from "../../../components/review/openReview";
import { FileExtIcon } from "./icons/file-ext-icon";
import { extractFilePathArg } from "./utils/tool-adapters";
import { isRecord, isV5ToolPart } from "./utils/assistant-blocks";

interface FileEdit {
  /** Relative to the project folder when it is inside it. */
  path: string;
  /** The path as the agent wrote it, which Review maps to its changed file. */
  source: string;
  added: number;
  removed: number;
}

/** More changed files than this start collapsed. */
const OPEN_FILE_LIMIT = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
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

function patchDelta(patches: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patches)) return null;
  let added = 0;
  let removed = 0;
  for (const patch of patches) {
    const lines = asRecord(patch)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

function editDelta(input: Record<string, unknown>, output: Record<string, unknown> | null): { added: number; removed: number } {
  const fromPatch = patchDelta(output?.structuredPatch);
  if (fromPatch) return fromPatch;
  if (Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    for (const edit of input.edits) {
      const row = asRecord(edit);
      if (!row) continue;
      const delta = lineDelta(textOf(row.oldText ?? row.old_string), textOf(row.newText ?? row.new_string));
      added += delta.added;
      removed += delta.removed;
    }
    return { added, removed };
  }
  return lineDelta(textOf(input.old_string ?? input.oldText), textOf(input.new_string ?? input.newText));
}

function writeDelta(input: Record<string, unknown>, output: Record<string, unknown> | null): { added: number; removed: number } {
  const content = textOf(output?.content) || textOf(input.content) || textOf(input.contents);
  if (!content) return { added: 0, removed: 0 };
  const lines = content.endsWith("\n") ? content.split("\n").slice(0, -1) : content.split("\n");
  return { added: lines.length, removed: 0 };
}

function toolLabel(part: { type: string; toolName?: unknown }): "edit" | "write" | null {
  const named = "toolName" in part && typeof part.toolName === "string" ? part.toolName : null;
  const name = part.type === "dynamic-tool" && named
    ? named
    : part.type.replace(/^tool-/, "");
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "edit" || normalized === "multiedit" || normalized === "notebookedit" || normalized === "declarefiles") {
    return "edit";
  }
  if (normalized === "write" || normalized === "writefile") return "write";
  return null;
}

function relativePath(filePath: string, root: string | null): string {
  const norm = filePath.replace(/\\/g, "/");
  if (!root) return norm;
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (norm.toLowerCase() === rootNorm.toLowerCase()) return norm.split("/").pop() || norm;
  const prefix = `${rootNorm}/`;
  if (norm.toLowerCase().startsWith(prefix.toLowerCase())) return norm.slice(prefix.length);
  return norm;
}

/** The file name and the folder it sits in; no folder for a file at the project's top level. */
function splitPath(filePath: string): { name: string; folder: string } {
  const slash = filePath.lastIndexOf("/");
  if (slash < 0) return { name: filePath, folder: "" };
  return { name: filePath.slice(slash + 1), folder: filePath.slice(0, slash) };
}

function collectEdits(messages: UIMessage[], root: string | null): { files: FileEdit[]; added: number; removed: number } | null {
  const byPath = new Map<string, FileEdit>();
  for (const message of messages) {
    for (const candidate of message.parts ?? []) {
      const part: unknown = candidate;
      if (!isV5ToolPart(part)) continue;
      if (part.state && part.state !== "output-available") continue;
      const kind = toolLabel(part);
      if (!kind) continue;
      const input = asRecord(part.input) ?? {};
      const output = asRecord(part.output) ?? asRecord(part.result);
      const filePath = extractFilePathArg(input);
      if (!filePath) continue;
      const path = relativePath(filePath, root);
      const delta = kind === "write" ? writeDelta(input, output) : editDelta(input, output);
      const current = byPath.get(path) ?? { path, source: filePath, added: 0, removed: 0 };
      current.added += delta.added;
      current.removed += delta.removed;
      byPath.set(path, current);
    }
  }
  if (byPath.size === 0) return null;
  const files = [...byPath.values()];
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { files, added, removed };
}

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="turn-edits-stat">
      {added > 0 && <span className="turn-edits-add">+{added}</span>}
      {removed > 0 && <span className="turn-edits-del">−{removed}</span>}
    </span>
  );
}

export function TurnEditSummary({ messages, turnId }: { messages: UIMessage[]; turnId?: string }) {
  const root = useActiveProjectPath();
  const summary = useMemo(() => collectEdits(messages, root), [messages, root]);
  // Null until the user toggles it: a long list starts collapsed, and stays as the user left it.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (!summary) return null;
  const open = userOpen ?? summary.files.length <= OPEN_FILE_LIMIT;
  const countLabel = `${summary.files.length} changed file${summary.files.length === 1 ? "" : "s"}`;
  const review = (file?: string) => void openTurnInReview(useAppStore.getState().activeThreadId, turnId, file);

  return (
    <section className="turn-edits" aria-label={countLabel} data-find-ignore>
      <div className="turn-edits-head">
        <button
          type="button"
          className="turn-edits-toggle"
          aria-expanded={open}
          onClick={() => setUserOpen(!open)}
        >
          <ChevronRight size={14} strokeWidth={2} className={`turn-edits-chevron${open ? " is-open" : ""}`} />
          <span className="turn-edits-count">{countLabel}</span>
          <Stat added={summary.added} removed={summary.removed} />
        </button>
        <button
          type="button"
          className="turn-edits-open"
          aria-label="Review changes"
          title="Review changes"
          onClick={() => review()}
        >
          <FileText size={14} strokeWidth={1.8} />
        </button>
      </div>
      {open && (
        <ul className="turn-edits-files">
          {summary.files.map((file) => {
            const { name, folder } = splitPath(file.path);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="turn-edits-file"
                  title={file.path}
                  aria-label={`Review ${file.path}`}
                  onClick={() => review(file.source)}
                >
                  <FileExtIcon filename={name} className="turn-edits-file-icon" />
                  <span className="turn-edits-file-name">{name}</span>
                  {folder && <span className="turn-edits-file-folder">{folder}</span>}
                  <Stat added={file.added} removed={file.removed} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
