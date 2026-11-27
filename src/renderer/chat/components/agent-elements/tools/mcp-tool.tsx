import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import { getToolStatus, areToolPropsEqual } from "../utils/format-tool";
import type { McpToolInfo } from "./tool-registry";
import { Wrench } from "../../../../lib/icons";
import { ToolRowBase } from "./tool-row-base";
import { cuaPresentation, mousseToolLabels, mousseToolOf, mousseToolSubject, webSearchSites } from "./mousse-tools";
import { MousseToolIcon } from "./mousse-tool-icon";
import { codeHighlighter } from "../code-highlighter";
import { codeOnlyComponents } from "../code-block";

export type McpToolProps = {
  part: any;
  mcpInfo: McpToolInfo;
  chatStatus?: string;
  defaultOpen?: boolean;
};

const PRIORITY_ARGS = [
  "query",
  "question",
  "email",
  "name",
  "id",
  "customer",
  "url",
  "issue",
  "body",
  "summary",
  "title",
];

const ACTIVE_VERBS: Record<string, string> = {
  List: "Listing",
  Get: "Getting",
  Create: "Creating",
  Update: "Updating",
  Delete: "Deleting",
  Search: "Searching",
  Fetch: "Fetching",
  Retrieve: "Retrieving",
  Send: "Sending",
  Generate: "Generating",
  Add: "Adding",
  Remove: "Removing",
  Modify: "Modifying",
  Draft: "Drafting",
  Manage: "Managing",
  Query: "Querying",
  Start: "Starting",
  Set: "Setting",
  Check: "Checking",
  Find: "Finding",
};

const COMPLETED_VERBS: Record<string, string> = {
  List: "Listed",
  Get: "Got",
  Create: "Created",
  Update: "Updated",
  Delete: "Deleted",
  Search: "Searched",
  Fetch: "Fetched",
  Retrieve: "Retrieved",
  Send: "Sent",
  Generate: "Generated",
  Add: "Added",
  Remove: "Removed",
  Modify: "Modified",
  Draft: "Drafted",
  Manage: "Managed",
  Query: "Queried",
  Start: "Started",
  Set: "Set",
  Check: "Checked",
  Find: "Found",
};

function getActiveTitle(info: McpToolInfo): string {
  const words = info.displayName.split(" ");
  const verb = words[0];
  const rest = words.slice(1).join(" ");
  const active = ACTIVE_VERBS[verb];
  if (active) return rest ? `${active} ${rest}` : active;
  return info.displayName;
}

function getCompletedTitle(info: McpToolInfo): string {
  const words = info.displayName.split(" ");
  const verb = words[0];
  const rest = words.slice(1).join(" ");
  const completed = COMPLETED_VERBS[verb];
  return completed
    ? rest
      ? `${completed} ${rest}`
      : completed
    : info.displayName;
}

function formatMcpArgs(input: any): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return "";

  const sorted = [...entries].sort(([a], [b]) => {
    const ai = PRIORITY_ARGS.indexOf(a);
    const bi = PRIORITY_ARGS.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  const parts: string[] = [];
  for (const [key, value] of sorted) {
    if (parts.length >= 2) break;
    const val = typeof value === "string" ? value : JSON.stringify(value);
    const display = val.length > 30 ? val.slice(0, 27) + "..." : val;
    parts.push(`${key}: ${display}`);
  }
  return parts.join("  ");
}

export function unwrapMcpOutput(output: any): any {
  if (!output) return output;
  if (Array.isArray(output)) {
    const textParts: string[] = [];
    for (const block of output) {
      if (block?.type === "text" && typeof block?.text === "string") {
        textParts.push(block.text);
      }
    }
    if (textParts.length > 0) {
      const combined = textParts.join("");
      try {
        return JSON.parse(combined);
      } catch {
        return combined;
      }
    }
    return output;
  }
  if (output?.type === "text" && typeof output?.text === "string") {
    try {
      return JSON.parse(output.text);
    } catch {
      return output.text;
    }
  }
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }
  return output;
}

/** Text as a fenced code block (JSON when it reads as JSON), or null when there is nothing to show. */
function fenced(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!text || !trimmed) return null;
  const language = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "text";
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

function formatOutputForDisplay(output: any): string {
  const unwrapped = unwrapMcpOutput(output);
  if (typeof unwrapped === "string") {
    return unwrapped.length > 3000
      ? unwrapped.slice(0, 3000) + "\n..."
      : unwrapped;
  }
  const text = JSON.stringify(unwrapped, null, 2);
  return text.length > 3000 ? text.slice(0, 3000) + "\n..." : text;
}

