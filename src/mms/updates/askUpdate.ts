import { NetError } from '../../shared/net/errors'
import { newId } from '../../shared/net/ids'
import {
  isReleaseVersion,
  parseRemoteUpdateStatus,
  remoteUpdateLimits,
  UPDATE_THERE_STEPS,
  type RemoteUpdateStatus,
  type UpdateThereStep
} from '../../shared/remoteUpdates'

/** `net.update.there`: one step of updating another computer, as a window asks it. */
export interface UpdateThereParams {
  node: string
  step: UpdateThereStep
  version?: string
  job?: string
  runningTurns?: number
}

const JOB = /^[0-9A-Za-z-]{1,64}$/

export function validateUpdateThere(params: Record<string, unknown>): UpdateThereParams {
  const bad = (): never => {
    throw new NetError('bad_request')
  }
  if (typeof params.node !== 'string' || !params.node) bad()
  if (!UPDATE_THERE_STEPS.includes(params.step as UpdateThereStep)) bad()
  const step = params.step as UpdateThereStep
  if (step === 'prepare' && !isReleaseVersion(params.version)) bad()
  if ((step === 'status' || step === 'install' || step === 'cancel') && (typeof params.job !== 'string' || !JOB.test(params.job))) bad()
  if (step === 'install' && (!Number.isSafeInteger(params.runningTurns) || (params.runningTurns as number) < 0)) bad()
  return {
    node: params.node as string,
    step,
    ...(step === 'prepare' ? { version: params.version as string } : {}),
    ...(step === 'status' || step === 'install' || step === 'cancel' ? { job: params.job as string } : {}),
    ...(step === 'install' ? { runningTurns: params.runningTurns as number } : {})
  }
}

type Rpc = (method: string, params: unknown, options: { id: ReturnType<typeof newId>; deadlineMs: number; idem?: string }) => Promise<unknown>

/**
 * Calls `update.<step>` on the other computer. A refusal of Full control comes back as a failed status, so the
 * window can say so; an unreachable computer throws, as any call does.
 */
export async function askUpdate(rpc: Rpc, params: UpdateThereParams): Promise<RemoteUpdateStatus> {
  const { step } = params
  if (step === 'refresh') throw new NetError('bad_request')
  const body =
    step === 'prepare'
      ? { version: params.version }
      : step === 'install'
        ? { job: params.job, runningTurns: params.runningTurns }
        : { job: params.job }
  const id = newId('rpc')
  try {
    const answer = await rpc(`update.${step}`, body, {
      id,
      deadlineMs: remoteUpdateLimits().callDeadlineMs,
      // A change is kept in the other computer's ledger: a retry of this call gets the same answer.
      ...(step === 'status' ? {} : { idem: id })
    })
    const status = parseRemoteUpdateStatus(answer)
    if (!status) throw new NetError('internal')
    return status
  } catch (error) {
    if (error instanceof NetError && error.code === 'forbidden')
      return { job: params.job ?? '', phase: 'failed', error: 'forbidden', runningTurns: 0 }
    throw error
  }
}
