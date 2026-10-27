import { NetError, forbiddenReason, type ForbiddenReason, type NodeId } from '../../../shared/net'
import type { RoutedRefusal } from '../../../shared/bridge/routed'
import { DomainRpcError } from '../../protocol/domainRegistry'

/**
 * Errors of a call that goes to another computer, with words a person can act on. The codes are
 * the ones a window tells apart: it disables an action it cannot do (`computer_outdated`,
 * `computer_forbidden`), shows the offline state (`computer_offline`) and says an action "may have
 * happened" (`outcome_uncertain`). A refusal of the owner keeps the owner's own code and message.
 */
export const COMPUTER_ERROR_CODES = [
  'computer_offline',
  'computer_forbidden',
  'computer_outdated',
  'mixed_computers',
  'not_available_remotely',
  'outcome_uncertain'
] as const

/** Why a computer refused this device, as the `cause` of the refusal says; `unknown` when it did not say. */
export type ComputerForbiddenReason = ForbiddenReason | 'unknown'

export interface ComputerRef {
  node: NodeId
  name: string
}

export function computerOffline(computer: ComputerRef, lastSeen?: number): DomainRpcError {
  return new DomainRpcError('computer_offline', `${computer.name} is offline.`, {
    node: computer.node,
    name: computer.name,
    ...(lastSeen === undefined ? {} : { lastSeen })
  })
}

const FORBIDDEN_WORDS: Record<ComputerForbiddenReason, (name: string) => string> = {
  blocked: (name) => `${name} refused this device.`,
  setting_off: (name) => `Works on threads is off on ${name}.`,
  capability: (name) =>
    `This device is not allowed to work on threads on ${name}. Turn on Works on threads for it in Devices.`,
  terminal_off: (name) => `Terminals from this device are off on ${name}.`,
  unknown: (name) => `${name} refused this request.`
}

export function computerForbidden(
  computer: ComputerRef,
  reason: ComputerForbiddenReason
): DomainRpcError {
  return new DomainRpcError('computer_forbidden', FORBIDDEN_WORDS[reason](computer.name), {
    node: computer.node,
    name: computer.name,
    reason
  })
}

/** An action the other computer's version does not have: only that action says so. */
export function computerOutdated(computer: ComputerRef, method: string, key?: string): DomainRpcError {
  return new DomainRpcError('computer_outdated', `Update Mousse on ${computer.name} to do this.`, {
    node: computer.node,
    name: computer.name,
    method,
    ...(key === undefined ? {} : { key })
  })
}

export function mixedComputers(): DomainRpcError {
  return new DomainRpcError(
    'mixed_computers',
    'One action cannot involve threads on more than one computer.'
  )
}

export function notAvailableRemotely(computer: ComputerRef, method: string): DomainRpcError {
  return new DomainRpcError(
    'not_available_remotely',
    `This cannot be done from another computer. Do it on ${computer.name}.`,
    { node: computer.node, name: computer.name, method }
  )
}

export function mayHaveHappened(computer: ComputerRef, method: string): DomainRpcError {
  return new DomainRpcError(
    'outcome_uncertain',
    `${computer.name} did not confirm this. It may have happened; check before trying again.`,
    { node: computer.node, name: computer.name, method }
  )
}

/** The owner's refusal, rethrown as the error its own window would have shown. */
export function refusalError(refusal: RoutedRefusal): DomainRpcError {
  return new DomainRpcError(refusal.code, refusal.message, refusal.details)
}

/** Whether `error` says the link to the computer was lost, not that the computer answered no. */
export function isLinkLoss(error: unknown): boolean {
  return (
    error instanceof NetError &&
    ['peer_offline', 'route_unreachable', 'deadline_exceeded', 'clock_skew'].includes(error.code)
  )
}

/**
 * What a Net error from a routed call means for the person. `undefined` for an error that is not
 * about the computer (a bug on this side), which the caller rethrows as it is.
 */
export function translateNetError(
  error: unknown,
  computer: ComputerRef,
  method: string
): DomainRpcError | undefined {
  if (error instanceof DomainRpcError) return error
  if (!(error instanceof NetError)) return undefined
  switch (error.code) {
    case 'forbidden':
      return computerForbidden(computer, forbiddenReason(error.details) ?? 'unknown')
    case 'revoked':
    case 'not_enrolled':
    case 'bad_delegation':
      return computerForbidden(computer, 'capability')
    case 'peer_offline':
    case 'route_unreachable':
      return computerOffline(computer)
    case 'outcome_uncertain':
      return mayHaveHappened(computer, method)
    case 'disabled':
      return new DomainRpcError('computer_offline', `${computer.name} is not sharing its threads right now.`, {
        node: computer.node,
        name: computer.name
      })
    case 'rate_limited':
      return new DomainRpcError('rate_limited', `${computer.name} is busy. Try again in a moment.`, {
        node: computer.node,
        name: computer.name
      })
    case 'deadline_exceeded':
      return new DomainRpcError('deadline_exceeded', `${computer.name} did not answer in time.`, {
        node: computer.node,
        name: computer.name
      })
    case 'cancelled':
      return new DomainRpcError('cancelled', 'The request was cancelled.')
    default:
      return new DomainRpcError(error.code, error.message, { node: computer.node, name: computer.name })
  }
}
