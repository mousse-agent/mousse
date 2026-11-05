import { memo } from "react";
import type { AnsweredQuestion } from "../../../../../shared/types";
import { IconMessageCircleQuestion } from "../../../../lib/icons";
import { ToolRowBase } from "../tools/tool-row-base";

export type AnsweredQuestionsPart = {
  type: string;
  toolCallId?: string;
  input?: { questions?: AnsweredQuestion[] };
};

const PROMPT_LIMIT = 60;

/** A question's first line, cut to fit the row. */
function shortPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > PROMPT_LIMIT ? `${line.slice(0, PROMPT_LIMIT - 1).trimEnd()}…` : line;
}

/** The answer on one line: the options chosen, then the text typed instead. */
export function answerText(question: AnsweredQuestion): string {
  const parts = [...question.chosen];
  if (question.reply?.trim()) parts.push(question.reply.trim().replace(/\s*\n\s*/g, " "));
  return parts.join(", ") || "No answer";
}

/** The collapsed row: "Answered N questions", or for one the question and "· answer". */
export function answeredQuestionsSummary(questions: AnsweredQuestion[]): {
  label: string;
  detail?: string;
} {
  if (questions.length === 1) {
    return { label: shortPrompt(questions[0].prompt), detail: `· ${answerText(questions[0])}` };
  }
  return { label: `Answered ${questions.length} questions` };
}

/**
 * The user's answers to the agent's questions, as one step of the agent's turn: a muted row
 * that opens, like other tool rows, to each question with the options chosen and any reply typed.
 */
export const AnsweredQuestionsTool = memo(function AnsweredQuestionsTool({
  part,
}: {
  part: AnsweredQuestionsPart;
}) {
  const questions = part.input?.questions ?? [];
  if (questions.length === 0) return null;
  const { label, detail } = answeredQuestionsSummary(questions);

  return (
    <div className="an-answered-questions">
      <ToolRowBase
        icon={<IconMessageCircleQuestion size={18} className="shrink-0 text-muted-foreground" />}
        completeLabel={label}
        detail={detail}
        isAnimating={false}
        expandable
      >
        <dl className="an-answered-questions-list flex flex-col gap-2.5 ml-1.5 border-l border-an-border-color pl-3 py-0.5 text-[14px] leading-[20px]">
          {questions.map((question, index) => (
            <div key={index} className="flex flex-col gap-0.5 min-w-0">
              <dt className="text-an-foreground-muted/60 whitespace-pre-wrap break-words">{question.prompt}</dt>
              {question.chosen.length > 0 && (
                <dd className="text-foreground break-words">{question.chosen.join(", ")}</dd>
              )}
              {question.reply?.trim() && (
                <dd className="text-foreground whitespace-pre-wrap break-words">“{question.reply.trim()}”</dd>
              )}
              {question.chosen.length === 0 && !question.reply?.trim() && (
                <dd className="text-muted-foreground">No answer</dd>
              )}
            </div>
          ))}
        </dl>
      </ToolRowBase>
    </div>
  );
});
