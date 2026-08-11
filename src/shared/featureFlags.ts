export interface MousseFeatureFlags {
  subagentLifecycleV2: boolean
  repositoryCoordination: boolean
  externalThreadStorage: boolean
  transactionalThreadStore: boolean
  threadWorkspaces: boolean
  turnCheckpoints: boolean
  publish: boolean
  latestTurnUndo: boolean
  conversationBranches: boolean
  codeRevertRedo: boolean
  threadTrashGc: boolean
}

export const DEFAULT_FEATURE_FLAGS: MousseFeatureFlags = {
  subagentLifecycleV2: false,
  repositoryCoordination: false,
  externalThreadStorage: false,
  transactionalThreadStore: false,
  threadWorkspaces: false,
  turnCheckpoints: false,
  publish: false,
  latestTurnUndo: false,
  conversationBranches: false,
  codeRevertRedo: false,
  threadTrashGc: false
}

const PREDECESSORS: Array<[keyof MousseFeatureFlags, keyof MousseFeatureFlags]> = [
  ['repositoryCoordination', 'subagentLifecycleV2'],
  ['externalThreadStorage', 'repositoryCoordination'],
  ['transactionalThreadStore', 'externalThreadStorage'],
  ['threadWorkspaces', 'transactionalThreadStore'],
  ['turnCheckpoints', 'threadWorkspaces'],
  ['publish', 'turnCheckpoints'],
  ['latestTurnUndo', 'publish'],
  ['conversationBranches', 'latestTurnUndo'],
  ['codeRevertRedo', 'conversationBranches'],
  ['threadTrashGc', 'latestTurnUndo']
]

export function validateFeatureFlags(flags: MousseFeatureFlags): void {
  for (const [feature, predecessor] of PREDECESSORS) {
    if (flags[feature] && !flags[predecessor]) {
      throw new Error(`${feature} requires ${predecessor}`)
    }
  }
}
