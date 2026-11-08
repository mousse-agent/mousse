import type { EffectClass } from '../execution/types'
import type { PermissionMode } from '../permissionMode'

/**
 * What a workflow step must ask a person for, under the permission mode its run is held to (#338). The same words as a
 * thread: Ask before changes asks before every write and every call outside; Auto-accept edits lets file writes run;
 * Auto and Full access let calls outside run too. A step Mousse cannot classify (a script, an approval node) always
 * asks, whatever the mode. A run with no mode (admitted before workflows had one) asks as `ask` does.
 */
export function workflowApprovalEffects(mode: PermissionMode | undefined): EffectClass[] {
  switch (mode) {
    case 'accept_edits':
      return ['external', 'unknown']
    case 'auto':
    case 'full':
      return ['unknown']
    default:
      return ['write', 'external', 'unknown']
  }
}
