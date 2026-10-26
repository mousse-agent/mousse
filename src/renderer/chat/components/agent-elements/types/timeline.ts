export type StepState = "pending" | "animating" | "complete";

export type TimelineStep =
  | {
      id: string;
      type: "input-typing";
      content: string;
      image?: string;
      duration: number;
    }
  | {
      id: string;
      type: "user-message";
      content: string;
      image?: string;
    }
  | {
      id: string;
      type: "tool-call";
      toolName: string;
      toolDetail: string;
      duration: number;
      toolVariant?: "thinking" | "action" | "search";
      thoughtContent?: string;
      searchQuery?: string;
      searchSource?: string;
      filePath?: string;
      diffStats?: string;
      diffLines?: { type: "add" | "remove" | "context"; content: string }[];
      bashCommand?: string;
      bashOutput?: string;
      bashSuccess?: boolean;
      /** Shell-wrapper-free label of the command, for the row. */
      bashLabel?: string;
      bashCwd?: string;
      /** Display only: the row's status follows the provider, not the exit code. */
      bashExitCode?: number;
      bashDurationMs?: number;
      /** The output is the tail of a longer one; `bashBytes` is the full size. */
      bashTruncated?: boolean;
      bashBytes?: number;
      /** The command ended without a result (stopped, cut off, or never reported). */
      bashInterrupted?: boolean;
      /** What the item says about how it ended ("Stopped", "No result reported"). */
      bashSummary?: string;
    }
  | {
      id: string;
      type: "assistant-stream";
      content: string;
    }
  | {
      id: string;
      type: "pause";
      duration: number;
    };

export type Turn = { userStep?: TimelineStep; steps: TimelineStep[] };
