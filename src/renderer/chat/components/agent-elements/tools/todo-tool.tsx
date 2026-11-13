import { memo } from "react";
import { CheckIcon, IconArrowRight } from "../icons";
import { RowTodo } from "../../../../lib/icons";
import { ToolRowBase } from "./tool-row-base";
import { getToolStatus, areToolPropsEqual } from "../utils/format-tool";
import { cn } from "../utils/cn";

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type TodoToolProps = {
  part: any;
  chatStatus?: string;
};

const TodoStatusIcon = ({
  status,
  isPending,
}: {
  status: TodoItem["status"];
  isPending?: boolean;
}) => {
  if (isPending && status === "in_progress") {
    return (
      <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border border-an-foreground-muted/60">
        <IconArrowRight className="w-2 h-2 text-an-foreground-muted/70" />
      </div>
    );
  }

  switch (status) {
    case "completed":
      return (
        <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border border-an-foreground-muted/40">
          <CheckIcon className="w-2 h-2 text-an-foreground-muted/70" />
        </div>
      );
    case "in_progress":
      return (
        <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border border-an-foreground-muted/60">
          <IconArrowRight className="w-2 h-2 text-an-foreground-muted/70" />
        </div>
      );
    default:
      return (
        <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border border-an-foreground-muted/60" />
      );
  }
};

const TodoListItem = memo(function TodoListItem({
  todo,
  isPending,
}: {
  todo: TodoItem;
  isPending: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-2")}>
      <div className="mt-[2px]">
        <TodoStatusIcon status={todo.status} isPending={isPending} />
      </div>
      <span
        className={cn(
          "text-base",
          todo.status === "completed" && "line-through",
          isPending || todo.status === "completed" || todo.status === "pending"
            ? "text-an-foreground/60"
            : "text-an-foreground/80",
        )}
      >
        {todo.content}
      </span>
    </div>
  );
});

/** "2 of 3 done", for the row's detail. */
function todoProgress(todos: TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return `${done} of ${todos.length} done`;
}

/**
 * A to-do list call: one row like the other tool rows (the checklist icon, what changed and how far the list is),
 * open by default to the list itself.
 */
export const TodoTool = memo(function TodoTool({
  part,
  chatStatus,
}: TodoToolProps) {
  const { isPending, isError } = getToolStatus(part, chatStatus);

  const isStreaming = part.state === "input-streaming";
  const oldTodos: TodoItem[] = part.output?.oldTodos || [];
  const newTodos: TodoItem[] = part.input?.todos || part.output?.newTodos || [];
  const isCreation = oldTodos.length === 0;
  const failed = isError && !isPending;

  // A finished call that sent an empty list cleared the to-dos; nothing is being generated.
  const cleared =
    !isStreaming &&
    newTodos.length === 0 &&
    part.state === "output-available" &&
    Array.isArray(part.input?.todos);
  const empty = isStreaming || newTodos.length === 0;

  const running = isCreation ? "Creating to-do list" : "Updating to-dos";
  const label = cleared
    ? "To-dos cleared"
    : failed
      ? (isCreation ? "Failed to create to-do list" : "Failed to update to-dos")
      : isCreation
        ? "Created to-do list"
        : "Updated to-dos";

  return (
    <ToolRowBase
      icon={<RowTodo size={18} />}
      shimmerLabel={running}
      completeLabel={label}
      isAnimating={!cleared && (isPending || empty)}
      failed={failed}
      detail={empty ? undefined : todoProgress(newTodos)}
      expandable={!empty}
      defaultOpen
    >
      <div className="space-y-2 pl-[26px] text-base leading-relaxed text-an-foreground/80">
        {newTodos.map((todo, idx) => (
          <TodoListItem key={idx} todo={todo} isPending={isPending} />
        ))}
      </div>
    </ToolRowBase>
  );
}, areToolPropsEqual);
