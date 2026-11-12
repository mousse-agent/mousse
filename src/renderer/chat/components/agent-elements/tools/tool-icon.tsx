import type { ComponentType, ReactNode } from "react";
import {
  ClipboardList,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  Pencil,
  Plug,
  Search,
  Terminal,
  Wrench,
} from "../../../../lib/icons";
import { parseMcpToolType, toolRegistry } from "./tool-registry";
import "./tool-icon.css";

type IconType = ComponentType<{ className?: string; size?: number }>;

/** What a row's icon says about its call: still going, done, or failed. */
export type ToolIconState = "running" | "done" | "failed";

/** The icon of each tool the rows know by name; anything else takes its registry icon, or a wrench. */
const TOOL_ICONS: Record<string, IconType> = {
  "tool-Bash": Terminal,
  "tool-BashOutput": Terminal,
  "tool-Read": FileText,
  "tool-Edit": Pencil,
  "tool-MultiEdit": Pencil,
  "tool-NotebookEdit": Pencil,
  "tool-Write": FilePlus,
  "tool-Grep": Search,
  "tool-Glob": FolderSearch,
  "tool-WebFetch": Globe,
  "tool-WebSearch": Globe,
  "tool-TodoWrite": ClipboardList,
  "tool-ToolSearch": Plug,
};

/** The icon for a tool part's type (`tool-Bash`, `tool-mcp__server__name`). */
export function toolIconFor(type: string | undefined): IconType {
  if (!type) return Wrench;
  const own = TOOL_ICONS[type];
  if (own) return own;
  if (parseMcpToolType(type)) return Plug;
  return toolRegistry[type]?.icon ?? Wrench;
}

/**
 * A tool row's icon in its state: running, it pulses gently (opacity only, still with motion off); done, it is still
 * and dimmed; failed, it takes the danger colour (tool-icon.css).
 */
export function ToolStateIcon({ state, children }: { state: ToolIconState; children: ReactNode }) {
  return (
    <span className="an-tool-icon" data-state={state} aria-hidden="true">
      {children}
    </span>
  );
}

/** The icon for a tool part's type, in its state. */
export function ToolIcon({ type, state, size = 18 }: { type: string | undefined; state: ToolIconState; size?: number }) {
  const Icon = toolIconFor(type);
  return (
    <ToolStateIcon state={state}>
      <Icon size={size} />
    </ToolStateIcon>
  );
}
