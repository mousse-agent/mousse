import { memo } from "react";
import type { AnsweredQuestion } from "../../../../../shared/types";
import { IconMessageCircleQuestion } from "../../../../lib/icons";
import { ReadAloudButton } from "../../../../readAloud/ReadAloudButton";
import { MessageImage } from "../message-image";
import { ToolRowBase } from "../tools/tool-row-base";

/** An image sent with the answers: its data URL, or only its name until its bytes arrive. */
export type AnsweredQuestionImage = { name: string; url?: string };

export type AnsweredQuestionsPart = {
  type: string;
  toolCallId?: string;
  input?: { questions?: AnsweredQuestion[]; images?: AnsweredQuestionImage[] };
};

const PROMPT_LIMIT = 60;

/** A question's first line, cut to fit the row. */
function shortPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > PROMPT_LIMIT ? `${line.slice(0, PROMPT_LIMIT - 1).trimEnd()}…` : line;
}

/** The answer on one line: the options chosen, then the text typed instead, then how many images came with it. */
export function answerText(question: AnsweredQuestion): string {
  const parts = [...question.chosen];
  if (question.reply?.trim()) parts.push(question.reply.trim().replace(/\s*\n\s*/g, " "));
  const images = question.images?.length ?? 0;
  if (images) parts.push(images === 1 ? "1 image" : `${images} images`);
  return parts.join(", ") || "No answer";
}

/** What Read aloud says: each question, then its answer. */
export function answeredQuestionsSpeechText(questions: AnsweredQuestion[]): string {
  // The answer as a list item, so it ends as a sentence of its own.
  return questions.map((question) => `${question.prompt.trim()}\n\n- ${answerText(question)}`).join("\n\n");
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
  const images = part.input?.images ?? [];
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
        <dl className="an-answered-questions-list flex flex-col gap-2.5 pl-[18px] py-0.5 text-[14px] leading-[20px]">
          {questions.map((question, index) => (
            <div key={index} className="flex flex-col gap-0.5 min-w-0">
              <dt className="text-[color:var(--text-secondary)] whitespace-pre-wrap break-words">{question.prompt}</dt>
              {question.chosen.length > 0 && (
                <dd className="text-foreground break-words">{question.chosen.join(", ")}</dd>
              )}
              {question.reply?.trim() && (
                <dd className="text-foreground whitespace-pre-wrap break-words">“{question.reply.trim()}”</dd>
              )}
              {(question.images?.length ?? 0) > 0 && (
                <dd className="an-answered-question-images flex flex-wrap gap-2">
                  {question.images!.map((index) => {
                    const image = images[index];
                    if (!image) return null;
                    return image.url ? (
                      <MessageImage key={index} src={image.url} alt={image.name} className="max-h-[120px] w-auto" />
                    ) : (
                      <span key={index} className="text-muted-foreground">{image.name}</span>
                    );
                  })}
                </dd>
              )}
              {question.chosen.length === 0 && !question.reply?.trim() && !question.images?.length && (
                <dd className="text-muted-foreground">No answer</dd>
              )}
            </div>
          ))}
        </dl>
        {part.toolCallId && (
          <div className="pl-[14px] pt-1">
            <ReadAloudButton speechKey={`answers:${part.toolCallId}`} markdown={answeredQuestionsSpeechText(questions)} />
          </div>
        )}
      </ToolRowBase>
    </div>
  );
});
