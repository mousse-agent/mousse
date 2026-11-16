import type { AnsweredQuestion, UserQuestion, UserQuestionAnswers } from '../../shared/types'

/**
 * The answers as the transcript keeps them (`ChatMessage.questionAnswers`): option ids resolve to
 * their labels; text that names no option is the reply typed instead.
 */
export function describeQuestionAnswers(
  questions: UserQuestion[],
  answers: UserQuestionAnswers,
  /** Which of the answer message's images each question got, by question id. */
  imageIndexes?: Record<string, number[]>
): AnsweredQuestion[] {
  return questions.map((question) => {
    const value = answers[question.id]
    const values = (value === undefined ? [] : Array.isArray(value) ? value : [value])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
    const chosen: string[] = []
    const typed: string[] = []
    for (const entry of values) {
      const option = question.options.find((each) => each.id === entry)
      if (option) chosen.push(option.label.trim() || entry)
      else typed.push(entry)
    }
    const images = imageIndexes && Object.hasOwn(imageIndexes, question.id) ? imageIndexes[question.id] : undefined
    return {
      prompt: question.prompt,
      chosen,
      ...(typed.length ? { reply: typed.join('\n') } : {}),
      ...(images?.length ? { images } : {})
    }
  })
}
