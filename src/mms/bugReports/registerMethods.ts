import { BUG_REPORT_BODY_MAX, BUG_REPORT_TITLE_MAX, type BugReportDraft, type BugReportSource } from '../../shared/bugReports'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { BugReportError, type BugReportService } from './BugReportService'

export const BUG_REPORTS_CAPABILITY = 'bugReports.v1'

/** Only a person at a window of this computer files, lists or revokes reports; no agent, CLI or other computer. */
function fromWindow(context: HandlerContext): void {
  if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Report bugs from a Mousse window on this computer.')
}

function refusal(error: unknown): never {
  if (error instanceof DomainRpcError) throw error
  if (error instanceof BugReportError) throw new DomainRpcError(error.code === 'invalid' ? 'invalid_params' : error.code, error.message)
  throw new DomainRpcError('bug_report_failed', error instanceof Error ? error.message : 'The report could not be sent.')
}

function draftOf(value: unknown): BugReportDraft {
  const p = domainObject(value ?? {}, ['title', 'body', 'signature'])
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > BUG_REPORT_TITLE_MAX * 2) throw new DomainRpcError('invalid_params', 'The report needs a title.')
  if (typeof p.body !== 'string' || p.body.length > BUG_REPORT_BODY_MAX) throw new DomainRpcError('invalid_params', 'The report is too long.')
  if (typeof p.signature !== 'string' || p.signature.length > 64) throw new DomainRpcError('invalid_params', 'The report has no signature.')
  return { title: p.title, body: p.body, signature: p.signature }
}

/** An error a window reports: short texts only, as `BugReportSource` of kind `button`. */
function sourceOf(value: unknown): BugReportSource {
  const p = domainObject(value ?? {}, ['title', 'message', 'reference', 'code', 'stack', 'surface'])
  const limits = { title: 400, message: 8000, reference: 120, code: 120, stack: 12000, surface: 40 } as const
  for (const [key, max] of Object.entries(limits)) {
    const field = p[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > max)) throw new DomainRpcError('invalid_params', `${key} must be text of at most ${max} characters`)
  }
  if (typeof p.title !== 'string' && typeof p.message !== 'string') throw new DomainRpcError('invalid_params', 'The error needs a title or a message.')
  return {
    kind: 'button',
    title: (p.title as string | undefined) ?? '',
    message: (p.message as string | undefined) ?? '',
    ...(p.reference ? { reference: p.reference as string } : {}),
    ...(p.code ? { code: p.code as string } : {}),
    ...(p.stack ? { stack: p.stack as string } : {}),
    ...(p.surface ? { surface: p.surface as string } : {})
  }
}

/**
 * Bug reports: an error's draft and the diagnostics the person may add, filing a draft the person saw, the reports filed from here (Settings) and
 * revoking one, and the drafts agents asked to file, which wait for the person.
 */
export function registerBugReportMethods(domains: DomainHandlerRegistry, domainFor: (profileId: string) => Promise<BugReportService>): void {
  const bound = async (binding: { profileId: string } | undefined) => {
    if (!binding) throw new DomainRpcError('profile_required', 'Bug reports need a profile')
    return domainFor(binding.profileId)
  }
  domains.register({
    method: 'bugReports.draft', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'source', 'app', 'view'])
      for (const key of ['app', 'view'] as const) if (p[key] !== undefined && (typeof p[key] !== 'string' || (p[key] as string).length > 200)) throw new DomainRpcError('invalid_params', `${key} must be short text`)
      return { source: sourceOf(p.source), app: p.app as string | undefined, view: p.view as string | undefined }
    },
    async handle(context, params, binding) {
      fromWindow(context)
      try {
        const service = await bound(binding)
        if (!service.settings().enabled) throw new BugReportError('disabled', 'Error reports are off in Settings → General.')
        return {
          draft: service.draft(params.source),
          diagnostics: await service.diagnostics({ app: params.app, view: params.view })
        }
      } catch (error) { refusal(error) }
    }
  })
  domains.register({
    method: 'bugReports.file', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'draft'])
      return { ...p, draft: draftOf(p.draft) }
    },
    async handle(context, params, binding) {
      fromWindow(context)
      try {
        return { outcome: await (await bound(binding)).file(params.draft as BugReportDraft) }
      } catch (error) { refusal(error) }
    }
  })
  domains.register({
    method: 'bugReports.list', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(context, _params, binding) {
      fromWindow(context)
      try {
        return { reports: await (await bound(binding)).list() }
      } catch (error) { refusal(error) }
    }
  })
  domains.register({
    method: 'bugReports.revoke', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'number'])
      if (typeof p.number !== 'number' || !Number.isInteger(p.number) || p.number < 1) throw new DomainRpcError('invalid_params', 'An issue number is required.')
      return p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      try {
        return { report: await (await bound(binding)).revoke(params.number as number) }
      } catch (error) { refusal(error) }
    }
  })
  domains.register({
    method: 'bugReports.pending', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    async handle(context, _params, binding) {
      fromWindow(context)
      return { pending: (await bound(binding)).pendingReports() }
    }
  })
  domains.register({
    method: 'bugReports.answer', scope: 'profile', capability: BUG_REPORTS_CAPABILITY,
    validate: (params) => {
      const p = domainObject(params ?? {}, ['profileId', 'id', 'file', 'draft'])
      if (typeof p.id !== 'string' || !p.id || p.id.length > 128) throw new DomainRpcError('invalid_params', 'A report id is required.')
      if (typeof p.file !== 'boolean') throw new DomainRpcError('invalid_params', 'Say whether to file it.')
      return p.file ? { ...p, draft: draftOf(p.draft) } : p
    },
    async handle(context, params, binding) {
      fromWindow(context)
      const service = await bound(binding)
      try {
        const outcome = params.file
          ? await service.answer(params.id as string, { file: true, draft: params.draft as BugReportDraft })
          : await service.answer(params.id as string, { file: false })
        return { outcome }
      } catch (error) { refusal(error) }
    }
  })
}