export const McpTool = memo(function McpTool({
  part,
  mcpInfo,
  chatStatus,
  defaultOpen,
}: McpToolProps) {
  const { isPending, isInterrupted, isError } = getToolStatus(part, chatStatus);
  const failed = isError && !isPending;

  // A computer use call, whatever runtime made it: what it did in words, one detail, and only what its allowlist keeps
  // of its arguments and result (a row saved before that existed included).
  const cua = useMemo(
    () => cuaPresentation(part),
    [part.type, part.input, part.output, part.state, part.useToolTarget],
  );

  // Mousse's own tools: its logo and what the call does, in words ("Creating a thread in Mousse").
  const mousseTool = mousseToolOf(part.type);
  const mousse = useMemo(() => {
    if (cua) return cua.labels;
    return mousseTool ? mousseToolLabels(mousseTool) : null;
  }, [cua, mousseTool]);

  const title = useMemo(() => {
    if (mousse) return isPending ? mousse.running : failed ? mousse.failed : mousse.done;
    if (part.state === "input-streaming")
      return `Preparing ${mcpInfo.displayName}`;
    if (isPending) return getActiveTitle(mcpInfo);
    if (failed) return `Failed ${mcpInfo.displayName}`;
    return getCompletedTitle(mcpInfo);
  }, [mousse, part.state, isPending, failed, mcpInfo]);

  const subtitle = useMemo(() => {
    if (cua) return cua.detail ?? "";
    if (part.state === "input-streaming") return "";
    // A Mousse tool names what it works on (a query, a URL, a title), not its arguments' keys; one whose arguments
    // name nothing readable (only an id) shows them as any tool's.
    return (mousseTool ? mousseToolSubject(mousseTool, part.input) : undefined) ?? formatMcpArgs(part.input);
  }, [cua, mousseTool, part.input, part.state]);

  // A web search lists the sites it found, not the text it returned.
  const sites = useMemo(
    () => (mousseTool === "web_search" && !isError ? webSearchSites(part.output) : []),
    [mousseTool, isError, part.output],
  );

  const displayOutput = useMemo(() => {
    const output = cua ? cua.output : part.output;
    if (!output || sites.length > 0) return null;
    return formatOutputForDisplay(output);
  }, [cua, part.output, sites]);

  const codeBlock = useMemo(() => fenced(displayOutput), [displayOutput]);

  // A computer use row shows what it ran as well as what came of it.
  const inputBlock = useMemo(() => (cua?.input ? fenced(JSON.stringify(cua.input, null, 2)) : null), [cua]);

  const hasExpandableContent = (!!codeBlock || !!inputBlock || sites.length > 0) && !isPending;

  if (isInterrupted) {
    return (
      <span className="text-base text-an-tool-color-muted">
        {mousse ? `Stopped ${mousse.running.charAt(0).toLowerCase()}${mousse.running.slice(1)}` : `${mcpInfo.displayName} interrupted`}
      </span>
    );
  }

  return (
    <div className="an-tool-mcp">
      <ToolRowBase
        icon={mousse ? <MousseToolIcon size={18} /> : <Wrench size={18} />}
        shimmerLabel={title}
        completeLabel={title}
        isAnimating={isPending}
        failed={failed}
        detail={subtitle || undefined}
        trailingContent={undefined}
        expandable={hasExpandableContent}
        defaultOpen={defaultOpen}
      >
        {inputBlock && (
          <div className="an-markdown an-tool-quiet-output text-[14px]" aria-label="Input">
            <Streamdown plugins={{ code: codeHighlighter }} controls={{ code: false }} components={codeOnlyComponents}>
              {inputBlock}
            </Streamdown>
          </div>
        )}
        {sites.length > 0 && (
          // The same plain list a code search's results use: each site's title, and where it is.
          <ul className="an-search-results flex flex-col gap-1 p-1 rounded-md bg-an-tool-background max-h-[200px] overflow-y-auto" aria-label="Sites">
            {sites.map((site) => (
              <li key={site.url} className="flex items-center gap-2 px-2 py-1 min-w-0" title={site.url}>
                <span className="text-base text-foreground/90 truncate flex-1 min-w-0">{site.title}</span>
                <span className="text-sm text-muted-foreground shrink-0 whitespace-nowrap">{site.host}</span>
              </li>
            ))}
          </ul>
        )}
        {codeBlock && (
          // The output in the same plain block as a command's: no header bar, no border.
          <div className="an-markdown an-tool-quiet-output text-[14px]" aria-label={inputBlock ? "Output" : undefined}>
            <Streamdown plugins={{ code: codeHighlighter }} controls={{ code: false }} components={codeOnlyComponents}>
              {codeBlock}
            </Streamdown>
          </div>
        )}
      </ToolRowBase>
    </div>
  );
}, areToolPropsEqual);
