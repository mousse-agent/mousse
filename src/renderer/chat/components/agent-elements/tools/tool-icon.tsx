import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import {
  Eye,
  RowEdit,
  RowSearch,
  RowSubagent,
  RowTodo,
  RowWeb,
  Terminal,
  Wrench,
} from "../../../../lib/icons";
import { parseMcpToolType, toolRegistry } from "./tool-registry";
import "./tool-icon.css";

/**
 * What a tool row knows about its call beyond its own part: when it started (`at`, for the time on hover), whether
 * the agent got past its failure (`recovered`), and the key its open state is kept under (`openKey`, the call's id:
 * tool-open-state.ts). The tool renderer provides it per call; a row's panel resets it, so a row nested inside another
 * reads its own.
 */
export type ToolRowInfo = { at?: string | number | Date; recovered?: boolean; openKey?: string };
export const ToolRowContext = createContext<ToolRowInfo>({});
export const NO_ROW_INFO: ToolRowInfo = {};
export const useToolRowInfo = () => useContext(ToolRowContext);

type IconType = ComponentType<{ className?: string; size?: number }>;

/** What a row's icon says about its call: still going, done, or failed. */
export type ToolIconState = "running" | "done" | "failed";

/** The icon of each tool the rows know by name; anything else takes its registry icon, or a wrench. */
const TOOL_ICONS: Record<string, IconType> = {
  "tool-Bash": Terminal,
  "tool-BashOutput": Terminal,
  "tool-Read": Eye,
  "tool-Edit": RowEdit,
  "tool-MultiEdit": RowEdit,
  "tool-NotebookEdit": RowEdit,
  "tool-Write": RowEdit,
  "tool-Grep": RowSearch,
  "tool-Glob": RowSearch,
  "tool-WebFetch": RowWeb,
  "tool-WebSearch": RowWeb,
  "tool-TodoWrite": RowTodo,
  "tool-ToolSearch": Wrench,
  "tool-Task": RowSubagent,
  "tool-Agent": RowSubagent,
  "tool-Subagent": RowSubagent,
};

/** The icon for a tool part's type (`tool-Bash`, `tool-mcp__server__name`). */
export function toolIconFor(type: string | undefined): IconType {
  if (!type) return Wrench;
  const own = TOOL_ICONS[type];
  if (own) return own;
  if (parseMcpToolType(type)) return Wrench;
  return toolRegistry[type]?.icon ?? Wrench;
}

/**
 * A tool row's icon in its state: running, it pulses gently (opacity only, still with motion off); done, it is still
 * and dimmed; failed, it takes the danger colour (tool-icon.css).
 */
export function ToolStateIcon({ state, children }: { state: ToolIconState; children: ReactNode }) {
  // A failure the agent got past only dims the icon toward the danger colour (with the row's small ×).
  const { recovered } = useToolRowInfo();
  return (
    <span className="an-tool-icon" data-state={state === "failed" && recovered ? "recovered" : state} aria-hidden="true">
      {children}
    </span>
  );
}

/** The small × after a failed call the agent got past; its label stays grey. */
export function RecoveredFailureMark() {
  return (
    <span className="an-tool-failed-mark" aria-hidden="true">
      ×
    </span>
  );
}

/** The time a row's call started, at the row's right edge; it fades in while the row is hovered or focused. */
const rowTimeFormatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

export function ToolRowTime({ at }: { at: ToolRowInfo["at"] }) {
  if (at === undefined || at === null || at === "") return null;
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time className="an-tool-row-time" dateTime={date.toISOString()}>
      {rowTimeFormatter.format(date)}
    </time>
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
