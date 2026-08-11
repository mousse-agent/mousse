import { Type, type Tool } from '@earendil-works/pi-ai'
import type { DocumentOpenPayload } from '../../shared/types'

export class PlanModeTools {
  constructor(
    private requestAnswers: (
      questions: Array<{
        id: string
        prompt: string
        options: Array<{ id: string; label: string }>
        allowMultiple?: boolean
      }>,
      threadId: string
    ) => Promise<Record<string, string | string[]>>,
    private openDocument: (payload: DocumentOpenPayload) => void
  ) {}

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'ask_user',
        description:
          'Ask the user one or more clarifying questions before continuing the plan. Use when requirements are ambiguous.',
        parameters: Type.Object({
          questions: Type.Array(
            Type.Object({
              id: Type.String({ description: 'Stable question id for the answer map.' }),
              prompt: Type.String({ description: 'Question shown to the user.' }),
              options: Type.Array(
                Type.Object({
                  id: Type.String(),
                  label: Type.String()
                })
              ),
              allowMultiple: Type.Optional(
                Type.Boolean({ description: 'Allow selecting multiple options.' })
              )
            }),
            { minItems: 1, maxItems: 3 }
          )
        })
      },
      {
        name: 'show_document',
        description:
          'Open a markdown document preview for the user. Use to present the final implementation plan.',
        parameters: Type.Object({
          title: Type.String({ description: 'Document tab title.' }),
          markdown: Type.String({ description: 'Markdown content to preview.' })
        })
      }
    ]
  }

  isPlanTool(name: string): boolean {
    return this.getToolDefinitions().some((tool) => tool.name === name)
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    threadId?: string
  ): Promise<{ text: string; isError: boolean }> {
    try {
      if (name === 'ask_user') {
        const questions = parseQuestions(args.questions)
        if (questions.length === 0) {
          return { text: 'No valid questions provided.', isError: true }
        }
        if (!threadId) {
          return { text: 'Cannot ask a question without an active thread.', isError: true }
        }
        const answers = await this.requestAnswers(questions, threadId)
        return { text: JSON.stringify(answers, null, 2), isError: false }
      }

      if (name === 'show_document') {
        const title = String(args.title ?? 'Document').trim() || 'Document'
        const markdown = String(args.markdown ?? '')
        if (!markdown.trim()) {
          return { text: 'Document markdown is empty.', isError: true }
        }
        this.openDocument({ title, markdown })
        return { text: `Opened document "${title}" in the preview tab.`, isError: false }
      }

      return { text: `Unknown plan tool: ${name}`, isError: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: message, isError: true }
    }
  }
}

function parseQuestions(raw: unknown): Array<{
  id: string
  prompt: string
  options: Array<{ id: string; label: string }>
  allowMultiple?: boolean
}> {
  if (!Array.isArray(raw)) return []

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = String(record.id ?? '').trim()
      const prompt = String(record.prompt ?? '').trim()
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (!option || typeof option !== 'object') return null
              const opt = option as Record<string, unknown>
              const optId = String(opt.id ?? '').trim()
              const label = String(opt.label ?? '').trim()
              if (!optId || !label) return null
              return { id: optId, label }
            })
            .filter((option): option is { id: string; label: string } => option !== null)
        : []
      if (!id || !prompt || options.length < 2) return null
      return {
        id,
        prompt,
        options,
        allowMultiple: record.allowMultiple === true
      }
    })
    .filter((question): question is NonNullable<typeof question> => question !== null)
}
